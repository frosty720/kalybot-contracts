/**
 * Rehearsal of the credits deploy on a local fork of KalyChain 3890 (KALYCHAIN_FORK=1). Nothing is
 * sent to the real chain. It runs deployCreditsAndRecord on a temp copy of deployments/kalychain.json,
 * impersonating the owner wallet, then buys $5 of each stablecoin through the new contract against
 * the LIVE splitter, with real token holders as payers.
 *
 *   KALYCHAIN_FORK=1 DEPLOYER_ADDRESS=0x… npx hardhat run scripts/rehearse-credits.ts
 */
import { ethers, network } from 'hardhat';
import { impersonateAccount, mine, setBalance } from '@nomicfoundation/hardhat-network-helpers';
import { copyFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TokenSpec } from './lib/deployAndRecord';
import { CREDITS_CHECKOUT_GAS_LIMITS, deployCreditsAndRecord } from './lib/deployCredits';

const RECORD_FILE = 'deployments/kalychain.json';
const MAINNET_GAS_PRICE = 21_000_000_000n;
/** How far back to look for a wallet holding enough of each stablecoin to pay. */
const HOLDER_SCAN_BLOCKS = 50_000;
const PACK_USD = 5n;
const FROSTY_BPS = 6000n;

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

async function rehearseBuy(creditsAddress: string, splitterAddress: string, token: TokenSpec, forkBlock: number): Promise<void> {
	const credits = await ethers.getContractAt('KalyBotCredits', creditsAddress);
	const splitter = await ethers.getContractAt('KalyBotSplitter', splitterAddress);
	const erc20 = await ethers.getContractAt('IERC20Metadata', token.address);
	const [frostyPayee, bossPayee] = await Promise.all([splitter.frostyPayee(), splitter.bossPayee()]);
	const amount = PACK_USD * 10n ** BigInt(token.decimals);
	const holder = await findHolder(token, amount, forkBlock, [frostyPayee, bossPayee, splitterAddress, creditsAddress]);
	if (!holder) {
		console.log(`SKIP ${token.symbol} buy: no wallet holding ${ethers.formatUnits(amount, token.decimals)} ${token.symbol} received it in the last ${HOLDER_SCAN_BLOCKS} blocks`);
		return;
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
	await (await erc20.connect(payer).approve(creditsAddress, amount)).wait();
	const receipt = (await (await credits.connect(payer).buyCredits(instanceId, token.address, amount, orderRef, { gasLimit: CREDITS_CHECKOUT_GAS_LIMITS.buyCredits })).wait())!;
	const event = receipt.logs.map((log) => credits.interface.parseLog(log)).find((e) => e?.name === 'CreditsBought');
	check(
		event?.args.orderRef === orderRef && event?.args.amount === amount && event?.args.instanceId === instanceId && event?.args.payer === holder && event?.args.token === token.address,
		`${token.symbol} buy emits CreditsBought for the order (${ethers.formatUnits(amount, token.decimals)} ${token.symbol}, gas ${receipt.gasUsed})`,
	);
	check(receipt.gasUsed <= CREDITS_CHECKOUT_GAS_LIMITS.buyCredits, `${token.symbol} first buy fits the ${CREDITS_CHECKOUT_GAS_LIMITS.buyCredits} gas fallback`);

	const [frostyAfter, bossAfter, paidAfter] = await Promise.all([erc20.balanceOf(frostyPayee), erc20.balanceOf(bossPayee), splitter.frostyPaidUsd()]);
	check(frostyAfter - frostyBefore === expectedToFrosty, `Frosty payee received ${ethers.formatUnits(expectedToFrosty, token.decimals)} ${token.symbol}`);
	check(bossAfter - bossBefore === amount - expectedToFrosty, `boss payee received ${ethers.formatUnits(amount - expectedToFrosty, token.decimals)} ${token.symbol}`);
	check(paidAfter - paidBefore === expectedFrostyUsd, `frostyPaidUsd rose by $${ethers.formatEther(expectedFrostyUsd)} (min of $3 and the cap room left)`);
	check((await erc20.balanceOf(creditsAddress)) === 0n, `credits contract holds no ${token.symbol}`);
	check((await credits.usedOrderRef(orderRef)) && (await credits.splitterApproved(token.address)), `${token.symbol} order marked used and splitter approved`);
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
	const recordFile = join(mkdtempSync(join(tmpdir(), 'kalybot-credits-rehearsal-')), 'kalychain.json');
	copyFileSync(RECORD_FILE, recordFile);

	const record = await deployCreditsAndRecord({ deployer, recordFile });
	const credits = await ethers.getContractAt('KalyBotCredits', record.credits!.address);
	const receipt = (await ethers.provider.getTransactionReceipt(record.credits!.txHash))!;
	check((await credits.owner()) === deployerAddress, `${deployerAddress} owns the credits contract`);
	check((await credits.pendingOwner()) === ethers.ZeroAddress, 'no ownership handover pending');
	check((await credits.splitter()) === record.splitter!.address, `credits pays into the live splitter ${record.splitter!.address}`);
	check(!(await credits.paused()), 'credits contract is not paused');
	check(record.checkoutGasLimits.buyCredits === CREDITS_CHECKOUT_GAS_LIMITS.buyCredits.toString(), 'record carries the buyCredits gas fallback');
	const cost = receipt.gasUsed * MAINNET_GAS_PRICE;
	check(kmtBefore >= cost, `deployer holds enough KMT (${ethers.formatEther(kmtBefore)} KMT)`);

	for (const token of record.tokens) await rehearseBuy(record.credits!.address, record.splitter!.address, token, forkBlock);
	console.log(`Deploy: 1 transaction, ${receipt.gasUsed} gas, about ${ethers.formatEther(cost)} KMT at 21 gwei.`);
	console.log('REHEARSAL PASSED');
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
