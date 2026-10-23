import hre, { ethers, network } from 'hardhat';
import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Signer } from 'ethers';
import { deployAndRecord, type DeploymentRecord } from '../scripts/lib/deployAndRecord';
import { DEPLOY_GAS_LIMITS, PLAN_PRICES_USD } from '../scripts/lib/deployKalyBot';
import {
	SUBSCRIPTION_REDEPLOY_GAS_LIMITS, expectedPlanPrices, redeploySubscriptionAndRecord, verifyPlanPrices,
} from '../scripts/lib/redeploySubscription';

use(chaiAsPromised);

/** solidity-coverage sets this flag; instrumented bytecode needs far more gas than the real limits. */
const COVERAGE = (hre as unknown as { __SOLIDITY_COVERAGE_RUNNING?: boolean }).__SOLIDITY_COVERAGE_RUNNING === true;
const coverageSplitterLimits = Object.fromEntries(
	Object.entries(DEPLOY_GAS_LIMITS).map(([k, v]) => [k, v * 3n]),
) as typeof DEPLOY_GAS_LIMITS;
const redeployLimits = COVERAGE
	? { deploy: SUBSCRIPTION_REDEPLOY_GAS_LIMITS.deploy * 3n, setPrice: SUBSCRIPTION_REDEPLOY_GAS_LIMITS.setPrice * 3n }
	: undefined;

async function mintable(name: string, symbol: string, decimals: number) {
	return (await ethers.getContractFactory('MockERC20')).deploy(name, symbol, decimals);
}

async function deployBase(): Promise<{ deployer: Signer; recordFile: string; record: DeploymentRecord; usdt: Awaited<ReturnType<typeof mintable>>; kusd: Awaited<ReturnType<typeof mintable>> }> {
	const [deployer, frosty, boss] = await ethers.getSigners();
	const usdt = await mintable('Tether', 'USDT', 6);
	const kusd = await mintable('KUSD Stablecoin', 'KUSD', 18);
	const tokens = [
		{ address: await usdt.getAddress(), symbol: 'USDT', decimals: 6 },
		{ address: await kusd.getAddress(), symbol: 'KUSD', decimals: 18 },
	];
	const recordFile = join(mkdtempSync(join(tmpdir(), 'kalybot-subscription-')), 'kalychain.json');
	const record = await deployAndRecord({
		deployer, frostyPayee: frosty.address, bossPayee: boss.address, outFile: recordFile, chainId: 3890, tokens,
		gasLimits: COVERAGE ? coverageSplitterLimits : undefined,
	});
	return { deployer, recordFile, record, usdt, kusd };
}

const readRecord = (file: string): DeploymentRecord => JSON.parse(readFileSync(file, 'utf-8')) as DeploymentRecord;

