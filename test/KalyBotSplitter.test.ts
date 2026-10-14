import { ethers } from 'hardhat';
import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

const USD = 10n ** 18n;
const USDT = (n: bigint) => n * 10n ** 6n;
const KUSD = (n: bigint) => n * 10n ** 18n;
const SOURCE_PAY = 0;
const SOURCE_SWEEP = 1;

async function deployFixture() {
	const [owner, frosty, boss, payer, stranger] = await ethers.getSigners();
	const Mock = await ethers.getContractFactory('MockERC20');
	const usdt = await Mock.deploy('Tether', 'USDT', 6);
	const kusd = await Mock.deploy('KUSD Stablecoin', 'KUSD', 18);
	const Splitter = await ethers.getContractFactory('KalyBotSplitter');
	const splitter = await Splitter.deploy(owner.address, frosty.address, boss.address, 6000, 5000n * USD);
	await splitter.addToken(await usdt.getAddress(), 6);
	await splitter.addToken(await kusd.getAddress(), 18);
	for (const token of [usdt, kusd]) {
		await token.mint(payer.address, 10n ** 30n);
		await token.connect(payer).approve(await splitter.getAddress(), ethers.MaxUint256);
	}
	return { splitter, usdt, kusd, owner, frosty, boss, payer, stranger };
}

