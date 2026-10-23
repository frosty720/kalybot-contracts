import { ethers } from 'hardhat';
import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

const USD = 10n ** 18n;
const USDT = (n: bigint): bigint => n * 10n ** 6n;
const KUSD = (n: bigint): bigint => n * 10n ** 18n;
const instance = (name: string): string => ethers.id(`instance:${name}`);
const order = (name: string): string => ethers.id(`order:${name}`);

async function deployFixture() {
	const [owner, frosty, boss, payer, stranger] = await ethers.getSigners();
	const Mock = await ethers.getContractFactory('MockERC20');
	const usdt = await Mock.deploy('Tether', 'USDT', 6);
	const kusd = await Mock.deploy('KUSD Stablecoin', 'KUSD', 18);
	const Splitter = await ethers.getContractFactory('KalyBotSplitter');
	const splitter = await Splitter.deploy(owner.address, frosty.address, boss.address, 6000, 5000n * USD);
	await splitter.addToken(await usdt.getAddress(), 6);
	await splitter.addToken(await kusd.getAddress(), 18);
	const Credits = await ethers.getContractFactory('KalyBotCredits');
	const credits = await Credits.deploy(await splitter.getAddress(), owner.address);
	await credits.setPrice(1, await usdt.getAddress(), USDT(5n));
	await credits.setPrice(2, await usdt.getAddress(), USDT(10n));
	await credits.setPrice(3, await usdt.getAddress(), USDT(25n));
	await credits.setPrice(1, await kusd.getAddress(), KUSD(5n));
	await credits.setPrice(2, await kusd.getAddress(), KUSD(10n));
	await credits.setPrice(3, await kusd.getAddress(), KUSD(25n));
	for (const token of [usdt, kusd]) {
		await token.mint(payer.address, 10n ** 30n);
		await token.connect(payer).approve(await credits.getAddress(), ethers.MaxUint256);
	}
	return { credits, splitter, usdt, kusd, owner, frosty, boss, payer, stranger };
}

