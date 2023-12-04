import { ethers } from 'hardhat';
import { BigNumberish } from 'ethers';
import { IStargateRouter as NsIStargateRouter } from '../../typechain-ethers6/contracts/Zaap';
import { PermitSingle } from '@uniswap/permit2-sdk';

// Tokens addresses
export const USDC_TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
export const ARB_TOKEN = '0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1';
export const DAI_TOKEN = '0x6B175474E89094C44Da98b954EedeAC495271d0F';

// Faucet accounts (impersonated)
export const USDC_FAUCET_ACCOUNT = '0x55FE002aefF02F77364de339a1292923A15844B8';
export const ARB_FAUCET_ACCOUNT = '0x6cC5F688a315f3dC28A7781717a9A798a59fDA7b';
export const DAI_FAUCET_ACCOUNT = '0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503';

// WETH9
export const WETH9_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

// Dummy structs
export const EMPTY_LZ_TX_OBJ: NsIStargateRouter.LzTxObjStruct = {
  dstGasForCall: 0,
  dstNativeAddr: ethers.ZeroAddress,
  dstNativeAmount: 0
};

export interface PermitDetailsEthers6 {
  token: string;
  amount: BigNumberish;
  expiration: BigNumberish;
  nonce: BigNumberish;
}

export interface PermitSingleEthers6 {
  details: PermitDetailsEthers6;
  spender: string;
  sigDeadline: BigNumberish;
}

export const EMPTY_PERMIT_SINGLE: PermitSingleEthers6 = {
  details: {
    token: ethers.ZeroAddress,
    amount: 0,
    expiration: 0,
    nonce: 0
  },
  spender: ethers.ZeroAddress,
  sigDeadline: 0
};
export const EMPTY_PERMIT_SIG: string = ethers.ZeroHash;

// Utils
export function permitSingleAdapter(permit: PermitSingle): PermitSingleEthers6 {
  return {
    details: {
      token: permit.details.token,
      amount: permit.details.amount.toString(),
      expiration: permit.details.expiration.toString(),
      nonce: permit.details.nonce.toString()
    },
    spender: permit.spender,
    sigDeadline: permit.sigDeadline.toString()
  };
}
