import { ethers, network } from 'hardhat';
import { redeploySubscriptionAndRecord } from './lib/redeploySubscription';

const RECORD_FILE = 'deployments/kalychain.json';

async function main(): Promise<void> {
	if (network.config.chainId !== 3890) throw new Error('Run with --network kalychain');
	const [deployer] = await ethers.getSigners();
	if (!deployer) throw new Error('DEPLOYER_PRIVATE_KEY is not set');
	const record = await redeploySubscriptionAndRecord({ deployer, recordFile: RECORD_FILE });
	console.log(`Done. ${record.owner} owns the new subscription contract; all sixteen plan prices are set and verified.`);
	console.log(`New subscription: ${record.subscription!.address}`);
	console.log('Switch in ONE window, in this order:');
	console.log('  1. Tenant backends must already run the new signature format.');
	console.log('  2. Deploy the credits contract too (npm run deploy:credits) if not yet done.');
	console.log(`  3. As the owner, call pause() on the OLD subscription ${record.subscriptionPrevious!.address}. Plan checkout now fails closed until step 5.`);
	console.log('  4. Back up provisioner.db (+ -wal/-shm), set');
	console.log(`     KALYBOT_SUBSCRIPTION_ADDRESS=${record.subscription!.address} (and KALYBOT_CREDITS_ADDRESS), then recreate the control plane.`);
	console.log('  5. Deploy the new site build (orderPaid pre-checks) and Mission Control in the same window.');
	console.log('Do NOT grant() the old customer\'s time on the new contract: the watcher would add it again as comp time.');
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
