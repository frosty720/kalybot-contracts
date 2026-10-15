# kalybot-contracts

KalyBot plan payments on KalyChain (chainId 3890).

- **KalyBotSubscription**: customers pay the exact on-chain price for a plan (USDT or KUSD), keyed by instance id. Renewals stack on the remaining time; a plan change while active converts the remaining time at the ratio of the two tiers' monthly prices, then adds the new period; every payment is forwarded to the splitter in the same transaction.
- **KalyBotSplitter**: pays Frosty 60% of every payment until his total reaches $5,000, then 100% to the boss. Terms are adjustable by the owner and logged on-chain; only the boss can change the boss's payout address; there is no withdraw function.

Adapted from FrostyFlow's `FrostySubscriptionV3` and `FrostyRevenueSplitter`. Not audited.

## Develop

```bash
npm install
npx hardhat test
```

## Deploy (KalyChain 3890)

1. Copy `.env.example` to `.env` and fill in `DEPLOYER_PRIVATE_KEY` (the wallet that will own both contracts), `FROSTY_PAYEE` and `BOSS_PAYEE`.
2. Rehearse on a local fork of 3890 (nothing is sent to the real chain): set `DEPLOYER_ADDRESS` to that wallet's address, then `npm run rehearse:kalychain`. It runs the same deploy code while impersonating the wallet, checks owner, payees, split, cap and all 16 prices, makes one real-token payment per stablecoin, and prints the KMT cost. It must end with `REHEARSAL PASSED`.
3. `npm run deploy:kalychain`. The script refuses zero payees, verifies the USDT/KUSD addresses on-chain, then deploys with explicit gas limits. It writes `deployments/kalychain.json` as soon as each contract exists (`status: "deploying"`), finishing with `status: "configured"`; if it stops part-way, the file shows what was deployed. It refuses to run if that file already exists. The deploying wallet owns both contracts; there is no ownership handover.
4. Copy the three lines it prints (`KALYBOT_SPLITTER_ADDRESS`, `KALYBOT_SUBSCRIPTION_ADDRESS`, `KALYBOT_WATCH_FROM_BLOCK`) into the control plane's `.env`.
