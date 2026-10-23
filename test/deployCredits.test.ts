import hre, { ethers, network } from 'hardhat';
import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Signer } from 'ethers';
import { deployAndRecord, type DeploymentRecord } from '../scripts/lib/deployAndRecord';
import { DEPLOY_GAS_LIMITS } from '../scripts/lib/deployKalyBot';
import {
	CREDIT_PACK_PRICES_USD, CREDITS_CHECKOUT_GAS_LIMITS, CREDITS_DEPLOY_GAS_LIMITS, deployCreditsAndRecord, expectedPrices, verifyPrices,
} from '../scripts/lib/deployCredits';

use(chaiAsPromised);

/** solidity-coverage sets this flag; instrumented bytecode needs far more gas than the real limits. */
const COVERAGE = (hre as unknown as { __SOLIDITY_COVERAGE_RUNNING?: boolean }).__SOLIDITY_COVERAGE_RUNNING === true;
const coverageSplitterLimits = Object.fromEntries(
	Object.entries(DEPLOY_GAS_LIMITS).map(([k, v]) => [k, v * 3n]),
) as typeof DEPLOY_GAS_LIMITS;
const creditsGasLimits = COVERAGE
	? { deploy: CREDITS_DEPLOY_GAS_LIMITS.deploy * 3n, setPrice: CREDITS_DEPLOY_GAS_LIMITS.setPrice * 3n }
	: undefined;

async function deployBase(): Promise<{ deployer: Signer; recordFile: string; record: DeploymentRecord; usdt: Awaited<ReturnType<typeof mintable>>; kusd: Awaited<ReturnType<typeof mintable>>; payer: Signer }> {
	const [deployer, frosty, boss, payer] = await ethers.getSigners();
	const usdt = await mintable('Tether', 'USDT', 6);
	const kusd = await mintable('KUSD Stablecoin', 'KUSD', 18);
	const tokens = [
		{ address: await usdt.getAddress(), symbol: 'USDT', decimals: 6 },
		{ address: await kusd.getAddress(), symbol: 'KUSD', decimals: 18 },
	];
	const recordFile = join(mkdtempSync(join(tmpdir(), 'kalybot-credits-')), 'kalychain.json');
	const record = await deployAndRecord({
		deployer, frostyPayee: frosty.address, bossPayee: boss.address, outFile: recordFile, chainId: 3890, tokens,
		gasLimits: COVERAGE ? coverageSplitterLimits : undefined,
	});
	return { deployer, recordFile, record, usdt, kusd, payer };
}

async function mintable(name: string, symbol: string, decimals: number) {
	return (await ethers.getContractFactory('MockERC20')).deploy(name, symbol, decimals);
}

const readRecord = (file: string): DeploymentRecord => JSON.parse(readFileSync(file, 'utf-8')) as DeploymentRecord;

