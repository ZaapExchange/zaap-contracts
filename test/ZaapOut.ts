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
import { DAI_FAUCET_ACCOUNT, DAI_TOKEN, USDC_FAUCET_ACCOUNT, USDC_TOKEN, WETH9_ADDRESS } from './helpers';

const ABI = hre.ethers.AbiCoder.defaultAbiCoder();

const chainId = network.config.chainId;
const UNI_SWAP_ROUTER_02_ADDR = UNI_SWAP_ROUTER_02_ADDRESS[chainId!];

const USDC_FAUCET_ADDR = USDC_FAUCET_ACCOUNT;
const DAI_FAUCET_ADDR = DAI_FAUCET_ACCOUNT;

const USDC_TOKEN_ADDR = USDC_TOKEN;
const DAI_TOKEN_ADDR = DAI_TOKEN;

const STARGATE_ETH_CHAIN_ID = 101;

describe('ZaapOut', function () {
  before(async function () {
    const { url, blockNumber } = config.networks?.hardhat?.forking!;
    await reset(url, blockNumber);
  });

  async function deployContractsFixture() {
    const { network, ethers } = hre;
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

    await network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [DAI_FAUCET_ADDR]
    });
    const daiFaucet = await ethers.provider.getSigner(DAI_FAUCET_ADDR);
    const daiToken = IERC20__factory.connect(DAI_TOKEN_ADDR, daiFaucet);
    await deployer.sendTransaction({
      to: DAI_FAUCET_ADDR,
      value: ethers.parseEther('1')
    });

    const ZaapFactory = await ethers.getContractFactory('Zaap');
    const zaap = await ZaapFactory.deploy(WETH9_ADDRESS, UNI_SWAP_ROUTER_02_ADDR, fakeStargateRouter.address, PERMIT2_ADDRESS);

    return { deployer, user, usdcToken, daiToken, fakeStargateRouter, zaap };
  }

  it('Should deploy Zaap', async function () {
    const { fakeStargateRouter, zaap } = await loadFixture(deployContractsFixture);
    expect(await zaap.stargateRouter()).to.equal(fakeStargateRouter.address);
    expect(await zaap.permit2()).to.equal(PERMIT2_ADDRESS);
    expect(await zaap.wETH9()).to.equal(WETH9_ADDRESS);
    expect(await zaap.swapRouter02()).to.equal(UNI_SWAP_ROUTER_02_ADDR);
  });

  it('Should revert if `msg.sender` is not `stargateRouterAddress`', async function () {
    const { zaap } = await loadFixture(deployContractsFixture);

    const bridgeAmountIn = ethers.parseUnits('100', 6);
    const payload = ABI.encode(
      ['tuple(uint8, uint256, tuple(address, uint24)[], uint256)[]', 'address', 'address'],
      [[], ethers.ZeroAddress, ethers.ZeroAddress]
    );
    await expect(zaap.sgReceive(STARGATE_ETH_CHAIN_ID, ethers.ZeroAddress, 0, USDC_TOKEN_ADDR, bridgeAmountIn, payload)).to.be.revertedWith(
      'ZaapOut: `msg.sender` must be `stargateRouterAddress`'
    );
  });

  it('Should complete bridging USDC to recipient', async function () {
    const { user, usdcToken, fakeStargateRouter, zaap } = await loadFixture(deployContractsFixture);
    const zaapAddress = await zaap.getAddress();

    // Transfer USDC to Zaap
    const bridgeAmountIn = ethers.parseUnits('100', 6);
    await usdcToken.transfer(zaapAddress, bridgeAmountIn);

    const payload = ABI.encode(['tuple(uint8, uint256, tuple(address, uint24)[], uint256)[]', 'address', 'address'], [[], USDC_TOKEN_ADDR, user.address]);
    const sgReceive = zaap.connect(fakeStargateRouter).sgReceive(STARGATE_ETH_CHAIN_ID, ethers.ZeroAddress, 0, USDC_TOKEN_ADDR, bridgeAmountIn, payload);

    await expect(sgReceive)
      .to.emit(zaap, 'ZaapedOut')
      .withArgs(STARGATE_ETH_CHAIN_ID, ethers.ZeroAddress, 0, USDC_TOKEN_ADDR, bridgeAmountIn, USDC_TOKEN_ADDR, bridgeAmountIn, user.address);
    expect(await usdcToken.balanceOf(user.address)).to.equal(bridgeAmountIn);
  });

  it('Should complete bridging USDC to recipient after swapping DAI to USDC (DAI-USDC) using Uniswap V2 and Uniswap V3', async function () {
    const { user, usdcToken, daiToken, fakeStargateRouter, zaap } = await loadFixture(deployContractsFixture);
    const zaapAddress = await zaap.getAddress();

    // Transfer DAI to Zaap
    const bridgeAmountIn = ethers.parseUnits('100', 18);
    await daiToken.transfer(zaapAddress, bridgeAmountIn);

    const DAI_USDC_MULTI_MIXED_SWAP_PARAMS = [
      [
        0, // Uniswap V2
        '50000000000000000000',
        [
          ['0x6B175474E89094C44Da98b954EedeAC495271d0F', 0],
          ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 0]
        ],
        '49890000'
      ],
      [
        1, // Uniswap V3
        '50000000000000000000',
        [
          ['0x6B175474E89094C44Da98b954EedeAC495271d0F', 0],
          ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 500]
        ],
        '49890000'
      ]
    ];

    const payload = ABI.encode(
      ['tuple(uint8, uint256, tuple(address, uint24)[], uint256)[]', 'address', 'address'],
      [DAI_USDC_MULTI_MIXED_SWAP_PARAMS, USDC_TOKEN_ADDR, user.address]
    );
    const sgReceive = zaap.connect(fakeStargateRouter).sgReceive(STARGATE_ETH_CHAIN_ID, ethers.ZeroAddress, 0, DAI_TOKEN_ADDR, bridgeAmountIn, payload);
    await expect(sgReceive)
      .to.emit(zaap, 'ZaapedOut')
      .withArgs(STARGATE_ETH_CHAIN_ID, ethers.ZeroAddress, 0, DAI_TOKEN_ADDR, bridgeAmountIn, USDC_TOKEN_ADDR, anyValue, user.address);
    const sgReceiveRes = await (await sgReceive).wait();

    const zaapedOutEvent: EventLog = sgReceiveRes?.logs.find(
      (log) => (log as EventLog).fragment !== undefined && (log as EventLog).fragment.name === 'ZaapedOut'
    )! as EventLog;
    const amountOut = zaapedOutEvent.args.dstTokenAmountOut;

    const totalAmountMin = DAI_USDC_MULTI_MIXED_SWAP_PARAMS.reduce((acc, curr) => acc + BigInt(curr[3] as number), 0n);

    expect(amountOut).to.be.gte(totalAmountMin);
    expect(await usdcToken.balanceOf(user.address)).to.equal(amountOut);
  });

  it('Should bridge USDC to recipient if `bridgeTokenAddress` != `dstTokenAddress` but `dstSwapsParams` is empty', async function () {
    const { user, usdcToken, fakeStargateRouter, zaap } = await loadFixture(deployContractsFixture);
    const zaapAddress = await zaap.getAddress();

    // Transfer USDC to Zaap
    const bridgeAmountIn = ethers.parseUnits('100', 6);
    await usdcToken.transfer(zaapAddress, bridgeAmountIn);

    const payload = ABI.encode(['tuple(uint8, uint256, tuple(address, uint24)[], uint256)[]', 'address', 'address'], [[], DAI_TOKEN_ADDR, user.address]);
    const sgReceive = zaap.connect(fakeStargateRouter).sgReceive(STARGATE_ETH_CHAIN_ID, ethers.ZeroAddress, 0, USDC_TOKEN_ADDR, bridgeAmountIn, payload);

    await expect(sgReceive).to.emit(zaap, 'ZaapErrored').withArgs('ZaapOut: `dstSwapsParams` must not be empty if `bridgeTokenAddress` != `dstTokenAddress`');
    expect(await usdcToken.balanceOf(user.address)).to.equal(bridgeAmountIn);
  });

  it('Should bridge USDC to recipient if 1 out of 1 swap is errored', async function () {
    const { user, usdcToken, fakeStargateRouter, zaap } = await loadFixture(deployContractsFixture);
    const zaapAddress = await zaap.getAddress();

    // Transfer USDC to Zaap
    const bridgeAmountIn = ethers.parseUnits('100', 6);
    await usdcToken.transfer(zaapAddress, bridgeAmountIn);

    const ERR_SWAP_PARAMS = [
      [
        1, // Uniswap V3
        '100000000',
        [
          ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 0],
          ['0x6B175474E89094C44Da98b954EedeAC495271d0F', 500]
        ],
        '110000000000000000000' // Errored slippage
      ]
    ];

    const payload = ABI.encode(
      ['tuple(uint8, uint256, tuple(address, uint24)[], uint256)[]', 'address', 'address'],
      [ERR_SWAP_PARAMS, DAI_TOKEN_ADDR, user.address]
    );
    const sgReceive = zaap.connect(fakeStargateRouter).sgReceive(STARGATE_ETH_CHAIN_ID, ethers.ZeroAddress, 0, USDC_TOKEN_ADDR, bridgeAmountIn, payload);

    await expect(sgReceive).to.emit(zaap, 'ZaapErrored').withArgs('ZaapOut: `_swap` errored');
    expect(await usdcToken.balanceOf(user.address)).to.equal(bridgeAmountIn);
  });

  it('Should partially bridge USDC to recipient if 1 out of 2 swap is errored', async function () {
    const { user, usdcToken, daiToken, fakeStargateRouter, zaap } = await loadFixture(deployContractsFixture);
    const zaapAddress = await zaap.getAddress();

    // Transfer USDC to Zaap
    const bridgeAmountIn = ethers.parseUnits('100', 6);
    await usdcToken.transfer(zaapAddress, bridgeAmountIn);

    const ERR_SWAP_PARAMS = [
      [
        0, // Uniswap V2
        '50000000',
        [
          ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 0],
          ['0x6B175474E89094C44Da98b954EedeAC495271d0F', 0]
        ],
        '49000000000000000000'
      ],
      [
        1, // Uniswap V3
        '50000000',
        [
          ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 0],
          ['0x6B175474E89094C44Da98b954EedeAC495271d0F', 500]
        ],
        '59000000000000000000' // Errored slippage
      ]
    ];

    const payload = ABI.encode(
      ['tuple(uint8, uint256, tuple(address, uint24)[], uint256)[]', 'address', 'address'],
      [ERR_SWAP_PARAMS, DAI_TOKEN_ADDR, user.address]
    );
    const sgReceive = zaap.connect(fakeStargateRouter).sgReceive(STARGATE_ETH_CHAIN_ID, ethers.ZeroAddress, 0, USDC_TOKEN_ADDR, bridgeAmountIn, payload);

    await expect(sgReceive).to.emit(zaap, 'ZaapErrored').withArgs('ZaapOut: `_swap` errored');
    expect(await daiToken.balanceOf(user.address)).to.gte(ethers.toBigInt(ERR_SWAP_PARAMS[0][3] as string));
    expect(await usdcToken.balanceOf(user.address)).to.gte(ethers.toBigInt(ERR_SWAP_PARAMS[1][1] as string));
  });

  it("Should doesn't allow to call sgReceive if contract is paused and vice-versa", async function () {
    const { user, fakeStargateRouter, zaap } = await loadFixture(deployContractsFixture);

    await zaap.pauseOut();
    await expect(zaap.sgReceive(STARGATE_ETH_CHAIN_ID, ethers.ZeroAddress, 0, USDC_TOKEN_ADDR, 0, '0x')).to.be.revertedWith('Pausable: paused');

    await zaap.unpauseOut();
    const payload = ABI.encode(['tuple(uint8, uint256, tuple(address, uint24)[], uint256)[]', 'address', 'address'], [[], USDC_TOKEN_ADDR, user.address]);
    const sgReceive = zaap.connect(fakeStargateRouter).sgReceive(STARGATE_ETH_CHAIN_ID, ethers.ZeroAddress, 0, USDC_TOKEN_ADDR, 0, payload);

    await expect(sgReceive).to.be.revertedWith('ZaapOut: `bridgeAmountIn` must be > 0');
  });
});
