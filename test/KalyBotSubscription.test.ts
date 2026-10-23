import { ethers } from 'hardhat';
import { expect } from 'chai';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';

const USD = 10n ** 18n;
const USDT = (n: bigint) => n * 10n ** 6n;
const KUSD = (n: bigint) => n * 10n ** 18n;
const MONTHLY = 0;
const ANNUAL = 1;
const STARTER = 1;
const PRO = 2;
const ENTERPRISE = 4;
const DAY = 24n * 60n * 60n;
const instance = (name: string) => ethers.id(`instance:${name}`);
const order = (name: string) => ethers.id(`order:${name}`);

async function deployFixture() {
	const [owner, frosty, boss, payer, stranger] = await ethers.getSigners();
	const Mock = await ethers.getContractFactory('MockERC20');
	const usdt = await Mock.deploy('Tether', 'USDT', 6);
	const kusd = await Mock.deploy('KUSD Stablecoin', 'KUSD', 18);
	const Splitter = await ethers.getContractFactory('KalyBotSplitter');
	const splitter = await Splitter.deploy(owner.address, frosty.address, boss.address, 6000, 5000n * USD);
	await splitter.addToken(await usdt.getAddress(), 6);
	await splitter.addToken(await kusd.getAddress(), 18);
	const Sub = await ethers.getContractFactory('KalyBotSubscription');
	const sub = await Sub.deploy(await splitter.getAddress(), owner.address);
	await sub.setPrice(STARTER, MONTHLY, await usdt.getAddress(), USDT(19n));
	await sub.setPrice(PRO, MONTHLY, await usdt.getAddress(), USDT(49n));
	await sub.setPrice(PRO, ANNUAL, await usdt.getAddress(), USDT(468n));
	await sub.setPrice(ENTERPRISE, MONTHLY, await usdt.getAddress(), USDT(199n));
	await sub.setPrice(PRO, MONTHLY, await kusd.getAddress(), KUSD(49n));
	for (const token of [usdt, kusd]) {
		await token.mint(payer.address, 10n ** 30n);
		await token.connect(payer).approve(await sub.getAddress(), ethers.MaxUint256);
	}
	return { sub, splitter, usdt, kusd, owner, frosty, boss, payer, stranger };
}

