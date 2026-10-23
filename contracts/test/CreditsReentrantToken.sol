// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';

interface IBuyCredits {
	function buyCredits(bytes32 instanceId, address token, uint256 amount, bytes32 orderRef) external;
}

/// @notice Test-only token that tries to re-enter buyCredits() from inside transferFrom.
contract CreditsReentrantToken is ERC20 {
	IBuyCredits public target;

	constructor() ERC20('Reentrant', 'RE') {}

	function setTarget(address target_) external {
		target = IBuyCredits(target_);
	}

	function mint(address to, uint256 amount) external {
		_mint(to, amount);
	}

	function transferFrom(address from, address to, uint256 value) public override returns (bool) {
		if (address(target) != address(0)) {
			target.buyCredits(bytes32(uint256(1)), address(this), 1, bytes32(uint256(2)));
		}
		return super.transferFrom(from, to, value);
	}
}
