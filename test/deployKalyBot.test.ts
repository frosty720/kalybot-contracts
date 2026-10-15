import { ethers } from 'hardhat';
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
	it('deploys, wires the token allowlist, sets every price and hands ownership to the owner', async () => {
		const [deployer, owner, frosty, boss] = await ethers.getSigners();
		const { tokens } = await mockTokens();
		const deployed: DeployedContract[] = [];

		const { splitter, subscription } = await deployKalyBot({
			deployer, owner: owner.address, frostyPayee: frosty.address, bossPayee: boss.address, tokens,
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
		// ownership waits for the owner to accept (Ownable2Step)
		expect(await split.pendingOwner()).to.equal(owner.address);
		expect(await sub.pendingOwner()).to.equal(owner.address);
	});

	it('reports each contract with its deploy tx and block as soon as it is deployed', async () => {
		const [deployer, owner, frosty, boss] = await ethers.getSigners();
		const { tokens } = await mockTokens();
		const deployed: DeployedContract[] = [];

		const result = await deployKalyBot({
			deployer, owner: owner.address, frostyPayee: frosty.address, bossPayee: boss.address, tokens,
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

	it('sends every deploy transaction with an explicit gas limit that covers real usage', async () => {
		const [deployer, owner, frosty, boss] = await ethers.getSigners();
		const { tokens } = await mockTokens();
		const startBlock = await ethers.provider.getBlockNumber();

		await deployKalyBot({
			deployer, owner: owner.address, frostyPayee: frosty.address, bossPayee: boss.address, tokens,
		});

		const limits = Object.values(DEPLOY_GAS_LIMITS);
		const latest = await ethers.provider.getBlockNumber();
		let deployerTxs = 0;
		for (let n = startBlock + 1; n <= latest; n++) {
			const block = (await ethers.provider.getBlock(n, true))!;
			for (const tx of block.prefetchedTransactions) {
				if (tx.from !== deployer.address) continue;
				deployerTxs++;
				const receipt = (await ethers.provider.getTransactionReceipt(tx.hash))!;
				expect(limits, `gas limit of tx ${tx.hash}`).to.include(tx.gasLimit);
				expect(receipt.gasUsed <= tx.gasLimit, `usage ${receipt.gasUsed} within limit ${tx.gasLimit}`).to.equal(true);
				expect(tx.gasLimit <= receipt.gasUsed * 2n, `limit ${tx.gasLimit} within 2x usage ${receipt.gasUsed}`).to.equal(true);
			}
		}
		expect(deployerTxs).to.equal(2 + 2 + 16 + 2);
	});

	it('refuses a zero owner, the deployer as owner, or a zero payee before sending any transaction', async () => {
		const [deployer, owner, frosty, boss] = await ethers.getSigners();
		const { tokens } = await mockTokens();
		const good = { deployer, owner: owner.address, frostyPayee: frosty.address, bossPayee: boss.address, tokens };
		const nonce = await deployer.getNonce();

		await expect(deployKalyBot({ ...good, owner: ethers.ZeroAddress })).to.be.rejectedWith(/owner must be a non-zero address/);
		await expect(deployKalyBot({ ...good, owner: deployer.address })).to.be.rejectedWith(/owner must be the cold wallet/);
		await expect(deployKalyBot({ ...good, frostyPayee: ethers.ZeroAddress })).to.be.rejectedWith(/frostyPayee must be a non-zero address/);
		await expect(deployKalyBot({ ...good, bossPayee: ethers.ZeroAddress })).to.be.rejectedWith(/bossPayee must be a non-zero address/);

		expect(await deployer.getNonce()).to.equal(nonce);
	});

	it('checkout gas fallbacks cover approve, a first payment and a plan change', async () => {
		const [deployer, owner, frosty, boss, payer] = await ethers.getSigners();
		const { usdt, tokens } = await mockTokens();
		const { subscription } = await deployKalyBot({
			deployer, owner: owner.address, frostyPayee: frosty.address, bossPayee: boss.address, tokens,
		});
		const sub = await ethers.getContractAt('KalyBotSubscription', subscription);
		const usdtAddress = await usdt.getAddress();
		await usdt.mint(payer.address, 10_000n * 10n ** 6n);

		const approveGas = (await (await usdt.connect(payer).approve(subscription, ethers.MaxUint256)).wait())!.gasUsed;
		const firstGas = (await (await sub.connect(payer)
			.subscribeFor(ethers.id('instance:a'), PRO, MONTHLY, usdtAddress, ethers.id('order:1'))).wait())!.gasUsed;
		await time.increase(10 * 24 * 60 * 60);
		const changeGas = (await (await sub.connect(payer)
			.subscribeFor(ethers.id('instance:a'), ENTERPRISE, MONTHLY, usdtAddress, ethers.id('order:2'))).wait())!.gasUsed;

		const maxPay = firstGas > changeGas ? firstGas : changeGas;
		expect(approveGas <= CHECKOUT_GAS_LIMITS.approve, `approve usage ${approveGas}`).to.equal(true);
		expect(CHECKOUT_GAS_LIMITS.approve <= 2n * approveGas, `approve limit vs usage ${approveGas}`).to.equal(true);
		expect(maxPay <= CHECKOUT_GAS_LIMITS.subscribeFor, `subscribeFor usage ${maxPay}`).to.equal(true);
		expect(CHECKOUT_GAS_LIMITS.subscribeFor <= 2n * maxPay, `subscribeFor limit vs usage ${maxPay}`).to.equal(true);
	});
});
