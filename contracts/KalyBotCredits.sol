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
///         Any wallet can pay for any instance, at the owner-set price of the pack.
/// @dev The price is enforced on-chain, so a front-runner who copies a pending `orderRef` must pay
///      the full price and the credits still go to the instance named in the event; the order is bound to
///      (orderRef, instance, pack), so copying only the orderRef blocks nobody (spec §14 H-A).
contract KalyBotCredits is Ownable2Step, Pausable, ReentrancyGuard {
	using SafeERC20 for IERC20;

	IKalyBotSplitter public immutable splitter;

	/// @notice Price of a pack in token units; 0 means the pack is not sold in that token.
	mapping(uint8 packId => mapping(address token => uint256)) public prices;
	mapping(address token => bool) public splitterApproved;
	mapping(bytes32 paidKey => bool) private _paid;

	event CreditsBought(
		bytes32 indexed instanceId,
		address indexed payer,
		uint8 packId,
		address token,
		uint256 amount,
		bytes32 indexed orderRef
	);
	event PriceSet(uint8 indexed packId, address indexed token, uint256 price);
	event TokenRescued(address indexed token, address indexed to, uint256 amount);

	error ZeroAddress();
	error ZeroInstance();
	error ZeroOrderRef();
	error InvalidPack();
	error PackNotConfigured();
	error OrderRefUsed();

	constructor(address splitter_, address owner_) Ownable(owner_) {
		if (splitter_ == address(0)) revert ZeroAddress();
		splitter = IKalyBotSplitter(splitter_);
	}

	// ── Payments ───────────────────────────────────────────────────────────

	/// @notice Pay the owner-set price of `packId` in `token` for an instance's credits. Pulls it
	///         from the caller and forwards it to the splitter. `orderRef` ties the payment to the
	///         control plane order.
	function buyCredits(bytes32 instanceId, uint8 packId, address token, bytes32 orderRef)
		external
		whenNotPaused
		nonReentrant
	{
		if (instanceId == bytes32(0)) revert ZeroInstance();
		if (orderRef == bytes32(0)) revert ZeroOrderRef();
		uint256 price = _priceOf(packId, token);
		bytes32 key = _paidKey(orderRef, instanceId, packId);
		if (_paid[key]) revert OrderRefUsed();
		_paid[key] = true;

		IERC20(token).safeTransferFrom(msg.sender, address(this), price);
		splitter.split(token, price);

		emit CreditsBought(instanceId, msg.sender, packId, token, price, orderRef);
	}

	/// @notice Whether this exact (orderRef, instance, pack) has been paid. An orderRef copied with
	///         another instance or pack is a different payment and blocks nobody.
	function orderPaid(bytes32 orderRef, bytes32 instanceId, uint8 packId) external view returns (bool) {
		return _paid[_paidKey(orderRef, instanceId, packId)];
	}

	// ── Owner ──────────────────────────────────────────────────────────────

	/// @notice Set a pack price in token units (0 disables it). The first price for a token approves
	///         the splitter to pull it.
	function setPrice(uint8 packId, address token, uint256 price) external onlyOwner {
		if (packId == 0) revert InvalidPack();
		if (token == address(0)) revert ZeroAddress();
		prices[packId][token] = price;
		if (!splitterApproved[token]) {
			splitterApproved[token] = true;
			IERC20(token).forceApprove(address(splitter), type(uint256).max);
		}
		emit PriceSet(packId, token, price);
	}

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

	// ── Internal ───────────────────────────────────────────────────────────

	function _paidKey(bytes32 orderRef, bytes32 instanceId, uint8 packId) internal pure returns (bytes32) {
		return keccak256(abi.encode(orderRef, instanceId, packId));
	}

	function _priceOf(uint8 packId, address token) internal view returns (uint256 price) {
		if (packId == 0) revert InvalidPack();
		price = prices[packId][token];
		if (price == 0) revert PackNotConfigured();
	}
}
