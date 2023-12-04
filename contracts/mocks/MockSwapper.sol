// SPDX-License-Identifier: UNLICENSED
// Zaap.exchange Contracts (MockSwapper.sol)
pragma solidity ^0.8.19;

import { Swapper } from "../Swapper.sol";
import { TransferHelper } from "../libraries/TransferHelper.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockSwapper is Swapper {
    event Swapped(address indexed fromTokenAddress, uint256 fromTokenAmountIn, address indexed toTokenAddress, uint256 toTokenAmountOut);

    constructor(address swapRouter02Address_) Swapper(swapRouter02Address_) {}

    function swap(address fromTokenAddress, uint fromTokenAmountIn, SwapParams[] calldata swapsParams, address toTokenAddress) external {
        TransferHelper.safeTransferFrom(fromTokenAddress, msg.sender, address(this), fromTokenAmountIn);
        (uint256 toTokenAmountOut, bool errored) = _swapExact(fromTokenAmountIn, swapsParams, fromTokenAddress, toTokenAddress, true);
        emit Swapped(fromTokenAddress, fromTokenAmountIn, toTokenAddress, toTokenAmountOut);
    }
}
