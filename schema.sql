-- ============================================================
-- Binance Agentic TG Bot — Supabase / PostgreSQL Schema
-- Run this once against your Supabase project using:
--   psql "$SUPABASE_DB_URL" -f schema.sql
-- or paste it into the Supabase SQL Editor.
-- ============================================================

-- ── Users ─────────────────────────────────────────────────────────────────────
-- One row per Telegram user. Tracks wallet connection state, bound Agent ID,
-- wallet address, and completed job count.

CREATE TABLE IF NOT EXISTS users (
  telegram_user_id    BIGINT      PRIMARY KEY,
  username            TEXT,
  first_name          TEXT,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_step        TEXT        NOT NULL DEFAULT 'start',
  -- current_step values:
  --   start | connecting | qr_shown | connected | previewing | executing | completed | failed | cancelled
  session_link        TEXT,       -- Pairing deep-link URI from @binance/agentic-wallet (baw)
  qr_generated        BOOLEAN     NOT NULL DEFAULT FALSE,
  is_wallet_connected BOOLEAN     NOT NULL DEFAULT FALSE,  -- TRUE only after markSessionConnected() succeeds
  wallet_address      TEXT,       -- Bound BSC 0x wallet address from baw
  agent_id_name       TEXT,       -- Bound SPACE ID *.ai Agent ID (if claimed)
  is_cancelled        BOOLEAN     NOT NULL DEFAULT FALSE,
  completed_count     INT         NOT NULL DEFAULT 0
);

-- Safe migrations for existing deployments (idempotent)
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_link TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS qr_generated BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_address TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_id_name TEXT;

