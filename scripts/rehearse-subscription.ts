/**
 * Rehearsal of the subscription redeploy on a local fork of KalyChain 3890 (KALYCHAIN_FORK=1). Nothing
 * is sent to the real chain. It runs redeploySubscriptionAndRecord on a temp copy of
 * deployments/kalychain.json, impersonating the owner wallet, then checks the sixteen plan prices and
 * pays Starter monthly in each stablecoin through the new contract against the LIVE splitter, with
 * real token holders as payers.
 *
 *   KALYCHAIN_FORK=1 DEPLOYER_ADDRESS=0x… npx hardhat run scripts/rehearse-subscription.ts
 */
import { ethers, network } from 'hardhat';
import { impersonateAccount, mine, setBalance } from '@nomicfoundation/hardhat-network-helpers';
import { copyFileSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TokenSpec } from './lib/deployAndRecord';
import { CHECKOUT_GAS_LIMITS, PLAN_PRICES_USD } from './lib/deployKalyBot';
import { expectedPlanPrices, redeploySubscriptionAndRecord } from './lib/redeploySubscription';

const RECORD_FILE = 'deployments/kalychain.json';
const MAINNET_GAS_PRICE = 21_000_000_000n;
/** How far back to look for a wallet holding enough of each stablecoin to pay. */
const HOLDER_SCAN_BLOCKS = 50_000;
const STARTER = 1;
const MONTHLY = 0;
const STARTER_MONTHLY_USD = BigInt(PLAN_PRICES_USD[STARTER][MONTHLY]);
const FROSTY_BPS = 6000n;
const MONTH_SECONDS = 30n * 24n * 60n * 60n;

function requireAddress(name: string): string {
	const value = process.env[name];
	if (!value || !ethers.isAddress(value)) throw new Error(`${name} must be set to a valid address`);
	return ethers.getAddress(value);
}

function check(ok: boolean, what: string): void {
	if (!ok) throw new Error(`FAIL: ${what}`);
	console.log(`ok   ${what}`);
}

/** A recent recipient of `token` (not one of `exclude`) that still holds at least `amount`, or null. */
async function findHolder(token: TokenSpec, amount: bigint, forkBlock: number, exclude: string[]): Promise<string | null> {
	const erc20 = await ethers.getContractAt('IERC20Metadata', token.address);
	const transfers = await erc20.queryFilter(erc20.filters.Transfer(), Math.max(0, forkBlock - HOLDER_SCAN_BLOCKS), forkBlock);
	const skip = new Set(exclude.map((a) => a.toLowerCase()));
	const recipients = [...new Set(transfers.map((t) => t.args.to))].filter((a) => !skip.has(a.toLowerCase()));
	let best: { who: string; balance: bigint } | null = null;
	for (const who of recipients) {
		const balance = await erc20.balanceOf(who);
		if (balance >= amount && (!best || balance > best.balance)) best = { who, balance };
	}
	return best?.who ?? null;
}

async function rehearsePayment(subscriptionAddress: string, splitterAddress: string, token: TokenSpec, forkBlock: number): Promise<void> {
	const subscription = await ethers.getContractAt('KalyBotSubscription', subscriptionAddress);
	const splitter = await ethers.getContractAt('KalyBotSplitter', splitterAddress);
	const erc20 = await ethers.getContractAt('IERC20Metadata', token.address);
	const [frostyPayee, bossPayee] = await Promise.all([splitter.frostyPayee(), splitter.bossPayee()]);
	const amount = STARTER_MONTHLY_USD * 10n ** BigInt(token.decimals);
	const holder = await findHolder(token, amount, forkBlock, [frostyPayee, bossPayee, splitterAddress, subscriptionAddress]);
	if (!holder) {
		throw new Error(`FAIL: no wallet holding ${ethers.formatUnits(amount, token.decimals)} ${token.symbol} received it in the last ${HOLDER_SCAN_BLOCKS} blocks, so the ${token.symbol} payment was not rehearsed`);
	}
	await impersonateAccount(holder);
	await setBalance(holder, 10n ** 18n); // fork-only gas money for the borrowed wallet
	const payer = await ethers.getSigner(holder);

	const scale = await splitter.usdScale(token.address);
	const [frostyBefore, bossBefore, paidBefore, cap] = await Promise.all([
		erc20.balanceOf(frostyPayee), erc20.balanceOf(bossPayee), splitter.frostyPaidUsd(), splitter.frostyCapUsd(),
	]);
	const room = cap - paidBefore;
	const wantFrostyUsd = (amount * scale * FROSTY_BPS) / 10_000n;
	const expectedFrostyUsd = wantFrostyUsd < room ? wantFrostyUsd : room;
	const expectedToFrosty = expectedFrostyUsd / scale;

	const instanceId = ethers.id(`rehearsal:${token.symbol}`);
	const orderRef = ethers.id(`rehearsal-order:${token.symbol}`);
	await (await erc20.connect(payer).approve(subscriptionAddress, amount)).wait();
	const receipt = (await (await subscription.connect(payer).subscribeFor(instanceId, STARTER, MONTHLY, token.address, orderRef, { gasLimit: CHECKOUT_GAS_LIMITS.subscribeFor })).wait())!;
	const event = receipt.logs.map((log) => subscription.interface.parseLog(log)).find((e) => e?.name === 'Subscribed');
	check(
		event?.args.orderRef === orderRef && event?.args.tier === BigInt(STARTER) && event?.args.period === BigInt(MONTHLY) && event?.args.amount === amount && event?.args.instanceId === instanceId && event?.args.payer === holder && event?.args.token === token.address,
		`${token.symbol} payment emits Subscribed for the order (${ethers.formatUnits(amount, token.decimals)} ${token.symbol}, gas ${receipt.gasUsed})`,
	);
	check(receipt.gasUsed <= CHECKOUT_GAS_LIMITS.subscribeFor, `${token.symbol} payment fits the ${CHECKOUT_GAS_LIMITS.subscribeFor} gas limit`);

	const [frostyAfter, bossAfter, paidAfter] = await Promise.all([erc20.balanceOf(frostyPayee), erc20.balanceOf(bossPayee), splitter.frostyPaidUsd()]);
	check(frostyAfter - frostyBefore === expectedToFrosty, `Frosty payee received ${ethers.formatUnits(expectedToFrosty, token.decimals)} ${token.symbol}`);
	check(bossAfter - bossBefore === amount - expectedToFrosty, `boss payee received ${ethers.formatUnits(amount - expectedToFrosty, token.decimals)} ${token.symbol}`);
	check(paidAfter - paidBefore === expectedFrostyUsd, `frostyPaidUsd rose by $${ethers.formatEther(expectedFrostyUsd)} (min of 60% and the cap room left)`);
	check((await erc20.balanceOf(subscriptionAddress)) === 0n, `subscription contract holds no ${token.symbol}`);
	const [tier, expiry, active] = await subscription.getSubscription(instanceId);
	const now = BigInt((await ethers.provider.getBlock('latest'))!.timestamp);
	check(tier === BigInt(STARTER) && active && expiry === now + MONTH_SECONDS, `${token.symbol} payment leaves the instance on Starter for 30 days`);
	check((await subscription.orderPaid(orderRef, instanceId, STARTER, MONTHLY)) && !(await subscription.orderPaid(orderRef, ethers.id('rehearsal:other'), STARTER, MONTHLY)) && (await subscription.splitterApproved(token.address)), `${token.symbol} order bound to its instance and splitter approved`);
}

