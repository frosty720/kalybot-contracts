import { ethers } from 'hardhat';
import { expect } from 'chai';
import { deployKalyBot, PLAN_PRICES_USD } from '../scripts/lib/deployKalyBot';

describe('deployKalyBot', () => {
	it('deploys, wires the token allowlist, sets every price and hands ownership to the owner', async () => {
		const [deployer, owner, frosty, boss] = await ethers.getSigners();
		const Mock = await ethers.getContractFactory('MockERC20');
		const usdt = await Mock.deploy('Tether', 'USDT', 6);
		const kusd = await Mock.deploy('KUSD Stablecoin', 'KUSD', 18);
		const tokens = [
			{ address: await usdt.getAddress(), decimals: 6 },
			{ address: await kusd.getAddress(), decimals: 18 },
		];

		const { splitter, subscription } = await deployKalyBot({
			deployer, owner: owner.address, frostyPayee: frosty.address, bossPayee: boss.address, tokens,
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
});
