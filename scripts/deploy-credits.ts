import { ethers, network } from 'hardhat';
import { deployCreditsAndRecord } from './lib/deployCredits';

const RECORD_FILE = 'deployments/kalychain.json';

async function main(): Promise<void> {
	if (network.config.chainId !== 3890) throw new Error('Run with --network kalychain');
	const [deployer] = await ethers.getSigners();
	if (!deployer) throw new Error('DEPLOYER_PRIVATE_KEY is not set');
	const record = await deployCreditsAndRecord({ deployer, recordFile: RECORD_FILE });
	console.log(`Done. ${record.owner} owns the credits contract; all six pack prices are set and verified. Control plane .env:`);
	console.log(`KALYBOT_CREDITS_ADDRESS=${record.credits!.address}`);
	console.log(`KALYBOT_GAS_BUY_CREDITS=${record.checkoutGasLimits.buyCredits}`);
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
