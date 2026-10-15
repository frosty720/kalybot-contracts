import hre, { ethers } from 'hardhat';
import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import {
	CHECKOUT_GAS_LIMITS,
	DEPLOY_GAS_LIMITS,
	deployKalyBot,
	PLAN_PRICES_USD,
	type DeployedContract,
} from '../scripts/lib/deployKalyBot';

use(chaiAsPromised);

/** solidity-coverage sets this flag; instrumented bytecode needs far more gas than the real limits. */
const COVERAGE = (hre as unknown as { __SOLIDITY_COVERAGE_RUNNING?: boolean }).__SOLIDITY_COVERAGE_RUNNING === true;
const COVERAGE_GAS_LIMITS = Object.fromEntries(
	Object.entries(DEPLOY_GAS_LIMITS).map(([kind, limit]) => [kind, limit * 3n]),
) as typeof DEPLOY_GAS_LIMITS;
const gasLimits = COVERAGE ? COVERAGE_GAS_LIMITS : undefined;

const PRO = 2;
const ENTERPRISE = 4;
const MONTHLY = 0;

async function mockTokens() {
	const Mock = await ethers.getContractFactory('MockERC20');
	const usdt = await Mock.deploy('Tether', 'USDT', 6);
	const kusd = await Mock.deploy('KUSD Stablecoin', 'KUSD', 18);
	return {
		usdt,
		kusd,
		tokens: [
			{ address: await usdt.getAddress(), decimals: 6 },
			{ address: await kusd.getAddress(), decimals: 18 },
		],
	};
}

