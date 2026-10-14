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

describe('KalyBotSplitter: owner and boss controls', () => {
	it('lets the owner change terms, logged as TermsChanged', async () => {
		const { splitter } = await loadFixture(deployFixture);
		await expect(splitter.setTerms(5000, 6000n * USD))
			.to.emit(splitter, 'TermsChanged')
			.withArgs(6000, 5000, 5000n * USD, 6000n * USD);
		expect(await splitter.frostyBps()).to.equal(5000);
		expect(await splitter.frostyCapUsd()).to.equal(6000n * USD);
	});

	it('refuses terms from anyone but the owner', async () => {
		const { splitter, frosty, boss } = await loadFixture(deployFixture);
		for (const signer of [frosty, boss]) {
			await expect(splitter.connect(signer).setTerms(9000, 9000n * USD))
				.to.be.revertedWithCustomError(splitter, 'OwnableUnauthorizedAccount');
		}
	});

	it('refuses a cap below what Frosty was already paid, or bps over 100%', async () => {
		const { splitter, usdt, payer } = await loadFixture(deployFixture);
		await splitter.connect(payer).split(await usdt.getAddress(), USDT(1000n)); // 600 paid
		await expect(splitter.setTerms(6000, 599n * USD)).to.be.revertedWithCustomError(splitter, 'CapBelowPaid');
		await expect(splitter.setTerms(10_001, 5000n * USD)).to.be.revertedWithCustomError(splitter, 'BpsTooHigh');
		await expect(splitter.setTerms(6000, 600n * USD)).to.emit(splitter, 'TermsChanged');
	});

	it('raising the cap after it was reached resumes Frosty\'s share on new payments only', async () => {
		const { splitter, usdt, frosty, payer } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await splitter.connect(payer).split(token, USDT(10_000n)); // cap reached: 5,000 paid
		const frostyAtCap = await usdt.balanceOf(frosty.address);
		expect(frostyAtCap).to.equal(USDT(5000n));
		await splitter.setTerms(6000, 5100n * USD);
		await splitter.connect(payer).split(token, USDT(100n)); // 60 fits under the new cap
		expect(await usdt.balanceOf(frosty.address)).to.equal(frostyAtCap + USDT(60n));
		expect(await splitter.frostyPaidUsd()).to.equal(5060n * USD);
	});

	it('lets the owner change Frosty\'s payout address', async () => {
		const { splitter, stranger } = await loadFixture(deployFixture);
		await expect(splitter.setFrostyPayee(stranger.address)).to.emit(splitter, 'FrostyPayeeSet');
		expect(await splitter.frostyPayee()).to.equal(stranger.address);
	});

	it('lets only the boss change the boss payout address — not the owner', async () => {
		const { splitter, owner, boss, stranger } = await loadFixture(deployFixture);
		await expect(splitter.connect(owner).setBossPayee(stranger.address))
			.to.be.revertedWithCustomError(splitter, 'NotBossPayee');
		await expect(splitter.connect(boss).setBossPayee(stranger.address))
			.to.emit(splitter, 'BossPayeeSet')
			.withArgs(boss.address, stranger.address);
		expect(await splitter.bossPayee()).to.equal(stranger.address);
	});

	it('rejects zero payout addresses', async () => {
		const { splitter, boss } = await loadFixture(deployFixture);
		await expect(splitter.setFrostyPayee(ethers.ZeroAddress)).to.be.revertedWithCustomError(splitter, 'ZeroAddress');
		await expect(splitter.connect(boss).setBossPayee(ethers.ZeroAddress)).to.be.revertedWithCustomError(splitter, 'ZeroAddress');
	});

	it('rescues a stray non-revenue token to the boss only, never a revenue token', async () => {
		const { splitter, usdt, boss, payer } = await loadFixture(deployFixture);
		const Mock = await ethers.getContractFactory('MockERC20');
		const stray = await Mock.deploy('Stray', 'STR', 18);
		await stray.mint(await splitter.getAddress(), KUSD(5n));
		await expect(splitter.rescueToken(await stray.getAddress(), KUSD(5n)))
			.to.emit(splitter, 'TokenRescued')
			.withArgs(await stray.getAddress(), boss.address, KUSD(5n));
		expect(await stray.balanceOf(boss.address)).to.equal(KUSD(5n));
		await usdt.connect(payer).transfer(await splitter.getAddress(), USDT(5n));
		await expect(splitter.rescueToken(await usdt.getAddress(), USDT(5n)))
			.to.be.revertedWithCustomError(splitter, 'CannotRescueRevenueToken');
	});

	it('blocks a token that re-enters split()', async () => {
		const { splitter, payer } = await loadFixture(deployFixture);
		const Reentrant = await ethers.getContractFactory('ReentrantToken');
		const evil = await Reentrant.deploy();
		await splitter.addToken(await evil.getAddress(), 18);
		await evil.setTarget(await splitter.getAddress());
		await evil.mint(payer.address, KUSD(10n));
		await evil.connect(payer).approve(await splitter.getAddress(), ethers.MaxUint256);
		await expect(splitter.connect(payer).split(await evil.getAddress(), KUSD(1n)))
			.to.be.revertedWithCustomError(splitter, 'ReentrancyGuardReentrantCall');
	});

	it('transfers ownership in two steps', async () => {
		const { splitter, boss } = await loadFixture(deployFixture);
		await splitter.transferOwnership(boss.address);
		expect(await splitter.pendingOwner()).to.equal(boss.address);
		await splitter.connect(boss).acceptOwnership();
		expect(await splitter.owner()).to.equal(boss.address);
	});

	it('keeps setFrostyPayee and rescueToken owner-only', async () => {
		const { splitter, usdt, boss, stranger } = await loadFixture(deployFixture);
		for (const signer of [stranger, boss]) {
			await expect(splitter.connect(signer).setFrostyPayee(stranger.address))
				.to.be.revertedWithCustomError(splitter, 'OwnableUnauthorizedAccount').withArgs(signer.address);
			await expect(splitter.connect(signer).rescueToken(await usdt.getAddress(), 1n))
				.to.be.revertedWithCustomError(splitter, 'OwnableUnauthorizedAccount').withArgs(signer.address);
		}
	});

	it('rescues a removed token\'s stranded balance to the boss', async () => {
		const { splitter, usdt, frosty, boss, payer } = await loadFixture(deployFixture);
		const token = await usdt.getAddress();
		await splitter.removeToken(token);
		await usdt.connect(payer).transfer(await splitter.getAddress(), USDT(7n));
		const frostyBefore = await usdt.balanceOf(frosty.address);
		const bossBefore = await usdt.balanceOf(boss.address);
		await splitter.rescueToken(token, USDT(7n));
		expect(await usdt.balanceOf(boss.address)).to.equal(bossBefore + USDT(7n));
		expect(await usdt.balanceOf(frosty.address)).to.equal(frostyBefore);
		expect(await usdt.balanceOf(await splitter.getAddress())).to.equal(0n);
	});
});
