import { ethers } from 'hardhat';
import type { BaseContract, Signer } from 'ethers';

export const FROSTY_BPS = 6000;
export const FROSTY_CAP_USD = 5000n * 10n ** 18n;

/** Tier → [monthly, annual] USD price (spec §2). Same number in USDT and KUSD units. */
export const PLAN_PRICES_USD: Record<number, [number, number]> = {
	1: [19, 180], // Starter
	2: [49, 468], // Pro
	3: [99, 948], // Scale
	4: [199, 1908], // Enterprise
};

export interface DeployInputs {
	deployer: string;
	owner: string;
	frostyPayee: string;
	bossPayee: string;
}

/** Rejects inputs that would leave the contracts owned by the hot deployer key or pay a dead address. */
export function validateDeployInputs(inputs: DeployInputs): void {
	for (const [name, value] of Object.entries(inputs)) {
		if (!ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error(`${name} must be a non-zero address`);
	}
	if (inputs.owner.toLowerCase() === inputs.deployer.toLowerCase()) {
		throw new Error('owner must be the cold wallet, not the deployer key');
	}
}

export interface DeployedContract {
	name: 'splitter' | 'subscription';
	address: string;
	txHash: string;
	blockNumber: number;
}

/**
 * Explicit gas limits for every deploy transaction. Hardhat-ethers estimates gas against the
 * `pending` block, which KalyChain's Besu has rejected before, so nothing is left to estimation.
 * Each limit is the gas measured on the Hardhat network with ~1.5× headroom, rounded up to 1,000.
 * setPrice is the exception: a token's first price write costs ~99k and later ones ~51.6k, so the
 * limit sits just above the cold write, which is also the most 2× the cheapest write allows.
 * test/deployKalyBot.test.ts fails if usage exceeds a limit or a limit exceeds 2× usage.
 */
export const DEPLOY_GAS_LIMITS = {
	splitter: 1_689_000n,
	subscription: 1_625_000n,
	addToken: 78_000n,
	setPrice: 103_000n,
	transferOwnership: 72_000n,
};

/**
 * Fallback gas limits for the checkout page (Plan 3). The page estimates live and adds 50%, and
 * uses these only when estimation fails. A gas limit is also a spending floor (the wallet needs
 * limit × max fee in KLC to sign), so they stay close to measured usage. Measured on the mock
 * tokens; compare against the first real payment after mainnet deploy.
 */
export const CHECKOUT_GAS_LIMITS = { approve: 71_000n, subscribeFor: 328_000n };

export interface DeployParams {
	deployer: Signer;
	owner: string;
	frostyPayee: string;
	bossPayee: string;
	tokens: { address: string; decimals: number }[];
	onDeployed?: (contract: DeployedContract) => void;
}

async function report(
	name: DeployedContract['name'],
	contract: BaseContract,
	onDeployed: DeployParams['onDeployed'],
): Promise<void> {
	const receipt = (await contract.deploymentTransaction()!.wait())!;
	onDeployed?.({ name, address: await contract.getAddress(), txHash: receipt.hash, blockNumber: receipt.blockNumber });
}

/**
 * Deploys the splitter and subscription with the deployer as temporary owner, configures tokens
 * and prices, then starts a two-step ownership transfer to `owner` (who must call acceptOwnership).
 */
export async function deployKalyBot(params: DeployParams): Promise<{ splitter: string; subscription: string }> {
	const { deployer, owner, frostyPayee, bossPayee, tokens } = params;
	const deployerAddress = await deployer.getAddress();
	validateDeployInputs({ deployer: deployerAddress, owner, frostyPayee, bossPayee });

	const splitter = await (await ethers.getContractFactory('KalyBotSplitter', deployer))
		.deploy(deployerAddress, frostyPayee, bossPayee, FROSTY_BPS, FROSTY_CAP_USD, { gasLimit: DEPLOY_GAS_LIMITS.splitter });
	await splitter.waitForDeployment();
	await report('splitter', splitter, params.onDeployed);
	const subscription = await (await ethers.getContractFactory('KalyBotSubscription', deployer))
		.deploy(await splitter.getAddress(), deployerAddress, { gasLimit: DEPLOY_GAS_LIMITS.subscription });
	await subscription.waitForDeployment();
	await report('subscription', subscription, params.onDeployed);

	for (const token of tokens) {
		await (await splitter.addToken(token.address, token.decimals, { gasLimit: DEPLOY_GAS_LIMITS.addToken })).wait();
		const unit = 10n ** BigInt(token.decimals);
		for (const [tier, [monthly, annual]] of Object.entries(PLAN_PRICES_USD)) {
			await (await subscription.setPrice(Number(tier), 0, token.address, BigInt(monthly) * unit, { gasLimit: DEPLOY_GAS_LIMITS.setPrice })).wait();
			await (await subscription.setPrice(Number(tier), 1, token.address, BigInt(annual) * unit, { gasLimit: DEPLOY_GAS_LIMITS.setPrice })).wait();
		}
	}

	await (await splitter.transferOwnership(owner, { gasLimit: DEPLOY_GAS_LIMITS.transferOwnership })).wait();
	await (await subscription.transferOwnership(owner, { gasLimit: DEPLOY_GAS_LIMITS.transferOwnership })).wait();

	return { splitter: await splitter.getAddress(), subscription: await subscription.getAddress() };
}
