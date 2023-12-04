import config from '../hardhat.config';
import { loadFixture, reset } from '@nomicfoundation/hardhat-toolbox/network-helpers';
import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { IERC20__factory } from '../typechain-ethers6';
import hre from 'hardhat';
import { EventLog } from 'ethers';
import { UNI_SWAP_ROUTER_02_ADDRESS } from '../scripts/constants';
import { ARB_FAUCET_ACCOUNT, ARB_TOKEN, DAI_FAUCET_ACCOUNT, DAI_TOKEN, USDC_FAUCET_ACCOUNT, USDC_TOKEN, WETH9_ADDRESS } from './helpers';

const USDC_FAUCET_ADDR = USDC_FAUCET_ACCOUNT;
const ARB_FAUCET_ADDR = ARB_FAUCET_ACCOUNT;
const DAI_FAUCET_ADDR = DAI_FAUCET_ACCOUNT;

const chainId = network.config.chainId;
const UNI_SWAP_ROUTER_02_ADDR = UNI_SWAP_ROUTER_02_ADDRESS[chainId!];

const USDC_TOKEN_ADDR = USDC_TOKEN;
const ARB_TOKEN_ADDR = ARB_TOKEN;
const DAI_TOKEN_ADDR = DAI_TOKEN;

describe('Swapper', function () {
  before(async function () {
    const { url, blockNumber } = config.networks?.hardhat?.forking!;
    await reset(url, blockNumber);
  });

  async function deployContractsFixture() {
    const { network, ethers } = hre;
    const [deployer, user] = await ethers.getSigners();

    await network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [ARB_FAUCET_ADDR]
    });
    const arbFaucet = await ethers.provider.getSigner(ARB_FAUCET_ADDR);
    const arbToken = IERC20__factory.connect(ARB_TOKEN_ADDR, arbFaucet);
    await deployer.sendTransaction({
      to: ARB_FAUCET_ADDR,
      value: ethers.parseEther('1')
    });

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

    const MockSwapperFactory = await ethers.getContractFactory('MockSwapper');
    const swapper = await MockSwapperFactory.deploy(UNI_SWAP_ROUTER_02_ADDR);

    return { deployer, user, usdcToken, arbToken, daiToken, swapper };
  }

  it('Should deploy MockSwapper', async function () {
    const { swapper } = await loadFixture(deployContractsFixture);
    expect(await swapper.swapRouter02()).to.equal(UNI_SWAP_ROUTER_02_ADDR);
  });

  it('Should single-swap ARB to USDC (ARB-WETH-USDC) using Uniswap V3', async function () {
    const { user, usdcToken, arbToken, swapper } = await loadFixture(deployContractsFixture);
    const swapperAddress = await swapper.getAddress();

    // Transfer ARB to the user
    const fromAmount = ethers.parseUnits('100', 18);
    await arbToken.transfer(user.address, fromAmount);

    expect(await arbToken.balanceOf(user.address)).to.equal(fromAmount);
    expect(await arbToken.balanceOf(swapperAddress)).to.equal(0);
    expect(await usdcToken.balanceOf(swapperAddress)).to.equal(0);

    // Approve MockSwapper to spend ARB on behalf of the user
    await arbToken.connect(user).approve(swapperAddress, fromAmount);

    const ARB_WETH_USDC_V3_SWAP_PARAMS = [
      {
        routerVersion: 1, // Uniswap V3
        pathParts: [
          { tokenAddress: '0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1', poolFee: 0 },
          { tokenAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', poolFee: 3000 },
          { tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', poolFee: 500 }
        ],
        amountIn: '100000000000000000000',
        amountOutMin: '90681512'
      }
    ];

    // Swap ARB to USDC
    const swapTx = swapper.connect(user).swap(ARB_TOKEN_ADDR, fromAmount, ARB_WETH_USDC_V3_SWAP_PARAMS, USDC_TOKEN_ADDR);
    await expect(swapTx).to.emit(swapper, 'Swapped');
    const swapTxRes = await (await swapTx).wait();

    const swappedEvent: EventLog = swapTxRes?.logs.find(
      (log) => (log as EventLog).fragment !== undefined && (log as EventLog).fragment.name === 'Swapped'
    )! as EventLog;

    const amountOut = swappedEvent.args.toTokenAmountOut;

    expect(await arbToken.balanceOf(user.address)).to.equal(0);
    expect(await arbToken.balanceOf(swapperAddress)).to.equal(0);
    expect(amountOut).to.be.gte(ethers.toBigInt(ARB_WETH_USDC_V3_SWAP_PARAMS[0].amountOutMin));
    expect(await usdcToken.balanceOf(swapperAddress)).to.be.gte(amountOut);
  });

  it('Should multi-swap ARB to USDC (ARB-WETH-USDC) using Uniswap V3', async function () {
    const { user, usdcToken, arbToken, swapper } = await loadFixture(deployContractsFixture);
    const swapperAddress = await swapper.getAddress();

    // Transfer ARB to the user
    const fromAmount = ethers.parseUnits('100', 18);
    await arbToken.transfer(user.address, fromAmount);

    expect(await arbToken.balanceOf(user.address)).to.equal(fromAmount);
    expect(await arbToken.balanceOf(swapperAddress)).to.equal(0);
    expect(await usdcToken.balanceOf(swapperAddress)).to.equal(0);

    // Approve MockSwapper to spend ARB on behalf of the user
    await arbToken.connect(user).approve(swapperAddress, fromAmount);

    const ARB_WETH_USDC_MULTI_V3_SWAP_PARAMS = [
      {
        routerVersion: 1, // Uniswap V3
        pathParts: [
          { tokenAddress: '0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1', poolFee: 0 },
          { tokenAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', poolFee: 3000 },
          { tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', poolFee: 500 }
        ],
        amountIn: '50000000000000000000',
        amountOutMin: '45340756'
      },
      {
        routerVersion: 1, // Uniswap V3
        pathParts: [
          { tokenAddress: '0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1', poolFee: 0 },
          { tokenAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', poolFee: 3000 },
          { tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', poolFee: 500 }
        ],
        amountIn: '50000000000000000000',
        amountOutMin: '45340092'
      }
    ];

    // Swap ARB to USDC
    const swapTx = swapper.connect(user).swap(ARB_TOKEN_ADDR, fromAmount, ARB_WETH_USDC_MULTI_V3_SWAP_PARAMS, USDC_TOKEN_ADDR);
    await expect(swapTx).to.emit(swapper, 'Swapped');
    const swapTxRes = await (await swapTx).wait();

    const swappedEvent: EventLog = swapTxRes?.logs.find(
      (log) => (log as EventLog).fragment !== undefined && (log as EventLog).fragment.name === 'Swapped'
    )! as EventLog;
    const amountOut = swappedEvent.args.toTokenAmountOut;

    const totalAmountMin = ARB_WETH_USDC_MULTI_V3_SWAP_PARAMS.reduce((acc, curr) => acc + BigInt(curr.amountOutMin), 0n);

    expect(await arbToken.balanceOf(user.address)).to.equal(0);
    expect(await arbToken.balanceOf(swapperAddress)).to.equal(0);
    expect(amountOut).to.be.gte(totalAmountMin);
    expect(await usdcToken.balanceOf(swapperAddress)).to.be.gte(amountOut);
  });

  it('Should single-swap DAI to USDC (DAI-USDC) using Uniswap V2', async function () {
    const { user, usdcToken, daiToken, swapper } = await loadFixture(deployContractsFixture);
    const swapperAddress = await swapper.getAddress();

    // Transfer DAI to the user
    const fromAmount = ethers.parseUnits('100', 18);
    await daiToken.transfer(user.address, fromAmount);

    expect(await daiToken.balanceOf(user.address)).to.equal(fromAmount);
    expect(await daiToken.balanceOf(swapperAddress)).to.equal(0);
    expect(await usdcToken.balanceOf(swapperAddress)).to.equal(0);

    // Approve MockSwapper to spend DAI on behalf of the user
    await daiToken.connect(user).approve(swapperAddress, fromAmount);

    const DAI_USDC_V2_SWAP_PARAMS = [
      {
        routerVersion: 0, // Uniswap V2
        pathParts: [
          { tokenAddress: '0x6B175474E89094C44Da98b954EedeAC495271d0F', poolFee: 0 },
          { tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', poolFee: 0 }
        ],
        amountIn: '100000000000000000000',
        amountOutMin: '99780000'
      }
    ];

    // Swap DAI to USDC
    const swapTx = swapper.connect(user).swap(DAI_TOKEN_ADDR, fromAmount, DAI_USDC_V2_SWAP_PARAMS, USDC_TOKEN_ADDR);
    await expect(swapTx).to.emit(swapper, 'Swapped');
    const swapTxRes = await (await swapTx).wait();

    const swappedEvent: EventLog = swapTxRes?.logs.find(
      (log) => (log as EventLog).fragment !== undefined && (log as EventLog).fragment.name === 'Swapped'
    )! as EventLog;

    const amountOut = swappedEvent.args.toTokenAmountOut;

    expect(await daiToken.balanceOf(user.address)).to.equal(0);
    expect(await daiToken.balanceOf(swapperAddress)).to.equal(0);
    expect(amountOut).to.be.gte(ethers.toBigInt(DAI_USDC_V2_SWAP_PARAMS[0].amountOutMin));
    expect(await usdcToken.balanceOf(swapperAddress)).to.be.gte(amountOut);
  });

  it('Should multi-swap DAI to USDC (DAI-USDC) using Uniswap V2', async function () {
    const { user, usdcToken, daiToken, swapper } = await loadFixture(deployContractsFixture);
    const swapperAddress = await swapper.getAddress();

    // Transfer DAI to the user
    const fromAmount = ethers.parseUnits('100', 18);
    await daiToken.transfer(user.address, fromAmount);

    expect(await daiToken.balanceOf(user.address)).to.equal(fromAmount);
    expect(await daiToken.balanceOf(swapperAddress)).to.equal(0);
    expect(await usdcToken.balanceOf(swapperAddress)).to.equal(0);

    // Approve MockSwapper to spend DAI on behalf of the user
    await daiToken.connect(user).approve(swapperAddress, fromAmount);

    const DAI_USDC_MULTI_V2_SWAP_PARAMS = [
      {
        routerVersion: 0, // Uniswap V2
        pathParts: [
          { tokenAddress: '0x6B175474E89094C44Da98b954EedeAC495271d0F', poolFee: 0 },
          { tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', poolFee: 0 }
        ],
        amountIn: '50000000000000000000',
        amountOutMin: '49890000'
      },
      {
        routerVersion: 0, // Uniswap V2
        pathParts: [
          { tokenAddress: '0x6B175474E89094C44Da98b954EedeAC495271d0F', poolFee: 0 },
          { tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', poolFee: 0 }
        ],
        amountIn: '50000000000000000000',
        amountOutMin: '49890000'
      }
    ];

    // Swap DAI to USDC
    const swapTx = swapper.connect(user).swap(DAI_TOKEN_ADDR, fromAmount, DAI_USDC_MULTI_V2_SWAP_PARAMS, USDC_TOKEN_ADDR);
    await expect(swapTx).to.emit(swapper, 'Swapped');
    const swapTxRes = await (await swapTx).wait();

    const swappedEvent: EventLog = swapTxRes?.logs.find(
      (log) => (log as EventLog).fragment !== undefined && (log as EventLog).fragment.name === 'Swapped'
    )! as EventLog;
    const amountOut = swappedEvent.args.toTokenAmountOut;

    const totalAmountMin = DAI_USDC_MULTI_V2_SWAP_PARAMS.reduce((acc, curr) => acc + BigInt(curr.amountOutMin), 0n);

    expect(await daiToken.balanceOf(user.address)).to.equal(0);
    expect(await daiToken.balanceOf(swapperAddress)).to.equal(0);
    expect(amountOut).to.be.gte(totalAmountMin);
    expect(await usdcToken.balanceOf(swapperAddress)).to.be.gte(amountOut);
  });

  it('Should multi-swap DAI to USDC (DAI-USDC) using Uniswap V2 and Uniswap V3', async function () {
    const { user, usdcToken, daiToken, swapper } = await loadFixture(deployContractsFixture);
    const swapperAddress = await swapper.getAddress();

    // Transfer DAI to the user
    const fromAmount = ethers.parseUnits('200', 18);
    await daiToken.transfer(user.address, fromAmount);

    expect(await daiToken.balanceOf(user.address)).to.equal(fromAmount);
    expect(await daiToken.balanceOf(swapperAddress)).to.equal(0);
    expect(await usdcToken.balanceOf(swapperAddress)).to.equal(0);

    // Approve MockSwapper to spend DAI on behalf of the user
    await daiToken.connect(user).approve(swapperAddress, fromAmount);

    const DAI_USDC_MULTI_MIXED_SWAP_PARAMS = [
      {
        routerVersion: 0, // Uniswap V2
        pathParts: [
          { tokenAddress: '0x6B175474E89094C44Da98b954EedeAC495271d0F', poolFee: 0 },
          { tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', poolFee: 0 }
        ],
        amountIn: '100000000000000000000',
        amountOutMin: '99780000'
      },
      {
        routerVersion: 1, // Uniswap V3
        pathParts: [
          { tokenAddress: '0x6B175474E89094C44Da98b954EedeAC495271d0F', poolFee: 0 },
          { tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', poolFee: 500 }
        ],
        amountIn: '100000000000000000000',
        amountOutMin: '99993000'
      }
    ];

    // Swap DAI to USDC
    const swapTx = swapper.connect(user).swap(DAI_TOKEN_ADDR, fromAmount, DAI_USDC_MULTI_MIXED_SWAP_PARAMS, USDC_TOKEN_ADDR);
    await expect(swapTx).to.emit(swapper, 'Swapped');
    const swapTxRes = await (await swapTx).wait();

    const swappedEvent: EventLog = swapTxRes?.logs.find(
      (log) => (log as EventLog).fragment !== undefined && (log as EventLog).fragment.name === 'Swapped'
    )! as EventLog;
    const amountOut = swappedEvent.args.toTokenAmountOut;

    const totalAmountMin = DAI_USDC_MULTI_MIXED_SWAP_PARAMS.reduce((acc, curr) => acc + BigInt(curr.amountOutMin), 0n);

    expect(await daiToken.balanceOf(user.address)).to.equal(0);
    expect(await daiToken.balanceOf(swapperAddress)).to.equal(0);
    expect(amountOut).to.be.gte(totalAmountMin);
    expect(await usdcToken.balanceOf(swapperAddress)).to.be.gte(amountOut);
  });

  it('Should revert if `firstPathPart.tokenAddress` != `fromTokenAddress`', async function () {
    const { user, usdcToken, arbToken, swapper } = await loadFixture(deployContractsFixture);
    const swapperAddress = await swapper.getAddress();

    // Transfer ARB to the user
    const fromAmount = ethers.parseUnits('100', 18);
    await arbToken.transfer(user.address, fromAmount);

    expect(await arbToken.balanceOf(user.address)).to.equal(fromAmount);
    expect(await arbToken.balanceOf(swapperAddress)).to.equal(0);
    expect(await usdcToken.balanceOf(swapperAddress)).to.equal(0);

    // Approve MockSwapper to spend ARB on behalf of the user
    await arbToken.connect(user).approve(swapperAddress, fromAmount);

    const ERR_SWAP_PARAMS = [
      {
        routerVersion: 1, // Uniswap V3
        pathParts: [
          { tokenAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', poolFee: 0 },
          { tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', poolFee: 500 }
        ],
        amountIn: '100000000000000000000',
        amountOutMin: '90681512'
      }
    ];

    const swapTx = swapper.connect(user).swap(ARB_TOKEN_ADDR, fromAmount, ERR_SWAP_PARAMS, USDC_TOKEN_ADDR);
    await expect(swapTx).to.revertedWith('Swapper: `firstPathPart.tokenAddress` != `fromTokenAddress`');
  });

  it('Should revert if `lastPathPart.tokenAddress` != `toTokenAddress`', async function () {
    const { user, usdcToken, arbToken, swapper } = await loadFixture(deployContractsFixture);
    const swapperAddress = await swapper.getAddress();

    // Transfer ARB to the user
    const fromAmount = ethers.parseUnits('100', 18);
    await arbToken.transfer(user.address, fromAmount);

    expect(await arbToken.balanceOf(user.address)).to.equal(fromAmount);
    expect(await arbToken.balanceOf(swapperAddress)).to.equal(0);
    expect(await usdcToken.balanceOf(swapperAddress)).to.equal(0);

    // Approve MockSwapper to spend ARB on behalf of the user
    await arbToken.connect(user).approve(swapperAddress, fromAmount);

    const ERR_SWAP_PARAMS = [
      {
        routerVersion: 1, // Uniswap V3
        pathParts: [
          { tokenAddress: '0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1', poolFee: 0 },
          { tokenAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', poolFee: 3000 }
        ],
        amountIn: '100000000000000000000',
        amountOutMin: '90681512'
      }
    ];

    const swapTx = swapper.connect(user).swap(ARB_TOKEN_ADDR, fromAmount, ERR_SWAP_PARAMS, USDC_TOKEN_ADDR);
    await expect(swapTx).to.revertedWith('Swapper: `lastPathPart.tokenAddress` != `toTokenAddress`');
  });

  it('Should revert if `swapParams.routerVersion` is not 0 nor 1', async function () {
    const { user, usdcToken, arbToken, swapper } = await loadFixture(deployContractsFixture);
    const swapperAddress = await swapper.getAddress();

    // Transfer ARB to the user
    const fromAmount = ethers.parseUnits('100', 18);
    await arbToken.transfer(user.address, fromAmount);

    expect(await arbToken.balanceOf(user.address)).to.equal(fromAmount);
    expect(await arbToken.balanceOf(swapperAddress)).to.equal(0);
    expect(await usdcToken.balanceOf(swapperAddress)).to.equal(0);

    // Approve MockSwapper to spend ARB on behalf of the user
    await arbToken.connect(user).approve(swapperAddress, fromAmount);

    const ERR_SWAP_PARAMS = [
      {
        routerVersion: 2, // Unknown router
        pathParts: [
          { tokenAddress: '0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1', poolFee: 0 },
          { tokenAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', poolFee: 3000 },
          { tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', poolFee: 500 }
        ],
        amountIn: '100000000000000000000',
        amountOutMin: '90681512'
      }
    ];

    const swapTx = swapper.connect(user).swap(ARB_TOKEN_ADDR, fromAmount, ERR_SWAP_PARAMS, USDC_TOKEN_ADDR);
    await expect(swapTx).to.be.reverted;
  });
});
