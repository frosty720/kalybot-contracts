import { ethers, network } from 'hardhat';
import { mkdirSync, writeFileSync } from 'fs';
import { deployKalyBot } from './lib/deployKalyBot';

/** KalyChain 3890 stablecoins, from KalySwap config. Re-checked on-chain below before use. */
const TOKENS = [
	{ address: '0x6318EcDbae6B469D39C38949eDC671f4bA8A6172', symbol: 'USDT', decimals: 6 },
	{ address: '0xFDb3307a16442ed5A7C040AE1600a3B3D3C8e7D9', symbol: 'KUSD', decimals: 18 },
];

function requireAddress(name: string): string {
	const value = process.env[name];
	if (!value || !ethers.isAddress(value)) throw new Error(`${name} must be set to a valid address`);
	return value;
}

async function main() {
	if (network.config.chainId !== 3890) throw new Error('Run with --network kalychain');
	const [deployer] = await ethers.getSigners();
	const owner = requireAddress('OWNER_ADDRESS');
	const frostyPayee = requireAddress('FROSTY_PAYEE');
	const bossPayee = requireAddress('BOSS_PAYEE');

	for (const token of TOKENS) {
		const erc20 = await ethers.getContractAt('IERC20Metadata', token.address);
		const [symbol, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()]);
		if (symbol !== token.symbol || Number(decimals) !== token.decimals) {
			throw new Error(`${token.address}: expected ${token.symbol}/${token.decimals}, chain says ${symbol}/${decimals}`);
		}
	}

	const result = await deployKalyBot({ deployer, owner, frostyPayee, bossPayee, tokens: TOKENS });
	mkdirSync('deployments', { recursive: true });
	writeFileSync('deployments/kalychain.json', JSON.stringify({ chainId: 3890, ...result, tokens: TOKENS }, null, '\t'));
	console.log('Deployed:', result);
	console.log(`Next: ${owner} must call acceptOwnership() on both contracts.`);
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
