import { ethers } from 'hardhat';
import type { Signer } from 'ethers';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import {
	CHECKOUT_GAS_LIMITS,
	DEPLOY_GAS_LIMITS,
	FROSTY_BPS,
	FROSTY_CAP_USD,
	deployKalyBot,
	validateDeployInputs,
	type DeployedContract,
} from './deployKalyBot';

export interface TokenSpec {
	address: string;
	symbol: string;
	decimals: number;
}

/** KalyChain 3890 stablecoins, from KalySwap config. Re-checked on-chain before use. */
export const KALYCHAIN_TOKENS: TokenSpec[] = [
	{ address: '0x6318EcDbae6B469D39C38949eDC671f4bA8A6172', symbol: 'USDT', decimals: 6 },
	{ address: '0xFDb3307a16442ed5A7C040AE1600a3B3D3C8e7D9', symbol: 'KUSD', decimals: 18 },
];

/** A deploy tx that was sent; blockNumber stays null until its receipt arrives. */
export type SentRecord = Omit<DeployedContract, 'blockNumber'> & { blockNumber: number | null };

export interface DeploymentRecord {
	chainId: number;
	status: 'deploying' | 'configured';
	deployer: string;
	owner: string;
	frostyPayee: string;
	bossPayee: string;
	frostyBps: number;
	frostyCapUsd: string;
	splitter?: SentRecord;
	subscription?: SentRecord;
	credits?: SentRecord;
	tokens: TokenSpec[];
	checkoutGasLimits: { approve: string; subscribeFor: string; buyCredits?: string };
}

export interface DeployAndRecordParams {
	deployer: Signer;
	frostyPayee: string;
	bossPayee: string;
	outFile: string;
	chainId: number;
	tokens?: TokenSpec[];
	/** Tests under solidity-coverage pass scaled limits; production uses the default. */
	gasLimits?: typeof DEPLOY_GAS_LIMITS;
}

/** Fails unless every token answers with the expected symbol and decimals. */
async function checkTokens(tokens: TokenSpec[]): Promise<void> {
	for (const token of tokens) {
		const erc20 = await ethers.getContractAt('IERC20Metadata', token.address);
		const [symbol, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()]);
		if (symbol !== token.symbol || Number(decimals) !== token.decimals) {
			throw new Error(`${token.address}: expected ${token.symbol}/${token.decimals}, chain says ${symbol}/${decimals}`);
		}
	}
}

/**
 * Checks the tokens, then deploys and configures both contracts from `deployer`, which owns them.
 * The record is written before the first transaction and after each contract, so a stop part-way
 * still shows what exists. Refuses to run if `outFile` already exists.
 */
export async function deployAndRecord(params: DeployAndRecordParams): Promise<DeploymentRecord> {
	const { deployer, frostyPayee, bossPayee, outFile, chainId } = params;
	const tokens = params.tokens ?? KALYCHAIN_TOKENS;
	if (existsSync(outFile)) throw new Error(`${outFile} already records a deployment. Move it aside before deploying again.`);
	const deployerAddress = await deployer.getAddress();
	validateDeployInputs({ deployer: deployerAddress, frostyPayee, bossPayee });
	await checkTokens(tokens);

	const record: DeploymentRecord = {
		chainId,
		status: 'deploying',
		deployer: deployerAddress,
		owner: deployerAddress,
		frostyPayee,
		bossPayee,
		frostyBps: FROSTY_BPS,
		frostyCapUsd: FROSTY_CAP_USD.toString(),
		tokens,
		checkoutGasLimits: {
			approve: CHECKOUT_GAS_LIMITS.approve.toString(),
			subscribeFor: CHECKOUT_GAS_LIMITS.subscribeFor.toString(),
		},
	};
	const save = () => writeFileSync(outFile, JSON.stringify(record, null, '\t'));
	mkdirSync(dirname(outFile), { recursive: true });
	save();
	try {
		await deployKalyBot({
			deployer,
			frostyPayee,
			bossPayee,
			tokens,
			gasLimits: params.gasLimits,
			onSent: (sent) => {
				record[sent.name] = { ...sent, blockNumber: null };
				save();
				console.log(`${sent.name} tx ${sent.txHash} sent, deploying at ${sent.address}`);
			},
			onDeployed: (contract) => {
				record[contract.name] = contract;
				save();
				console.log(`${contract.name} deployed at ${contract.address} (block ${contract.blockNumber})`);
			},
		});
	} catch (err) {
		if (record.splitter || record.subscription) {
			console.error(`Deployment stopped part-way; ${deployerAddress} owns what was deployed. See ${outFile}.`);
		}
		throw err;
	}
	record.status = 'configured';
	save();
	return record;
}
