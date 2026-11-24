# Binance Agentic TG Bot — JAGER ($JAGENT) One-Confirm Full Cycle

A public, portable Telegram bot that automates the **JAGER ($JAGENT) One-Confirm Full Cycle** on BNB Smart Chain (`chainId: 56`) via each user's non-custodial **Binance Agentic Wallet** (`@binance/agentic-wallet` / `baw`), with Gemini AI handling natural-language intent routing and instant plain-text final reporting.

---

## Fixed Referrer & Platform Policy

Every mint transaction automatically uses the hardcoded referrer (never `0x0`, never user-overridden) and displays it immediately on `/start`:

- **Platform / Refer Link:** `https://jager.live/?ref=noyonislam.ai`
- **Live Stats / Price API:** `https://jager.live/api/stats`
- **Referrer Code / Agent ID:** `noyonislam.ai`
- **Referrer Wallet:** `0x85377229b28515432cCF1e1c4999BB71C9AdBE11`

---

## JAGER One-Confirm Full Cycle Flow

1. **QR Wallet Connection (`/connect`):** Non-custodial Binance Agentic Wallet pairing (`.ai` Agent ID) with per-user isolated session directories (`<BAW_SESSION_ROOT>/<userId>/`).
2. **Silent Preflight Checks (`/mint` or `🚀 Complete All Process`):**
   - Verifies wallet is fresh (`minted == 0`, `remaining >= 10`, `paidOnce == false`) and holds a `.ai` Agent ID.
   - Fetches LIVE price directly from `https://jager.live/api/stats` (never cached).
   - Verifies USDT balance covers `live_price * 10 * 1.02` (exact `maxCost`) and BNB balance covers LOW/MEDIUM gas.
   - Verifies `baw` Developer Mode is ON, unexpired, and within daily limits.
   - Queries PancakeSwap V2 live sell quote on the official `JAGENT / USDT` pair (net of `JagentTokenV2`'s 2% sell tax) and verifies it is not more than 8% below mint cost (`sell_quote >= mint_cost * 0.92`).
3. **Single Combined Preview & ONE Confirmation:**
   - Displays exact USDT approve amount (`live_price * 10 * 1.02`), 10-share mint cost, expected JAGENT output, estimated USDT sell value, and estimated net loss/fees.
   - Presents inline `✅ Confirm & Execute Full Cycle` / `❌ Cancel` buttons once.
4. **Automated Back-to-Back Execution (after ONE confirmation, zero further prompts):**
   - **Step A — Exact USDT Approve:** Approves exact `live_price * 10 * 1.02` USDT to the JAGER Mint Contract (no unlimited approvals).
   - **Step B — Mint 10 Shares in ONE TX:** Simulates first (`eth_call` + `estimateGas`), then executes `mint(10, 0x85377229b28515432cCF1e1c4999BB71C9AdBE11, maxCost)` (selector `0x836a1040`). Never splits or mints fewer than 10 shares.
   - **Step C — Immediate Sell All JAGENT for USDT:** Re-checks live PancakeSwap V2 sell quote (stops if `< mint_cost * 0.92`), approves exact JAGENT balance to PancakeSwap V2 Router if needed, and swaps 100% of JAGENT for USDT via `swapExactTokensForTokensSupportingFeeOnTransferTokens`.
   - **Step D — Revoke Leftover USDT Approval:** Resets USDT allowance for the Mint Contract back to `0` (retries continuously until confirmed).
   - **Step E — Claim Referral Reward (Max 50 Attempts Cap):** Checks `https://jager.live/api/invite-rewards?address=<wallet>` and retries claiming + receipt confirmation (plus auto-payout/settlement detection) with adaptive backoff up to a strict maximum of **50 attempts** (applied only to this step). If not confirmed after 50 attempts, records `50/50` and the latest reason cleanly and proceeds to the final summary without stalling.
   - **All Other Steps (Steps A–D):** Retry continuously with on-chain idempotency checks until confirmed, stopping immediately only on user cancel, expired session, or a mandatory stop condition.
5. **Mandatory Stop Conditions (stops immediately without continuing):**
   - Any transaction simulation fails
   - Sell quote is more than 8% below mint cost (`sell_quote < mint_cost * 0.92`)
   - Wallet is underfunded (USDT or BNB) or already minted (`minted > 0` / `remaining < 10`)
   - Developer Mode is OFF / expired / balance cap exceeded
   - User clicks Cancel or `baw` session expires
6. **Pre-Summary BEP-20 Payment Wallet Prompt, Final Report & Admin Notification:**
   - Right after Steps A–E finish (and before sending the final summary), prompts the user in Bangla to paste a valid **BEP-20 (`0x...`)** payout wallet address or tap **⏭️ স্কিপ (এজেন্ট ওয়ালেটে পেমেন্ট)** (defaults to their connected Agent Wallet).
   - Strictly validates pasted addresses against `/^0x[a-fA-F0-9]{40}$/` (rejecting invalid formats in Bangla) and saves `payout_wallet_address` + `payout_mode` (`CUSTOM_BEP20` or `AGENT_WALLET_SKIPPED`) in PostgreSQL `executions`.
   - Delivers ONE complete final summary to the user including their selected payout wallet, and sends an HTML admin payout alert with the payout address wrapped in `<code>0x...</code>` for one-click copy.

---

## Contracts & Addresses (BSC Mainnet — chainId 56)

| Name | Address |
|---|---|
| USDT (BEP-20, 18 decimals) | `0x55d398326f99059fF775485246999027B3197955` |
| JAGER Mint Contract (`JagentMintV2`) | `0x3643A907f875fA9B740e1C0747E91b5aA5222aB8` |
| JAGENT Token (`JagentTokenV2`, 18 decimals) | `0x8e6442663A4F8C50b6132c68d42A30E7DFE4Ae15` |
| Official JAGENT/USDT Pair | `0xE6efCdEf2b720d1eca2b69eDB7ef357725680BEa` |
| PancakeSwap V2 Router | `0x10ED43C718714eb63d5aA57B78B54704E256024E` |
| WBNB | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` |
| Referrer (hardcoded) | `0x85377229b28515432cCF1e1c4999BB71C9AdBE11` (`noyonislam.ai`) |

---

## Folder Structure

```
binance-agentic-tg-bot/
├── src/
│   ├── config.ts              # Env validation, multi-ADMIN_ID parsing, portable paths
│   ├── logger.ts              # Pino structured logger with safe pino-pretty fallback
│   ├── db.ts                  # PostgreSQL pool (auto-SSL), schema bootstrap (USDT + legacy cols), user & admin queries
│   ├── bsc.ts                 # Layer 2: JAGER live API, BSC RPC reads, freshness/8% guards & calldata builders
│   ├── wallet.ts              # Layer 1: @binance/agentic-wallet (baw) MPC signing & LOW/MEDIUM gas sizing
│   ├── gemini.ts              # Gemini AI intent router + plain-text final JAGER report
│   ├── qr.ts                  # QR code PNG generator
│   ├── executor.ts            # Layer 3: JAGER One-Confirm preview + automated Steps A→E engine
│   ├── keyboards.ts           # Telegraf inline keyboard layouts (including One-Confirm buttons)
│   ├── index.ts               # Layer 4/5: Bot entry point, commands, /health server, graceful shutdown
│   └── handlers/
│       ├── start.ts           # /start welcome + JAGER platform link & fixed referrer notice
│       ├── wallet.ts          # /connect & Connect Wallet QR pairing flow + freshness check
│       ├── qr.ts              # Generate QR Code from stored pairing URI
│       ├── execute.ts         # /mint preview, confirm_execute_cycle, cancel_preview & admin alerts
│       ├── jobs.ts            # /status & /my_jobs personal status view (own data only)
│       ├── cancel.ts          # Cancel & session reset
│       ├── admin.ts           # /admin, /admin_completed, /admin_incomplete, /admin_users, /admin_stop, /admin_start
│       └── message.ts         # Free-text → Gemini intent routing
├── schema.sql                 # Supabase/PostgreSQL schema (idempotent, backward-compatible)
├── package.json
├── package-lock.json
├── tsconfig.json
├── railway.toml               # Railway deploy config
├── nixpacks.toml              # Render / Railway Nixpacks build config
└── README.md
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | ✅ Yes | — | Google AI Studio API key |
| `TELEGRAM_BOT_TOKEN` | ✅ Yes | — | Telegram bot token from `@BotFather` |
| `SUPABASE_DB_URL` | ✅ Yes | — | PostgreSQL connection string (SSL auto-enabled for non-local hosts; set `sslmode=disable` if not using SSL) |
| `ADMIN_ID` | ✅ Yes | — | Primary Telegram numeric admin user ID (also accepts comma-separated IDs) |
| `BSC_RPC_URL` | ✅ Yes | — | BSC mainnet (`chainId: 56`) RPC URL, e.g. `https://bsc-dataseed1.binance.org/` |
| `ADMIN_IDS` | ☑️ Optional | — | Additional comma-separated admin Telegram user IDs (merged with `ADMIN_ID`) |
| `BAW_SESSION_ROOT` | ☑️ Optional | `~/.baw-sessions` | Directory root for per-user `baw` sessions (`<root>/<userId>/`) |
| `LOG_LEVEL` | ☑️ Optional | `info` | `trace` / `debug` / `info` / `warn` / `error` |
| `PORT` | ☑️ Optional | `3000` | HTTP health-check server port (`GET /health`) |
| `NODE_ENV` | ☑️ Optional | — | Set to `production` for structured JSON logs |

---

## Setup & Run

```bash
# 1. Install exact dependencies (including @binance/agentic-wallet CLI & TypeScript)
npm ci

# 2. Apply SQL schema + idempotent migrations once (also auto-bootstrapped on startup)
psql "$SUPABASE_DB_URL" -f schema.sql

# 3. Type-check and build
npm run typecheck
npm run build

# 4. Start
npm start
```

Health check endpoint: `GET http://localhost:<PORT>/health` returns:
```json
{ "status": "ok", "botMode": "running", "db": "connected", "baw": "ready", "uptime": 42 }
```

---

## Bot Commands & Role Separation

### Normal User Commands (Own Data Only)
| Trigger | Action |
|---|---|
| `/start` | Welcome message with platform link (`https://jager.live/?ref=noyonislam.ai`), fixed referrer (`noyonislam.ai` / `0x85377229...`), and main menu |
| `/connect` or `🔗 Connect Your Binance Wallet` | Start real `baw auth signin` pairing flow, send scannable QR, bind session, and check JAGER freshness |
| `📱 Generate QR Code` | Re-render QR strictly from the user's stored pairing session URI |
| `/mint` or `🚀 Complete All Process` | Run silent preflight checks, fetch live price from `jager.live/api/stats`, and display the single combined preview with ONE confirmation button |
| `✅ Confirm & Execute Full Cycle` | Execute Steps A (Exact USDT Approve) → B (Mint 10 Shares) → C (Sell 100% JAGENT → USDT) → D (Revoke USDT Approval) → E (Claim Invite Reward) back-to-back |
| `/status`, `/my_jobs`, or `📊 My Status & Jobs` | View **only your own** wallet connection, bound `.ai` Agent ID, completed cycle history (USDT/BNB), and incomplete counts |
| `❌ Cancel` | Request stop at next safe checkpoint and reset/sign out session |

### Admin Commands (Strictly Restricted to `ADMIN_ID` / `ADMIN_IDS`)
| Command / Button | Action |
|---|---|
| `/admin` or `🛡️ Admin Dashboard` | Overview across all users, connected wallets, completed cycles, unique completed Agent IDs, and incomplete breakdown |
| `/admin_completed` | Total count and full list of completed users and Agent IDs |
| `/admin_incomplete` | Connected-only and incomplete/stopped/failed/cancelled accounts with last reason |
| `/admin_users` | All registered users with connection status, bound Agent ID, completed/incomplete counts, and join date |
| `/admin_stop` or `/stop_bot` | Stop the bot for all normal users (persisted in `bot_settings`; admin retains full access) |
| `/admin_start` or `/start_bot` | Turn the bot back ON for all users |

---

## Security & Rules

- 🔒 Non-custodial signing via `@binance/agentic-wallet` (`baw`) MPC — never requests seed phrases or private keys
- 🔒 Per-user isolated `baw` session directories (`<BAW_SESSION_ROOT>/<userId>/`) and per-user serial execution locks
- 🔒 Never asks users to send USDT or BNB directly to a contract address
- 🔒 Exact USDT approve (`live_price * 10 * 1.02`) + automatic revoke back to `0` after execution (no unlimited approvals)
- 🔒 Always mints exactly `10` shares in ONE transaction with hardcoded referrer `0x85377229b28515432cCF1e1c4999BB71C9AdBE11` (`noyonislam.ai`)
- 🔒 Strict 8% sell-quote protection (`sell_quote < mint_cost * 0.92` stops immediately) and pre-broadcast simulation on every tx
- 🔒 LOW/MEDIUM gas settings only
- 🔒 Admin views strictly gated by numeric `ADMIN_IDS` check

## License

MIT