-- Indexes for admin & status queries
CREATE INDEX IF NOT EXISTS idx_users_last_active ON users (last_active_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_completed   ON users (completed_count DESC) WHERE completed_count > 0;
CREATE INDEX IF NOT EXISTS idx_users_connected   ON users (is_wallet_connected) WHERE is_wallet_connected = TRUE;
CREATE INDEX IF NOT EXISTS idx_users_agent_id    ON users (agent_id_name) WHERE agent_id_name IS NOT NULL;

-- ── Executions ────────────────────────────────────────────────────────────────
-- One row per JAGER full-cycle attempt (COMPLETED, STOPPED, FAILED, CANCELLED).
-- Retains legacy BNB columns for backward compatibility alongside USDT columns.

CREATE TABLE IF NOT EXISTS executions (
  id                 BIGSERIAL   PRIMARY KEY,
  telegram_user_id   BIGINT      NOT NULL REFERENCES users (telegram_user_id) ON DELETE CASCADE,
  wallet_address     TEXT,                       -- Bound BSC 0x wallet address for one-time completed ID lock
  agent_id_name      TEXT,                       -- *.ai SPACE ID name, or wallet address fallback
  mint_contract      TEXT,                       -- Target mint contract address (scopes 1-time completion per contract)
  status             TEXT        NOT NULL,       -- COMPLETED | STOPPED | CANCELLED | FAILED
  currency           TEXT        NOT NULL DEFAULT 'USDT', -- 'USDT' (JAGER V2) | 'BNB' (legacy)
  mint_cost_bnb      NUMERIC(30, 18),            -- Legacy column (mirrors USDT cost on JAGER runs)
  mint_cost_usdt     NUMERIC(30, 18),            -- USDT spent on 10-share JAGER mint
  tokens_received    NUMERIC(30, 18),            -- JAGENT tokens received after mint
  sell_bnb           NUMERIC(30, 18),            -- Legacy column (mirrors USDT sell on JAGER runs)
  sell_usdt          NUMERIC(30, 18),            -- USDT received from PancakeSwap V2 sell
  pnl_or_fee         NUMERIC(30, 18),            -- sell − mint_cost (negative = net loss/fees)
  pnl_or_fee_usdt    NUMERIC(30, 18),            -- sell_usdt − mint_cost_usdt (negative = net loss/fees)
  invite_reward_usdt    NUMERIC(30, 18),         -- Invite reward USDT claimed in Step E (if due)
  claim_attempts        INT,                     -- Step E referral reward claim attempts (up to 50)
  payout_wallet_address    TEXT,                    -- Selected BEP-20 payout wallet (custom or Agent Wallet on skip)
  payout_mode              TEXT,                    -- CUSTOM_BEP20 | AGENT_WALLET_SKIPPED
  claim_payout_status      TEXT,                    -- PAID | MANUAL_REVIEW | FAILED_SYSTEM | PENDING
  claim_payout_amount_usdt NUMERIC(30, 18),         -- USDT reward amount claimed/paid by Auto Payment System
  claim_payout_tx_hash     TEXT,                    -- On-chain BSC USDT payout transaction hash (if auto-paid)
  tx_hashes                JSONB,                   -- { "approve": "0x...", "mint": "0x...", "sell_approve": "0x...", "sell": "0x...", "revoke": "0x...", "claim": "0x..." }
  summary                  TEXT,                    -- Execution summary or stop/failure reason
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Safe idempotent migrations for existing deployments
ALTER TABLE executions ADD COLUMN IF NOT EXISTS wallet_address           TEXT;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS mint_contract            TEXT;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS currency                 TEXT NOT NULL DEFAULT 'BNB';
ALTER TABLE executions ADD COLUMN IF NOT EXISTS mint_cost_usdt           NUMERIC(30, 18);
ALTER TABLE executions ADD COLUMN IF NOT EXISTS sell_usdt                NUMERIC(30, 18);
ALTER TABLE executions ADD COLUMN IF NOT EXISTS pnl_or_fee_usdt          NUMERIC(30, 18);
ALTER TABLE executions ADD COLUMN IF NOT EXISTS invite_reward_usdt       NUMERIC(30, 18);
ALTER TABLE executions ADD COLUMN IF NOT EXISTS claim_attempts           INT;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS payout_wallet_address    TEXT;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS payout_mode              TEXT;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS claim_payout_status      TEXT;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS claim_payout_amount_usdt NUMERIC(30, 18);
ALTER TABLE executions ADD COLUMN IF NOT EXISTS claim_payout_tx_hash     TEXT;

CREATE INDEX IF NOT EXISTS idx_executions_user               ON executions (telegram_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_executions_status             ON executions (status);
CREATE INDEX IF NOT EXISTS idx_executions_agent              ON executions (agent_id_name) WHERE agent_id_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_executions_completed_agent    ON executions (LOWER(agent_id_name)) WHERE status = 'COMPLETED' AND agent_id_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_executions_completed_addr     ON executions (LOWER(wallet_address)) WHERE status = 'COMPLETED' AND wallet_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_executions_completed_contract ON executions (LOWER(mint_contract)) WHERE status = 'COMPLETED' AND mint_contract IS NOT NULL;

-- ── Admin Notifications Queue ─────────────────────────────────────────────────
-- Durable retry queue guaranteeing completion & payout details reach every admin
-- without duplicates (deduplicated by `dedupe_key`) even across Telegram 429s,
-- transient network failures, or bot restarts.

CREATE TABLE IF NOT EXISTS admin_notifications (
  id               BIGSERIAL   PRIMARY KEY,
  dedupe_key       TEXT        NOT NULL UNIQUE,
  admin_id         BIGINT      NOT NULL,
  telegram_user_id BIGINT      NOT NULL,
  execution_id     BIGINT      REFERENCES executions (id) ON DELETE SET NULL,
  status           TEXT        NOT NULL DEFAULT 'PENDING', -- PENDING | DELIVERED
  retry_count      INT         NOT NULL DEFAULT 0,
  next_retry_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error       TEXT,
  html_message     TEXT        NOT NULL,
  plain_message    TEXT        NOT NULL,
  payload          JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_notif_pending ON admin_notifications (status, next_retry_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_admin_notif_exec    ON admin_notifications (execution_id) WHERE execution_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_admin_notif_user    ON admin_notifications (telegram_user_id, created_at DESC);

-- ── Reward Claims (Anti-Abuse Lock & Auto-Payment Ledger) ────────────────────
-- Strictly enforces 1-time reward claim/payout per Agent ID and per Agent Wallet
-- via partial unique indexes, while ALLOWING one user / one BEP-20 payout address
-- to claim payouts across unlimited distinct Agent IDs / Agent Wallets.

CREATE TABLE IF NOT EXISTS reward_claims (
  id                    BIGSERIAL      PRIMARY KEY,
  execution_id          BIGINT         REFERENCES executions (id) ON DELETE SET NULL,
  telegram_user_id      BIGINT         NOT NULL,
  agent_id_name         TEXT           NOT NULL,
  agent_wallet_address  TEXT           NOT NULL,
  payout_wallet_address TEXT           NOT NULL,
  payout_mode           TEXT           NOT NULL,  -- CUSTOM_BEP20 | AGENT_WALLET_SKIPPED
  amount_usdt           NUMERIC(30, 18) NOT NULL,
  status                TEXT           NOT NULL,  -- PROCESSING | PAID | MANUAL_REVIEW | FAILED_SYSTEM
  referral_verified     BOOLEAN        NOT NULL DEFAULT FALSE,
  payout_tx_hash        TEXT,
  failure_reason        TEXT,
  created_at            TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ    NOT NULL DEFAULT now(),
  paid_at               TIMESTAMPTZ
);

-- Strict anti-abuse uniqueness: same Agent ID or same Agent Wallet can NEVER be claimed/paid twice
CREATE UNIQUE INDEX IF NOT EXISTS uq_reward_claims_agent_id
  ON reward_claims (LOWER(agent_id_name))
  WHERE status IN ('PROCESSING', 'PAID', 'MANUAL_REVIEW');

CREATE UNIQUE INDEX IF NOT EXISTS uq_reward_claims_agent_wallet
  ON reward_claims (LOWER(agent_wallet_address))
  WHERE status IN ('PROCESSING', 'PAID', 'MANUAL_REVIEW');

CREATE INDEX IF NOT EXISTS idx_reward_claims_user   ON reward_claims (telegram_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reward_claims_payout ON reward_claims (LOWER(payout_wallet_address));

-- ── Bot Settings ──────────────────────────────────────────────────────────────
-- Durable key-value runtime flags (bot_paused, maintenance_mode, withdraw_amount_usdt, admin_wallet_*).

CREATE TABLE IF NOT EXISTS bot_settings (
  key        TEXT        PRIMARY KEY,
  value      TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
