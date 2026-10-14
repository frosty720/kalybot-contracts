// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import {IKalyBotSplitter} from '../interfaces/IKalyBotSplitter.sol';

/// @notice Test-only token that tries to re-enter split() from inside transferFrom.
contract ReentrantToken is ERC20 {
	IKalyBotSplitter public target;

	constructor() ERC20('Reentrant', 'RE') {}

	function setTarget(address target_) external {
		target = IKalyBotSplitter(target_);
	}

	function mint(address to, uint256 amount) external {
		_mint(to, amount);
	}

	function transferFrom(address from, address to, uint256 value) public override returns (bool) {
		if (address(target) != address(0)) target.split(address(this), 1);
		return super.transferFrom(from, to, value);
	}
}
