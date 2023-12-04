import config from '../hardhat.config';
import { loadFixture, reset } from '@nomicfoundation/hardhat-toolbox/network-helpers';
import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { IERC20__factory } from '../typechain-ethers6';
import hre from 'hardhat';
import { EventLog } from 'ethers';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import { UNI_SWAP_ROUTER_02_ADDRESS } from '../scripts/constants/uniswap';
import { PERMIT2_ADDRESS } from '@uniswap/permit2-sdk';
import { USDC_FAUCET_ACCOUNT, USDC_TOKEN, WETH9_ADDRESS } from './helpers';
import { NATIVE_TOKEN_ADDRESS } from '../constants';

const ABI = hre.ethers.AbiCoder.defaultAbiCoder();

const chainId = network.config.chainId;
const UNI_SWAP_ROUTER_02_ADDR = UNI_SWAP_ROUTER_02_ADDRESS[chainId!];

const USDC_FAUCET_ADDR = USDC_FAUCET_ACCOUNT;

const USDC_TOKEN_ADDR = USDC_TOKEN;

const STARGATE_ETH_CHAIN_ID = 101;

describe('ZaapOutNative', function () {
  before(async function () {
    const { url, blockNumber } = config.networks?.hardhat?.forking!;
    await reset(url, blockNumber);
  });

  async function deployContractsFixture() {
    const { network, ethers } = hre;
    const { provider } = ethers;
    const [deployer, user, fakeStargateRouter] = await ethers.getSigners();

    await network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [USDC_FAUCET_ADDR]
    });
    const usdcFaucet = await ethers.provider.getSigner(USDC_FAUCET_ADDR);
    const usdcToken = IERC20__factory.connect(USDC_TOKEN_ADDR, usdcFaucet);
    await deployer.sendTransaction({
      to: USDC_FAUCET_ADDR,
      value: ethers.parseEther('1')
    });

    const ZaapFactory = await ethers.getContractFactory('Zaap');
    const zaap = await ZaapFactory.deploy(WETH9_ADDRESS, UNI_SWAP_ROUTER_02_ADDR, fakeStargateRouter.address, PERMIT2_ADDRESS);

    return { provider, deployer, user, usdcToken, fakeStargateRouter, zaap };
  }

  it('Should deploy Zaap', async function () {
    const { fakeStargateRouter, zaap } = await loadFixture(deployContractsFixture);
    expect(await zaap.stargateRouter()).to.equal(fakeStargateRouter.address);
    expect(await zaap.permit2()).to.equal(PERMIT2_ADDRESS);
    expect(await zaap.wETH9()).to.equal(WETH9_ADDRESS);
    expect(await zaap.swapRouter02()).to.equal(UNI_SWAP_ROUTER_02_ADDR);
  });

  it('Should complete bridging ETH to recipient after swapping USDC to WETH (USDC-WETH) using Uniswap V2 and Uniswap V3 then unwrapping WETH to ETH', async function () {
    const { provider, user, usdcToken, fakeStargateRouter, zaap } = await loadFixture(deployContractsFixture);
    const zaapAddress = await zaap.getAddress();

    const userPreSgReceiveBalance = await provider.getBalance(user.address);

    // Transfer USDC to Zaap
    const bridgeAmountIn = ethers.parseUnits('1612', 6);
    await usdcToken.transfer(zaapAddress, bridgeAmountIn);

    const USDC_WETH_MULTI_MIXED_SWAP_PARAMS = [
      [
        0, // Uniswap V2
        '806000000',
        [
          ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 0],
          ['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 0]
        ],
        '450000000000000000'
      ],
      [
        1, // Uniswap V3
        '806000000',
        [
          ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 0],
          ['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 500]
        ],
        '450000000000000000'
      ]
    ];

    const payload = ABI.encode(
      ['tuple(uint8, uint256, tuple(address, uint24)[], uint256)[]', 'address', 'address'],
      [USDC_WETH_MULTI_MIXED_SWAP_PARAMS, NATIVE_TOKEN_ADDRESS, user.address]
    );
    const sgReceive = zaap.connect(fakeStargateRouter).sgReceive(STARGATE_ETH_CHAIN_ID, ethers.ZeroAddress, 0, USDC_TOKEN_ADDR, bridgeAmountIn, payload);
    await expect(sgReceive)
      .to.emit(zaap, 'ZaapedOut')
      .withArgs(STARGATE_ETH_CHAIN_ID, ethers.ZeroAddress, 0, USDC_TOKEN_ADDR, bridgeAmountIn, NATIVE_TOKEN_ADDRESS, anyValue, user.address);
    const sgReceiveRes = await (await sgReceive).wait();

    const zaapedOutEvent: EventLog = sgReceiveRes?.logs.find(
      (log) => (log as EventLog).fragment !== undefined && (log as EventLog).fragment.name === 'ZaapedOut'
    )! as EventLog;
    const amountOut = zaapedOutEvent.args.dstTokenAmountOut;

    const totalAmountMin = USDC_WETH_MULTI_MIXED_SWAP_PARAMS.reduce((acc, curr) => acc + BigInt(curr[3] as number), 0n);

    expect(amountOut).to.be.gte(totalAmountMin);
    expect(await provider.getBalance(user.address)).to.equal(userPreSgReceiveBalance + amountOut);
  });
});
