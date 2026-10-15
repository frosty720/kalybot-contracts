import type { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';
import 'dotenv/config';

const config: HardhatUserConfig = {
	solidity: {
		version: '0.8.24',
		settings: { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 } },
	},
	networks: {
		kalychain: {
			url: process.env.KALYCHAIN_RPC_URL || 'https://mainrpc.kalychain.io/rpc',
			chainId: 3890,
			accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
			gasPrice: 21_000_000_000,
		},
	},
};

export default config;
