import config from '../hardhat.config';
import { loadFixture, reset } from '@nomicfoundation/hardhat-toolbox/network-helpers';
import { expect } from 'chai';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import { ethers, network } from 'hardhat';
import { IERC20, IERC20__factory, IStargateBridge, IStargateBridge__factory, IStargateRouter, IStargateRouter__factory, Zaap } from '../typechain-ethers6';
import hre from 'hardhat';
import { EventLog } from 'ethers';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { STARGATE_ROUTER_ADDRESS, UNI_SWAP_ROUTER_02_ADDRESS } from '../scripts/constants';
import { AllowanceTransfer, PERMIT2_ADDRESS, PermitSingle } from '@uniswap/permit2-sdk';
import { toDeadline } from '../scripts/utils';
import {
  ARB_FAUCET_ACCOUNT,
  ARB_TOKEN,
  DAI_FAUCET_ACCOUNT,
  DAI_TOKEN,
  EMPTY_LZ_TX_OBJ,
  EMPTY_PERMIT_SIG,
  EMPTY_PERMIT_SINGLE,
  USDC_FAUCET_ACCOUNT,
  USDC_TOKEN,
  WETH9_ADDRESS,
  permitSingleAdapter
} from './helpers';

const ABI = hre.ethers.AbiCoder.defaultAbiCoder();

const USDC_FAUCET_ADDR = USDC_FAUCET_ACCOUNT;
const ARB_FAUCET_ADDR = ARB_FAUCET_ACCOUNT;
const DAI_FAUCET_ADDR = DAI_FAUCET_ACCOUNT;

const chainId = network.config.chainId;
const STARGATE_ROUTER_ADDR = STARGATE_ROUTER_ADDRESS[chainId!];
const UNI_SWAP_ROUTER_02_ADDR = UNI_SWAP_ROUTER_02_ADDRESS[chainId!];

const USDC_TOKEN_ADDR = USDC_TOKEN;
const ARB_TOKEN_ADDR = ARB_TOKEN;
const DAI_TOKEN_ADDR = DAI_TOKEN;

const STARGATE_USDC_POOL_ID = 1;
const STARGATE_BASE_CHAIN_ID = 184;

const DEFAULT_PERMIT2_EXP = 1000 * 60 * 60 * 24 * 30;
const DEFAULT_PERMIT2_SIG_EXP = 1000 * 60 * 60 * 30;

const permitSigFn = (permitSingle: PermitSingle, signer: HardhatEthersSigner) => {
  const { domain, types, values } = AllowanceTransfer.getPermitData(permitSingle, PERMIT2_ADDRESS, network.config.chainId!);
  return signer.signTypedData(
    {
      name: domain.name,
      chainId: domain.chainId?.toString(),
      verifyingContract: domain.verifyingContract
    },
    types,
    values
  );
};

