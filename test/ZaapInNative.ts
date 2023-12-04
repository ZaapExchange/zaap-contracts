import config from '../hardhat.config';
import { loadFixture, reset } from '@nomicfoundation/hardhat-toolbox/network-helpers';
import { expect } from 'chai';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import { ethers, network } from 'hardhat';
import { IERC20__factory, IStargateBridge__factory, IStargateRouter__factory, Zaap } from '../typechain-ethers6';
import hre from 'hardhat';
import { EventLog } from 'ethers';
import { STARGATE_ROUTER_ADDRESS, UNI_SWAP_ROUTER_02_ADDRESS } from '../scripts/constants';
import { PERMIT2_ADDRESS } from '@uniswap/permit2-sdk';
import { EMPTY_LZ_TX_OBJ, EMPTY_PERMIT_SIG, EMPTY_PERMIT_SINGLE, USDC_TOKEN, WETH9_ADDRESS } from './helpers';
import { NATIVE_TOKEN_ADDRESS } from '../constants';

const ABI = hre.ethers.AbiCoder.defaultAbiCoder();

const chainId = network.config.chainId;
const STARGATE_ROUTER_ADDR = STARGATE_ROUTER_ADDRESS[chainId!];
const UNI_SWAP_ROUTER_02_ADDR = UNI_SWAP_ROUTER_02_ADDRESS[chainId!];

const USDC_TOKEN_ADDR = USDC_TOKEN;
const WETH_TOKEN_ADDR = WETH9_ADDRESS;

const STARGATE_USDC_POOL_ID = 1;
const STARGATE_BASE_CHAIN_ID = 184;

