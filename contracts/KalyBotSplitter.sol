// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {Ownable2Step} from '@openzeppelin/contracts/access/Ownable2Step.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {IKalyBotSplitter} from './interfaces/IKalyBotSplitter.sol';

/// @notice Splits KalyBot revenue between Frosty and the boss. Frosty receives `frostyBps` of
///         every payment until his cumulative share reaches `frostyCapUsd`; after that the boss
///         receives everything. Built on FrostyRevenueSplitter's patterns: payments are pulled in
///         and pushed out in the same call, stray balances are swept through the same split, and
///         funds can only ever move to the two payees — there is no withdraw path.
/// @dev All USD amounts use 18 decimals. Accepted tokens are $1 stablecoins (USDT, KUSD);
///      `usdScale[token] = 10^(18 - decimals)` converts token units to USD (0 = not accepted).
contract KalyBotSplitter is IKalyBotSplitter, Ownable2Step, ReentrancyGuard {
	using SafeERC20 for IERC20;

	uint256 public constant BPS = 10_000;
	uint8 public constant SOURCE_PAY = 0;
	uint8 public constant SOURCE_SWEEP = 1;

	address public frostyPayee;
	address public bossPayee;
	uint16 public frostyBps;
	uint256 public frostyCapUsd;
	uint256 public frostyPaidUsd;
	uint256 public totalRevenueUsd;

	mapping(address token => uint256 scale) public usdScale;

	event Split(address indexed token, uint256 amount, uint256 toFrosty, uint256 toBoss, uint256 frostyPaidUsd, uint8 source);
	event TokenAdded(address indexed token, uint8 decimals);
	event TokenRemoved(address indexed token);

	error ZeroAddress();
	error BpsTooHigh();
	error DecimalsTooHigh();
	error TokenNotAccepted();
	error NothingToSweep();

	constructor(address owner_, address frostyPayee_, address bossPayee_, uint16 frostyBps_, uint256 frostyCapUsd_)
		Ownable(owner_)
	{
		if (frostyPayee_ == address(0) || bossPayee_ == address(0)) revert ZeroAddress();
		if (frostyBps_ > BPS) revert BpsTooHigh();
		frostyPayee = frostyPayee_;
		bossPayee = bossPayee_;
		frostyBps = frostyBps_;
		frostyCapUsd = frostyCapUsd_;
	}

	// ── Payments ───────────────────────────────────────────────────────────

	/// @notice Pull `amount` of `token` from the caller and split it. Permissionless — the caller funds it.
	function split(address token, uint256 amount) external nonReentrant {
		uint256 scale = _scaleOf(token);
		IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
		_distribute(token, amount, scale, SOURCE_PAY);
	}

	/// @notice Split the whole balance of `token` held here (tokens that arrived by plain transfer,
	///         e.g. Yellow Card USDT bridged from Polygon). Permissionless.
	function sweep(address token) external nonReentrant {
		uint256 scale = _scaleOf(token);
		uint256 amount = IERC20(token).balanceOf(address(this));
		if (amount == 0) revert NothingToSweep();
		_distribute(token, amount, scale, SOURCE_SWEEP);
	}

	// ── Owner config ───────────────────────────────────────────────────────

	function addToken(address token, uint8 decimals) external onlyOwner {
		if (token == address(0)) revert ZeroAddress();
		if (decimals > 18) revert DecimalsTooHigh();
		usdScale[token] = 10 ** (18 - decimals);
		emit TokenAdded(token, decimals);
	}

	function removeToken(address token) external onlyOwner {
		usdScale[token] = 0;
		emit TokenRemoved(token);
	}

	// ── Internal ───────────────────────────────────────────────────────────

	function _scaleOf(address token) internal view returns (uint256 scale) {
		scale = usdScale[token];
		if (scale == 0) revert TokenNotAccepted();
	}

	/// @dev Frosty's share is `frostyBps` of the USD value, limited to the cap room left. Rounding
	///      dust goes to the boss. `frostyPaidUsd` grows by what was actually sent, so it never
	///      exceeds `frostyCapUsd`.
	function _distribute(address token, uint256 amount, uint256 scale, uint8 source) internal {
		uint256 usd = amount * scale;
		uint256 frostyUsd = (usd * frostyBps) / BPS;
		uint256 room = frostyCapUsd - frostyPaidUsd;
		if (frostyUsd > room) frostyUsd = room;

		uint256 toFrosty = frostyUsd / scale;
		uint256 toBoss = amount - toFrosty;
		frostyPaidUsd += toFrosty * scale;
		totalRevenueUsd += usd;

		if (toFrosty > 0) IERC20(token).safeTransfer(frostyPayee, toFrosty);
		if (toBoss > 0) IERC20(token).safeTransfer(bossPayee, toBoss);
		emit Split(token, amount, toFrosty, toBoss, frostyPaidUsd, source);
	}
}
