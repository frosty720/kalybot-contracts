// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {Ownable2Step} from '@openzeppelin/contracts/access/Ownable2Step.sol';
import {Pausable} from '@openzeppelin/contracts/utils/Pausable.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {IKalyBotSplitter} from './interfaces/IKalyBotSplitter.sol';

/// @notice KalyBot AI credit top-ups. A one-off payment for an instance is pulled from the caller
///         and forwarded to the splitter in the same transaction (this contract never keeps funds).
///         Any wallet can pay for any instance.
/// @dev Pack prices are not enforced on-chain: the control plane checks the amount against the
///      order and credits the instance when it sees `CreditsBought` (spec C2).
contract KalyBotCredits is Ownable2Step, Pausable, ReentrancyGuard {
	using SafeERC20 for IERC20;

	IKalyBotSplitter public immutable splitter;

	mapping(address token => bool) public splitterApproved;
	mapping(bytes32 orderRef => bool) public usedOrderRef;

	event CreditsBought(
		bytes32 indexed instanceId,
		address indexed payer,
		address token,
		uint256 amount,
		bytes32 indexed orderRef
	);
	event TokenRescued(address indexed token, address indexed to, uint256 amount);

	error ZeroAddress();
	error ZeroInstance();
	error ZeroOrderRef();
	error ZeroAmount();
	error OrderRefUsed();

	constructor(address splitter_, address owner_) Ownable(owner_) {
		if (splitter_ == address(0)) revert ZeroAddress();
		splitter = IKalyBotSplitter(splitter_);
	}

	// ── Payments ───────────────────────────────────────────────────────────

	/// @notice Pay `amount` of `token` for an instance's credits. Pulls it from the caller and
	///         forwards it to the splitter. `orderRef` ties the payment to the control plane order.
	///         The first use of a token approves the splitter to pull it.
	function buyCredits(bytes32 instanceId, address token, uint256 amount, bytes32 orderRef)
		external
		whenNotPaused
		nonReentrant
	{
		if (instanceId == bytes32(0)) revert ZeroInstance();
		if (orderRef == bytes32(0)) revert ZeroOrderRef();
		if (amount == 0) revert ZeroAmount();
		if (usedOrderRef[orderRef]) revert OrderRefUsed();
		usedOrderRef[orderRef] = true;

		IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
		if (!splitterApproved[token]) {
			splitterApproved[token] = true;
			IERC20(token).forceApprove(address(splitter), type(uint256).max);
		}
		splitter.split(token, amount);

		emit CreditsBought(instanceId, msg.sender, token, amount, orderRef);
	}

	// ── Owner ──────────────────────────────────────────────────────────────

	function pause() external onlyOwner {
		_pause();
	}

	function unpause() external onlyOwner {
		_unpause();
	}

	/// @notice This contract never keeps funds, so anything here was sent by mistake.
	function rescueToken(address token, address to, uint256 amount) external onlyOwner {
		if (to == address(0)) revert ZeroAddress();
		IERC20(token).safeTransfer(to, amount);
		emit TokenRescued(token, to, amount);
	}
}