describe('KalyBotSubscription', () => {
	it('charges the exact price, splits it, and starts a 30-day period', async () => {
		const { sub, usdt, frosty, boss, payer } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await sub.connect(payer).subscribeFor(instance('acme'), PRO, MONTHLY, token, order('1'));
		const now = BigInt(await time.latest());
		const [tier, expiry, active] = await sub.getSubscription(instance('acme'));
		expect(tier).to.equal(PRO);
		expect(expiry).to.equal(now + 30n * DAY);
		expect(active).to.equal(true);
		expect(await usdt.balanceOf(frosty.address)).to.equal(29_400_000n); // 60% of 49
		expect(await usdt.balanceOf(boss.address)).to.equal(19_600_000n);
		expect(await usdt.balanceOf(await sub.getAddress())).to.equal(0n);
	});

	it('emits Subscribed with the order reference for the control plane', async () => {
		const { sub, usdt, payer } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		const tx = sub.connect(payer).subscribeFor(instance('acme'), PRO, MONTHLY, token, order('1'));
		await expect(tx).to.emit(sub, 'Subscribed');
		const receipt = await (await tx).wait();
		const log = receipt!.logs.map((l) => sub.interface.parseLog(l)).find((l) => l?.name === 'Subscribed')!;
		expect(log.args.instanceId).to.equal(instance('acme'));
		expect(log.args.tier).to.equal(PRO);
		expect(log.args.period).to.equal(MONTHLY);
		expect(log.args.payer).to.equal(payer.address);
		expect(log.args.token).to.equal(token);
		expect(log.args.amount).to.equal(USDT(49n));
		expect(log.args.orderRef).to.equal(order('1'));
	});

	it('an annual plan adds 365 days', async () => {
		const { sub, usdt, payer } = await loadFixture(deployFixture);
		await sub.connect(payer).subscribeFor(instance('acme'), PRO, ANNUAL, await usdt.getAddress(), order('1'));
		const now = BigInt(await time.latest());
		const [, expiry] = await sub.getSubscription(instance('acme'));
		expect(expiry).to.equal(now + 365n * DAY);
	});

	it('an early renewal stacks on top of the remaining time', async () => {
		const { sub, usdt, payer } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await sub.connect(payer).subscribeFor(instance('acme'), PRO, MONTHLY, token, order('1'));
		const [, firstExpiry] = await sub.getSubscription(instance('acme'));
		await time.increase(10n * DAY);
		await sub.connect(payer).subscribeFor(instance('acme'), PRO, MONTHLY, token, order('2'));
		const [, secondExpiry] = await sub.getSubscription(instance('acme'));
		expect(secondExpiry).to.equal(firstExpiry + 30n * DAY);
	});

	it('a renewal after expiry starts from now, not from the old expiry', async () => {
		const { sub, usdt, payer } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await sub.connect(payer).subscribeFor(instance('acme'), PRO, MONTHLY, token, order('1'));
		await time.increase(45n * DAY);
		expect((await sub.getSubscription(instance('acme')))[2]).to.equal(false);
		await sub.connect(payer).subscribeFor(instance('acme'), PRO, MONTHLY, token, order('2'));
		const now = BigInt(await time.latest());
		expect((await sub.getSubscription(instance('acme')))[1]).to.equal(now + 30n * DAY);
	});

	it('an upgrade mid-period converts the leftover time at the monthly price ratio', async () => {
		const { sub, usdt, payer } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await sub.connect(payer).subscribeFor(instance('acme'), PRO, MONTHLY, token, order('1'));
		const [, firstExpiry] = await sub.getSubscription(instance('acme'));
		await time.increase(10n * DAY);
		const tx = await sub.connect(payer).subscribeFor(instance('acme'), ENTERPRISE, MONTHLY, token, order('2'));
		const now = BigInt(await time.latest());
		const [tier, expiry] = await sub.getSubscription(instance('acme'));
		expect(tier).to.equal(ENTERPRISE);
		// ~20 Pro days left are worth 20 × 49/199 ≈ 4.9 Enterprise days, plus the 30 days paid for
		expect(expiry).to.equal(now + ((firstExpiry - now) * 49n) / 199n + 30n * DAY);
		// the event's expiry matches the expiry stored on-chain
		const receipt = await tx.wait();
		const log = receipt!.logs.map((l) => sub.interface.parseLog(l)).find((l) => l?.name === 'Subscribed')!;
		expect(log.args.expiry).to.equal(expiry);
	});

	it('a downgrade mid-period keeps the value already paid', async () => {
		const { sub, usdt, payer } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await sub.connect(payer).subscribeFor(instance('acme'), ENTERPRISE, MONTHLY, token, order('1'));
		const [, firstExpiry] = await sub.getSubscription(instance('acme'));
		await time.increase(10n * DAY);
		await sub.connect(payer).subscribeFor(instance('acme'), STARTER, MONTHLY, token, order('2'));
		const now = BigInt(await time.latest());
		const [tier, expiry] = await sub.getSubscription(instance('acme'));
		expect(tier).to.equal(STARTER);
		expect(expiry).to.equal(now + ((firstExpiry - now) * 199n) / 19n + 30n * DAY);
		// ~20 Enterprise days become more than 200 Starter days, not 20
		expect(expiry - now - 30n * DAY).to.be.greaterThan(200n * DAY);
	});

	it('a plan change after expiry starts fresh with nothing to convert', async () => {
		const { sub, usdt, payer } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await sub.connect(payer).subscribeFor(instance('acme'), PRO, MONTHLY, token, order('1'));
		await time.increase(45n * DAY);
		await sub.connect(payer).subscribeFor(instance('acme'), ENTERPRISE, MONTHLY, token, order('2'));
		const now = BigInt(await time.latest());
		expect((await sub.getSubscription(instance('acme')))[1]).to.equal(now + 30n * DAY);
	});

	it('refuses a plan change it cannot price instead of dropping the leftover time', async () => {
		const { sub, kusd, payer } = await loadFixture(deployFixture);
		const token = await kusd.getAddress();
		// KUSD has a Pro monthly price but no Starter monthly price, so Pro days cannot be converted
		await sub.connect(payer).subscribeFor(instance('acme'), PRO, MONTHLY, token, order('1'));
		await sub.setPrice(STARTER, ANNUAL, token, KUSD(180n));
		await time.increase(5n * DAY);
		await expect(sub.connect(payer).subscribeFor(instance('acme'), STARTER, ANNUAL, token, order('2')))
			.to.be.revertedWithCustomError(sub, 'TierNotConfigured');
	});

	it('accepts KUSD at its own price', async () => {
		const { sub, kusd, frosty, payer } = await loadFixture(deployFixture);
		await sub.connect(payer).subscribeFor(instance('acme'), PRO, MONTHLY, await kusd.getAddress(), order('1'));
		expect(await kusd.balanceOf(frosty.address)).to.equal(294n * 10n ** 17n);
	});

	it('rejects a reused (orderRef, instance, tier, period)', async () => {
		const { sub, usdt, payer } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await sub.connect(payer).subscribeFor(instance('acme'), PRO, MONTHLY, token, order('1'));
		await expect(sub.connect(payer).subscribeFor(instance('acme'), PRO, MONTHLY, token, order('1')))
			.to.be.revertedWithCustomError(sub, 'OrderRefUsed');
	});

	it('a front-runner copying only the orderRef with another instance, tier or period does not block the customer', async () => {
		const { sub, usdt, payer, stranger } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await usdt.mint(stranger.address, USDT(1000n));
		await usdt.connect(stranger).approve(await sub.getAddress(), ethers.MaxUint256);
		await sub.connect(stranger).subscribeFor(instance('attacker'), STARTER, MONTHLY, token, order('victim'));
		await sub.connect(stranger).subscribeFor(instance('customer'), STARTER, MONTHLY, token, order('victim'));
		await sub.connect(stranger).subscribeFor(instance('customer'), PRO, MONTHLY, token, order('victim'));

		await expect(sub.connect(payer).subscribeFor(instance('customer'), PRO, ANNUAL, token, order('victim')))
			.to.emit(sub, 'Subscribed');
		expect((await sub.getSubscription(instance('customer')))[0]).to.equal(PRO);
	});

	it('an exact copy pays for and extends the customer\u2019s instance; the customer\u2019s own tx then reverts OrderRefUsed and is not charged', async () => {
		const { sub, usdt, payer, stranger } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await usdt.mint(stranger.address, USDT(1000n));
		await usdt.connect(stranger).approve(await sub.getAddress(), ethers.MaxUint256);
		const customerBefore = await usdt.balanceOf(payer.address);
		const strangerBefore = await usdt.balanceOf(stranger.address);

		await expect(sub.connect(stranger).subscribeFor(instance('customer'), PRO, MONTHLY, token, order('victim')))
			.to.emit(sub, 'Subscribed');

		const [tier, expiry, active] = await sub.getSubscription(instance('customer'));
		expect(tier).to.equal(PRO);
		expect(active).to.equal(true);
		expect(expiry).to.equal(BigInt(await time.latest()) + 30n * DAY);
		expect(strangerBefore - (await usdt.balanceOf(stranger.address))).to.equal(USDT(49n));
		await expect(sub.connect(payer).subscribeFor(instance('customer'), PRO, MONTHLY, token, order('victim')))
			.to.be.revertedWithCustomError(sub, 'OrderRefUsed');
		expect(await usdt.balanceOf(payer.address)).to.equal(customerBefore);
	});

	it('orderPaid reports a paid (orderRef, instance, tier, period) and nothing else', async () => {
		const { sub, usdt, payer } = await loadFixture(deployFixture);
		await sub.connect(payer).subscribeFor(instance('acme'), PRO, MONTHLY, await usdt.getAddress(), order('1'));
		expect(await sub.orderPaid(order('1'), instance('acme'), PRO, MONTHLY)).to.equal(true);
		expect(await sub.orderPaid(order('1'), instance('acme'), PRO, ANNUAL)).to.equal(false);
		expect(await sub.orderPaid(order('1'), instance('acme'), STARTER, MONTHLY)).to.equal(false);
		expect(await sub.orderPaid(order('1'), instance('other'), PRO, MONTHLY)).to.equal(false);
		expect(await sub.orderPaid(order('2'), instance('acme'), PRO, MONTHLY)).to.equal(false);
	});

	it('rejects a zero orderRef and a zero instanceId', async () => {
		const { sub, usdt, payer } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await expect(sub.connect(payer).subscribeFor(instance('acme'), PRO, MONTHLY, token, ethers.ZeroHash))
			.to.be.revertedWithCustomError(sub, 'ZeroOrderRef');
		await expect(sub.connect(payer).subscribeFor(ethers.ZeroHash, PRO, MONTHLY, token, order('1')))
			.to.be.revertedWithCustomError(sub, 'ZeroInstance');
	});

	it('rejects tiers, periods and tokens without a price', async () => {
		const { sub, usdt, kusd, payer } = await loadFixture(deployFixture);
		await expect(sub.connect(payer).subscribeFor(instance('a'), 0, MONTHLY, await usdt.getAddress(), order('1')))
			.to.be.revertedWithCustomError(sub, 'InvalidTier');
		await expect(sub.connect(payer).subscribeFor(instance('a'), 5, MONTHLY, await usdt.getAddress(), order('2')))
			.to.be.revertedWithCustomError(sub, 'InvalidTier');
		await expect(sub.connect(payer).subscribeFor(instance('a'), PRO, 2, await usdt.getAddress(), order('3')))
			.to.be.revertedWithCustomError(sub, 'InvalidPeriod');
		await expect(sub.connect(payer).subscribeFor(instance('a'), STARTER, MONTHLY, await kusd.getAddress(), order('4')))
			.to.be.revertedWithCustomError(sub, 'TierNotConfigured');
	});

	it('blocks payments while paused and resumes after unpause', async () => {
		const { sub, usdt, payer } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await sub.pause();
		await expect(sub.connect(payer).subscribeFor(instance('a'), PRO, MONTHLY, token, order('1')))
			.to.be.revertedWithCustomError(sub, 'EnforcedPause');
		await sub.unpause();
		await expect(sub.connect(payer).subscribeFor(instance('a'), PRO, MONTHLY, token, order('1'))).to.emit(sub, 'Subscribed');
	});

	it('lets the owner grant free time without moving money', async () => {
		const { sub, usdt, boss } = await loadFixture(deployFixture);
		await expect(sub.grant(instance('comp'), PRO, 30n * DAY)).to.emit(sub, 'SubscriptionGranted');
		const [tier, , active] = await sub.getSubscription(instance('comp'));
		expect(tier).to.equal(PRO);
		expect(active).to.equal(true);
		expect(await usdt.balanceOf(boss.address)).to.equal(0n);
	});

	it('keeps prices and grants owner-only', async () => {
		const { sub, usdt, stranger } = await loadFixture(deployFixture);
		await expect(sub.connect(stranger).setPrice(PRO, MONTHLY, await usdt.getAddress(), 1n))
			.to.be.revertedWithCustomError(sub, 'OwnableUnauthorizedAccount');
		await expect(sub.connect(stranger).grant(instance('x'), PRO, 30n * DAY))
			.to.be.revertedWithCustomError(sub, 'OwnableUnauthorizedAccount');
		await expect(sub.connect(stranger).pause()).to.be.revertedWithCustomError(sub, 'OwnableUnauthorizedAccount');
	});

	it('reports 30 and 365 days for the two periods', async () => {
		const { sub } = await loadFixture(deployFixture);
		expect(await sub.periodDuration(MONTHLY)).to.equal(30n * DAY);
		expect(await sub.periodDuration(ANNUAL)).to.equal(365n * DAY);
	});

	it('rejects a zero splitter in the constructor', async () => {
		const { owner } = await loadFixture(deployFixture);
		const Sub = await ethers.getContractFactory('KalyBotSubscription');
		await expect(Sub.deploy(ethers.ZeroAddress, owner.address)).to.be.revertedWithCustomError(Sub, 'ZeroAddress');
	});

	it('setPrice rejects a zero token, a bad tier or a bad period, and logs PriceSet', async () => {
		const { sub, usdt } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await expect(sub.setPrice(PRO, MONTHLY, ethers.ZeroAddress, 1n)).to.be.revertedWithCustomError(sub, 'ZeroAddress');
		await expect(sub.setPrice(0, MONTHLY, token, 1n)).to.be.revertedWithCustomError(sub, 'InvalidTier');
		await expect(sub.setPrice(5, MONTHLY, token, 1n)).to.be.revertedWithCustomError(sub, 'InvalidTier');
		await expect(sub.setPrice(PRO, 2, token, 1n)).to.be.revertedWithCustomError(sub, 'InvalidPeriod');
		await expect(sub.setPrice(PRO, MONTHLY, token, USDT(55n)))
			.to.emit(sub, 'PriceSet').withArgs(PRO, MONTHLY, token, USDT(55n));
		expect(await sub.prices(PRO, MONTHLY, token)).to.equal(USDT(55n));
	});

	it('grant rejects a zero instance, a bad tier and a zero duration', async () => {
		const { sub } = await loadFixture(deployFixture);
		await expect(sub.grant(ethers.ZeroHash, PRO, DAY)).to.be.revertedWithCustomError(sub, 'ZeroInstance');
		await expect(sub.grant(instance('x'), 0, DAY)).to.be.revertedWithCustomError(sub, 'InvalidTier');
		await expect(sub.grant(instance('x'), 5, DAY)).to.be.revertedWithCustomError(sub, 'InvalidTier');
		await expect(sub.grant(instance('x'), PRO, 0)).to.be.revertedWithCustomError(sub, 'InvalidDuration');
	});

	it('rescues a token sent by mistake to the given address, owner-only, never to zero', async () => {
		const { sub, usdt, stranger } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await usdt.mint(await sub.getAddress(), USDT(7n));
		await expect(sub.rescueToken(token, stranger.address, USDT(7n)))
			.to.emit(sub, 'TokenRescued').withArgs(token, stranger.address, USDT(7n));
		expect(await usdt.balanceOf(stranger.address)).to.equal(USDT(7n));
		await expect(sub.rescueToken(token, ethers.ZeroAddress, 1n)).to.be.revertedWithCustomError(sub, 'ZeroAddress');
		await expect(sub.connect(stranger).rescueToken(token, stranger.address, 1n))
			.to.be.revertedWithCustomError(sub, 'OwnableUnauthorizedAccount');
	});

	it('grant stacks 1:1 on the time left and switches tier without converting', async () => {
		const { sub, usdt, payer } = await loadFixture(deployFixture);
		await sub.connect(payer).subscribeFor(instance('acme'), PRO, MONTHLY, await usdt.getAddress(), order('1'));
		const [, firstExpiry] = await sub.getSubscription(instance('acme'));
		await time.increase(10n * DAY);
		await sub.grant(instance('acme'), ENTERPRISE, 7n * DAY);
		const [tier, expiry] = await sub.getSubscription(instance('acme'));
		expect(tier).to.equal(ENTERPRISE);
		expect(expiry).to.equal(firstExpiry + 7n * DAY);
	});

	it('grant rejects a duration that would overflow the stored expiry', async () => {
		const { sub } = await loadFixture(deployFixture);
		await expect(sub.grant(instance('x'), PRO, 2n ** 64n))
			.to.be.revertedWithCustomError(sub, 'SafeCastOverflowedUintDowncast');
	});
});
