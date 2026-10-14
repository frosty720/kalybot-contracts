import { ethers } from 'hardhat';
import type { Signer } from 'ethers';

export const FROSTY_BPS = 6000;
export const FROSTY_CAP_USD = 5000n * 10n ** 18n;

/** Tier → [monthly, annual] USD price (spec §2). Same number in USDT and KUSD units. */
export const PLAN_PRICES_USD: Record<number, [number, number]> = {
	1: [19, 180], // Starter
	2: [49, 468], // Pro
	3: [99, 948], // Scale
	4: [199, 1908], // Enterprise
};

export interface DeployParams {
	deployer: Signer;
	owner: string;
	frostyPayee: string;
	bossPayee: string;
	tokens: { address: string; decimals: number }[];
}

/**
 * Deploys the splitter and subscription with the deployer as temporary owner, configures tokens
 * and prices, then starts a two-step ownership transfer to `owner` (who must call acceptOwnership).
 */
export async function deployKalyBot(params: DeployParams): Promise<{ splitter: string; subscription: string }> {
	const { deployer, owner, frostyPayee, bossPayee, tokens } = params;
	const deployerAddress = await deployer.getAddress();

	const splitter = await (await ethers.getContractFactory('KalyBotSplitter', deployer))
		.deploy(deployerAddress, frostyPayee, bossPayee, FROSTY_BPS, FROSTY_CAP_USD);
	await splitter.waitForDeployment();
	const subscription = await (await ethers.getContractFactory('KalyBotSubscription', deployer))
		.deploy(await splitter.getAddress(), deployerAddress);
	await subscription.waitForDeployment();

	for (const token of tokens) {
		await (await splitter.addToken(token.address, token.decimals)).wait();
		const unit = 10n ** BigInt(token.decimals);
		for (const [tier, [monthly, annual]] of Object.entries(PLAN_PRICES_USD)) {
			await (await subscription.setPrice(Number(tier), 0, token.address, BigInt(monthly) * unit)).wait();
			await (await subscription.setPrice(Number(tier), 1, token.address, BigInt(annual) * unit)).wait();
		}
	}

	await (await splitter.transferOwnership(owner)).wait();
	await (await subscription.transferOwnership(owner)).wait();

	return { splitter: await splitter.getAddress(), subscription: await subscription.getAddress() };
}
