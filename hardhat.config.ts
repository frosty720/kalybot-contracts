import type { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';
import 'dotenv/config';

const config: HardhatUserConfig = {
	solidity: {
		version: '0.8.24',
		settings: { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 } },
	},
	networks: {
		// KALYCHAIN_FORK=1: the in-process network forks KalyChain 3890 for scripts/rehearse.ts.
		hardhat: process.env.KALYCHAIN_FORK === '1'
			? {
				forking: { url: process.env.KALYCHAIN_RPC_URL || 'https://mainrpc.kalychain.io/rpc' },
				// 3890 runs every hardfork through Prague from block 0 (kalychain-ops/files/kmt-3890/genesis-3890.json).
				hardfork: 'prague',
			}
			: {},
		kalychain: {
			url: process.env.KALYCHAIN_RPC_URL || 'https://mainrpc.kalychain.io/rpc',
			chainId: 3890,
			accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
			gasPrice: 21_000_000_000,
		},
	},
};

export default config;
