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
	frostyPayee: string;
	bossPayee: string;
}

/** Rejects a zero or malformed address, so no payment can be split to a dead address. */
export function validateDeployInputs(inputs: DeployInputs): void {
	for (const [name, value] of Object.entries(inputs)) {
		if (!ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error(`${name} must be a non-zero address`);
	}
}

export interface DeployedContract {
	name: 'splitter' | 'subscription';
	address: string;
	txHash: string;
	blockNumber: number;
}

export interface SentContract {
	name: DeployedContract['name'];
	address: string;
	txHash: string;
}

/**
 * Explicit gas limits for every deploy transaction. Hardhat-ethers estimates gas against the
 * `pending` block, which KalyChain's Besu has rejected before, so nothing is left to estimation.
 * Each limit is ~1.5× the heaviest measured use of that kind on the Hardhat network, rounded up to
 * 1,000. The first setPrice per token is the heaviest because it approves the splitter. The deployer
 * pays, so the 2× bound is per kind, not per transaction. test/deployKalyBot.test.ts fails if usage
 * exceeds a limit or a limit exceeds 2× the heaviest use of its kind.
 */
export const DEPLOY_GAS_LIMITS = {
	splitter: 1_689_000n,
	subscription: 1_625_000n,
	addToken: 78_000n,
	setPrice: 150_000n,
};

/**
 * Fallback gas limits for the checkout page (Plan 3). The page estimates live and adds 50%, and
 * uses these only when estimation fails. Each is ~1.5× the estimateGas of the heaviest case of
 * its kind (approve; first payment on a fresh deployment; plan change), rounded up to 1,000. A gas
 * limit is also a spending floor (the wallet needs limit × max fee in KLC to sign), so the 2×
 * bound in test/deployKalyBot.test.ts protects customers' balances. Measured on the mock tokens;
 * compare against the first real payment after mainnet deploy.
 */
export const CHECKOUT_GAS_LIMITS = { approve: 71_000n, subscribeFor: 400_000n };

export interface DeployParams {
	deployer: Signer;
	frostyPayee: string;
	bossPayee: string;
	tokens: { address: string; decimals: number }[];
	/** Limits for every deploy tx. Tests under solidity-coverage pass scaled limits; production uses the default. */
	gasLimits?: typeof DEPLOY_GAS_LIMITS;
	/** Called right after a deploy tx is sent, before it is mined. */
	onSent?: (sent: SentContract) => void;
	onDeployed?: (contract: DeployedContract) => void;
}

async function announceSent(name: DeployedContract['name'], contract: BaseContract, onSent: DeployParams['onSent']): Promise<void> {
	onSent?.({ name, address: await contract.getAddress(), txHash: contract.deploymentTransaction()!.hash });
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
 * Deploys the splitter and subscription, configures tokens and prices. The deploying wallet is the
 * owner of both contracts from the start (Frosty, 2026-10-15: deploy from the owner wallet).
 */
export async function deployKalyBot(params: DeployParams): Promise<{ splitter: string; subscription: string }> {
	const { deployer, frostyPayee, bossPayee, tokens } = params;
	const limits = params.gasLimits ?? DEPLOY_GAS_LIMITS;
	const deployerAddress = await deployer.getAddress();
	validateDeployInputs({ deployer: deployerAddress, frostyPayee, bossPayee });

	const splitter = await (await ethers.getContractFactory('KalyBotSplitter', deployer))
		.deploy(deployerAddress, frostyPayee, bossPayee, FROSTY_BPS, FROSTY_CAP_USD, { gasLimit: limits.splitter });
	await announceSent('splitter', splitter, params.onSent);
	await splitter.waitForDeployment();
	await report('splitter', splitter, params.onDeployed);
	const subscription = await (await ethers.getContractFactory('KalyBotSubscription', deployer))
		.deploy(await splitter.getAddress(), deployerAddress, { gasLimit: limits.subscription });
	await announceSent('subscription', subscription, params.onSent);
	await subscription.waitForDeployment();
	await report('subscription', subscription, params.onDeployed);

	for (const token of tokens) {
		await (await splitter.addToken(token.address, token.decimals, { gasLimit: limits.addToken })).wait();
		const unit = 10n ** BigInt(token.decimals);
		for (const [tier, [monthly, annual]] of Object.entries(PLAN_PRICES_USD)) {
			await (await subscription.setPrice(Number(tier), 0, token.address, BigInt(monthly) * unit, { gasLimit: limits.setPrice })).wait();
			await (await subscription.setPrice(Number(tier), 1, token.address, BigInt(annual) * unit, { gasLimit: limits.setPrice })).wait();
		}
	}

	return { splitter: await splitter.getAddress(), subscription: await subscription.getAddress() };
}
