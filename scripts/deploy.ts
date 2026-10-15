import { ethers, network } from 'hardhat';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import {
	CHECKOUT_GAS_LIMITS,
	FROSTY_BPS,
	FROSTY_CAP_USD,
	deployKalyBot,
	validateDeployInputs,
	type DeployedContract,
} from './lib/deployKalyBot';

const OUT_DIR = 'deployments';
const OUT_FILE = `${OUT_DIR}/kalychain.json`;

/** KalyChain 3890 stablecoins, from KalySwap config. Re-checked on-chain below before use. */
const TOKENS = [
	{ address: '0x6318EcDbae6B469D39C38949eDC671f4bA8A6172', symbol: 'USDT', decimals: 6 },
	{ address: '0xFDb3307a16442ed5A7C040AE1600a3B3D3C8e7D9', symbol: 'KUSD', decimals: 18 },
];

/** A deploy tx that was sent; blockNumber stays null until its receipt arrives. */
type SentRecord = Omit<DeployedContract, 'blockNumber'> & { blockNumber: number | null };

interface DeploymentRecord {
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
	tokens: typeof TOKENS;
	checkoutGasLimits: { approve: string; subscribeFor: string };
}

function requireAddress(name: string): string {
	const value = process.env[name];
	if (!value || !ethers.isAddress(value)) throw new Error(`${name} must be set to a valid address`);
	return value;
}

function save(record: DeploymentRecord): void {
	writeFileSync(OUT_FILE, JSON.stringify(record, null, '\t'));
}

async function main() {
	if (network.config.chainId !== 3890) throw new Error('Run with --network kalychain');
	if (existsSync(OUT_FILE)) throw new Error(`${OUT_FILE} already records a deployment. Move it aside before deploying again.`);
	const [deployer] = await ethers.getSigners();
	if (!deployer) throw new Error('DEPLOYER_PRIVATE_KEY is not set');
	const deployerAddress = await deployer.getAddress();
	const owner = requireAddress('OWNER_ADDRESS');
	const frostyPayee = requireAddress('FROSTY_PAYEE');
	const bossPayee = requireAddress('BOSS_PAYEE');
	validateDeployInputs({ deployer: deployerAddress, owner, frostyPayee, bossPayee });

	for (const token of TOKENS) {
		const erc20 = await ethers.getContractAt('IERC20Metadata', token.address);
		const [symbol, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()]);
		if (symbol !== token.symbol || Number(decimals) !== token.decimals) {
			throw new Error(`${token.address}: expected ${token.symbol}/${token.decimals}, chain says ${symbol}/${decimals}`);
		}
	}

	const record: DeploymentRecord = {
		chainId: 3890,
		status: 'deploying',
		deployer: deployerAddress,
		owner,
		frostyPayee,
		bossPayee,
		frostyBps: FROSTY_BPS,
		frostyCapUsd: FROSTY_CAP_USD.toString(),
		tokens: TOKENS,
		checkoutGasLimits: {
			approve: CHECKOUT_GAS_LIMITS.approve.toString(),
			subscribeFor: CHECKOUT_GAS_LIMITS.subscribeFor.toString(),
		},
	};
	mkdirSync(OUT_DIR, { recursive: true });
	save(record);
	try {
		await deployKalyBot({
			deployer,
			owner,
			frostyPayee,
			bossPayee,
			tokens: TOKENS,
			onSent: (sent) => {
				record[sent.name] = { ...sent, blockNumber: null };
				save(record);
				console.log(`${sent.name} tx ${sent.txHash} sent, deploying at ${sent.address}`);
			},
			onDeployed: (contract) => {
				record[contract.name] = contract;
				save(record);
				console.log(`${contract.name} deployed at ${contract.address} (block ${contract.blockNumber})`);
			},
		});
	} catch (err) {
		if (record.splitter || record.subscription) {
			console.error(`Deployment stopped part-way. The deployer ${deployerAddress} still owns what was deployed; see ${OUT_FILE}.`);
		}
		throw err;
	}
	record.status = 'configured';
	save(record);
	console.log(`Next: ${owner} must call acceptOwnership() on both contracts.`);
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
