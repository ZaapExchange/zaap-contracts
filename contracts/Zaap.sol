// SPDX-License-Identifier: UNLICENSED
// Zaap.exchange Contracts (Zaap.sol)
pragma solidity ^0.8.19;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Pausable } from "@openzeppelin/contracts/security/Pausable.sol";

import { NativeWrapper } from "./NativeWrapper.sol";
import { Swapper } from "./Swapper.sol";
import { ZaapIn } from "./ZaapIn.sol";
import { ZaapOut } from "./ZaapOut.sol";

import { IWETH9 } from "./interfaces/Uniswap/IWETH9.sol";
import { IStargateRouter } from "./interfaces/Stargate/IStargateRouter.sol";
import { IPermit2 } from "./interfaces/Permit2/IPermit2.sol";
import { IAllowanceTransfer } from "./interfaces/Permit2/IAllowanceTransfer.sol";

contract Zaap is NativeWrapper, Swapper, ZaapIn, ZaapOut {
    constructor(
        IWETH9 wETH9_,
        address swapRouter02Address_,
        IStargateRouter stargateRouter_,
        IPermit2 permit2_
    ) NativeWrapper(wETH9_) Swapper(swapRouter02Address_) ZaapIn(stargateRouter_, permit2_) ZaapOut(address(stargateRouter_)) {}
}
