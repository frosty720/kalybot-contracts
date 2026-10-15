# kalybot-contracts

KalyBot plan payments on KalyChain (chainId 3890).

- **KalyBotSubscription**: customers pay the exact on-chain price for a plan (USDT or KUSD), keyed by instance id. Renewals stack on the remaining time; every payment is forwarded to the splitter in the same transaction.
- **KalyBotSplitter**: pays Frosty 60% of every payment until his total reaches $5,000, then 100% to the boss. Terms are adjustable by the owner and logged on-chain; only the boss can change the boss's payout address; there is no withdraw function.

Adapted from FrostyFlow's `FrostySubscriptionV3` and `FrostyRevenueSplitter`. Not audited.

## Develop

```bash
npm install
npx hardhat test
```

## Deploy (KalyChain 3890)

1. Copy `.env.example` to `.env` and fill in `DEPLOYER_PRIVATE_KEY`, `OWNER_ADDRESS`, `FROSTY_PAYEE`, `BOSS_PAYEE`.
2. `npm run deploy:kalychain`. The script refuses a zero or deployer-owned `OWNER_ADDRESS` and zero payees, verifies the USDT/KUSD addresses on-chain, then deploys with explicit gas limits. It writes `deployments/kalychain.json` as soon as each contract exists (`status: "deploying"`), finishing with `status: "configured"`; if it stops part-way, the file shows what was deployed (still owned by the deployer key). It refuses to run if that file already exists.
3. From `OWNER_ADDRESS`, call `acceptOwnership()` on both contracts.