describe('deployKalyBot', () => {
	it('deploys, wires the token allowlist, sets every price and leaves the deploying wallet as owner', async () => {
		const [deployer, frosty, boss] = await ethers.getSigners();
		const { tokens } = await mockTokens();
		const deployed: DeployedContract[] = [];

		const { splitter, subscription } = await deployKalyBot({
			deployer, frostyPayee: frosty.address, bossPayee: boss.address, tokens, gasLimits,
			onDeployed: (contract) => deployed.push(contract),
		});

		const split = await ethers.getContractAt('KalyBotSplitter', splitter);
		const sub = await ethers.getContractAt('KalyBotSubscription', subscription);

		expect(await split.frostyBps()).to.equal(6000);
		expect(await split.frostyCapUsd()).to.equal(5000n * 10n ** 18n);
		expect(await split.usdScale(tokens[0].address)).to.equal(10n ** 12n);
		expect(await split.usdScale(tokens[1].address)).to.equal(1n);
		// hand-checked prices: Pro monthly $49, Enterprise annual $1,908
		expect(await sub.prices(2, 0, tokens[0].address)).to.equal(49_000_000n);
		expect(await sub.prices(4, 1, tokens[1].address)).to.equal(1908n * 10n ** 18n);
		expect(Object.keys(PLAN_PRICES_USD)).to.have.length(4);
		// the deploying wallet is the owner from the start: no handover pending
		expect(await split.owner()).to.equal(deployer.address);
		expect(await sub.owner()).to.equal(deployer.address);
		expect(await split.pendingOwner()).to.equal(ethers.ZeroAddress);
		expect(await sub.pendingOwner()).to.equal(ethers.ZeroAddress);
		expect(await sub.splitter()).to.equal(splitter);
	});

	it('reports each contract with its deploy tx and block as soon as it is deployed', async () => {
		const [deployer, frosty, boss] = await ethers.getSigners();
		const { tokens } = await mockTokens();
		const deployed: DeployedContract[] = [];

		const result = await deployKalyBot({
			deployer, frostyPayee: frosty.address, bossPayee: boss.address, tokens, gasLimits,
			onDeployed: (contract) => deployed.push(contract),
		});

		expect(deployed.map((c) => c.name)).to.deep.equal(['splitter', 'subscription']);
		for (const c of deployed) {
			const receipt = (await ethers.provider.getTransactionReceipt(c.txHash))!;
			expect(receipt.contractAddress).to.equal(c.address);
			expect(receipt.blockNumber).to.equal(c.blockNumber);
		}
		expect(result.splitter).to.equal(deployed[0].address);
		expect(result.subscription).to.equal(deployed[1].address);
	});

	it('sends every deploy transaction with an explicit gas limit that covers real usage', async function () {
		if (COVERAGE) this.skip();
		const [deployer, frosty, boss] = await ethers.getSigners();
		const { tokens } = await mockTokens();
		const startBlock = await ethers.provider.getBlockNumber();

		await deployKalyBot({
			deployer, frostyPayee: frosty.address, bossPayee: boss.address, tokens, gasLimits,
		});

		const limits = Object.values(DEPLOY_GAS_LIMITS);
		expect(new Set(limits).size, 'every kind has a distinct limit').to.equal(limits.length);
		const latest = await ethers.provider.getBlockNumber();
		const maxUsedByLimit = new Map<bigint, bigint>();
		let deployerTxs = 0;
		for (let n = startBlock + 1; n <= latest; n++) {
			const block = (await ethers.provider.getBlock(n, true))!;
			for (const tx of block.prefetchedTransactions) {
				if (tx.from !== deployer.address) continue;
				deployerTxs++;
				const receipt = (await ethers.provider.getTransactionReceipt(tx.hash))!;
				expect(limits, `gas limit of tx ${tx.hash}`).to.include(tx.gasLimit);
				expect(receipt.gasUsed <= tx.gasLimit, `usage ${receipt.gasUsed} within limit ${tx.gasLimit}`).to.equal(true);
				const seen = maxUsedByLimit.get(tx.gasLimit) ?? 0n;
				if (receipt.gasUsed > seen) maxUsedByLimit.set(tx.gasLimit, receipt.gasUsed);
			}
		}
		for (const [limit, maxUsed] of maxUsedByLimit) {
			expect(limit <= 2n * maxUsed, `limit ${limit} within 2x heaviest use ${maxUsed}`).to.equal(true);
		}
		expect(deployerTxs).to.equal(2 + 2 + 16);
	});

	it('reports each deploy tx as sent, before waiting for it to be mined', async () => {
		const [deployer, frosty, boss] = await ethers.getSigners();
		const { tokens } = await mockTokens();
		const events: string[] = [];
		const sent: Record<string, { address: string; txHash: string }> = {};
		const deployed: Record<string, { address: string; txHash: string }> = {};

		await deployKalyBot({
			deployer, frostyPayee: frosty.address, bossPayee: boss.address, tokens, gasLimits,
			onSent: (s) => {
				events.push(`sent:${s.name}`);
				sent[s.name] = { address: s.address, txHash: s.txHash };
			},
			onDeployed: (c) => {
				events.push(`deployed:${c.name}`);
				deployed[c.name] = { address: c.address, txHash: c.txHash };
			},
		});

		expect(events).to.deep.equal(['sent:splitter', 'deployed:splitter', 'sent:subscription', 'deployed:subscription']);
		expect(sent.splitter).to.deep.equal(deployed.splitter);
		expect(sent.subscription).to.deep.equal(deployed.subscription);
	});

	it('uses the supplied gas limits for every deploy transaction', async () => {
		const [deployer, frosty, boss] = await ethers.getSigners();
		const { tokens } = await mockTokens();

		await expect(deployKalyBot({
			deployer, frostyPayee: frosty.address, bossPayee: boss.address, tokens,
			gasLimits: { ...DEPLOY_GAS_LIMITS, splitter: 100_000n },
		})).to.be.rejectedWith(/gas/i);
	});

	it('refuses a zero payee before sending any transaction', async () => {
		const [deployer, frosty, boss] = await ethers.getSigners();
		const { tokens } = await mockTokens();
		const good = { deployer, frostyPayee: frosty.address, bossPayee: boss.address, tokens, gasLimits };
		const nonce = await deployer.getNonce();

		await expect(deployKalyBot({ ...good, frostyPayee: ethers.ZeroAddress })).to.be.rejectedWith(/frostyPayee must be a non-zero address/);
		await expect(deployKalyBot({ ...good, bossPayee: ethers.ZeroAddress })).to.be.rejectedWith(/bossPayee must be a non-zero address/);

		expect(await deployer.getNonce()).to.equal(nonce);
	});

	it('checkout gas fallbacks cover approve, a first payment and a plan change when sent as the gas limit', async function () {
		if (COVERAGE) this.skip();
		const [deployer, frosty, boss, payer] = await ethers.getSigners();
		const { usdt, tokens } = await mockTokens();
		const { subscription } = await deployKalyBot({
			deployer, frostyPayee: frosty.address, bossPayee: boss.address, tokens,
		});
		const sub = await ethers.getContractAt('KalyBotSubscription', subscription);
		const usdtAddress = await usdt.getAddress();
		await usdt.mint(payer.address, 10_000n * 10n ** 6n);
		const { approve, subscribeFor } = CHECKOUT_GAS_LIMITS;

		const approveEstimate = await usdt.connect(payer).approve.estimateGas(subscription, ethers.MaxUint256);
		const approveReceipt = await (await usdt.connect(payer).approve(subscription, ethers.MaxUint256, { gasLimit: approve })).wait();
		expect(approveReceipt!.status).to.equal(1);

		const firstEstimate = await sub.connect(payer)
			.subscribeFor.estimateGas(ethers.id('instance:a'), PRO, MONTHLY, usdtAddress, ethers.id('order:1'));
		const firstReceipt = await (await sub.connect(payer)
			.subscribeFor(ethers.id('instance:a'), PRO, MONTHLY, usdtAddress, ethers.id('order:1'), { gasLimit: subscribeFor })).wait();
		expect(firstReceipt!.status).to.equal(1);

		await time.increase(10 * 24 * 60 * 60);
		const changeEstimate = await sub.connect(payer)
			.subscribeFor.estimateGas(ethers.id('instance:a'), ENTERPRISE, MONTHLY, usdtAddress, ethers.id('order:2'));
		const changeReceipt = await (await sub.connect(payer)
			.subscribeFor(ethers.id('instance:a'), ENTERPRISE, MONTHLY, usdtAddress, ethers.id('order:2'), { gasLimit: subscribeFor })).wait();
		expect(changeReceipt!.status).to.equal(1);

		const maxPay = firstEstimate > changeEstimate ? firstEstimate : changeEstimate;
		expect(approveEstimate <= approve, `approve estimate ${approveEstimate}`).to.equal(true);
		expect(approve <= 2n * approveEstimate, `approve limit ${approve} vs estimate ${approveEstimate}`).to.equal(true);
		expect(maxPay <= subscribeFor, `subscribeFor estimate ${maxPay}`).to.equal(true);
		expect(subscribeFor <= 2n * maxPay, `subscribeFor limit ${subscribeFor} vs estimate ${maxPay}`).to.equal(true);
		console.log(`      estimates: approve ${approveEstimate}, first ${firstEstimate}, change ${changeEstimate}`);
	});
});