describe('ZaapIn', function () {
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

    const stargateRouter = IStargateRouter__factory.connect(STARGATE_ROUTER_ADDR, deployer);
    const stargateBridgeAddress = await stargateRouter.bridge();
    const stargateBridge = IStargateBridge__factory.connect(stargateBridgeAddress, deployer);

    const ZaapFactory = await ethers.getContractFactory('Zaap');
    const zaap = await ZaapFactory.deploy(WETH9_ADDRESS, UNI_SWAP_ROUTER_02_ADDR, STARGATE_ROUTER_ADDR, PERMIT2_ADDRESS);

    return { deployer, user, usdcToken, arbToken, daiToken, stargateRouter, stargateBridge, zaap };
  }

  it('Should deploy Zaap', async function () {
    const { zaap } = await loadFixture(deployContractsFixture);
    expect(await zaap.stargateRouter()).to.equal(STARGATE_ROUTER_ADDR);
    expect(await zaap.permit2()).to.equal(PERMIT2_ADDRESS);
    expect(await zaap.wETH9()).to.equal(WETH9_ADDRESS);
    expect(await zaap.swapRouter02()).to.equal(UNI_SWAP_ROUTER_02_ADDR);
  });

  it('Should init USDC bridging to dest', async function () {
    const { user, usdcToken, stargateRouter, stargateBridge, zaap } = await loadFixture(deployContractsFixture);

    const usdcAmount = ethers.parseUnits('100', 6);
    await bridgeUsdcToDest(user, usdcToken, stargateRouter, stargateBridge, zaap, usdcAmount);
  });

  it('Should init USDC bridging to dest after swapping DAI to USDC (DAI-USDC) using Uniswap V2 and Uniswap V3', async function () {
    const { user, usdcToken, daiToken, stargateRouter, stargateBridge, zaap } = await loadFixture(deployContractsFixture);
    const zaapAddress = await zaap.getAddress();

    // Transfer DAI to the user
    const fromAmount = ethers.parseUnits('200', 18);
    await daiToken.transfer(user.address, fromAmount);

    expect(await daiToken.balanceOf(user.address)).to.equal(fromAmount);
    expect(await daiToken.balanceOf(zaapAddress)).to.equal(0);

    // Approve Permit2 to spend DAI on behalf of the user
    await daiToken.connect(user).approve(PERMIT2_ADDRESS, fromAmount);

    // Permit Zaap to spend DAI on behalf of the user
    const permitSingle: PermitSingle = {
      details: {
        token: DAI_TOKEN_ADDR,
        amount: fromAmount,
        expiration: toDeadline(DEFAULT_PERMIT2_EXP),
        nonce: 0
      },
      spender: zaapAddress,
      sigDeadline: toDeadline(DEFAULT_PERMIT2_SIG_EXP)
    };
    const permitSig = await permitSigFn(permitSingle, user);

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

    const totalAmountMin = DAI_USDC_MULTI_MIXED_SWAP_PARAMS.reduce((acc, curr) => acc + BigInt(curr.amountOutMin), 0n);

    const allowedSlippagePercent = 5n;
    const bridgeAmountMin = totalAmountMin - (totalAmountMin * allowedSlippagePercent) / 10000n;

    // Swap DAI for USDC then bridge USDC to dest using Zaap
    const swapTx = zaap
      .connect(user)
      .swap(
        DAI_TOKEN_ADDR,
        fromAmount,
        DAI_USDC_MULTI_MIXED_SWAP_PARAMS,
        STARGATE_USDC_POOL_ID,
        USDC_TOKEN_ADDR,
        bridgeAmountMin,
        STARGATE_BASE_CHAIN_ID,
        STARGATE_USDC_POOL_ID,
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        [],
        user.address,
        permitSingleAdapter(permitSingle),
        permitSig,
        EMPTY_LZ_TX_OBJ,
        0,
        '0x',
        { value: lzFee }
      );
    await expect(swapTx)
      .to.emit(zaap, 'ZaapedIn')
      .withArgs(
        user.address,
        DAI_TOKEN_ADDR,
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

    expect(await usdcToken.balanceOf(user.address)).to.equal(0);
    expect(await usdcToken.balanceOf(zaapAddress)).to.equal(0);

    expect(await daiToken.balanceOf(user.address)).to.equal(0);
    expect(await daiToken.balanceOf(zaapAddress)).to.equal(0);

    expect(bridgeAmount).to.be.gte(totalAmountMin);
  });

  it('Should revert if `srcTokenAmountIn` is <= 0', async function () {
    const { user, zaap } = await loadFixture(deployContractsFixture);

    await expect(
      zaap
        .connect(user)
        .swap(
          USDC_TOKEN_ADDR,
          0,
          [],
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
    ).to.revertedWith('ZaapIn: `srcTokenAmountIn` must be > 0');
  });

  it('Should revert if `deadline` is < block.timestamp', async function () {
    const { user, zaap } = await loadFixture(deployContractsFixture);

    let currentBlockTimestamp = (await ethers.provider.send('eth_getBlockByNumber', ['pending', false]))?.timestamp;

    await expect(
      zaap
        .connect(user)
        .swap(
          USDC_TOKEN_ADDR,
          1,
          [],
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
          currentBlockTimestamp - 1,
          '0x'
        )
    ).to.revertedWith('ZaapIn: `deadline` must be >= block.timestamp');

    currentBlockTimestamp = (await ethers.provider.send('eth_getBlockByNumber', ['pending', false]))?.timestamp;

    await expect(
      zaap
        .connect(user)
        .swap(
          USDC_TOKEN_ADDR,
          1,
          [],
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
          currentBlockTimestamp,
          '0x'
        )
    ).to.not.revertedWith('ZaapIn: `deadline` must be >= block.timestamp');
  });

  it('Should revert if `srcSwapsParams` is empty and `srcTokenAddress` != `bridgeTokenAddress`', async function () {
    const { user, daiToken, zaap } = await loadFixture(deployContractsFixture);
    const zaapAddress = await zaap.getAddress();

    // Transfer DAI to the user
    const fromAmount = ethers.parseUnits('200', 18);
    await daiToken.transfer(user.address, fromAmount);

    expect(await daiToken.balanceOf(user.address)).to.equal(fromAmount);
    expect(await daiToken.balanceOf(zaapAddress)).to.equal(0);

    // Approve Permit2 to spend DAI on behalf of the user
    await daiToken.connect(user).approve(PERMIT2_ADDRESS, fromAmount);

    // Permit Zaap to spend DAI on behalf of the user
    const permitSingle: PermitSingle = {
      details: {
        token: DAI_TOKEN_ADDR,
        amount: fromAmount,
        expiration: toDeadline(DEFAULT_PERMIT2_EXP),
        nonce: 0
      },
      spender: zaapAddress,
      sigDeadline: toDeadline(DEFAULT_PERMIT2_SIG_EXP)
    };
    const permitSig = await permitSigFn(permitSingle, user);

    await expect(
      zaap
        .connect(user)
        .swap(
          DAI_TOKEN_ADDR,
          fromAmount,
          [],
          STARGATE_USDC_POOL_ID,
          USDC_TOKEN_ADDR,
          0,
          STARGATE_BASE_CHAIN_ID,
          STARGATE_USDC_POOL_ID,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          [],
          user.address,
          permitSingleAdapter(permitSingle),
          permitSig,
          EMPTY_LZ_TX_OBJ,
          0,
          '0x'
        )
    ).to.revertedWith('ZaapIn: `srcSwapsParams` must not be empty if `srcTokenAddress` != `bridgeTokenAddress`');
  });

  it('Should be able to set treasuryAddress if owner', async function () {
    const { zaap } = await loadFixture(deployContractsFixture);

    const treasuryAddress = await zaap.treasuryAddress();
    expect(treasuryAddress).to.equal(ethers.ZeroAddress);

    const newTreasuryAddress = ethers.Wallet.createRandom().address;
    await zaap.setTreasuryAddress(newTreasuryAddress);

    expect(await zaap.treasuryAddress()).to.equal(newTreasuryAddress);
  });

  it('Should not be able to set treasuryAddress if not owner', async function () {
    const { user, zaap } = await loadFixture(deployContractsFixture);

    const randomAddress = ethers.Wallet.createRandom().address;
    await expect(zaap.connect(user).setTreasuryAddress(randomAddress)).to.be.revertedWith('Ownable: caller is not the owner');
  });

  it('Should be able to set feeBps if owner', async function () {
    const { zaap } = await loadFixture(deployContractsFixture);

    const feeBps = await zaap.feeBps();
    expect(feeBps).to.equal(0);

    const newFeeBps = 50;
    await zaap.setFeeBps(newFeeBps);

    expect(await zaap.feeBps()).to.equal(newFeeBps);
  });

  it('Should not be able to set feeBps if `feeBps_` > 50', async function () {
    const { zaap } = await loadFixture(deployContractsFixture);

    const newFeeBps = 51;
    await expect(zaap.setFeeBps(newFeeBps)).to.be.revertedWith('ZaapIn: `feeBps_` must be <= 50');
  });

  it('Should not be able to set feeBps if not owner', async function () {
    const { user, zaap } = await loadFixture(deployContractsFixture);

    const newFeeBps = 50;
    await expect(zaap.connect(user).setFeeBps(newFeeBps)).to.be.revertedWith('Ownable: caller is not the owner');
  });

  it('Should not collect fees if treasuryAddress is not set', async function () {
    const { user, usdcToken, stargateRouter, stargateBridge, zaap } = await loadFixture(deployContractsFixture);

    const newFeeBps = 50;
    await zaap.setFeeBps(newFeeBps);

    const treasuryAddress = await zaap.treasuryAddress();
    expect(treasuryAddress).to.equal(ethers.ZeroAddress);
    expect(await usdcToken.balanceOf(treasuryAddress)).to.equal(0);

    await bridgeUsdcToDest(user, usdcToken, stargateRouter, stargateBridge, zaap);

    expect(await usdcToken.balanceOf(treasuryAddress)).to.equal(0);
  });

  it('Should not collect fees if feeBps is not set', async function () {
    const { user, usdcToken, stargateRouter, stargateBridge, zaap } = await loadFixture(deployContractsFixture);

    const newTreasuryAddress = ethers.Wallet.createRandom().address;
    await zaap.setTreasuryAddress(newTreasuryAddress);

    const feeBps = await zaap.feeBps();
    expect(feeBps).to.equal(0);
    expect(await usdcToken.balanceOf(newTreasuryAddress)).to.equal(0);

    await bridgeUsdcToDest(user, usdcToken, stargateRouter, stargateBridge, zaap);

    expect(await usdcToken.balanceOf(newTreasuryAddress)).to.equal(0);
  });

  it('Should collect the correct amount of fees if treasuryAddress and feeBps are set', async function () {
    const { user, usdcToken, stargateRouter, stargateBridge, zaap } = await loadFixture(deployContractsFixture);

    const newTreasuryAddress = ethers.Wallet.createRandom().address;
    await zaap.setTreasuryAddress(newTreasuryAddress);

    const newFeeBps = 50;
    await zaap.setFeeBps(newFeeBps);

    const usdcAmount = ethers.parseUnits('100', 6);
    await bridgeUsdcToDest(user, usdcToken, stargateRouter, stargateBridge, zaap, usdcAmount, newFeeBps);

    const expectedFeeAmount = (usdcAmount * BigInt(newFeeBps)) / 10000n;
    expect(await usdcToken.balanceOf(newTreasuryAddress)).to.equal(expectedFeeAmount);
  });

  it('Should revshare the correct amount of partner fees according to the `PartnerConfig` [percentShare=0]', async function () {
    const { user, usdcToken, stargateRouter, stargateBridge, zaap } = await loadFixture(deployContractsFixture);

    const newTreasuryAddress = ethers.Wallet.createRandom().address;
    await zaap.setTreasuryAddress(newTreasuryAddress);

    const newFeeBps = 50;
    await zaap.setFeeBps(newFeeBps);

    const partnerId = '123';
    const parnterAddress = ethers.Wallet.createRandom().address;
    await zaap.setPartnerConfig(partnerId, parnterAddress, 0);

    const usdcAmount = ethers.parseUnits('1000', 6);
    await bridgeUsdcToDest(user, usdcToken, stargateRouter, stargateBridge, zaap, usdcAmount, newFeeBps, partnerId);

    const expectedFeeAmount = (usdcAmount * BigInt(newFeeBps)) / 10000n;
    expect(await usdcToken.balanceOf(newTreasuryAddress)).to.equal(expectedFeeAmount);
    expect(await usdcToken.balanceOf(parnterAddress)).to.equal(0);
  });

  it('Should revshare the correct amount of partner fees according to the `PartnerConfig` [percentShare=50]', async function () {
    const { user, usdcToken, stargateRouter, stargateBridge, zaap } = await loadFixture(deployContractsFixture);

    const newTreasuryAddress = ethers.Wallet.createRandom().address;
    await zaap.setTreasuryAddress(newTreasuryAddress);

    const newFeeBps = 50;
    await zaap.setFeeBps(newFeeBps);

    const partnerId = '456';
    const parnterAddress = ethers.Wallet.createRandom().address;
    await zaap.setPartnerConfig(partnerId, parnterAddress, 50);

    const usdcAmount = ethers.parseUnits('100', 6);
    await bridgeUsdcToDest(user, usdcToken, stargateRouter, stargateBridge, zaap, usdcAmount, newFeeBps, partnerId);

    const expectedFeeAmount = (usdcAmount * BigInt(newFeeBps)) / 10000n;
    expect(await usdcToken.balanceOf(newTreasuryAddress)).to.equal(expectedFeeAmount / 2n);
    expect(await usdcToken.balanceOf(parnterAddress)).to.equal(expectedFeeAmount / 2n);
  });

  it('Should revshare the correct amount of partner fees according to the `PartnerConfig` [percentShare=100]', async function () {
    const { user, usdcToken, stargateRouter, stargateBridge, zaap } = await loadFixture(deployContractsFixture);

    const newTreasuryAddress = ethers.Wallet.createRandom().address;
    await zaap.setTreasuryAddress(newTreasuryAddress);

    const newFeeBps = 50;
    await zaap.setFeeBps(newFeeBps);

    const partnerId = '789';
    const parnterAddress = ethers.Wallet.createRandom().address;
    await zaap.setPartnerConfig(partnerId, parnterAddress, 100);

    const usdcAmount = ethers.parseUnits('200', 6);
    await bridgeUsdcToDest(user, usdcToken, stargateRouter, stargateBridge, zaap, usdcAmount, newFeeBps, partnerId);

    const expectedFeeAmount = (usdcAmount * BigInt(newFeeBps)) / 10000n;
    expect(await usdcToken.balanceOf(newTreasuryAddress)).to.equal(0);
    expect(await usdcToken.balanceOf(parnterAddress)).to.equal(expectedFeeAmount);
  });

  it('Should not revshare any partner fees if `PartnerConfig` was deleted', async function () {
    const { user, usdcToken, stargateRouter, stargateBridge, zaap } = await loadFixture(deployContractsFixture);

    const newTreasuryAddress = ethers.Wallet.createRandom().address;
    await zaap.setTreasuryAddress(newTreasuryAddress);

    const newFeeBps = 50;
    await zaap.setFeeBps(newFeeBps);

    const partnerId = 'abc123';
    const parnterAddress = ethers.Wallet.createRandom().address;
    await zaap.setPartnerConfig(partnerId, parnterAddress, 100);

    await zaap.deletePartnerConfig(partnerId);

    const usdcAmount = ethers.parseUnits('100', 6);
    await bridgeUsdcToDest(user, usdcToken, stargateRouter, stargateBridge, zaap, usdcAmount, newFeeBps, partnerId);

    const expectedFeeAmount = (usdcAmount * BigInt(newFeeBps)) / 10000n;
    expect(await usdcToken.balanceOf(newTreasuryAddress)).to.equal(expectedFeeAmount);
    expect(await usdcToken.balanceOf(parnterAddress)).to.equal(0);
  });

  it("Should doesn't allow swap if contract is paused and vice-versa", async function () {
    const { user, zaap } = await loadFixture(deployContractsFixture);

    await zaap.pauseIn();
    await expect(
      zaap
        .connect(user)
        .swap(
          USDC_TOKEN_ADDR,
          0,
          [],
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
    ).to.revertedWith('Pausable: paused');

    await zaap.unpauseIn();
    await expect(
      zaap
        .connect(user)
        .swap(
          USDC_TOKEN_ADDR,
          0,
          [],
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
    ).to.revertedWith('ZaapIn: `srcTokenAmountIn` must be > 0');
  });
});

const bridgeUsdcToDest = async (
  user: HardhatEthersSigner,
  usdcToken: IERC20,
  stargateRouter: IStargateRouter,
  stargateBridge: IStargateBridge,
  zaap: Zaap,
  usdcAmount: bigint = ethers.parseUnits('100', 6),
  feeBps: number = 0,
  partnerId: string = '0x'
) => {
  const zaapAddress = await zaap.getAddress();

  // Transfer USDC to the user
  const fromAmount = usdcAmount;
  await usdcToken.transfer(user.address, fromAmount);

  expect(await usdcToken.balanceOf(user.address)).to.equal(fromAmount);
  expect(await usdcToken.balanceOf(zaapAddress)).to.equal(0);

  // Approve Permit2 to spend USDC on behalf of the user
  await usdcToken.connect(user).approve(PERMIT2_ADDRESS, fromAmount);

  // Permit Zaap to spend USDC on behalf of the user
  const permitSingle: PermitSingle = {
    details: {
      token: USDC_TOKEN_ADDR,
      amount: fromAmount,
      expiration: toDeadline(DEFAULT_PERMIT2_EXP),
      nonce: 0
    },
    spender: zaapAddress,
    sigDeadline: toDeadline(DEFAULT_PERMIT2_SIG_EXP)
  };
  const permitSig = await permitSigFn(permitSingle, user);

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

  const allowedSlippagePercent = 5n;
  const fromAmountMinusFee = fromAmount - (fromAmount * BigInt(feeBps)) / 10000n;
  const bridgeAmountMin = fromAmountMinusFee - (fromAmountMinusFee * allowedSlippagePercent) / 10000n;

  // Bridge USDC to dest using Zaap
  await expect(
    zaap
      .connect(user)
      .swap(
        USDC_TOKEN_ADDR,
        fromAmount,
        [],
        STARGATE_USDC_POOL_ID,
        USDC_TOKEN_ADDR,
        bridgeAmountMin,
        STARGATE_BASE_CHAIN_ID,
        STARGATE_USDC_POOL_ID,
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        [],
        user.address,
        permitSingleAdapter(permitSingle),
        permitSig,
        EMPTY_LZ_TX_OBJ,
        0,
        partnerId,
        { value: lzFee }
      )
  )
    .to.emit(zaap, 'ZaapedIn')
    .withArgs(
      user.address,
      USDC_TOKEN_ADDR,
      fromAmount,
      STARGATE_USDC_POOL_ID,
      USDC_TOKEN_ADDR,
      anyValue,
      STARGATE_BASE_CHAIN_ID,
      STARGATE_USDC_POOL_ID,
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      user.address,
      partnerId
    )
    .to.emit(stargateBridge, 'SendMsg')
    .withArgs(1, anyValue);

  expect(await usdcToken.balanceOf(user.address)).to.equal(0);
  expect(await usdcToken.balanceOf(zaapAddress)).to.equal(0);
};
