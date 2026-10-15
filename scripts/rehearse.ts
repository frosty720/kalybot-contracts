/**
 * Mainnet rehearsal on a local fork of KalyChain 3890 (KALYCHAIN_FORK=1). Nothing is sent to the
 * real chain. It runs the same deployAndRecord as scripts/deploy.ts, impersonating the wallet that
 * will deploy, then checks every setting and makes one real-token payment per stablecoin.
 *
 *   KALYCHAIN_FORK=1 DEPLOYER_ADDRESS=0x… FROSTY_PAYEE=0x… BOSS_PAYEE=0x… npx hardhat run scripts/rehearse.ts
 */
import { ethers, network } from 'hardhat';
import { impersonateAccount, mine, setBalance } from '@nomicfoundation/hardhat-network-helpers';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { deployAndRecord, KALYCHAIN_TOKENS, type DeploymentRecord, type TokenSpec } from './lib/deployAndRecord';
import { FROSTY_BPS, FROSTY_CAP_USD, PLAN_PRICES_USD } from './lib/deployKalyBot';

const MAINNET_GAS_PRICE = 21_000_000_000n;
/** How far back to look for a wallet holding enough of each stablecoin to pay. */
const HOLDER_SCAN_BLOCKS = 50_000;
const STARTER = 1;
const MONTHLY = 0;

function requireAddress(name: string): string {
	const value = process.env[name];
	if (!value || !ethers.isAddress(value)) throw new Error(`${name} must be set to a valid address`);
	return ethers.getAddress(value);
}

function check(ok: boolean, what: string): void {
	if (!ok) throw new Error(`FAIL: ${what}`);
	console.log(`ok   ${what}`);
}

/** The deployer's transactions between two blocks, with their gas used. */
async function deployerGas(deployer: string, fromBlock: number, toBlock: number): Promise<{ txs: number; gas: bigint }> {
	let txs = 0;
	let gas = 0n;
	for (let n = fromBlock; n <= toBlock; n++) {
		const block = (await ethers.provider.getBlock(n, true))!;
		for (const tx of block.prefetchedTransactions) {
			if (tx.from.toLowerCase() !== deployer.toLowerCase()) continue;
			txs++;
			gas += (await ethers.provider.getTransactionReceipt(tx.hash))!.gasUsed;
		}
	}
	return { txs, gas };
}

/** A recent recipient of `token` that still holds at least `amount`, or null. */
async function findHolder(token: TokenSpec, amount: bigint, forkBlock: number): Promise<string | null> {
	const erc20 = await ethers.getContractAt('IERC20Metadata', token.address);
	const transfers = await erc20.queryFilter(erc20.filters.Transfer(), Math.max(0, forkBlock - HOLDER_SCAN_BLOCKS), forkBlock);
	const recipients = [...new Set(transfers.map((t) => t.args.to))];
	let best: { who: string; balance: bigint } | null = null;
	for (const who of recipients) {
		const balance = await erc20.balanceOf(who);
		if (balance >= amount && (!best || balance > best.balance)) best = { who, balance };
	}
	return best?.who ?? null;
}

async function verifyConfiguration(record: DeploymentRecord, deployer: string, frostyPayee: string, bossPayee: string): Promise<void> {
	const splitter = await ethers.getContractAt('KalyBotSplitter', record.splitter!.address);
	const subscription = await ethers.getContractAt('KalyBotSubscription', record.subscription!.address);
	check(record.status === 'configured', 'deployment record says configured');
	check((await splitter.owner()) === deployer && (await subscription.owner()) === deployer, `${deployer} owns both contracts`);
	check((await splitter.pendingOwner()) === ethers.ZeroAddress && (await subscription.pendingOwner()) === ethers.ZeroAddress, 'no ownership handover pending');
	check((await subscription.splitter()) === record.splitter!.address, 'subscription pays into the splitter');
	check((await splitter.frostyPayee()) === frostyPayee, `Frosty payee is ${frostyPayee}`);
	check((await splitter.bossPayee()) === bossPayee, `boss payee is ${bossPayee}`);
	check((await splitter.frostyBps()) === BigInt(FROSTY_BPS), 'split is 60% Frosty / 40% boss');
	check((await splitter.frostyCapUsd()) === FROSTY_CAP_USD, 'Frosty cap is $5,000');
	for (const token of KALYCHAIN_TOKENS) {
		const unit = 10n ** BigInt(token.decimals);
		check((await splitter.usdScale(token.address)) === 10n ** BigInt(18 - token.decimals), `${token.symbol} accepted by the splitter`);
		for (const [tier, [monthly, annual]] of Object.entries(PLAN_PRICES_USD)) {
			const [m, a] = await Promise.all([
				subscription.prices(Number(tier), 0, token.address),
				subscription.prices(Number(tier), 1, token.address),
			]);
			check(m === BigInt(monthly) * unit && a === BigInt(annual) * unit, `tier ${tier} ${token.symbol}: $${monthly}/month, $${annual}/year`);
		}
	}
}

