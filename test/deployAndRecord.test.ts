import { ethers } from 'hardhat';
import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { deployAndRecord, type DeploymentRecord } from '../scripts/lib/deployAndRecord';
import { DEPLOY_GAS_LIMITS } from '../scripts/lib/deployKalyBot';
import hre from 'hardhat';

use(chaiAsPromised);

const COVERAGE = (hre as unknown as { __SOLIDITY_COVERAGE_RUNNING?: boolean }).__SOLIDITY_COVERAGE_RUNNING === true;
const gasLimits = COVERAGE
	? (Object.fromEntries(Object.entries(DEPLOY_GAS_LIMITS).map(([k, v]) => [k, v * 3n])) as typeof DEPLOY_GAS_LIMITS)
	: undefined;

async function mockTokens() {
	const Mock = await ethers.getContractFactory('MockERC20');
	const usdt = await Mock.deploy('Tether', 'USDT', 6);
	const kusd = await Mock.deploy('KUSD Stablecoin', 'KUSD', 18);
	return [
		{ address: await usdt.getAddress(), symbol: 'USDT', decimals: 6 },
		{ address: await kusd.getAddress(), symbol: 'KUSD', decimals: 18 },
	];
}

const outFile = () => join(mkdtempSync(join(tmpdir(), 'kalybot-deploy-')), 'kalychain.json');

describe('deployAndRecord', () => {
	it('deploys from the given wallet, which owns both contracts, and records a configured deployment', async () => {
		const [deployer, frosty, boss] = await ethers.getSigners();
		const tokens = await mockTokens();
		const file = outFile();

		const record = await deployAndRecord({ deployer, frostyPayee: frosty.address, bossPayee: boss.address, outFile: file, chainId: 3890, tokens, gasLimits });

		const saved = JSON.parse(readFileSync(file, 'utf-8')) as DeploymentRecord;
		expect(saved).to.deep.equal(JSON.parse(JSON.stringify(record)));
		expect(saved.status).to.equal('configured');
		expect(saved.owner).to.equal(deployer.address);
		expect(saved.deployer).to.equal(deployer.address);
		expect(saved.frostyPayee).to.equal(frosty.address);
		expect(saved.bossPayee).to.equal(boss.address);
		expect(saved.checkoutGasLimits).to.deep.equal({ approve: '71000', subscribeFor: '400000' });
		const sub = await ethers.getContractAt('KalyBotSubscription', saved.subscription!.address);
		expect(await sub.owner()).to.equal(deployer.address);
		expect(await sub.splitter()).to.equal(saved.splitter!.address);
		expect(saved.splitter!.blockNumber).to.be.a('number');
	});

	it('refuses to run when the record file already exists, before sending any transaction', async () => {
		const [deployer, frosty, boss] = await ethers.getSigners();
		const tokens = await mockTokens();
		const file = outFile();
		writeFileSync(file, '{}');
		const nonce = await deployer.getNonce();

		await expect(deployAndRecord({ deployer, frostyPayee: frosty.address, bossPayee: boss.address, outFile: file, chainId: 3890, tokens, gasLimits }))
			.to.be.rejectedWith(/already records a deployment/);
		expect(await deployer.getNonce()).to.equal(nonce);
	});

	it('refuses a token whose on-chain symbol or decimals differ, before writing or sending anything', async () => {
		const [deployer, frosty, boss] = await ethers.getSigners();
		const [usdt, kusd] = await mockTokens();
		const file = outFile();
		const nonce = await deployer.getNonce();

		await expect(deployAndRecord({ deployer, frostyPayee: frosty.address, bossPayee: boss.address, outFile: file, chainId: 3890, tokens: [{ ...usdt, decimals: 18 }, kusd], gasLimits }))
			.to.be.rejectedWith(/expected USDT\/18, chain says USDT\/6/);
		expect(existsSync(file)).to.equal(false);
		expect(await deployer.getNonce()).to.equal(nonce);
	});
});