describe('deployCreditsAndRecord', () => {
	it('deploys from the owner wallet against the recorded splitter and records address, tx and block', async () => {
		const { deployer, recordFile, record } = await deployBase();

		const result = await deployCreditsAndRecord({ deployer, recordFile, gasLimits: creditsGasLimits });

		const saved = readRecord(recordFile);
		expect(saved).to.deep.equal(JSON.parse(JSON.stringify(result)));
		const credits = await ethers.getContractAt('KalyBotCredits', saved.credits!.address);
		expect(await ethers.provider.getCode(saved.credits!.address)).to.not.equal('0x');
		expect(await credits.owner()).to.equal(await deployer.getAddress());
		expect(await credits.splitter()).to.equal(record.splitter!.address);
		expect(saved.credits!.blockNumber).to.be.a('number');
		expect(saved.credits!.txHash).to.match(/^0x[0-9a-f]{64}$/);
		expect(saved.checkoutGasLimits.buyCredits).to.equal(CREDITS_CHECKOUT_GAS_LIMITS.buyCredits.toString());
		expect(saved.checkoutGasLimits.approve).to.equal('71000');
		expect(saved.splitter).to.deep.equal(record.splitter);
	});

	it('writes the credits entry as soon as the deploy tx is sent', async () => {
		const { deployer, recordFile } = await deployBase();
		await network.provider.send('evm_setAutomine', [false]);
		try {
			const pending = deployCreditsAndRecord({ deployer, recordFile, gasLimits: creditsGasLimits });
			let sent: DeploymentRecord['credits'];
			for (let i = 0; i < 100 && !sent; i++) {
				await new Promise((resolve) => setTimeout(resolve, 20));
				sent = readRecord(recordFile).credits;
			}
			expect(sent, 'credits entry written while the tx is unmined').to.not.equal(undefined);
			expect(sent!.blockNumber).to.equal(null);
			expect(await ethers.provider.getCode(sent!.address)).to.equal('0x');
			await network.provider.send('evm_mine');
			await network.provider.send('evm_setAutomine', [true]); // the price transactions follow the deploy
			const done = await pending;
			expect(done.credits!.blockNumber).to.be.a('number');
			expect(done.credits!.address).to.equal(sent!.address);
			expect(done.credits!.txHash).to.equal(sent!.txHash);
		} finally {
			await network.provider.send('evm_setAutomine', [true]);
		}
	});

	it('refuses when the record already has credits, before sending anything', async () => {
		const { deployer, recordFile } = await deployBase();
		await deployCreditsAndRecord({ deployer, recordFile, gasLimits: creditsGasLimits });
		const nonce = await deployer.getNonce();
		const before = readFileSync(recordFile, 'utf-8');

		await expect(deployCreditsAndRecord({ deployer, recordFile, gasLimits: creditsGasLimits })).to.be.rejectedWith(/already has a credits contract/);

		expect(await deployer.getNonce()).to.equal(nonce);
		expect(readFileSync(recordFile, 'utf-8')).to.equal(before);
	});

	it('refuses a deployer that is not the recorded owner', async () => {
		const { recordFile } = await deployBase();
		const [, , , stranger] = await ethers.getSigners();
		const nonce = await stranger.getNonce();

		await expect(deployCreditsAndRecord({ deployer: stranger, recordFile, gasLimits: creditsGasLimits })).to.be.rejectedWith(/is not the recorded owner/);

		expect(await stranger.getNonce()).to.equal(nonce);
		expect(readRecord(recordFile).credits).to.equal(undefined);
	});

	it('refuses a record that is not a configured deployment', async () => {
		const { deployer, recordFile } = await deployBase();
		writeFileSync(recordFile, JSON.stringify({ ...readRecord(recordFile), status: 'deploying' }));
		const nonce = await deployer.getNonce();

		await expect(deployCreditsAndRecord({ deployer, recordFile, gasLimits: creditsGasLimits })).to.be.rejectedWith(/not a configured deployment/);
		expect(await deployer.getNonce()).to.equal(nonce);
	});

	it('refuses when the splitter does not accept a recorded token', async () => {
		const { deployer, recordFile, record } = await deployBase();
		const splitter = await ethers.getContractAt('KalyBotSplitter', record.splitter!.address);
		await splitter.removeToken(record.tokens[1].address);
		const nonce = await deployer.getNonce();

		await expect(deployCreditsAndRecord({ deployer, recordFile, gasLimits: creditsGasLimits })).to.be.rejectedWith(/does not accept KUSD/);

		expect(await deployer.getNonce()).to.equal(nonce);
		expect(readRecord(recordFile).credits).to.equal(undefined);
	});

	it('sets all six prices and refuses to finish if any is unset or wrong', async () => {
		const { deployer, recordFile, record: base, usdt, kusd } = await deployBase();

		const record = await deployCreditsAndRecord({ deployer, recordFile, gasLimits: creditsGasLimits });

		const credits = await ethers.getContractAt('KalyBotCredits', record.credits!.address);
		const [usdtAddress, kusdAddress] = [await usdt.getAddress(), await kusd.getAddress()];
		const wanted: [number, string, bigint][] = [
			[1, usdtAddress, 5_000_000n], [2, usdtAddress, 10_000_000n], [3, usdtAddress, 25_000_000n],
			[1, kusdAddress, 5n * 10n ** 18n], [2, kusdAddress, 10n * 10n ** 18n], [3, kusdAddress, 25n * 10n ** 18n],
		];
		for (const [pack, token, price] of wanted) expect(await credits.prices(pack, token)).to.equal(price);
		expect(CREDIT_PACK_PRICES_USD).to.deep.equal({ 1: 5, 2: 10, 3: 25 });
		const saved = readRecord(recordFile);
		expect(saved.credits!.prices).to.deep.equal(wanted.map(([packId, token, price]) => ({ packId, token, price: price.toString() })));
		expect(saved.credits!.prices).to.deep.equal(expectedPrices(base.tokens));

		await credits.setPrice(2, usdtAddress, 9_000_000n);
		await expect(verifyPrices(credits, expectedPrices(base.tokens))).to.be.rejectedWith(/Price for pack 2 .* is 9000000, expected 10000000/);
		await credits.setPrice(2, usdtAddress, 0n);
		await expect(verifyPrices(credits, expectedPrices(base.tokens))).to.be.rejectedWith(/Price for pack 2 .* is 0, expected 10000000/);
	});

	it('every setPrice carries an explicit gas limit that covers real use and is at most 2x it', async function () {
		if (COVERAGE) this.skip();
		const { deployer, recordFile } = await deployBase();

		const record = await deployCreditsAndRecord({ deployer, recordFile });

		const credits = await ethers.getContractAt('KalyBotCredits', record.credits!.address);
		const events = await credits.queryFilter(credits.filters.PriceSet());
		expect(events.length).to.equal(6);
		let heaviest = 0n;
		for (const event of events) {
			const tx = (await event.getTransaction())!;
			const receipt = (await event.getTransactionReceipt())!;
			expect(tx.gasLimit).to.equal(CREDITS_DEPLOY_GAS_LIMITS.setPrice);
			expect(receipt.gasUsed <= CREDITS_DEPLOY_GAS_LIMITS.setPrice, `usage ${receipt.gasUsed}`).to.equal(true);
			if (receipt.gasUsed > heaviest) heaviest = receipt.gasUsed;
		}
		expect(CREDITS_DEPLOY_GAS_LIMITS.setPrice <= 2n * heaviest, `limit ${CREDITS_DEPLOY_GAS_LIMITS.setPrice} vs heaviest ${heaviest}`).to.equal(true);
		console.log(`      credits setPrice gas used (first per token, heaviest): ${heaviest}`);
	});

	it('the deploy gas limit covers real usage and is at most 2x it', async function () {
		if (COVERAGE) this.skip();
		const { deployer, recordFile } = await deployBase();

		const record = await deployCreditsAndRecord({ deployer, recordFile });

		const { deploy } = CREDITS_DEPLOY_GAS_LIMITS;
		const tx = (await ethers.provider.getTransaction(record.credits!.txHash))!;
		const receipt = (await ethers.provider.getTransactionReceipt(record.credits!.txHash))!;
		expect(tx.gasLimit).to.equal(deploy);
		expect(receipt.gasUsed <= deploy, `usage ${receipt.gasUsed}`).to.equal(true);
		expect(deploy <= 2n * receipt.gasUsed, `limit ${deploy} vs usage ${receipt.gasUsed}`).to.equal(true);
		console.log(`      credits deploy gas used: ${receipt.gasUsed}`);
	});

	it('the buyCredits fallback covers a buy and is at most 2x its estimate', async function () {
		if (COVERAGE) this.skip();
		const { deployer, recordFile, usdt, payer } = await deployBase();
		const record = await deployCreditsAndRecord({ deployer, recordFile });
		const credits = await ethers.getContractAt('KalyBotCredits', record.credits!.address);
		const token = await usdt.getAddress();
		await usdt.mint(await payer.getAddress(), 100n * 10n ** 6n);
		await usdt.connect(payer).approve(record.credits!.address, ethers.MaxUint256);
		const { buyCredits } = CREDITS_CHECKOUT_GAS_LIMITS;

		const estimate = await credits.connect(payer).buyCredits.estimateGas(ethers.id('instance:a'), 3, token, ethers.id('order:1'));
		const first = await (await credits.connect(payer).buyCredits(ethers.id('instance:a'), 3, token, ethers.id('order:1'), { gasLimit: buyCredits })).wait();

		expect(first!.status).to.equal(1);
		expect(estimate <= buyCredits, `estimate ${estimate}`).to.equal(true);
		expect(buyCredits <= 2n * estimate, `limit ${buyCredits} vs estimate ${estimate}`).to.equal(true);
		console.log(`      buyCredits estimate: ${estimate}, used ${first!.gasUsed}`);
	});
});