describe('KalyBotSplitter: split and sweep', () => {
	it('splits a USDT payment 60/40 and sends both shares out', async () => {
		const { splitter, usdt, frosty, boss, payer } = await loadFixture(deployFixture);
		await splitter.connect(payer).split(await usdt.getAddress(), USDT(19n));
		expect(await usdt.balanceOf(frosty.address)).to.equal(11_400_000n);
		expect(await usdt.balanceOf(boss.address)).to.equal(7_600_000n);
		expect(await usdt.balanceOf(await splitter.getAddress())).to.equal(0n);
		expect(await splitter.frostyPaidUsd()).to.equal(114n * USD / 10n);
		expect(await splitter.totalRevenueUsd()).to.equal(19n * USD);
	});

	it('splits a KUSD payment using 18 decimals', async () => {
		const { splitter, kusd, frosty, boss, payer } = await loadFixture(deployFixture);
		await splitter.connect(payer).split(await kusd.getAddress(), KUSD(49n));
		expect(await kusd.balanceOf(frosty.address)).to.equal(294n * 10n ** 17n);
		expect(await kusd.balanceOf(boss.address)).to.equal(196n * 10n ** 17n);
		expect(await splitter.frostyPaidUsd()).to.equal(294n * USD / 10n);
	});

	it('counts USDT and KUSD toward the same USD cap', async () => {
		const { splitter, usdt, kusd, payer } = await loadFixture(deployFixture);
		await splitter.connect(payer).split(await usdt.getAddress(), USDT(100n));
		await splitter.connect(payer).split(await kusd.getAddress(), KUSD(100n));
		expect(await splitter.frostyPaidUsd()).to.equal(120n * USD);
		expect(await splitter.totalRevenueUsd()).to.equal(200n * USD);
	});

	it('caps Frosty at exactly the remainder, then pays the boss everything', async () => {
		const { splitter, usdt, frosty, boss, payer } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		// 8,300 USDT at 60% = 4,980 to Frosty; $20 of cap room left
		await splitter.connect(payer).split(token, USDT(8300n));
		expect(await splitter.frostyPaidUsd()).to.equal(4980n * USD);
		// next 100 USDT: 60% would be 60, but only 20 fits under the cap
		await expect(splitter.connect(payer).split(token, USDT(100n)))
			.to.emit(splitter, 'Split')
			.withArgs(token, USDT(100n), USDT(20n), USDT(80n), 5000n * USD, SOURCE_PAY);
		expect(await splitter.frostyPaidUsd()).to.equal(5000n * USD);
		// after the cap: 100% to the boss
		const frostyBefore = await usdt.balanceOf(frosty.address);
		const bossBefore = await usdt.balanceOf(boss.address);
		await splitter.connect(payer).split(token, USDT(50n));
		expect(await usdt.balanceOf(frosty.address)).to.equal(frostyBefore);
		expect(await usdt.balanceOf(boss.address)).to.equal(bossBefore + USDT(50n));
	});

	it('sends a payment too small to split entirely to the boss', async () => {
		const { splitter, usdt, boss, payer } = await loadFixture(deployFixture);
		await splitter.connect(payer).split(await usdt.getAddress(), 1n);
		expect(await usdt.balanceOf(boss.address)).to.equal(1n);
		expect(await splitter.frostyPaidUsd()).to.equal(0n);
	});

	it('sweeps tokens that arrived by plain transfer (bridged Yellow Card USDT)', async () => {
		const { splitter, usdt, frosty, boss, payer, stranger } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await usdt.connect(payer).transfer(await splitter.getAddress(), USDT(50n));
		await expect(splitter.connect(stranger).sweep(token))
			.to.emit(splitter, 'Split')
			.withArgs(token, USDT(50n), USDT(30n), USDT(20n), 30n * USD, SOURCE_SWEEP);
		expect(await usdt.balanceOf(frosty.address)).to.equal(USDT(30n));
		expect(await usdt.balanceOf(boss.address)).to.equal(USDT(20n));
	});

	it('reverts a sweep when there is nothing to split', async () => {
		const { splitter, usdt } = await loadFixture(deployFixture);
		await expect(splitter.sweep(await usdt.getAddress())).to.be.revertedWithCustomError(splitter, 'NothingToSweep');
	});

	it('rejects tokens that were never added', async () => {
		const { splitter, payer } = await loadFixture(deployFixture);
		const Mock = await ethers.getContractFactory('MockERC20');
		const other = await Mock.deploy('Other', 'OTH', 18);
		await other.mint(payer.address, KUSD(10n));
		await other.connect(payer).approve(await splitter.getAddress(), ethers.MaxUint256);
		await expect(splitter.connect(payer).split(await other.getAddress(), KUSD(10n)))
			.to.be.revertedWithCustomError(splitter, 'TokenNotAccepted');
		await expect(splitter.sweep(await other.getAddress())).to.be.revertedWithCustomError(splitter, 'TokenNotAccepted');
	});

	it('rejects a constructor with a zero payee or bps over 100%', async () => {
		const [owner, frosty] = await ethers.getSigners();
		const Splitter = await ethers.getContractFactory('KalyBotSplitter');
		await expect(Splitter.deploy(owner.address, frosty.address, ethers.ZeroAddress, 6000, 5000n * USD))
			.to.be.revertedWithCustomError(Splitter, 'ZeroAddress');
		await expect(Splitter.deploy(owner.address, frosty.address, frosty.address, 10_001, 5000n * USD))
			.to.be.revertedWithCustomError(Splitter, 'BpsTooHigh');
	});

	it('addToken rejects the zero address and more than 18 decimals', async () => {
		const { splitter, usdt } = await loadFixture(deployFixture);
		await expect(splitter.addToken(ethers.ZeroAddress, 6)).to.be.revertedWithCustomError(splitter, 'ZeroAddress');
		await expect(splitter.addToken(await usdt.getAddress(), 19)).to.be.revertedWithCustomError(splitter, 'DecimalsTooHigh');
	});

	it('keeps addToken and removeToken owner-only', async () => {
		const { splitter, usdt, stranger } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await expect(splitter.connect(stranger).addToken(token, 6))
			.to.be.revertedWithCustomError(splitter, 'OwnableUnauthorizedAccount').withArgs(stranger.address);
		await expect(splitter.connect(stranger).removeToken(token))
			.to.be.revertedWithCustomError(splitter, 'OwnableUnauthorizedAccount').withArgs(stranger.address);
	});

	it('removeToken stops a token from being split or swept', async () => {
		const { splitter, usdt, payer } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		expect(await splitter.usdScale(token)).to.equal(10n ** 12n);
		await expect(splitter.removeToken(token)).to.emit(splitter, 'TokenRemoved').withArgs(token);
		expect(await splitter.usdScale(token)).to.equal(0n);
		await expect(splitter.connect(payer).split(token, USDT(1n))).to.be.revertedWithCustomError(splitter, 'TokenNotAccepted');
		await expect(splitter.sweep(token)).to.be.revertedWithCustomError(splitter, 'TokenNotAccepted');
	});
});
