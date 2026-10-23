import { ethers } from 'hardhat';
import type { Signer } from 'ethers';
import { readFileSync, writeFileSync } from 'fs';
import type { DeploymentRecord } from './deployAndRecord';

/**
 * Explicit gas limit for the credits deploy, ~1.5× the measured use on the Hardhat network,
 * rounded up to 1,000 (same rule as DEPLOY_GAS_LIMITS). test/deployCredits.test.ts fails if usage
 * exceeds it or it exceeds 2× the usage.
 */
export const CREDITS_DEPLOY_GAS_LIMIT = 1_038_000n;

/**
 * Fallback gas limit for the checkout's buyCredits, used only when live estimation fails. ~1.5× the
 * heaviest case: the first buy per token, which also approves the splitter. Same 2× bound in the test.
 */
export const CREDITS_CHECKOUT_GAS_LIMITS = { buyCredits: 428_000n };

export interface DeployCreditsParams {
	deployer: Signer;
	recordFile: string;
	/** Tests under solidity-coverage pass a scaled limit; production uses the default. */
	gasLimit?: bigint;
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
 * Deploys KalyBotCredits from the owner wallet against the recorded splitter. The record gets the
 * credits entry as soon as the tx is sent (blockNumber null) and again once it is mined.
 */
export async function deployCreditsAndRecord(params: DeployCreditsParams): Promise<DeploymentRecord> {
	const { deployer, recordFile } = params;
	const record = JSON.parse(readFileSync(recordFile, 'utf-8')) as DeploymentRecord;
	const deployerAddress = await deployer.getAddress();
	await checkPreconditions(record, deployerAddress);

	const save = () => writeFileSync(recordFile, JSON.stringify(record, null, '\t'));
	const credits = await (await ethers.getContractFactory('KalyBotCredits', deployer))
		.deploy(record.splitter!.address, deployerAddress, { gasLimit: params.gasLimit ?? CREDITS_DEPLOY_GAS_LIMIT });
	const address = await credits.getAddress();
	const txHash = credits.deploymentTransaction()!.hash;
	record.credits = { name: 'credits', address, txHash, blockNumber: null };
	save();
	console.log(`credits tx ${txHash} sent, deploying at ${address}`);

	const receipt = (await credits.deploymentTransaction()!.wait())!;
	record.credits = { name: 'credits', address, txHash: receipt.hash, blockNumber: receipt.blockNumber };
	record.checkoutGasLimits.buyCredits = CREDITS_CHECKOUT_GAS_LIMITS.buyCredits.toString();
	save();
	console.log(`credits deployed at ${address} (block ${receipt.blockNumber})`);
	return record;
}