describe('redeploySubscriptionAndRecord', () => {
	it('deploys from the owner wallet against the recorded splitter; records new as subscription and old as subscriptionPrevious', async () => {
		const { deployer, recordFile, record: base } = await deployBase();

		const result = await redeploySubscriptionAndRecord({ deployer, recordFile, gasLimits: redeployLimits });

		const saved = readRecord(recordFile);
		expect(saved).to.deep.equal(JSON.parse(JSON.stringify(result)));
		expect(saved.subscriptionPrevious).to.deep.equal(base.subscription);
		expect(saved.subscription!.address).to.not.equal(base.subscription!.address);
		const sub = await ethers.getContractAt('KalyBotSubscription', saved.subscription!.address);
		expect(await sub.owner()).to.equal(await deployer.getAddress());
		expect(await sub.splitter()).to.equal(base.splitter!.address);
		expect(saved.subscription!.name).to.equal('subscription');
		expect(saved.subscription!.blockNumber).to.be.a('number');
		expect(saved.subscription!.txHash).to.match(/^0x[0-9a-f]{64}$/);
		expect(saved.splitter).to.deep.equal(base.splitter);
		expect(saved.checkoutGasLimits).to.deep.equal(base.checkoutGasLimits);
	});

	it('writes the new subscription entry as soon as the deploy tx is sent', async () => {
		const { deployer, recordFile, record: base } = await deployBase();
		await network.provider.send('evm_setAutomine', [false]);
		try {
			const pending = redeploySubscriptionAndRecord({ deployer, recordFile, gasLimits: redeployLimits });
			let sent: DeploymentRecord['subscription'];
			for (let i = 0; i < 100 && !sent; i++) {
				await new Promise((resolve) => setTimeout(resolve, 20));
				const saved = readRecord(recordFile);
				if (saved.subscriptionPrevious) sent = saved.subscription;
			}
			expect(sent, 'new entry written while the tx is unmined').to.not.equal(undefined);
			expect(sent!.blockNumber).to.equal(null);
			expect(sent!.address).to.not.equal(base.subscription!.address);
			expect(readRecord(recordFile).subscriptionPrevious).to.deep.equal(base.subscription);
			expect(await ethers.provider.getCode(sent!.address)).to.equal('0x');
			await network.provider.send('evm_mine');
			await network.provider.send('evm_setAutomine', [true]); // the price transactions follow the deploy
			const done = await pending;
			expect(done.subscription!.blockNumber).to.be.a('number');
			expect(done.subscription!.address).to.equal(sent!.address);
			expect(done.subscription!.txHash).to.equal(sent!.txHash);
		} finally {
			await network.provider.send('evm_setAutomine', [true]);
		}
	});

	it('refuses a record that already replaced its subscription, before sending anything', async () => {
		const { deployer, recordFile } = await deployBase();
		await redeploySubscriptionAndRecord({ deployer, recordFile, gasLimits: redeployLimits });
		const nonce = await deployer.getNonce();
		const before = readFileSync(recordFile, 'utf-8');

		await expect(redeploySubscriptionAndRecord({ deployer, recordFile, gasLimits: redeployLimits })).to.be.rejectedWith(/already replaced a subscription contract/);

		expect(await deployer.getNonce()).to.equal(nonce);
		expect(readFileSync(recordFile, 'utf-8')).to.equal(before);
	});

	it('refuses a deployer that is not the recorded owner', async () => {
		const { recordFile } = await deployBase();
		const [, , , stranger] = await ethers.getSigners();
		const nonce = await stranger.getNonce();
		const before = readFileSync(recordFile, 'utf-8');

		await expect(redeploySubscriptionAndRecord({ deployer: stranger, recordFile, gasLimits: redeployLimits })).to.be.rejectedWith(/is not the recorded owner/);

		expect(await stranger.getNonce()).to.equal(nonce);
		expect(readFileSync(recordFile, 'utf-8')).to.equal(before);
	});

	it('refuses a record that is not configured, or has no subscription to replace', async () => {
		const { deployer, recordFile } = await deployBase();
		const configured = readRecord(recordFile);
		const nonce = await deployer.getNonce();

		writeFileSync(recordFile, JSON.stringify({ ...configured, status: 'deploying' }));
		await expect(redeploySubscriptionAndRecord({ deployer, recordFile, gasLimits: redeployLimits })).to.be.rejectedWith(/not a configured deployment/);

		writeFileSync(recordFile, JSON.stringify({ ...configured, subscription: undefined }));
		await expect(redeploySubscriptionAndRecord({ deployer, recordFile, gasLimits: redeployLimits })).to.be.rejectedWith(/not a configured deployment/);

		expect(await deployer.getNonce()).to.equal(nonce);
	});

	it('refuses when the splitter does not accept a recorded token', async () => {
		const { deployer, recordFile, record } = await deployBase();
		const splitter = await ethers.getContractAt('KalyBotSplitter', record.splitter!.address);
		await splitter.removeToken(record.tokens[1].address);
		const nonce = await deployer.getNonce();

		await expect(redeploySubscriptionAndRecord({ deployer, recordFile, gasLimits: redeployLimits })).to.be.rejectedWith(/does not accept KUSD/);

		expect(await deployer.getNonce()).to.equal(nonce);
		expect(readRecord(recordFile).subscriptionPrevious).to.equal(undefined);
	});

	it('sets all sixteen prices and refuses to finish if any is unset or wrong', async () => {
		const { deployer, recordFile, record: base, usdt, kusd } = await deployBase();

		const record = await redeploySubscriptionAndRecord({ deployer, recordFile, gasLimits: redeployLimits });

		const sub = await ethers.getContractAt('KalyBotSubscription', record.subscription!.address);
		const expected = expectedPlanPrices(base.tokens);
		expect(expected.length).to.equal(16);
		for (const [token, unit] of [[await usdt.getAddress(), 10n ** 6n], [await kusd.getAddress(), 10n ** 18n]] as [string, bigint][]) {
			for (const [tier, [monthly, annual]] of Object.entries(PLAN_PRICES_USD)) {
				expect(await sub.prices(Number(tier), 0, token)).to.equal(BigInt(monthly) * unit);
				expect(await sub.prices(Number(tier), 1, token)).to.equal(BigInt(annual) * unit);
			}
		}
		expect(readRecord(recordFile).subscription!.prices).to.deep.equal(expected);

		await sub.setPrice(2, 1, await usdt.getAddress(), 9_000_000n);
		await expect(verifyPlanPrices(sub, expected)).to.be.rejectedWith(/Price for tier 2 period 1 .* is 9000000, expected 468000000/);
		await sub.setPrice(2, 1, await usdt.getAddress(), 0n);
		await expect(verifyPlanPrices(sub, expected)).to.be.rejectedWith(/Price for tier 2 period 1 .* is 0, expected 468000000/);
	});

	it('refuses to finish when a price read back is wrong, leaving no recorded prices', async () => {
		const { deployer, recordFile, record } = await deployBase();
		const usdtSpec = record.tokens[0];
		writeFileSync(recordFile, JSON.stringify({ ...record, tokens: [...record.tokens, { ...usdtSpec, decimals: 18 }] }));

		await expect(redeploySubscriptionAndRecord({ deployer, recordFile, gasLimits: redeployLimits })).to.be.rejectedWith(/Price for tier 1 period 0 .* is 19000000000000000000, expected 19000000/);

		const saved = readRecord(recordFile);
		expect(saved.subscription!.prices).to.equal(undefined);
		expect(saved.subscriptionPrevious).to.deep.equal(record.subscription);
	});

	it('every setPrice carries an explicit gas limit that covers real use and is at most 2x it', async function () {
		if (COVERAGE) this.skip();
		const { deployer, recordFile } = await deployBase();

		const record = await redeploySubscriptionAndRecord({ deployer, recordFile });

		const sub = await ethers.getContractAt('KalyBotSubscription', record.subscription!.address);
		const events = await sub.queryFilter(sub.filters.PriceSet());
		expect(events.length).to.equal(16);
		let heaviest = 0n;
		for (const event of events) {
			const tx = (await event.getTransaction())!;
			const receipt = (await event.getTransactionReceipt())!;
			expect(tx.gasLimit).to.equal(SUBSCRIPTION_REDEPLOY_GAS_LIMITS.setPrice);
			expect(receipt.gasUsed <= SUBSCRIPTION_REDEPLOY_GAS_LIMITS.setPrice, `usage ${receipt.gasUsed}`).to.equal(true);
			if (receipt.gasUsed > heaviest) heaviest = receipt.gasUsed;
		}
		expect(SUBSCRIPTION_REDEPLOY_GAS_LIMITS.setPrice <= 2n * heaviest, `limit ${SUBSCRIPTION_REDEPLOY_GAS_LIMITS.setPrice} vs heaviest ${heaviest}`).to.equal(true);
		console.log(`      subscription setPrice gas used (first per token, heaviest): ${heaviest}`);
	});

	it('the deploy gas limit covers real usage and is at most 2x it', async function () {
		if (COVERAGE) this.skip();
		const { deployer, recordFile } = await deployBase();

		const record = await redeploySubscriptionAndRecord({ deployer, recordFile });

		const { deploy } = SUBSCRIPTION_REDEPLOY_GAS_LIMITS;
		const tx = (await ethers.provider.getTransaction(record.subscription!.txHash))!;
		const receipt = (await ethers.provider.getTransactionReceipt(record.subscription!.txHash))!;
		expect(tx.gasLimit).to.equal(deploy);
		expect(receipt.gasUsed <= deploy, `usage ${receipt.gasUsed}`).to.equal(true);
		expect(deploy <= 2n * receipt.gasUsed, `limit ${deploy} vs usage ${receipt.gasUsed}`).to.equal(true);
		console.log(`      subscription deploy gas used: ${receipt.gasUsed}`);
	});
});