describe('KalyBotCredits', () => {
	it('charges the configured price for the pack, splits it 60/40 and keeps nothing', async () => {
		const { credits, usdt, frosty, boss, payer } = await loadFixture(deployFixture);
		const before = await usdt.balanceOf(payer.address);
		await credits.connect(payer).buyCredits(instance('acme'), 1, await usdt.getAddress(), order('1'));
		expect(before - (await usdt.balanceOf(payer.address))).to.equal(USDT(5n));
		expect(await usdt.balanceOf(frosty.address)).to.equal(3_000_000n);
		expect(await usdt.balanceOf(boss.address)).to.equal(2_000_000n);
		expect(await usdt.balanceOf(await credits.getAddress())).to.equal(0n);
	});

	it('charges 25 KUSD for pack 3', async () => {
		const { credits, kusd, frosty, boss, payer } = await loadFixture(deployFixture);
		await credits.connect(payer).buyCredits(instance('acme'), 3, await kusd.getAddress(), order('1'));
		expect(await kusd.balanceOf(frosty.address)).to.equal(15n * 10n ** 18n);
		expect(await kusd.balanceOf(boss.address)).to.equal(10n * 10n ** 18n);
	});

	it('emits CreditsBought with instance, payer, packId, token, the charged amount and orderRef', async () => {
		const { credits, usdt, payer } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await expect(credits.connect(payer).buyCredits(instance('acme'), 2, token, order('1')))
			.to.emit(credits, 'CreditsBought')
			.withArgs(instance('acme'), payer.address, 2, token, USDT(10n), order('1'));
		expect(await credits.orderPaid(order('1'), instance('acme'), 2)).to.equal(true);
	});

	it('a front-runner using a customer\u2019s orderRef pays the full price and credits the customer\u2019s instance', async () => {
		const { credits, usdt, payer, stranger } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await usdt.mint(stranger.address, USDT(100n));
		await usdt.connect(stranger).approve(await credits.getAddress(), ethers.MaxUint256);
		const attackerBefore = await usdt.balanceOf(stranger.address);
		await expect(credits.connect(stranger).buyCredits(instance('customer'), 3, token, order('victim')))
			.to.emit(credits, 'CreditsBought')
			.withArgs(instance('customer'), stranger.address, 3, token, USDT(25n), order('victim'));
		expect(attackerBefore - (await usdt.balanceOf(stranger.address))).to.equal(USDT(25n));

		const customerBefore = await usdt.balanceOf(payer.address);
		await expect(credits.connect(payer).buyCredits(instance('customer'), 3, token, order('victim')))
			.to.be.revertedWithCustomError(credits, 'OrderRefUsed');
		expect(await usdt.balanceOf(payer.address)).to.equal(customerBefore);
	});

	it('a front-runner copying only the orderRef with another instance or pack does not block the customer', async () => {
		const { credits, usdt, payer, stranger } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await usdt.mint(stranger.address, USDT(100n));
		await usdt.connect(stranger).approve(await credits.getAddress(), ethers.MaxUint256);
		await expect(credits.connect(stranger).buyCredits(instance('attacker'), 1, token, order('victim')))
			.to.emit(credits, 'CreditsBought')
			.withArgs(instance('attacker'), stranger.address, 1, token, USDT(5n), order('victim'));

		await expect(credits.connect(payer).buyCredits(instance('customer'), 3, token, order('victim')))
			.to.emit(credits, 'CreditsBought')
			.withArgs(instance('customer'), payer.address, 3, token, USDT(25n), order('victim'));
		await expect(credits.connect(stranger).buyCredits(instance('customer'), 1, token, order('victim'))).to.not.be.reverted;
	});

	it('orderPaid reports a paid (orderRef, instance, pack) and nothing else', async () => {
		const { credits, usdt, payer } = await loadFixture(deployFixture);
		await credits.connect(payer).buyCredits(instance('acme'), 1, await usdt.getAddress(), order('1'));
		expect(await credits.orderPaid(order('1'), instance('acme'), 1)).to.equal(true);
		expect(await credits.orderPaid(order('1'), instance('acme'), 2)).to.equal(false);
		expect(await credits.orderPaid(order('1'), instance('other'), 1)).to.equal(false);
		expect(await credits.orderPaid(order('2'), instance('acme'), 1)).to.equal(false);
	});

	it('rejects pack 0 (InvalidPack) and an unpriced pack or token (PackNotConfigured)', async () => {
		const { credits, usdt, payer } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await expect(credits.connect(payer).buyCredits(instance('acme'), 0, token, order('1')))
			.to.be.revertedWithCustomError(credits, 'InvalidPack');
		await expect(credits.connect(payer).buyCredits(instance('acme'), 4, token, order('1')))
			.to.be.revertedWithCustomError(credits, 'PackNotConfigured');
		await expect(credits.connect(payer).buyCredits(instance('acme'), 1, ethers.Wallet.createRandom().address, order('1')))
			.to.be.revertedWithCustomError(credits, 'PackNotConfigured');
		expect(await credits.orderPaid(order('1'), instance('acme'), 1)).to.equal(false);
	});

	it('rejects a zero instance, a zero orderRef and a reused orderRef', async () => {
		const { credits, usdt, payer } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await expect(credits.connect(payer).buyCredits(ethers.ZeroHash, 1, token, order('1')))
			.to.be.revertedWithCustomError(credits, 'ZeroInstance');
		await expect(credits.connect(payer).buyCredits(instance('acme'), 1, token, ethers.ZeroHash))
			.to.be.revertedWithCustomError(credits, 'ZeroOrderRef');
		await credits.connect(payer).buyCredits(instance('acme'), 1, token, order('1'));
		await expect(credits.connect(payer).buyCredits(instance('acme'), 1, token, order('1')))
			.to.be.revertedWithCustomError(credits, 'OrderRefUsed');
	});

	it('setPrice is owner-only, emits PriceSet, rejects pack 0 and a zero token, and approves the splitter once per token', async () => {
		const { credits, splitter, usdt, stranger } = await loadFixture(deployFixture);
		const Mock = await ethers.getContractFactory('MockERC20');
		const fresh = await Mock.deploy('Fresh', 'FRS', 6);
		const token = await fresh.getAddress();
		await expect(credits.connect(stranger).setPrice(1, token, 1n)).to.be.revertedWithCustomError(credits, 'OwnableUnauthorizedAccount');
		await expect(credits.setPrice(0, token, 1n)).to.be.revertedWithCustomError(credits, 'InvalidPack');
		await expect(credits.setPrice(1, ethers.ZeroAddress, 1n)).to.be.revertedWithCustomError(credits, 'ZeroAddress');

		expect(await credits.splitterApproved(token)).to.equal(false);
		await expect(credits.setPrice(1, token, 7n)).to.emit(credits, 'PriceSet').withArgs(1, token, 7n);
		expect(await credits.prices(1, token)).to.equal(7n);
		expect(await credits.splitterApproved(token)).to.equal(true);
		expect(await fresh.allowance(await credits.getAddress(), await splitter.getAddress())).to.equal(ethers.MaxUint256);
		await credits.setPrice(2, token, 9n);
		expect(await credits.prices(2, token)).to.equal(9n);
		expect(await credits.splitterApproved(await usdt.getAddress())).to.equal(true);
	});

	it('a price set to 0 disables that pack for that token', async () => {
		const { credits, usdt, payer } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await credits.setPrice(1, token, 0n);
		await expect(credits.connect(payer).buyCredits(instance('acme'), 1, token, order('1')))
			.to.be.revertedWithCustomError(credits, 'PackNotConfigured');
		await expect(credits.connect(payer).buyCredits(instance('acme'), 2, token, order('1'))).to.not.be.reverted;
	});

	it('counts toward the cap: the payment that crosses it pays Frosty only the remainder', async () => {
		const { credits, splitter, usdt, frosty, boss, payer } = await loadFixture(deployFixture);
		await splitter.setTerms(6000, 4n * 10n ** 18n);
		await credits.connect(payer).buyCredits(instance('acme'), 3, await usdt.getAddress(), order('1'));
		expect(await usdt.balanceOf(frosty.address)).to.equal(4_000_000n);
		expect(await usdt.balanceOf(boss.address)).to.equal(21_000_000n);
		expect(await splitter.frostyPaidUsd()).to.equal(4n * 10n ** 18n);
	});

	it('rejects a token the splitter does not accept', async () => {
		const { credits, splitter, payer } = await loadFixture(deployFixture);
		const Mock = await ethers.getContractFactory('MockERC20');
		const other = await Mock.deploy('Other', 'OTH', 6);
		await other.mint(payer.address, USDT(100n));
		await other.connect(payer).approve(await credits.getAddress(), ethers.MaxUint256);
		await credits.setPrice(1, await other.getAddress(), USDT(5n));
		await expect(credits.connect(payer).buyCredits(instance('acme'), 1, await other.getAddress(), order('1')))
			.to.be.revertedWithCustomError(splitter, 'TokenNotAccepted');
		expect(await credits.orderPaid(order('1'), instance('acme'), 1)).to.equal(false);
	});

	it('refuses payments while paused; owner-only pause/unpause/rescue; rescue sends a stray token to the given address', async () => {
		const { credits, usdt, payer, stranger } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await credits.pause();
		expect(await credits.paused()).to.equal(true);
		await expect(credits.connect(payer).buyCredits(instance('acme'), 1, token, order('1')))
			.to.be.revertedWithCustomError(credits, 'EnforcedPause');
		await credits.unpause();
		await expect(credits.connect(payer).buyCredits(instance('acme'), 1, token, order('1'))).to.not.be.reverted;

		const guarded = credits.connect(stranger);
		await expect(guarded.pause()).to.be.revertedWithCustomError(credits, 'OwnableUnauthorizedAccount');
		await expect(guarded.unpause()).to.be.revertedWithCustomError(credits, 'OwnableUnauthorizedAccount');
		await expect(guarded.rescueToken(token, stranger.address, 1n)).to.be.revertedWithCustomError(credits, 'OwnableUnauthorizedAccount');

		await usdt.mint(await credits.getAddress(), USDT(7n));
		await expect(credits.rescueToken(token, stranger.address, USDT(7n)))
			.to.emit(credits, 'TokenRescued').withArgs(token, stranger.address, USDT(7n));
		expect(await usdt.balanceOf(stranger.address)).to.equal(USDT(7n));
		await expect(credits.rescueToken(token, ethers.ZeroAddress, 1n)).to.be.revertedWithCustomError(credits, 'ZeroAddress');
	});

	it('rejects a zero splitter in the constructor and sets the owner', async () => {
		const { credits, owner } = await loadFixture(deployFixture);
		const Credits = await ethers.getContractFactory('KalyBotCredits');
		await expect(Credits.deploy(ethers.ZeroAddress, owner.address)).to.be.revertedWithCustomError(Credits, 'ZeroAddress');
		expect(await credits.owner()).to.equal(owner.address);
	});

	it('blocks a token that re-enters buyCredits', async () => {
		const { credits, splitter, payer } = await loadFixture(deployFixture);
		const Evil = await ethers.getContractFactory('CreditsReentrantToken');
		const evil = await Evil.deploy();
		await splitter.addToken(await evil.getAddress(), 18);
		await credits.setPrice(1, await evil.getAddress(), KUSD(5n));
		await evil.mint(payer.address, KUSD(100n));
		await evil.connect(payer).approve(await credits.getAddress(), ethers.MaxUint256);
		await evil.setTarget(await credits.getAddress());
		await expect(credits.connect(payer).buyCredits(instance('acme'), 1, await evil.getAddress(), order('1')))
			.to.be.revertedWithCustomError(credits, 'ReentrancyGuardReentrantCall');
	});
});