describe('ZaapInNative', function () {
  before(async function () {
    const { url, blockNumber } = config.networks?.hardhat?.forking!;
    await reset(url, blockNumber);
  });

  async function deployContractsFixture() {
    const { ethers } = hre;
    const { provider } = ethers;
    const [deployer, user] = await ethers.getSigners();

    const wEthToken = IERC20__factory.connect(WETH_TOKEN_ADDR, provider);
    const usdcToken = IERC20__factory.connect(USDC_TOKEN_ADDR, provider);

    const stargateRouter = IStargateRouter__factory.connect(STARGATE_ROUTER_ADDR, deployer);
    const stargateBridgeAddress = await stargateRouter.bridge();
    const stargateBridge = IStargateBridge__factory.connect(stargateBridgeAddress, deployer);

    const ZaapFactory = await ethers.getContractFactory('Zaap');
    const zaap = await ZaapFactory.deploy(WETH9_ADDRESS, UNI_SWAP_ROUTER_02_ADDR, STARGATE_ROUTER_ADDR, PERMIT2_ADDRESS);

    return { provider, deployer, user, wEthToken, usdcToken, stargateRouter, stargateBridge, zaap };
  }

  it('Should deploy Zaap', async function () {
    const { zaap } = await loadFixture(deployContractsFixture);
    expect(await zaap.stargateRouter()).to.equal(STARGATE_ROUTER_ADDR);
    expect(await zaap.permit2()).to.equal(PERMIT2_ADDRESS);
    expect(await zaap.wETH9()).to.equal(WETH9_ADDRESS);
    expect(await zaap.swapRouter02()).to.equal(UNI_SWAP_ROUTER_02_ADDR);
  });

  it('Should init ETH bridging to dest after wrapping ETH to WETH then swapping WETH to USDC (ETH-USDC) using Uniswap V2 and Uniswap V3', async function () {
    const { provider, user, wEthToken, usdcToken, stargateRouter, stargateBridge, zaap } = await loadFixture(deployContractsFixture);
    const zaapAddress = await zaap.getAddress();

    const fromAmount = ethers.parseUnits('1', 18);

    const userPreSwapBalance = await provider.getBalance(user.address);
    expect(userPreSwapBalance).to.greaterThan(fromAmount);
    expect(await provider.getBalance(zaapAddress)).to.equal(0);

    // Get Layer Zero fee
    const [lzFee] = await stargateRouter.quoteLayerZeroFee(
      STARGATE_BASE_CHAIN_ID,
      1,
      ethers.ZeroAddress,
      ABI.encode(['tuple(uint8, uint256, tuple(address, uint24)[], uint256)[]', 'address', 'address'], [[], ethers.ZeroAddress, ethers.ZeroAddress]),
      {
        dstGasForCall: 0,
        dstNativeAmount: 0,
        dstNativeAddr: ethers.ZeroAddress
      }
    );

    const WETH_USDC_MULTI_MIXED_SWAP_PARAMS = [
      {
        routerVersion: 0, // Uniswap V2
        pathParts: [
          { tokenAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', poolFee: 0 },
          { tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', poolFee: 0 }
        ],
        amountIn: '500000000000000000',
        amountOutMin: '806000000'
      },
      {
        routerVersion: 1, // Uniswap V3
        pathParts: [
          { tokenAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', poolFee: 0 },
          { tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', poolFee: 500 }
        ],
        amountIn: '500000000000000000',
        amountOutMin: '806000000'
      }
    ];

    const totalAmountMin = WETH_USDC_MULTI_MIXED_SWAP_PARAMS.reduce((acc, curr) => acc + BigInt(curr.amountOutMin), 0n);

    const allowedSlippagePercent = 5n;
    const bridgeAmountMin = totalAmountMin - (totalAmountMin * allowedSlippagePercent) / 10000n;

    // Swap WETH for USDC then bridge ETH to dest using Zaap
    const swapParams: Parameters<Zaap['swap']> = [
      NATIVE_TOKEN_ADDRESS,
      fromAmount,
      WETH_USDC_MULTI_MIXED_SWAP_PARAMS,
      STARGATE_USDC_POOL_ID,
      USDC_TOKEN_ADDR,
      bridgeAmountMin,
      STARGATE_BASE_CHAIN_ID,
      STARGATE_USDC_POOL_ID,
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      [],
      user.address,
      EMPTY_PERMIT_SINGLE,
      EMPTY_PERMIT_SIG,
      EMPTY_LZ_TX_OBJ,
      0,
      '0x',
      { value: lzFee + fromAmount }
    ];
    const swapFn = zaap.getFunction('swap');
    const swapTxEstimateGas = await swapFn.estimateGas(...swapParams);
    const swapTx = zaap.connect(user).swap(...swapParams);
    await expect(swapTx)
      .to.emit(zaap, 'ZaapedIn')
      .withArgs(
        user.address,
        NATIVE_TOKEN_ADDRESS,
        fromAmount,
        STARGATE_USDC_POOL_ID,
        USDC_TOKEN_ADDR,
        anyValue,
        STARGATE_BASE_CHAIN_ID,
        STARGATE_USDC_POOL_ID,
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        user.address,
        '0x'
      )
      .to.emit(stargateBridge, 'SendMsg')
      .withArgs(1, anyValue);
    const swapTxRes = await (await swapTx).wait();

    const zaapedInEvent: EventLog = swapTxRes?.logs.find(
      (log) => (log as EventLog).fragment !== undefined && (log as EventLog).fragment.name === 'ZaapedIn'
    )! as EventLog;
    const bridgeAmount = zaapedInEvent.args.bridgeAmount;

    expect(await provider.getBalance(user.address)).to.closeTo(userPreSwapBalance - fromAmount - swapTxEstimateGas, BigInt(1e17));
    expect(await provider.getBalance(zaapAddress)).to.equal(0);

    expect(await wEthToken.balanceOf(user.address)).to.equal(0);
    expect(await wEthToken.balanceOf(zaapAddress)).to.equal(0);

    expect(await usdcToken.balanceOf(user.address)).to.equal(0);
    expect(await usdcToken.balanceOf(zaapAddress)).to.equal(0);

    expect(bridgeAmount).to.be.gte(totalAmountMin);
  });

  it('Should revert if `msg.value` is < `srcTokenAmountIn`', async function () {
    const { user, zaap } = await loadFixture(deployContractsFixture);

    const fromAmount = ethers.parseUnits('1', 18);

    const WETH_USDC_MULTI_MIXED_SWAP_PARAMS = [
      {
        routerVersion: 0, // Uniswap V2
        pathParts: [
          { tokenAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', poolFee: 0 },
          { tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', poolFee: 0 }
        ],
        amountIn: '500000000000000000',
        amountOutMin: '816000000'
      }
    ];

    await expect(
      zaap
        .connect(user)
        .swap(
          NATIVE_TOKEN_ADDRESS,
          fromAmount,
          WETH_USDC_MULTI_MIXED_SWAP_PARAMS,
          STARGATE_USDC_POOL_ID,
          USDC_TOKEN_ADDR,
          0,
          STARGATE_BASE_CHAIN_ID,
          STARGATE_USDC_POOL_ID,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          [],
          user.address,
          EMPTY_PERMIT_SINGLE,
          EMPTY_PERMIT_SIG,
          EMPTY_LZ_TX_OBJ,
          0,
          '0x'
        )
    ).to.revertedWith('ZaapIn: `msg.value` must be >= `srcTokenAmountIn`');
  });
});