async function rehearsePayment(record: DeploymentRecord, token: TokenSpec, frostyPayee: string, bossPayee: string, forkBlock: number): Promise<void> {
	const subscription = await ethers.getContractAt('KalyBotSubscription', record.subscription!.address);
	const erc20 = await ethers.getContractAt('IERC20Metadata', token.address);
	const price = await subscription.prices(STARTER, MONTHLY, token.address);
	const holder = await findHolder(token, price, forkBlock);
	if (!holder) {
		console.log(`SKIP ${token.symbol} payment: no wallet holding ${ethers.formatUnits(price, token.decimals)} ${token.symbol} received it in the last ${HOLDER_SCAN_BLOCKS} blocks`);
		return;
	}
	await impersonateAccount(holder);
	await setBalance(holder, 10n ** 18n); // fork-only gas money for the borrowed wallet
	const payer = await ethers.getSigner(holder);
	const [frostyBefore, bossBefore] = await Promise.all([erc20.balanceOf(frostyPayee), erc20.balanceOf(bossPayee)]);
	const instanceId = ethers.id(`rehearsal:${token.symbol}`);
	const orderRef = ethers.id(`rehearsal-order:${token.symbol}`);
	await (await erc20.connect(payer).approve(record.subscription!.address, price)).wait();
	const receipt = (await (await subscription.connect(payer).subscribeFor(instanceId, STARTER, MONTHLY, token.address, orderRef)).wait())!;
	const event = receipt.logs.map((log) => subscription.interface.parseLog(log)).find((e) => e?.name === 'Subscribed');
	check(event?.args.orderRef === orderRef && event?.args.amount === price && event?.args.instanceId === instanceId, `${token.symbol} payment emits Subscribed for the order (${ethers.formatUnits(price, token.decimals)} ${token.symbol})`);
	const [frostyAfter, bossAfter] = await Promise.all([erc20.balanceOf(frostyPayee), erc20.balanceOf(bossPayee)]);
	const toFrosty = (price * BigInt(FROSTY_BPS)) / 10_000n;
	check(frostyAfter - frostyBefore === toFrosty, `Frosty received ${ethers.formatUnits(toFrosty, token.decimals)} ${token.symbol}`);
	check(bossAfter - bossBefore === price - toFrosty, `boss received ${ethers.formatUnits(price - toFrosty, token.decimals)} ${token.symbol}`);
	check((await erc20.allowance(holder, record.subscription!.address)) === 0n, `${token.symbol} approval fully used`);
}

async function main() {
	if (network.name !== 'hardhat' || process.env.KALYCHAIN_FORK !== '1') throw new Error('Run with KALYCHAIN_FORK=1 on the in-process hardhat network');
	const deployerAddress = requireAddress('DEPLOYER_ADDRESS');
	const frostyPayee = requireAddress('FROSTY_PAYEE');
	const bossPayee = requireAddress('BOSS_PAYEE');
	const forkBlock = await ethers.provider.getBlockNumber();
	console.log(`Forked KalyChain 3890 at block ${forkBlock}. Nothing here touches the real chain.`);
	// Hardhat can't execute calls on the fork block of an unknown chain; one local block makes every call local.
	await mine();

	await impersonateAccount(deployerAddress);
	const deployer = await ethers.getSigner(deployerAddress);
	const kmtBefore = await ethers.provider.getBalance(deployerAddress);
	const outFile = join(mkdtempSync(join(tmpdir(), 'kalybot-rehearsal-')), 'kalychain.json');
	const record = await deployAndRecord({ deployer, frostyPayee, bossPayee, outFile, chainId: 3890 });
	const afterDeploy = await ethers.provider.getBlockNumber();
	check(JSON.stringify(JSON.parse(readFileSync(outFile, 'utf-8'))) === JSON.stringify(record), `deployment record written (${outFile})`);

	await verifyConfiguration(record, deployerAddress, frostyPayee, bossPayee);
	for (const token of KALYCHAIN_TOKENS) await rehearsePayment(record, token, frostyPayee, bossPayee, forkBlock);

	const { txs, gas } = await deployerGas(deployerAddress, forkBlock + 2, afterDeploy);
	const cost = gas * MAINNET_GAS_PRICE;
	check(kmtBefore >= cost, `deployer holds enough KMT (${ethers.formatEther(kmtBefore)} KMT)`);
	console.log(`Deploy: ${txs} transactions, ${gas} gas, about ${ethers.formatEther(cost)} KMT at 21 gwei.`);
	console.log('REHEARSAL PASSED');
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
