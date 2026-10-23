import { ethers, network } from 'hardhat';
import { redeploySubscriptionAndRecord } from './lib/redeploySubscription';

const RECORD_FILE = 'deployments/kalychain.json';

async function main(): Promise<void> {
	if (network.config.chainId !== 3890) throw new Error('Run with --network kalychain');
	const [deployer] = await ethers.getSigners();
	if (!deployer) throw new Error('DEPLOYER_PRIVATE_KEY is not set');
	const record = await redeploySubscriptionAndRecord({ deployer, recordFile: RECORD_FILE });
	console.log(`Done. ${record.owner} owns the new subscription contract; all sixteen plan prices are set and verified. Control plane .env:`);
	console.log(`KALYBOT_SUBSCRIPTION_ADDRESS=${record.subscription!.address}`);
	console.log(`Then recreate the control plane and pause() the old contract ${record.subscriptionPrevious!.address}.`);
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
