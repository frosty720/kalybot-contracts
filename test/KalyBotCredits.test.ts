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
	for (const token of [usdt, kusd]) {
		await token.mint(payer.address, 10n ** 30n);
		await token.connect(payer).approve(await credits.getAddress(), ethers.MaxUint256);
	}
	return { credits, splitter, usdt, kusd, owner, frosty, boss, payer, stranger };
}

describe('KalyBotCredits', () => {
	it('pulls the amount, splits it 60/40 and keeps nothing', async () => {
		const { credits, usdt, frosty, boss, payer } = await loadFixture(deployFixture);
		await credits.connect(payer).buyCredits(instance('acme'), await usdt.getAddress(), USDT(5n), order('1'));
		expect(await usdt.balanceOf(frosty.address)).to.equal(3_000_000n);
		expect(await usdt.balanceOf(boss.address)).to.equal(2_000_000n);
		expect(await usdt.balanceOf(await credits.getAddress())).to.equal(0n);
	});

	it('works for an 18-decimal token', async () => {
		const { credits, kusd, frosty, boss, payer } = await loadFixture(deployFixture);
		await credits.connect(payer).buyCredits(instance('acme'), await kusd.getAddress(), KUSD(25n), order('1'));
		expect(await kusd.balanceOf(frosty.address)).to.equal(15n * 10n ** 18n);
		expect(await kusd.balanceOf(boss.address)).to.equal(10n * 10n ** 18n);
	});

	it('emits CreditsBought with instance, payer, token, amount and orderRef', async () => {
		const { credits, usdt, payer } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await expect(credits.connect(payer).buyCredits(instance('acme'), token, USDT(10n), order('1')))
			.to.emit(credits, 'CreditsBought')
			.withArgs(instance('acme'), payer.address, token, USDT(10n), order('1'));
		expect(await credits.usedOrderRef(order('1'))).to.equal(true);
	});

	it('approves the splitter for a token once, on first use', async () => {
		const { credits, splitter, usdt, payer } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		expect(await credits.splitterApproved(token)).to.equal(false);
		await credits.connect(payer).buyCredits(instance('acme'), token, USDT(5n), order('1'));
		expect(await credits.splitterApproved(token)).to.equal(true);
		expect(await usdt.allowance(await credits.getAddress(), await splitter.getAddress())).to.equal(
			ethers.MaxUint256,
		);
		await expect(credits.connect(payer).buyCredits(instance('acme'), token, USDT(5n), order('2'))).to.not.be.reverted;
	});

	it('counts toward the cap: the payment that crosses it pays Frosty only the remainder', async () => {
		const { credits, splitter, usdt, frosty, boss, payer } = await loadFixture(deployFixture);
		await splitter.setTerms(6000, 4n * 10n ** 18n);
		await credits.connect(payer).buyCredits(instance('acme'), await usdt.getAddress(), USDT(25n), order('1'));
		expect(await usdt.balanceOf(frosty.address)).to.equal(4_000_000n);
		expect(await usdt.balanceOf(boss.address)).to.equal(21_000_000n);
		expect(await splitter.frostyPaidUsd()).to.equal(4n * 10n ** 18n);
	});

	it('rejects a zero instance, a zero orderRef and a zero amount', async () => {
		const { credits, usdt, payer } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await expect(credits.connect(payer).buyCredits(ethers.ZeroHash, token, USDT(5n), order('1')))
			.to.be.revertedWithCustomError(credits, 'ZeroInstance');
		await expect(credits.connect(payer).buyCredits(instance('acme'), token, USDT(5n), ethers.ZeroHash))
			.to.be.revertedWithCustomError(credits, 'ZeroOrderRef');
		await expect(credits.connect(payer).buyCredits(instance('acme'), token, 0n, order('1')))
			.to.be.revertedWithCustomError(credits, 'ZeroAmount');
	});

	it('rejects a reused orderRef', async () => {
		const { credits, usdt, payer } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await credits.connect(payer).buyCredits(instance('acme'), token, USDT(5n), order('1'));
		await expect(credits.connect(payer).buyCredits(instance('other'), token, USDT(5n), order('1')))
			.to.be.revertedWithCustomError(credits, 'OrderRefUsed');
	});

	it('rejects a token the splitter does not accept', async () => {
		const { credits, splitter, payer } = await loadFixture(deployFixture);
		const Mock = await ethers.getContractFactory('MockERC20');
		const other = await Mock.deploy('Other', 'OTH', 6);
		await other.mint(payer.address, USDT(100n));
		await other.connect(payer).approve(await credits.getAddress(), ethers.MaxUint256);
		await expect(credits.connect(payer).buyCredits(instance('acme'), await other.getAddress(), USDT(5n), order('1')))
			.to.be.revertedWithCustomError(splitter, 'TokenNotAccepted');
		expect(await credits.usedOrderRef(order('1'))).to.equal(false);
	});

	it('refuses payments while paused, accepts them after unpause', async () => {
		const { credits, usdt, payer } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await credits.pause();
		expect(await credits.paused()).to.equal(true);
		await expect(credits.connect(payer).buyCredits(instance('acme'), token, USDT(5n), order('1')))
			.to.be.revertedWithCustomError(credits, 'EnforcedPause');
		await credits.unpause();
		await expect(credits.connect(payer).buyCredits(instance('acme'), token, USDT(5n), order('1'))).to.not.be.reverted;
	});

	it('lets only the owner pause, unpause and rescue', async () => {
		const { credits, usdt, stranger } = await loadFixture(deployFixture);
		const guarded = credits.connect(stranger);
		await expect(guarded.pause()).to.be.revertedWithCustomError(credits, 'OwnableUnauthorizedAccount');
		await expect(guarded.unpause()).to.be.revertedWithCustomError(credits, 'OwnableUnauthorizedAccount');
		await expect(guarded.rescueToken(await usdt.getAddress(), stranger.address, 1n))
			.to.be.revertedWithCustomError(credits, 'OwnableUnauthorizedAccount');
	});

	it('rescues a stray token to the given address', async () => {
		const { credits, usdt, stranger } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
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
		await evil.mint(payer.address, KUSD(100n));
		await evil.connect(payer).approve(await credits.getAddress(), ethers.MaxUint256);
		await evil.setTarget(await credits.getAddress());
		await expect(credits.connect(payer).buyCredits(instance('acme'), await evil.getAddress(), KUSD(5n), order('1')))
			.to.be.revertedWithCustomError(credits, 'ReentrancyGuardReentrantCall');
	});
});
