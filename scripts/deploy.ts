import { ethers, network } from 'hardhat';
import { deployAndRecord } from './lib/deployAndRecord';

const OUT_FILE = 'deployments/kalychain.json';

function requireAddress(name: string): string {
	const value = process.env[name];
	if (!value || !ethers.isAddress(value)) throw new Error(`${name} must be set to a valid address`);
	return value;
}

async function main() {
	if (network.config.chainId !== 3890) throw new Error('Run with --network kalychain');
	const [deployer] = await ethers.getSigners();
	if (!deployer) throw new Error('DEPLOYER_PRIVATE_KEY is not set');
	const record = await deployAndRecord({
		deployer,
		frostyPayee: requireAddress('FROSTY_PAYEE'),
		bossPayee: requireAddress('BOSS_PAYEE'),
		outFile: OUT_FILE,
		chainId: 3890,
	});
	console.log(`Done. ${record.owner} owns both contracts. Control plane .env:`);
	console.log(`KALYBOT_SPLITTER_ADDRESS=${record.splitter!.address}`);
	console.log(`KALYBOT_SUBSCRIPTION_ADDRESS=${record.subscription!.address}`);
	console.log(`KALYBOT_WATCH_FROM_BLOCK=${record.splitter!.blockNumber}`);
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
