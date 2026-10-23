// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {Ownable2Step} from '@openzeppelin/contracts/access/Ownable2Step.sol';
import {Pausable} from '@openzeppelin/contracts/utils/Pausable.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeCast} from '@openzeppelin/contracts/utils/math/SafeCast.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {IKalyBotSplitter} from './interfaces/IKalyBotSplitter.sol';

/// @notice KalyBot plan payments. Adapted from FrostyFlow's FrostySubscriptionV3: exact on-chain
///         prices, and every payment forwarded to the splitter in the same transaction (this
///         contract never keeps funds). Renewals on the same tier stack on the remaining time; a
///         tier change converts the remaining time at the monthly price ratio. Subscriptions are
///         keyed by the control plane's instance id, so any wallet can pay for any instance.
/// @dev The on-chain expiry is informational; the control plane's paid_until is authoritative.
///      The price is enforced on-chain and an order is bound to (orderRef, instance, tier, period), so a
///      front-runner copying only the orderRef blocks nobody; an exact copy pays for the customer.
contract KalyBotSubscription is Ownable2Step, Pausable, ReentrancyGuard {
	using SafeERC20 for IERC20;

	uint8 public constant PERIOD_MONTHLY = 0;
	uint8 public constant PERIOD_ANNUAL = 1;
	uint8 public constant MAX_TIER = 4;

	IKalyBotSplitter public immutable splitter;

	mapping(uint8 tier => mapping(uint8 period => mapping(address token => uint256 price))) public prices;
	mapping(address token => bool) public splitterApproved;
	mapping(bytes32 paidKey => bool) private _paid;

	struct Subscription {
		uint8 tier;
		uint64 expiry;
	}

	mapping(bytes32 instanceId => Subscription) private _subscriptions;

	event Subscribed(
		bytes32 indexed instanceId,
		uint8 tier,
		uint8 period,
		uint256 expiry,
		address indexed payer,
		address token,
		uint256 amount,
		bytes32 indexed orderRef
	);
	event SubscriptionGranted(bytes32 indexed instanceId, uint8 tier, uint256 duration, uint256 expiry);
	event PriceSet(uint8 indexed tier, uint8 indexed period, address indexed token, uint256 price);
	event TokenRescued(address indexed token, address indexed to, uint256 amount);

	error ZeroAddress();
	error ZeroInstance();
	error ZeroOrderRef();
	error InvalidTier();
	error InvalidPeriod();
	error InvalidDuration();
	error TierNotConfigured();
	error OrderRefUsed();

	constructor(address splitter_, address owner_) Ownable(owner_) {
		if (splitter_ == address(0)) revert ZeroAddress();
		splitter = IKalyBotSplitter(splitter_);
	}

	// ── Payments ───────────────────────────────────────────────────────────

	/// @notice Pay for `tier` over `period` for an instance. Pulls the exact price from the caller
	///         and forwards it to the splitter. `orderRef` ties the payment to the control plane order.
	function subscribeFor(bytes32 instanceId, uint8 tier, uint8 period, address token, bytes32 orderRef)
		external
		whenNotPaused
		nonReentrant
	{
		if (instanceId == bytes32(0)) revert ZeroInstance();
		if (orderRef == bytes32(0)) revert ZeroOrderRef();
		bytes32 key = _paidKey(orderRef, instanceId, tier, period);
		if (_paid[key]) revert OrderRefUsed();
		uint256 price = _priceOf(tier, period, token);
		_paid[key] = true;

		IERC20(token).safeTransferFrom(msg.sender, address(this), price);
		Subscription storage sub = _subscriptions[instanceId];
		uint256 left = _remaining(sub);
		if (left > 0 && sub.tier != tier) left = _convert(left, sub.tier, tier, token);
		uint256 expiry = _store(sub, tier, block.timestamp + left + periodDuration(period));
		splitter.split(token, price);

		emit Subscribed(instanceId, tier, period, expiry, msg.sender, token, price, orderRef);
	}

	// ── Views ──────────────────────────────────────────────────────────────

	/// @notice Whether this exact (orderRef, instance, tier, period) has been paid. An orderRef copied
	///         with another instance, tier or period is a different payment and blocks nobody.
	function orderPaid(bytes32 orderRef, bytes32 instanceId, uint8 tier, uint8 period) external view returns (bool) {
		return _paid[_paidKey(orderRef, instanceId, tier, period)];
	}

	function getSubscription(bytes32 instanceId) external view returns (uint8 tier, uint256 expiry, bool active) {
		Subscription storage sub = _subscriptions[instanceId];
		return (sub.tier, sub.expiry, sub.expiry > block.timestamp);
	}

	function periodDuration(uint8 period) public pure returns (uint256) {
		if (period == PERIOD_MONTHLY) return 30 days;
		if (period == PERIOD_ANNUAL) return 365 days;
		revert InvalidPeriod();
	}

	// ── Owner ──────────────────────────────────────────────────────────────

	/// @notice Set a price in token units. The first price for a token approves the splitter to pull it.
	function setPrice(uint8 tier, uint8 period, address token, uint256 price) external onlyOwner {
		_checkTier(tier);
		periodDuration(period);
		if (token == address(0)) revert ZeroAddress();
		prices[tier][period][token] = price;
		if (!splitterApproved[token]) {
			splitterApproved[token] = true;
			IERC20(token).forceApprove(address(splitter), type(uint256).max);
		}
		emit PriceSet(tier, period, token, price);
	}

	/// @notice Free time for comps. Moves no money. Stacks 1:1 on any time left and switches the
	///         tier without converting it: a comp is the owner's deliberate choice.
	function grant(bytes32 instanceId, uint8 tier, uint256 duration) external onlyOwner {
		if (instanceId == bytes32(0)) revert ZeroInstance();
		_checkTier(tier);
		if (duration == 0) revert InvalidDuration();
		Subscription storage sub = _subscriptions[instanceId];
		uint256 expiry = _store(sub, tier, block.timestamp + _remaining(sub) + duration);
		emit SubscriptionGranted(instanceId, tier, duration, expiry);
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

	function _paidKey(bytes32 orderRef, bytes32 instanceId, uint8 tier, uint8 period) internal pure returns (bytes32) {
		return keccak256(abi.encode(orderRef, instanceId, tier, period));
	}

	function _checkTier(uint8 tier) internal pure {
		if (tier == 0 || tier > MAX_TIER) revert InvalidTier();
	}

	function _priceOf(uint8 tier, uint8 period, address token) internal view returns (uint256 price) {
		_checkTier(tier);
		periodDuration(period);
		price = prices[tier][period][token];
		if (price == 0) revert TierNotConfigured();
	}

	/// @dev Seconds left on the current plan; 0 once it has lapsed.
	function _remaining(Subscription storage sub) internal view returns (uint256) {
		return sub.expiry > block.timestamp ? sub.expiry - block.timestamp : 0;
	}

	/// @dev Converts leftover time on `fromTier` into time on `toTier` at the ratio of their monthly
	///      prices in `token`: an upgrade buys proportionally fewer days, a downgrade keeps the value
	///      already paid. Reverts rather than silently dropping time if either monthly price is unset.
	function _convert(uint256 left, uint8 fromTier, uint8 toTier, address token) internal view returns (uint256) {
		uint256 fromRate = prices[fromTier][PERIOD_MONTHLY][token];
		uint256 toRate = prices[toTier][PERIOD_MONTHLY][token];
		if (fromRate == 0 || toRate == 0) revert TierNotConfigured();
		return (left * fromRate) / toRate;
	}

	/// @dev The tier switches immediately. SafeCast reverts instead of wrapping an absurd expiry.
	function _store(Subscription storage sub, uint8 tier, uint256 expiry) internal returns (uint256) {
		sub.tier = tier;
		sub.expiry = SafeCast.toUint64(expiry);
		return expiry;
	}
}