async function main(): Promise<void> {
	if (network.name !== 'hardhat' || process.env.KALYCHAIN_FORK !== '1') throw new Error('Run with KALYCHAIN_FORK=1 on the in-process hardhat network');
	const deployerAddress = requireAddress('DEPLOYER_ADDRESS');
	const forkBlock = await ethers.provider.getBlockNumber();
	console.log(`Forked KalyChain 3890 at block ${forkBlock}. Nothing here touches the real chain.`);
	// Hardhat can't execute calls on the fork block of an unknown chain; one local block makes every call local.
	await mine();

	await impersonateAccount(deployerAddress);
	const deployer = await ethers.getSigner(deployerAddress);
	const kmtBefore = await ethers.provider.getBalance(deployerAddress);
	const recordFile = join(mkdtempSync(join(tmpdir(), 'kalybot-subscription-rehearsal-')), 'kalychain.json');
	copyFileSync(RECORD_FILE, recordFile);

	const record = await redeploySubscriptionAndRecord({ deployer, recordFile });
	const subscription = await ethers.getContractAt('KalyBotSubscription', record.subscription!.address);
	const receipt = (await ethers.provider.getTransactionReceipt(record.subscription!.txHash))!;
	const priceReceipts = await Promise.all((await subscription.queryFilter(subscription.filters.PriceSet())).map((e) => e.getTransactionReceipt()));
	const deployGas = priceReceipts.reduce((sum, r) => sum + r.gasUsed, receipt.gasUsed);
	check((await subscription.owner()) === deployerAddress, `${deployerAddress} owns the new subscription contract`);
	check((await subscription.pendingOwner()) === ethers.ZeroAddress, 'no ownership handover pending');
	check((await subscription.splitter()) === record.splitter!.address, `subscription pays into the live splitter ${record.splitter!.address}`);
	check(!(await subscription.paused()), 'subscription contract is not paused');
	const expected = expectedPlanPrices(record.tokens);
	for (const { tier, period, token, price } of expected) {
		check((await subscription.prices(tier, period, token)).toString() === price, `tier ${tier} period ${period} costs ${price} units of ${token}`);
	}
	check(JSON.stringify(record.subscription!.prices) === JSON.stringify(expected), 'record lists the sixteen verified prices');
	const live = JSON.parse(readFileSync(RECORD_FILE, 'utf-8')) as { subscription: unknown };
	check(JSON.stringify(record.subscriptionPrevious) === JSON.stringify(live.subscription), 'record keeps the live subscription as subscriptionPrevious');
	const cost = deployGas * MAINNET_GAS_PRICE;
	check(kmtBefore >= cost, `deployer holds enough KMT (${ethers.formatEther(kmtBefore)} KMT)`);

	for (const token of record.tokens) await rehearsePayment(record.subscription!.address, record.splitter!.address, token, forkBlock);
	console.log(`Redeploy: ${1 + priceReceipts.length} transactions (contract + prices), ${deployGas} gas, about ${ethers.formatEther(cost)} KMT at 21 gwei.`);
	console.log('REHEARSAL PASSED');
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
