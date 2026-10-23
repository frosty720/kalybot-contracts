import { ethers } from 'hardhat';
import type { Signer } from 'ethers';
import type { KalyBotCredits } from '../../typechain-types';
import { readFileSync, writeFileSync } from 'fs';
import type { DeploymentRecord, TokenSpec } from './deployAndRecord';

/** Pack → USD price (spec §2.3), the same number in USDT and KUSD units. Mirrors the control plane's CREDIT_PACKS. */
export const CREDIT_PACK_PRICES_USD: Record<number, number> = { 1: 5, 2: 10, 3: 25 };

/**
 * Explicit gas limits for the credits deploy, ~1.5× the measured use on the Hardhat network, rounded
 * up to 1,000 (same rule as DEPLOY_GAS_LIMITS). setPrice is sized on the first price per token, which
 * also approves the splitter. test/deployCredits.test.ts fails if usage exceeds a limit or a limit
 * exceeds 2× the heaviest use of its kind.
 */
export const CREDITS_DEPLOY_GAS_LIMITS = { deploy: 1_246_000n, setPrice: 148_000n };

/**
 * Fallback gas limit for the checkout's buyCredits, used only when live estimation fails. ~1.5× the
 * estimate of a buy. Same 2× bound in the test.
 */
export const CREDITS_CHECKOUT_GAS_LIMITS = { buyCredits: 364_000n };

export interface DeployCreditsParams {
	deployer: Signer;
	recordFile: string;
	/** Tests under solidity-coverage pass scaled limits; production uses the defaults. */
	gasLimits?: typeof CREDITS_DEPLOY_GAS_LIMITS;
}

export interface PackPrice {
	packId: number;
	token: string;
	price: string;
}

/** The six prices the contract must hold: every pack in every recorded token, in that token's units. */
export function expectedPrices(tokens: TokenSpec[]): PackPrice[] {
	return tokens.flatMap((token) => Object.entries(CREDIT_PACK_PRICES_USD).map(([packId, usd]) => ({
		packId: Number(packId),
		token: token.address,
		price: (BigInt(usd) * 10n ** BigInt(token.decimals)).toString(),
	})));
}

/** Reads every expected price back from the contract and throws unless each one matches. */
export async function verifyPrices(credits: KalyBotCredits, expected: PackPrice[]): Promise<void> {
	for (const { packId, token, price } of expected) {
		const onChain = await credits.prices(packId, token);
		if (onChain.toString() !== price) throw new Error(`Price for pack ${packId} in ${token} is ${onChain}, expected ${price}.`);
	}
}

/** Refuses, before any transaction, unless the record can take a credits contract from `deployer`. */
async function checkPreconditions(record: DeploymentRecord, deployerAddress: string): Promise<void> {
	if (record.status !== 'configured' || !record.splitter) throw new Error('The record is not a configured deployment.');
	if (record.credits) throw new Error(`The record already has a credits contract at ${record.credits.address}.`);
	if (deployerAddress !== record.owner) throw new Error(`Deployer ${deployerAddress} is not the recorded owner ${record.owner}.`);
	const splitter = await ethers.getContractAt('KalyBotSplitter', record.splitter.address);
	for (const token of record.tokens) {
		if ((await splitter.usdScale(token.address)) === 0n) throw new Error(`The splitter does not accept ${token.symbol} (${token.address}).`);
	}
}

/**
 * Deploys KalyBotCredits from the owner wallet against the recorded splitter, sets all six pack
 * prices and reads them back. The record gets the credits entry as soon as the tx is sent
 * (blockNumber null), again once it is mined, and its `prices` only after they are verified.
 */
export async function deployCreditsAndRecord(params: DeployCreditsParams): Promise<DeploymentRecord> {
	const { deployer, recordFile } = params;
	const record = JSON.parse(readFileSync(recordFile, 'utf-8')) as DeploymentRecord;
	const deployerAddress = await deployer.getAddress();
	await checkPreconditions(record, deployerAddress);

	const save = () => writeFileSync(recordFile, JSON.stringify(record, null, '\t'));
	const limits = params.gasLimits ?? CREDITS_DEPLOY_GAS_LIMITS;
	const credits = await (await ethers.getContractFactory('KalyBotCredits', deployer))
		.deploy(record.splitter!.address, deployerAddress, { gasLimit: limits.deploy });
	const address = await credits.getAddress();
	const txHash = credits.deploymentTransaction()!.hash;
	record.credits = { name: 'credits', address, txHash, blockNumber: null };
	save();
	console.log(`credits tx ${txHash} sent, deploying at ${address}`);

	const receipt = (await credits.deploymentTransaction()!.wait())!;
	record.credits = { name: 'credits', address, txHash: receipt.hash, blockNumber: receipt.blockNumber };
	save();
	console.log(`credits deployed at ${address} (block ${receipt.blockNumber})`);

	const expected = expectedPrices(record.tokens);
	for (const { packId, token, price } of expected) {
		await (await credits.setPrice(packId, token, BigInt(price), { gasLimit: limits.setPrice })).wait();
	}
	await verifyPrices(credits, expected);
	record.credits = { name: 'credits', address, txHash: receipt.hash, blockNumber: receipt.blockNumber, prices: expected };
	record.checkoutGasLimits.buyCredits = CREDITS_CHECKOUT_GAS_LIMITS.buyCredits.toString();
	save();
	console.log(`credits prices set and verified: ${expected.length}`);
	return record;
}
