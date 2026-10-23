import { ethers } from 'hardhat';
import type { Signer } from 'ethers';
import type { KalyBotSubscription } from '../../typechain-types';
import { readFileSync, writeFileSync } from 'fs';
import type { DeploymentRecord, PlanPriceRecord, TokenSpec } from './deployAndRecord';
import { PLAN_PRICES_USD } from './deployKalyBot';

/**
 * Explicit gas limits for the subscription redeploy, ~1.5× the measured use on the Hardhat network,
 * rounded up to 1,000 (same rule as DEPLOY_GAS_LIMITS). setPrice is sized on the first price per token,
 * which also approves the splitter. test/redeploySubscription.test.ts fails if usage exceeds a limit
 * or a limit exceeds 2× the heaviest use of its kind.
 */
export const SUBSCRIPTION_REDEPLOY_GAS_LIMITS = { deploy: 1_690_000n, setPrice: 150_000n };

export interface RedeploySubscriptionParams {
	deployer: Signer;
	recordFile: string;
	/** Tests under solidity-coverage pass scaled limits; production uses the defaults. */
	gasLimits?: typeof SUBSCRIPTION_REDEPLOY_GAS_LIMITS;
}

/** The sixteen prices the contract must hold: every tier and period in every recorded token, in that token's units. */
export function expectedPlanPrices(tokens: TokenSpec[]): PlanPriceRecord[] {
	return tokens.flatMap((token) => Object.entries(PLAN_PRICES_USD).flatMap(([tier, usdByPeriod]) => usdByPeriod.map((usd, period) => ({
		tier: Number(tier),
		period,
		token: token.address,
		price: (BigInt(usd) * 10n ** BigInt(token.decimals)).toString(),
	}))));
}

/** Reads every expected price back from the contract and throws unless each one matches. */
export async function verifyPlanPrices(subscription: KalyBotSubscription, expected: PlanPriceRecord[]): Promise<void> {
	for (const { tier, period, token, price } of expected) {
		const onChain = await subscription.prices(tier, period, token);
		if (onChain.toString() !== price) throw new Error(`Price for tier ${tier} period ${period} in ${token} is ${onChain}, expected ${price}.`);
	}
}

/** Refuses, before any transaction, unless the record can take a replacement subscription contract from `deployer`. */
async function checkPreconditions(record: DeploymentRecord, deployerAddress: string): Promise<void> {
	if (record.status !== 'configured' || !record.splitter || !record.subscription) throw new Error('The record is not a configured deployment.');
	if (record.subscriptionPrevious) throw new Error(`The record already replaced a subscription contract (previous ${record.subscriptionPrevious.address}).`);
	if (deployerAddress !== record.owner) throw new Error(`Deployer ${deployerAddress} is not the recorded owner ${record.owner}.`);
	const splitter = await ethers.getContractAt('KalyBotSplitter', record.splitter.address);
	for (const token of record.tokens) {
		if ((await splitter.usdScale(token.address)) === 0n) throw new Error(`The splitter does not accept ${token.symbol} (${token.address}).`);
	}
}

/**
 * Deploys a new KalyBotSubscription from the owner wallet against the recorded splitter, sets all
 * sixteen plan prices and reads them back. The old entry moves to `subscriptionPrevious`; the new one
 * is written as soon as its tx is sent (blockNumber null), again once mined, and gets its `prices` only
 * after they are verified. The old contract is left running: pausing it is a separate owner step.
 */
export async function redeploySubscriptionAndRecord(params: RedeploySubscriptionParams): Promise<DeploymentRecord> {
	const { deployer, recordFile } = params;
	const record = JSON.parse(readFileSync(recordFile, 'utf-8')) as DeploymentRecord;
	const deployerAddress = await deployer.getAddress();
	await checkPreconditions(record, deployerAddress);

	const save = (): void => writeFileSync(recordFile, JSON.stringify(record, null, '\t'));
	const limits = params.gasLimits ?? SUBSCRIPTION_REDEPLOY_GAS_LIMITS;
	const previous = record.subscription!;
	const subscription = await (await ethers.getContractFactory('KalyBotSubscription', deployer))
		.deploy(record.splitter!.address, deployerAddress, { gasLimit: limits.deploy });
	const address = await subscription.getAddress();
	const txHash = subscription.deploymentTransaction()!.hash;
	record.subscriptionPrevious = previous;
	record.subscription = { name: 'subscription', address, txHash, blockNumber: null };
	save();
	console.log(`subscription tx ${txHash} sent, deploying at ${address} (replaces ${previous.address})`);

	const receipt = (await subscription.deploymentTransaction()!.wait())!;
	record.subscription = { name: 'subscription', address, txHash: receipt.hash, blockNumber: receipt.blockNumber };
	save();
	console.log(`subscription deployed at ${address} (block ${receipt.blockNumber})`);

	const expected = expectedPlanPrices(record.tokens);
	for (const { tier, period, token, price } of expected) {
		await (await subscription.setPrice(tier, period, token, BigInt(price), { gasLimit: limits.setPrice })).wait();
	}
	await verifyPlanPrices(subscription, expected);
	record.subscription = { name: 'subscription', address, txHash: receipt.hash, blockNumber: receipt.blockNumber, prices: expected };
	save();
	console.log(`subscription prices set and verified: ${expected.length}`);
	return record;
}
