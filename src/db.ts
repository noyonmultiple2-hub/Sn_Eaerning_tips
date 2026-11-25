// src/db.ts
// Supabase / PostgreSQL client, portable SSL config, schema bootstrap,
// and user/admin queries.

import { Pool, PoolConfig } from 'pg';
import { ethers } from 'ethers';
import { config } from './config.js';
import { logger } from './logger.js';

function buildPoolConfig(connectionString: string): PoolConfig {
  let useSsl = false;
  try {
    const parsed = new URL(connectionString);
    const host = parsed.hostname.toLowerCase();
    const sslMode = (parsed.searchParams.get('sslmode') ?? process.env.PGSSLMODE ?? '').toLowerCase();
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (sslMode === 'disable') {
      useSsl = false;
    } else if (!isLocal) {
      // Cloud PostgreSQL providers (Supabase, Railway, Render) require SSL on remote connections.
      useSsl = true;
    }
  } catch {
    // Non-URL connection string — let pg parse it directly.
  }

  return {
    connectionString,
    connectionTimeoutMillis: 10_000,
    ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  };
}

export const pool = new Pool(buildPoolConfig(config.SUPABASE_DB_URL));

let dbReady = false;
let botPausedCache = false;
let emergencyShutdownCache = false;
let emergencyShutdownReasonCache: string | null = null;
let withdrawAmountUsdtCache = '1.00';
let adminWalletAddressCache: string | null = null;
let adminWalletConnectedCache = false;

export function isDbAvailable(): boolean {
  return dbReady;
}

/** Returns whether the admin has stopped the bot for normal users (admin retains full access). */
export function isBotPaused(): boolean {
  return botPausedCache;
}

/** Returns whether Emergency Auto-Shutdown / Maintenance mode is active for users. */
export function isEmergencyShutdown(): boolean {
  return emergencyShutdownCache;
}

/** Returns the exact runtime failure reason that triggered Emergency Auto-Shutdown. */
export function getEmergencyShutdownReason(): string | null {
  return emergencyShutdownReasonCache;
}

/** Returns the configured BEP-20 USDT reward amount per completed user claim. */
export function getWithdrawAmountUsdt(): string {
  return withdrawAmountUsdtCache;
}

/** Returns cached Admin Agent Wallet configuration (address & connected flag). */
export function getAdminWalletConfig(): { connected: boolean; address: string | null } {
  return {
    connected: adminWalletConnectedCache,
    address: adminWalletAddressCache,
  };
}

async function upsertBotSetting(key: string, value: string): Promise<boolean> {
  try {
    await pool.query(
      `INSERT INTO bot_settings (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             updated_at = now()`,
      [key, value],
    );
    dbReady = true;
    return true;
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, key }, 'upsertBotSetting failed (kept in memory)');
    return false;
  }
}

/** Reloads persisted `bot_paused` state from PostgreSQL/Supabase. */
export async function loadBotPausedState(): Promise<boolean> {
  try {
    const { rows } = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM bot_settings
       WHERE key IN (
         'bot_paused', 'maintenance_mode', 'maintenance_reason',
         'withdraw_amount_usdt', 'admin_wallet_address', 'admin_wallet_connected'
       )`,
    );
    dbReady = true;
    const map = new Map(rows.map((r) => [r.key, r.value]));
    botPausedCache = map.get('bot_paused') === 'true';
    emergencyShutdownCache = map.get('maintenance_mode') === 'true';
    emergencyShutdownReasonCache = map.get('maintenance_reason') || null;
    const wAmt = map.get('withdraw_amount_usdt');
    if (wAmt) {
      const parsed = parseAndFormatWithdrawAmountUsdt(wAmt);
      if (parsed.ok) withdrawAmountUsdtCache = parsed.amount;
    }
    adminWalletAddressCache = map.get('admin_wallet_address') || null;
    adminWalletConnectedCache = map.get('admin_wallet_connected') === 'true' && Boolean(adminWalletAddressCache);
    return botPausedCache;
  } catch (err) {
    logger.warn({ err }, 'loadBotPausedState failed — using in-memory caches');
    return botPausedCache;
  }
}

/** Persists admin bot stop/start state to `bot_settings` and updates in-memory cache immediately. */
export async function setBotPaused(
  paused: boolean,
): Promise<{ paused: boolean; persisted: boolean }> {
  botPausedCache = paused;
  const persisted = await upsertBotSetting('bot_paused', paused ? 'true' : 'false');
  logger.info({ botPaused: paused, persisted }, 'Updated bot_paused state');
  return { paused, persisted };
}

/**
 * Activates or clears Emergency Auto-Shutdown / Maintenance mode (`maintenance_mode`).
 * When active, all non-admin user actions are blocked with the Bangla maintenance notice.
 */
export async function setEmergencyShutdown(
  active: boolean,
  reason?: string | null,
): Promise<{ active: boolean; reason: string | null; persisted: boolean }> {
  emergencyShutdownCache = active;
  emergencyShutdownReasonCache = active ? (reason?.trim() || 'Auto-payment wallet failure') : null;
  const [p1, p2] = await Promise.all([
    upsertBotSetting('maintenance_mode', active ? 'true' : 'false'),
    upsertBotSetting('maintenance_reason', emergencyShutdownReasonCache ?? ''),
  ]);
  const persisted = p1 && p2;
  logger.warn(
    { emergencyShutdown: active, reason: emergencyShutdownReasonCache, persisted },
    active ? 'EMERGENCY AUTO-SHUTDOWN ACTIVATED' : 'Emergency Auto-Shutdown cleared by admin',
  );
  return { active, reason: emergencyShutdownReasonCache, persisted };
}

/**
 * Exact string/BigInt parser & canonicalizer for BEP-20 USDT withdraw reward amounts
 * (ZERO floating-point rounding drift). Accepts inputs like `"1"`, `"1.5"`, `"$2.25"`, `"0.125 USDT"`.
 */
export function parseAndFormatWithdrawAmountUsdt(
  rawAmount: string,
): { ok: true; amount: string; amountWei: bigint } | { ok: false; error: string } {
  const cleaned = rawAmount
    .trim()
    .replace(/^\$\s*/, '')
    .replace(/\s*usdt$/i, '')
    .trim();

  if (!/^\d+(?:\.\d{1,6})?$/.test(cleaned)) {
    return {
      ok: false,
      error: 'Invalid USDT amount format. Enter a positive decimal up to 6 decimals (e.g. 1, 1.5, 2.25, 0.05).',
    };
  }

  const [rawInt, rawFrac = ''] = cleaned.split('.');
  const cleanInt = rawInt.replace(/^0+(?=\d)/, '') || '0';
  const trimmedFrac = rawFrac.replace(/0+$/, '');
  const paddedFrac = trimmedFrac.length >= 2 ? trimmedFrac : trimmedFrac.padEnd(2, '0');
  const formatted = `${cleanInt}.${paddedFrac}`;

  let amountWei: bigint;
  try {
    amountWei = ethers.parseUnits(formatted, 18);
  } catch {
    return { ok: false, error: 'Could not parse USDT amount cleanly.' };
  }

  const maxWei = ethers.parseUnits('10000', 18);
  if (amountWei <= 0n || amountWei > maxWei) {
    return { ok: false, error: 'Amount must be greater than 0 and at most 10,000 USDT.' };
  }

  return { ok: true, amount: formatted, amountWei };
}

/**
 * Validates and persists the admin-configured BEP-20 USDT reward amount per completed claim
 * with exact BigInt / string decimal precision (no IEEE-754 rounding bugs).
 */
export async function setWithdrawAmountUsdt(
  rawAmount: string,
): Promise<{ ok: true; amount: string; persisted: boolean } | { ok: false; error: string }> {
  const parsed = parseAndFormatWithdrawAmountUsdt(rawAmount);
  if (!parsed.ok) return parsed;

  withdrawAmountUsdtCache = parsed.amount;
  const persisted = await upsertBotSetting('withdraw_amount_usdt', parsed.amount);
  logger.info(
    { withdrawAmountUsdt: parsed.amount, amountWei: parsed.amountWei.toString(), persisted },
    'Updated withdraw_amount_usdt',
  );
  return { ok: true, amount: parsed.amount, persisted };
}

/** Persists the connected Admin Agent Wallet address & connectivity state. */
export async function setAdminWalletConfig(
  address: string | null,
  connected: boolean,
): Promise<{ address: string | null; connected: boolean; persisted: boolean }> {
  adminWalletAddressCache = address ? address.trim() : null;
  adminWalletConnectedCache = Boolean(connected && adminWalletAddressCache);
  const [p1, p2] = await Promise.all([
    upsertBotSetting('admin_wallet_address', adminWalletAddressCache ?? ''),
    upsertBotSetting('admin_wallet_connected', adminWalletConnectedCache ? 'true' : 'false'),
  ]);
  return {
    address: adminWalletAddressCache,
    connected: adminWalletConnectedCache,
    persisted: p1 && p2,
  };
}

pool.on('error', (err) => {
  dbReady = false;
  logger.error({ err }, 'Unexpected DB pool error');
});

// ─── Schema Bootstrap ───────────────────────────────────────────────────────

export async function initDb(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_user_id    BIGINT PRIMARY KEY,
        username            TEXT,
        first_name          TEXT,
        started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_active_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        current_step        TEXT NOT NULL DEFAULT 'start',
        session_link        TEXT,
        qr_generated        BOOLEAN NOT NULL DEFAULT FALSE,
        is_wallet_connected BOOLEAN NOT NULL DEFAULT FALSE,
        wallet_address      TEXT,
        agent_id_name       TEXT,
        is_cancelled        BOOLEAN NOT NULL DEFAULT FALSE,
        completed_count     INT NOT NULL DEFAULT 0
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS executions (
        id                 BIGSERIAL PRIMARY KEY,
        telegram_user_id   BIGINT NOT NULL REFERENCES users(telegram_user_id) ON DELETE CASCADE,
        wallet_address     TEXT,
        agent_id_name      TEXT,
        mint_contract      TEXT,
        status             TEXT NOT NULL,
        currency           TEXT NOT NULL DEFAULT 'USDT',
        mint_cost_bnb      NUMERIC,
        mint_cost_usdt     NUMERIC,
        tokens_received    NUMERIC,
        sell_bnb           NUMERIC,
        sell_usdt          NUMERIC,
        pnl_or_fee         NUMERIC,
        pnl_or_fee_usdt    NUMERIC,
        invite_reward_usdt    NUMERIC,
        claim_attempts        INT,
        payout_wallet_address TEXT,
        payout_mode           TEXT,
        tx_hashes             JSONB,
        summary               TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // Safe idempotent migrations for deployments created on earlier schema versions
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS session_link TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS qr_generated BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_address TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_id_name TEXT`);
    await client.query(`ALTER TABLE executions ADD COLUMN IF NOT EXISTS wallet_address TEXT`);
    await client.query(`ALTER TABLE executions ADD COLUMN IF NOT EXISTS mint_contract TEXT`);
    await client.query(`ALTER TABLE executions ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'BNB'`);
    await client.query(`ALTER TABLE executions ADD COLUMN IF NOT EXISTS mint_cost_usdt NUMERIC`);
    await client.query(`ALTER TABLE executions ADD COLUMN IF NOT EXISTS sell_usdt NUMERIC`);
    await client.query(`ALTER TABLE executions ADD COLUMN IF NOT EXISTS pnl_or_fee_usdt NUMERIC`);
    await client.query(`ALTER TABLE executions ADD COLUMN IF NOT EXISTS invite_reward_usdt NUMERIC`);
    await client.query(`ALTER TABLE executions ADD COLUMN IF NOT EXISTS claim_attempts INT`);
    await client.query(`ALTER TABLE executions ADD COLUMN IF NOT EXISTS payout_wallet_address TEXT`);
    await client.query(`ALTER TABLE executions ADD COLUMN IF NOT EXISTS payout_mode TEXT`);
    await client.query(`ALTER TABLE executions ADD COLUMN IF NOT EXISTS claim_payout_status TEXT`);
    await client.query(`ALTER TABLE executions ADD COLUMN IF NOT EXISTS claim_payout_amount_usdt NUMERIC`);
    await client.query(`ALTER TABLE executions ADD COLUMN IF NOT EXISTS claim_payout_tx_hash TEXT`);

    // Anti-abuse Reward Claims ledger & strict 1-time-per-Agent-ID/Wallet payout lock
    await client.query(`
      CREATE TABLE IF NOT EXISTS reward_claims (
        id                    BIGSERIAL   PRIMARY KEY,
        execution_id          BIGINT      REFERENCES executions (id) ON DELETE SET NULL,
        telegram_user_id      BIGINT      NOT NULL,
        agent_id_name         TEXT        NOT NULL,
        agent_wallet_address  TEXT        NOT NULL,
        payout_wallet_address TEXT        NOT NULL,
        payout_mode           TEXT        NOT NULL,
        amount_usdt           NUMERIC     NOT NULL,
        status                TEXT        NOT NULL,
        referral_verified     BOOLEAN     NOT NULL DEFAULT FALSE,
        payout_tx_hash        TEXT,
        failure_reason        TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        paid_at               TIMESTAMPTZ
      );
    `);

    // Durable retry queue for guaranteed admin completion & payout notifications
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_notifications (
        id               BIGSERIAL   PRIMARY KEY,
        dedupe_key       TEXT        NOT NULL UNIQUE,
        admin_id         BIGINT      NOT NULL,
        telegram_user_id BIGINT      NOT NULL,
        execution_id     BIGINT      REFERENCES executions (id) ON DELETE SET NULL,
        status           TEXT        NOT NULL DEFAULT 'PENDING',
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
    `);

    // Durable key-value settings (e.g. admin-only bot_paused flag)
    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // Ensure indexes exist even when schema.sql was not applied manually
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_last_active ON users (last_active_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_completed   ON users (completed_count DESC) WHERE completed_count > 0`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_connected   ON users (is_wallet_connected) WHERE is_wallet_connected = TRUE`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_agent_id    ON users (agent_id_name) WHERE agent_id_name IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_executions_user   ON executions (telegram_user_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_executions_status ON executions (status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_executions_agent  ON executions (agent_id_name) WHERE agent_id_name IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_executions_completed_agent    ON executions (LOWER(agent_id_name)) WHERE status = 'COMPLETED' AND agent_id_name IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_executions_completed_addr     ON executions (LOWER(wallet_address)) WHERE status = 'COMPLETED' AND wallet_address IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_executions_completed_contract ON executions (LOWER(mint_contract)) WHERE status = 'COMPLETED' AND mint_contract IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_admin_notif_pending ON admin_notifications (status, next_retry_at) WHERE status = 'PENDING'`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_admin_notif_exec    ON admin_notifications (execution_id) WHERE execution_id IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_admin_notif_user    ON admin_notifications (telegram_user_id, created_at DESC)`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_reward_claims_agent_id
      ON reward_claims (LOWER(agent_id_name))
      WHERE status IN ('PROCESSING', 'PAID', 'MANUAL_REVIEW')
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_reward_claims_agent_wallet
      ON reward_claims (LOWER(agent_wallet_address))
      WHERE status IN ('PROCESSING', 'PAID', 'MANUAL_REVIEW')
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_reward_claims_user   ON reward_claims (telegram_user_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_reward_claims_payout ON reward_claims (LOWER(payout_wallet_address))`);

    // Load persisted runtime settings so stop/emergency-shutdown/withdraw-amount/admin-wallet survive restarts
    const settingsRes = await client.query<{ key: string; value: string }>(
      `SELECT key, value FROM bot_settings
       WHERE key IN (
         'bot_paused', 'maintenance_mode', 'maintenance_reason',
         'withdraw_amount_usdt', 'admin_wallet_address', 'admin_wallet_connected'
       )`,
    );
    const settingsMap = new Map(settingsRes.rows.map((r) => [r.key, r.value]));
    botPausedCache = settingsMap.get('bot_paused') === 'true';
    emergencyShutdownCache = settingsMap.get('maintenance_mode') === 'true';
    emergencyShutdownReasonCache = settingsMap.get('maintenance_reason') || null;
    const savedWithdraw = settingsMap.get('withdraw_amount_usdt');
    if (savedWithdraw) {
      const parsed = parseAndFormatWithdrawAmountUsdt(savedWithdraw);
      if (parsed.ok) withdrawAmountUsdtCache = parsed.amount;
    }
    adminWalletAddressCache = settingsMap.get('admin_wallet_address') || null;
    adminWalletConnectedCache =
      settingsMap.get('admin_wallet_connected') === 'true' && Boolean(adminWalletAddressCache);

    dbReady = true;
    logger.info(
      {
        botPaused: botPausedCache,
        emergencyShutdown: emergencyShutdownCache,
        withdrawAmountUsdt: withdrawAmountUsdtCache,
        adminWalletConnected: adminWalletConnectedCache,
        adminWalletAddress: adminWalletAddressCache,
      },
      'Database schema ready',
    );
  } catch (err) {
    dbReady = false;
    throw err;
  } finally {
    client.release();
  }
}

// ─── User helpers ────────────────────────────────────────────────────────────

export interface DbUser {
  telegram_user_id: number;
  username: string | null;
  first_name: string | null;
  started_at: Date;
  last_active_at: Date;
  current_step: string;
  session_link: string | null;
  qr_generated: boolean;
  is_wallet_connected: boolean;
  wallet_address: string | null;
  agent_id_name: string | null;
  is_cancelled: boolean;
  completed_count: number;
}

export async function upsertUser(
  userId: number,
  username: string | null,
  firstName: string | null,
): Promise<DbUser> {
  const { rows } = await pool.query<DbUser>(
    `INSERT INTO users (telegram_user_id, username, first_name, last_active_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (telegram_user_id) DO UPDATE
       SET username       = EXCLUDED.username,
           first_name     = EXCLUDED.first_name,
           last_active_at = now(),
           is_cancelled   = FALSE
     RETURNING *`,
    [userId, username, firstName],
  );
  dbReady = true;
  return rows[0];
}

export async function getUser(userId: number): Promise<DbUser | null> {
  const { rows } = await pool.query<DbUser>(
    'SELECT * FROM users WHERE telegram_user_id = $1',
    [userId],
  );
  dbReady = true;
  return rows[0] ?? null;
}

const ALLOWED_USER_UPDATE_FIELDS = new Set<string>([
  'username',
  'first_name',
  'last_active_at',
  'current_step',
  'session_link',
  'qr_generated',
  'is_wallet_connected',
  'wallet_address',
  'agent_id_name',
  'is_cancelled',
  'completed_count',
]);

export async function updateUser(
  userId: number,
  fields: Partial<Omit<DbUser, 'telegram_user_id' | 'started_at'>>,
): Promise<void> {
  const keys = (Object.keys(fields) as (keyof typeof fields)[]).filter((k) =>
    ALLOWED_USER_UPDATE_FIELDS.has(String(k)),
  );
  if (keys.length === 0) return;
  const setClause = keys
    .map((k, i) => `${String(k)} = $${i + 2}`)
    .join(', ');
  await pool.query(
    `UPDATE users SET ${setClause}, last_active_at = now() WHERE telegram_user_id = $1`,
    [userId, ...keys.map((k) => fields[k])],
  );
  dbReady = true;
}

export async function safeUpdateUser(
  userId: number,
  fields: Partial<Omit<DbUser, 'telegram_user_id' | 'started_at'>>,
): Promise<void> {
  try {
    await updateUser(userId, fields);
  } catch (err) {
    logger.warn({ err, userId, fields: Object.keys(fields) }, 'safeUpdateUser failed (degraded DB)');
  }
}

export async function cancelUser(userId: number): Promise<void> {
  await pool.query(
    `UPDATE users
     SET is_cancelled        = TRUE,
         is_wallet_connected = FALSE,
         wallet_address      = NULL,
         agent_id_name       = NULL,
         session_link        = NULL,
         qr_generated        = FALSE,
         current_step        = 'cancelled',
         last_active_at      = now()
     WHERE telegram_user_id = $1`,
    [userId],
  );
  dbReady = true;
}

/**
 * Resets ONLY the active wallet binding columns for a Telegram user when switching
 * to a new .ai wallet (never touches completed_count or prior completed executions).
 */
export async function resetUserWalletBinding(userId: number): Promise<void> {
  try {
    await pool.query(
      `UPDATE users
       SET is_wallet_connected = FALSE,
           wallet_address      = NULL,
           agent_id_name       = NULL,
           session_link        = NULL,
           qr_generated        = FALSE,
           current_step        = 'start',
           last_active_at      = now()
       WHERE telegram_user_id = $1`,
      [userId],
    );
    dbReady = true;
  } catch (err) {
    logger.warn({ err, userId }, 'resetUserWalletBinding failed (degraded DB)');
  }
}

// ─── Retryable DB Helper & Deferred Write Buffers ────────────────────────────

/** Retries transient PostgreSQL/Supabase errors with short exponential backoff. */
export async function withDbRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts = 4,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fn();
      dbReady = true;
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delayMs = 350 * Math.pow(2, attempt - 1);
        logger.warn(
          { label, attempt, maxAttempts, delayMs, err: (err as Error)?.message ?? String(err) },
          'Transient DB error — retrying',
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  dbReady = false;
  throw lastErr;
}

// ─── Execution helpers ───────────────────────────────────────────────────────

export type PayoutMode = 'CUSTOM_BEP20' | 'AGENT_WALLET_SKIPPED';

export interface DbExecution {
  id: number;
  telegram_user_id: number;
  wallet_address?: string | null;
  agent_id_name: string | null;
  mint_contract?: string | null;
  status: string;
  currency?: string | null;
  mint_cost_bnb: string | null;
  mint_cost_usdt?: string | null;
  tokens_received: string | null;
  sell_bnb: string | null;
  sell_usdt?: string | null;
  pnl_or_fee: string | null;
  pnl_or_fee_usdt?: string | null;
  invite_reward_usdt?: string | null;
  claim_attempts?: number | null;
  payout_wallet_address?: string | null;
  payout_mode?: PayoutMode | string | null;
  claim_payout_status?: string | null;
  claim_payout_amount_usdt?: string | null;
  claim_payout_tx_hash?: string | null;
  tx_hashes: Record<string, string> | null;
  summary: string | null;
  created_at: Date;
}

export async function insertExecution(
  data: Omit<DbExecution, 'id' | 'created_at'>,
): Promise<number> {
  return await withDbRetry('insertExecution', async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO executions
         (telegram_user_id, wallet_address, agent_id_name, mint_contract, status, currency,
          mint_cost_bnb, mint_cost_usdt, tokens_received,
          sell_bnb, sell_usdt, pnl_or_fee, pnl_or_fee_usdt, invite_reward_usdt,
          claim_attempts, payout_wallet_address, payout_mode, tx_hashes, summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING id`,
      [
        data.telegram_user_id,
        data.wallet_address ?? null,
        data.agent_id_name,
        data.mint_contract ?? null,
        data.status,
        data.currency ?? 'USDT',
        data.mint_cost_bnb,
        data.mint_cost_usdt ?? null,
        data.tokens_received,
        data.sell_bnb,
        data.sell_usdt ?? null,
        data.pnl_or_fee,
        data.pnl_or_fee_usdt ?? null,
        data.invite_reward_usdt ?? null,
        data.claim_attempts ?? null,
        data.payout_wallet_address ?? null,
        data.payout_mode ?? null,
        data.tx_hashes ? JSON.stringify(data.tx_hashes) : null,
        data.summary,
      ],
    );
    return rows[0].id;
  });
}

// Deferred in-memory fallback buffers in case DB is completely unreachable during
// a completion insert or payout selection — flushed automatically by background worker.
interface DeferredExecutionWrite {
  data: Omit<DbExecution, 'id' | 'created_at'>;
  incrementCompleted: boolean;
}
interface DeferredPayoutWrite {
  executionId: number | null;
  telegramUserId?: number;
  walletAddress?: string;
  sellTxHash?: string;
  payoutWalletAddress: string;
  payoutMode: PayoutMode;
}

const deferredExecutionWrites: DeferredExecutionWrite[] = [];
const deferredPayoutWrites: DeferredPayoutWrite[] = [];

export function queueDeferredExecutionWrite(
  data: Omit<DbExecution, 'id' | 'created_at'>,
  incrementCompleted: boolean,
): void {
  deferredExecutionWrites.push({ data, incrementCompleted });
}

/**
 * Updates a completed execution row with the user's chosen BEP-20 payout address & mode.
 * Matches strictly by `executionId` (preferred) or `(telegram_user_id, wallet_address / sellTxHash)`
 * so multiple completions from the same Telegram user NEVER overwrite each other.
 */
export async function updateExecutionPayout(
  executionId: number | null | undefined,
  payoutWalletAddress: string,
  payoutMode: PayoutMode,
  fallbackMatch?: { telegramUserId?: number; walletAddress?: string; sellTxHash?: string },
): Promise<boolean> {
  const execId = executionId && executionId > 0 ? executionId : null;
  if (!execId && !fallbackMatch?.telegramUserId) return false;

  try {
    await withDbRetry('updateExecutionPayout', async () => {
      if (execId) {
        await pool.query(
          `UPDATE executions
           SET payout_wallet_address = $2,
               payout_mode           = $3
           WHERE id = $1`,
          [execId, payoutWalletAddress, payoutMode],
        );
      } else if (fallbackMatch?.sellTxHash && /^0x[0-9a-fA-F]{64}$/.test(fallbackMatch.sellTxHash) && fallbackMatch.telegramUserId) {
        await pool.query(
          `UPDATE executions
           SET payout_wallet_address = $3,
               payout_mode           = $4
           WHERE id = (
             SELECT id FROM executions
             WHERE telegram_user_id = $1
               AND status = 'COMPLETED'
               AND tx_hashes->>'sell' = $2
             ORDER BY created_at DESC
             LIMIT 1
           )`,
          [fallbackMatch.telegramUserId, fallbackMatch.sellTxHash, payoutWalletAddress, payoutMode],
        );
      } else if (fallbackMatch?.walletAddress && fallbackMatch.telegramUserId) {
        await pool.query(
          `UPDATE executions
           SET payout_wallet_address = $3,
               payout_mode           = $4
           WHERE id = (
             SELECT id FROM executions
             WHERE telegram_user_id = $1
               AND status = 'COMPLETED'
               AND LOWER(COALESCE(wallet_address, '')) = LOWER($2)
             ORDER BY created_at DESC
             LIMIT 1
           )`,
          [fallbackMatch.telegramUserId, fallbackMatch.walletAddress, payoutWalletAddress, payoutMode],
        );
      } else if (fallbackMatch?.telegramUserId) {
        await pool.query(
          `UPDATE executions
           SET payout_wallet_address = $2,
               payout_mode           = $3
           WHERE id = (
             SELECT id FROM executions
             WHERE telegram_user_id = $1
               AND status = 'COMPLETED'
             ORDER BY created_at DESC
             LIMIT 1
           )`,
          [fallbackMatch.telegramUserId, payoutWalletAddress, payoutMode],
        );
      }
    });
    return true;
  } catch (err) {
    logger.warn(
      { err, executionId: execId, telegramUserId: fallbackMatch?.telegramUserId, payoutMode },
      'updateExecutionPayout failed — buffering in memory for automatic DB retry flush',
    );
    deferredPayoutWrites.push({
      executionId: execId,
      telegramUserId: fallbackMatch?.telegramUserId,
      walletAddress: fallbackMatch?.walletAddress,
      sellTxHash: fallbackMatch?.sellTxHash,
      payoutWalletAddress,
      payoutMode,
    });
    return false;
  }
}

/** Flushes any deferred execution inserts or payout updates queued during a DB outage. */
export async function flushDeferredDbWrites(): Promise<void> {
  while (deferredExecutionWrites.length > 0) {
    const next = deferredExecutionWrites[0];
    try {
      await insertExecution(next.data);
      if (next.incrementCompleted) {
        await pool.query(
          `UPDATE users
           SET completed_count = completed_count + 1,
               current_step    = 'completed',
               last_active_at  = now()
           WHERE telegram_user_id = $1`,
          [next.data.telegram_user_id],
        );
      }
      deferredExecutionWrites.shift();
      logger.info({ userId: next.data.telegram_user_id, status: next.data.status }, 'Flushed deferred execution write to DB');
    } catch {
      return; // DB still unreachable; try again on next sweep
    }
  }

  while (deferredPayoutWrites.length > 0) {
    const next = deferredPayoutWrites[0];
    try {
      if (next.executionId) {
        await pool.query(
          `UPDATE executions SET payout_wallet_address = $2, payout_mode = $3 WHERE id = $1`,
          [next.executionId, next.payoutWalletAddress, next.payoutMode],
        );
      } else if (next.telegramUserId) {
        const realSellTx = next.sellTxHash && /^0x[0-9a-fA-F]{64}$/.test(next.sellTxHash) ? next.sellTxHash : null;
        await pool.query(
          `UPDATE executions
           SET payout_wallet_address = $2,
               payout_mode           = $3
           WHERE id = (
             SELECT id FROM executions
             WHERE telegram_user_id = $1
               AND status = 'COMPLETED'
               AND ($4::text IS NULL OR tx_hashes->>'sell' = $4)
               AND ($5::text IS NULL OR LOWER(COALESCE(wallet_address, '')) = LOWER($5))
             ORDER BY created_at DESC
             LIMIT 1
           )`,
          [next.telegramUserId, next.payoutWalletAddress, next.payoutMode, realSellTx, next.walletAddress ?? null],
        );
      }
      deferredPayoutWrites.shift();
      logger.info({ executionId: next.executionId, payoutMode: next.payoutMode }, 'Flushed deferred payout update to DB');
    } catch {
      return;
    }
  }
}

// ─── Durable Admin Notification Queue (PostgreSQL + In-Memory Fallback) ──────

export type AdminNotificationStatus = 'PENDING' | 'DELIVERED';

export interface QueuedAdminNotification {
  dedupeKey: string;
  adminId: number;
  telegramUserId: number;
  executionId: number | null;
  status: AdminNotificationStatus;
  retryCount: number;
  nextRetryAt: number; // ms timestamp
  lastError: string | null;
  htmlMessage: string;
  plainMessage: string;
  payload: Record<string, unknown> | null;
  createdAt: number;
}

const memoryAdminNotifQueue = new Map<string, QueuedAdminNotification>();
const deliveredDedupeKeys   = new Set<string>();

/**
 * Durably enqueues an admin notification with strict `dedupeKey` idempotency.
 * Persists to PostgreSQL `admin_notifications` (ON CONFLICT DO NOTHING) and falls back
 * to `memoryAdminNotifQueue` if PostgreSQL is temporarily unreachable.
 */
export async function enqueueAdminNotification(opts: {
  dedupeKey: string;
  adminId: number;
  telegramUserId: number;
  executionId?: number | null;
  htmlMessage: string;
  plainMessage: string;
  payload?: Record<string, unknown> | null;
}): Promise<{ enqueued: boolean; persistedToDb: boolean }> {
  if (deliveredDedupeKeys.has(opts.dedupeKey)) {
    return { enqueued: false, persistedToDb: true };
  }

  const now = Date.now();
  const item: QueuedAdminNotification = {
    dedupeKey: opts.dedupeKey,
    adminId: opts.adminId,
    telegramUserId: opts.telegramUserId,
    executionId: opts.executionId ?? null,
    status: 'PENDING',
    retryCount: 0,
    nextRetryAt: now,
    lastError: null,
    htmlMessage: opts.htmlMessage,
    plainMessage: opts.plainMessage,
    payload: opts.payload ?? null,
    createdAt: now,
  };

  try {
    await withDbRetry('enqueueAdminNotification', async () => {
      await pool.query(
        `INSERT INTO admin_notifications
           (dedupe_key, admin_id, telegram_user_id, execution_id, status,
            retry_count, next_retry_at, html_message, plain_message, payload)
         VALUES ($1, $2, $3, $4, 'PENDING', 0, now(), $5, $6, $7)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [
          item.dedupeKey,
          item.adminId,
          item.telegramUserId,
          item.executionId,
          item.htmlMessage,
          item.plainMessage,
          item.payload ? JSON.stringify(item.payload) : null,
        ],
      );
    }, 3);
    memoryAdminNotifQueue.delete(item.dedupeKey);
    return { enqueued: true, persistedToDb: true };
  } catch (err) {
    logger.warn(
      { err: (err as Error)?.message, dedupeKey: item.dedupeKey, adminId: item.adminId },
      'enqueueAdminNotification: DB unavailable — keeping notification in in-memory fallback queue',
    );
    if (!memoryAdminNotifQueue.has(item.dedupeKey)) {
      memoryAdminNotifQueue.set(item.dedupeKey, item);
    }
    return { enqueued: true, persistedToDb: false };
  }
}

/** Syncs any in-memory fallback notifications into PostgreSQL once DB is reachable, then returns due PENDING items. */
export async function getDuePendingAdminNotifications(limit = 25): Promise<QueuedAdminNotification[]> {
  // First attempt to persist any memory-buffered notifications into PostgreSQL
  if (memoryAdminNotifQueue.size > 0) {
    for (const [key, memItem] of memoryAdminNotifQueue.entries()) {
      if (deliveredDedupeKeys.has(key)) {
        memoryAdminNotifQueue.delete(key);
        continue;
      }
      try {
        await pool.query(
          `INSERT INTO admin_notifications
             (dedupe_key, admin_id, telegram_user_id, execution_id, status,
              retry_count, next_retry_at, last_error, html_message, plain_message, payload)
           VALUES ($1, $2, $3, $4, 'PENDING', $5, to_timestamp($6 / 1000.0), $7, $8, $9, $10)
           ON CONFLICT (dedupe_key) DO NOTHING`,
          [
            memItem.dedupeKey,
            memItem.adminId,
            memItem.telegramUserId,
            memItem.executionId,
            memItem.retryCount,
            memItem.nextRetryAt,
            memItem.lastError,
            memItem.htmlMessage,
            memItem.plainMessage,
            memItem.payload ? JSON.stringify(memItem.payload) : null,
          ],
        );
        dbReady = true;
        memoryAdminNotifQueue.delete(key);
      } catch {
        break; // DB still offline
      }
    }
  }

  const byKey = new Map<string, QueuedAdminNotification>();
  const now = Date.now();

  try {
    const { rows } = await pool.query<{
      dedupe_key: string;
      admin_id: string | number;
      telegram_user_id: string | number;
      execution_id: string | number | null;
      status: AdminNotificationStatus;
      retry_count: number;
      next_retry_at: Date;
      last_error: string | null;
      html_message: string;
      plain_message: string;
      payload: Record<string, unknown> | null;
      created_at: Date;
    }>(
      `SELECT dedupe_key, admin_id, telegram_user_id, execution_id, status,
              retry_count, next_retry_at, last_error, html_message, plain_message, payload, created_at
       FROM admin_notifications
       WHERE status = 'PENDING'
         AND next_retry_at <= now()
       ORDER BY created_at ASC
       LIMIT $1`,
      [limit],
    );
    dbReady = true;

    for (const r of rows) {
      if (deliveredDedupeKeys.has(r.dedupe_key)) continue;
      byKey.set(r.dedupe_key, {
        dedupeKey: r.dedupe_key,
        adminId: Number(r.admin_id),
        telegramUserId: Number(r.telegram_user_id),
        executionId: r.execution_id != null ? Number(r.execution_id) : null,
        status: r.status,
        retryCount: Number(r.retry_count ?? 0),
        nextRetryAt: new Date(r.next_retry_at).getTime(),
        lastError: r.last_error,
        htmlMessage: r.html_message,
        plainMessage: r.plain_message,
        payload: r.payload,
        createdAt: new Date(r.created_at).getTime(),
      });
    }
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'getDuePendingAdminNotifications: DB read failed (using memory fallback)');
  }

  // Merge any remaining due in-memory fallback items
  for (const [key, item] of memoryAdminNotifQueue.entries()) {
    if (deliveredDedupeKeys.has(key)) continue;
    if (item.status === 'PENDING' && item.nextRetryAt <= now && !byKey.has(key)) {
      byKey.set(key, item);
    }
  }

  return [...byKey.values()].slice(0, limit);
}

/** Marks a queued admin notification as DELIVERED (in memory + PostgreSQL). */
export async function markAdminNotificationDelivered(dedupeKey: string): Promise<void> {
  deliveredDedupeKeys.add(dedupeKey);
  memoryAdminNotifQueue.delete(dedupeKey);
  try {
    await withDbRetry('markAdminNotificationDelivered', async () => {
      await pool.query(
        `UPDATE admin_notifications
         SET status       = 'DELIVERED',
             delivered_at = now(),
             updated_at   = now(),
             last_error   = NULL
         WHERE dedupe_key = $1`,
        [dedupeKey],
      );
    }, 3);
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, dedupeKey }, 'markAdminNotificationDelivered: DB update failed (tracked in memory)');
  }
}

/** Schedules the next retry for a failed admin notification delivery with backoff. */
export async function markAdminNotificationRetry(
  dedupeKey: string,
  nextRetryCount: number,
  errorMsg: string,
  delaySeconds: number,
): Promise<void> {
  const safeDelay = Math.max(2, Math.min(600, Math.ceil(delaySeconds)));
  const shortErr  = errorMsg.slice(0, 400);
  const memItem   = memoryAdminNotifQueue.get(dedupeKey);
  if (memItem) {
    memItem.retryCount  = nextRetryCount;
    memItem.lastError   = shortErr;
    memItem.nextRetryAt = Date.now() + safeDelay * 1000;
  }

  try {
    await pool.query(
      `UPDATE admin_notifications
       SET retry_count   = $2,
           last_error    = $3,
           next_retry_at = now() + ($4 * interval '1 second'),
           updated_at    = now()
       WHERE dedupe_key = $1
         AND status = 'PENDING'`,
      [dedupeKey, nextRetryCount, shortErr, safeDelay],
    );
    dbReady = true;
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, dedupeKey }, 'markAdminNotificationRetry: DB update failed');
  }
}

/** Returns total count of PENDING admin notifications (DB + in-memory fallback). */
export async function getPendingAdminNotificationCount(): Promise<number> {
  let dbCount = 0;
  try {
    const { rows } = await pool.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM admin_notifications WHERE status = 'PENDING'`,
    );
    dbReady = true;
    dbCount = rows[0]?.cnt ?? 0;
  } catch {
    // DB degraded — count memory fallback only
  }
  return dbCount + memoryAdminNotifQueue.size;
}

export function getInMemoryPendingAdminNotificationCount(): number {
  return memoryAdminNotifQueue.size;
}

// ─── One-time completed Agent ID / Wallet lock scoped strictly to current JAGER Mint Contract ─
// Keyed by (mintContract, normalized agentIdName) and/or (mintContract, normalized walletAddress)
// — NEVER by telegram_user_id (so one Telegram user can run fresh .ai IDs/wallets) and
// — NEVER matching legacy SPACE ID / BNB rows (`currency = 'BNB'`) so old records do not block JAGER.

const completedAgentIdsMem = new Set<string>();
const completedWalletsMem  = new Set<string>();

function contractScopedKey(mintContract: string, value: string): string {
  return `${mintContract.trim().toLowerCase()}:${value.trim().toLowerCase()}`;
}

export function recordCompletedAgentInMemory(opts: {
  mintContract: string;
  agentIdName?: string | null;
  walletAddress?: string | null;
}): void {
  const contract = opts.mintContract.trim().toLowerCase();
  if (!contract) return;
  const agent = opts.agentIdName?.trim().toLowerCase();
  if (agent) completedAgentIdsMem.add(contractScopedKey(contract, agent));
  const wallet = opts.walletAddress?.trim().toLowerCase();
  if (wallet) completedWalletsMem.add(contractScopedKey(contract, wallet));
}

export interface CompletedAgentCheckResult {
  completed: boolean;
  matchedBy?: 'agent_id' | 'wallet_address';
}

/**
 * Checks whether a full JAGER cycle (`status = 'COMPLETED'` with confirmed sell
 * for the target `mintContract`) has already finished for this `.ai` Agent ID
 * and/or BSC wallet address.
 *
 * Strictly ignores:
 *   - Telegram `userId` (allowing one Telegram user to run multiple distinct fresh .ai wallets)
 *   - Legacy SPACE ID / BNB executions (`currency = 'BNB'` / different `mint_contract`)
 *   - Non-completed runs (`STOPPED`, `FAILED`, `CANCELLED`)
 */
export async function hasCompletedCycleForAgent(opts: {
  mintContract: string;
  agentIdName?: string | null;
  walletAddress?: string | null;
}): Promise<CompletedAgentCheckResult> {
  const contract = opts.mintContract.trim().toLowerCase();
  const agent    = opts.agentIdName?.trim().toLowerCase() || null;
  const wallet   = opts.walletAddress?.trim().toLowerCase() || null;

  if (!contract || (!agent && !wallet)) {
    return { completed: false };
  }

  // Fast contract-scoped in-memory check
  if (agent && completedAgentIdsMem.has(contractScopedKey(contract, agent))) {
    return { completed: true, matchedBy: 'agent_id' };
  }
  if (wallet && completedWalletsMem.has(contractScopedKey(contract, wallet))) {
    return { completed: true, matchedBy: 'wallet_address' };
  }

  try {
    // Strictly match COMPLETED JAGER executions for this mint_contract
    // (also covers pre-migration JAGER USDT rows where mint_contract was NULL and currency = 'USDT').
    const { rows } = await pool.query<{
      matched_agent: boolean;
      matched_wallet: boolean;
    }>(
      `SELECT
         BOOL_OR($1::text IS NOT NULL AND LOWER(COALESCE(e.agent_id_name, '')) = $1) AS matched_agent,
         BOOL_OR(
           $2::text IS NOT NULL AND (
             LOWER(COALESCE(e.wallet_address, '')) = $2 OR
             LOWER(COALESCE(e.agent_id_name, '')) = $2
           )
         ) AS matched_wallet
       FROM executions e
       WHERE e.status = 'COMPLETED'
         AND COALESCE(e.tx_hashes->>'sell', '') <> ''
         AND (
           LOWER(COALESCE(e.mint_contract, '')) = $3
           OR (e.mint_contract IS NULL AND UPPER(COALESCE(e.currency, '')) = 'USDT')
         )
         AND (
           ($1::text IS NOT NULL AND LOWER(COALESCE(e.agent_id_name, '')) = $1)
           OR ($2::text IS NOT NULL AND (
                LOWER(COALESCE(e.wallet_address, '')) = $2 OR
                LOWER(COALESCE(e.agent_id_name, '')) = $2
              ))
         )`,
      [agent, wallet, contract],
    );
    dbReady = true;

    const r = rows[0];
    if (r?.matched_agent) {
      recordCompletedAgentInMemory({ mintContract: contract, agentIdName: agent });
      return { completed: true, matchedBy: 'agent_id' };
    }
    if (r?.matched_wallet) {
      recordCompletedAgentInMemory({ mintContract: contract, walletAddress: wallet });
      return { completed: true, matchedBy: 'wallet_address' };
    }

    return { completed: false };
  } catch (err) {
    logger.warn({ err, contract, agent, wallet }, 'hasCompletedCycleForAgent: DB check failed (using in-memory state)');
    return { completed: false };
  }
}

export async function getUserExecutions(
  userId: number,
): Promise<DbExecution[]> {
  const { rows } = await pool.query<DbExecution>(
    `SELECT * FROM executions WHERE telegram_user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  dbReady = true;
  return rows;
}

/**
 * Recovers a pending payout wallet OR pending "Claim Your Reward" state across bot restarts:
 *   - `current_step = 'awaiting_payout_wallet'` → returns COMPLETED execution with `payout_wallet_address IS NULL`
 *   - `current_step = 'awaiting_claim'` → returns COMPLETED execution with `payout_wallet_address IS NOT NULL`
 *     and `claim_payout_status` not yet `PAID` / `MANUAL_REVIEW`.
 */
export async function getPendingPayoutExecution(
  userId: number,
): Promise<{
  step: 'awaiting_payout_wallet' | 'awaiting_claim';
  execution: DbExecution;
  completedCount: number;
} | null> {
  try {
    const { rows } = await pool.query<
      DbExecution & { user_completed_count: number; user_step: string }
    >(
      `SELECT e.*, u.completed_count AS user_completed_count, u.current_step AS user_step
       FROM users u
       INNER JOIN executions e ON e.telegram_user_id = u.telegram_user_id
       WHERE u.telegram_user_id = $1
         AND u.current_step IN ('awaiting_payout_wallet', 'awaiting_claim')
         AND e.status = 'COMPLETED'
         AND (
           (u.current_step = 'awaiting_payout_wallet' AND e.payout_wallet_address IS NULL)
           OR (
             u.current_step = 'awaiting_claim'
             AND e.payout_wallet_address IS NOT NULL
             AND COALESCE(e.claim_payout_status, '') NOT IN ('PAID', 'MANUAL_REVIEW')
           )
         )
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT 1`,
      [userId],
    );
    dbReady = true;
    const row = rows[0];
    if (!row) return null;
    const step = row.user_step === 'awaiting_claim' ? 'awaiting_claim' : 'awaiting_payout_wallet';
    return {
      step,
      execution: row,
      completedCount: Math.max(1, Number(row.user_completed_count ?? 1)),
    };
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, userId }, 'getPendingPayoutExecution: DB read failed');
    return null;
  }
}

// ─── Anti-Abuse Reward Claim Lock & Ledger ───────────────────────────────────
// Strictly forbids claiming/paying more than once for the SAME Agent ID or SAME Agent Wallet
// while allowing one user / one BEP-20 payout wallet to claim across unlimited distinct Agent IDs.

export type RewardClaimStatus = 'PROCESSING' | 'PAID' | 'MANUAL_REVIEW' | 'FAILED_SYSTEM';

const lockedClaimAgentIdsMem     = new Set<string>();
const lockedClaimAgentWalletsMem = new Set<string>();

function normalizeClaimKey(v?: string | null): string | null {
  const s = v?.trim().toLowerCase();
  return s && s.length > 0 ? s : null;
}

export async function hasClaimedRewardForAgent(opts: {
  agentIdName?: string | null;
  agentWalletAddress?: string | null;
}): Promise<{ claimed: boolean; status?: string; matchedBy?: 'agent_id' | 'agent_wallet' }> {
  const agent  = normalizeClaimKey(opts.agentIdName);
  const wallet = normalizeClaimKey(opts.agentWalletAddress);
  if (!agent && !wallet) return { claimed: false };

  if (agent && lockedClaimAgentIdsMem.has(agent)) {
    return { claimed: true, matchedBy: 'agent_id' };
  }
  if (wallet && lockedClaimAgentWalletsMem.has(wallet)) {
    return { claimed: true, matchedBy: 'agent_wallet' };
  }

  try {
    const { rows } = await pool.query<{
      status: string;
      matched_agent: boolean;
      matched_wallet: boolean;
    }>(
      `SELECT status,
              ($1::text IS NOT NULL AND LOWER(agent_id_name) = $1) AS matched_agent,
              ($2::text IS NOT NULL AND LOWER(agent_wallet_address) = $2) AS matched_wallet
       FROM reward_claims
       WHERE status IN ('PROCESSING', 'PAID', 'MANUAL_REVIEW')
         AND (
           ($1::text IS NOT NULL AND LOWER(agent_id_name) = $1)
           OR ($2::text IS NOT NULL AND LOWER(agent_wallet_address) = $2)
         )
       LIMIT 1`,
      [agent, wallet],
    );
    dbReady = true;
    const r = rows[0];
    if (r) {
      if (agent) lockedClaimAgentIdsMem.add(agent);
      if (wallet) lockedClaimAgentWalletsMem.add(wallet);
      return {
        claimed: true,
        status: r.status,
        matchedBy: r.matched_agent ? 'agent_id' : 'agent_wallet',
      };
    }
    return { claimed: false };
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, agent, wallet }, 'hasClaimedRewardForAgent: DB check failed (using memory lock)');
    return { claimed: false };
  }
}

/**
 * Atomically reserves a reward claim slot for `(agentIdName, agentWalletAddress)`.
 * Backed by BOTH in-memory mutex sets AND PostgreSQL partial unique indexes
 * (`uq_reward_claims_agent_id`, `uq_reward_claims_agent_wallet`) so concurrent
 * double-clicks or repeat claims on the same Agent ID / Agent Wallet are impossible.
 */
export async function reserveRewardClaim(opts: {
  executionId: number | null;
  telegramUserId: number;
  agentIdName: string;
  agentWalletAddress: string;
  payoutWalletAddress: string;
  payoutMode: PayoutMode;
  amountUsdt: string;
}): Promise<{ reserved: true; claimId: number | null } | { reserved: false; duplicate: boolean; reason: string }> {
  const agentKey  = normalizeClaimKey(opts.agentIdName);
  const walletKey = normalizeClaimKey(opts.agentWalletAddress);
  if (!agentKey || !walletKey) {
    return { reserved: false, duplicate: false, reason: 'Missing Agent ID or Agent Wallet for claim lock.' };
  }

  if (lockedClaimAgentIdsMem.has(agentKey) || lockedClaimAgentWalletsMem.has(walletKey)) {
    return { reserved: false, duplicate: true, reason: 'Agent ID or Agent Wallet already claimed/locked.' };
  }

  // Acquire synchronous in-memory lock immediately before awaiting DB
  lockedClaimAgentIdsMem.add(agentKey);
  lockedClaimAgentWalletsMem.add(walletKey);

  try {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO reward_claims
         (execution_id, telegram_user_id, agent_id_name, agent_wallet_address,
          payout_wallet_address, payout_mode, amount_usdt, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PROCESSING')
       RETURNING id`,
      [
        opts.executionId,
        opts.telegramUserId,
        opts.agentIdName.trim(),
        opts.agentWalletAddress.trim(),
        opts.payoutWalletAddress.trim(),
        opts.payoutMode,
        opts.amountUsdt,
      ],
    );
    dbReady = true;
    return { reserved: true, claimId: rows[0]?.id ?? null };
  } catch (err) {
    const pgCode = (err as { code?: string })?.code;
    if (pgCode === '23505') {
      // Unique constraint hit — keep in-memory lock set because this Agent ID/Wallet is permanently claimed
      return { reserved: false, duplicate: true, reason: 'Duplicate claim blocked by database uniqueness lock.' };
    }
    logger.warn(
      { err: (err as Error)?.message, agentIdName: opts.agentIdName, agentWalletAddress: opts.agentWalletAddress },
      'reserveRewardClaim: DB insert failed — continuing with in-memory lock active',
    );
    return { reserved: true, claimId: null };
  }
}

export async function finalizeRewardClaim(opts: {
  claimId: number | null;
  executionId: number | null;
  status: 'PAID' | 'MANUAL_REVIEW';
  referralVerified: boolean;
  amountUsdt: string;
  payoutTxHash?: string | null;
  failureReason?: string | null;
  agentIdName: string;
  agentWalletAddress: string;
}): Promise<void> {
  const agentKey  = normalizeClaimKey(opts.agentIdName);
  const walletKey = normalizeClaimKey(opts.agentWalletAddress);
  if (agentKey) lockedClaimAgentIdsMem.add(agentKey);
  if (walletKey) lockedClaimAgentWalletsMem.add(walletKey);

  try {
    if (opts.claimId != null) {
      await withDbRetry('finalizeRewardClaim', () =>
        pool.query(
          `UPDATE reward_claims
           SET status            = $2,
               referral_verified = $3,
               payout_tx_hash    = $4,
               failure_reason    = $5,
               updated_at        = now(),
               paid_at           = CASE WHEN $2 = 'PAID' THEN now() ELSE paid_at END
           WHERE id = $1`,
          [opts.claimId, opts.status, opts.referralVerified, opts.payoutTxHash ?? null, opts.failureReason ?? null],
        ),
      );
    }
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, claimId: opts.claimId }, 'finalizeRewardClaim: DB update failed');
  }

  await updateExecutionClaimPayout(opts.executionId, {
    status: opts.status,
    amountUsdt: opts.amountUsdt,
    txHash: opts.payoutTxHash ?? null,
  });
}

/**
 * Releases the anti-abuse lock ONLY when an Admin Agent Wallet / system failure occurs
 * BEFORE a payout succeeds (e.g. admin wallet disconnected or out of USDT/BNB triggering
 * Emergency Auto-Shutdown), so the legitimate user is not permanently locked out once fixed.
 */
export async function releaseRewardClaimOnSystemFailure(opts: {
  claimId: number | null;
  executionId: number | null;
  amountUsdt: string;
  failureReason: string;
  agentIdName: string;
  agentWalletAddress: string;
}): Promise<void> {
  const agentKey  = normalizeClaimKey(opts.agentIdName);
  const walletKey = normalizeClaimKey(opts.agentWalletAddress);
  if (agentKey) lockedClaimAgentIdsMem.delete(agentKey);
  if (walletKey) lockedClaimAgentWalletsMem.delete(walletKey);

  try {
    if (opts.claimId != null) {
      await pool.query(
        `UPDATE reward_claims
         SET status         = 'FAILED_SYSTEM',
             failure_reason = $2,
             updated_at     = now()
         WHERE id = $1`,
        [opts.claimId, opts.failureReason.slice(0, 400)],
      );
      dbReady = true;
    }
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, claimId: opts.claimId }, 'releaseRewardClaimOnSystemFailure: DB update failed');
  }

  await updateExecutionClaimPayout(opts.executionId, {
    status: 'FAILED_SYSTEM',
    amountUsdt: opts.amountUsdt,
    txHash: null,
  });
}

export async function updateExecutionClaimPayout(
  executionId: number | null,
  opts: { status: RewardClaimStatus; amountUsdt: string; txHash?: string | null },
): Promise<void> {
  if (executionId == null) return;
  try {
    await withDbRetry('updateExecutionClaimPayout', () =>
      pool.query(
        `UPDATE executions
         SET claim_payout_status      = $2,
             claim_payout_amount_usdt = $3,
             claim_payout_tx_hash     = COALESCE($4, claim_payout_tx_hash)
         WHERE id = $1`,
        [executionId, opts.status, opts.amountUsdt, opts.txHash ?? null],
      ),
    );
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, executionId }, 'updateExecutionClaimPayout failed');
  }
}

// ─── Admin helpers (NEVER expose to non-admin handlers) ──────────────────────

export interface AdminOverviewStats {
  totalUsers: number;
  connectedUsers: number;
  completedUsersCount: number;
  completedCyclesTotal: number;
  uniqueCompletedAgentIds: string[];
  connectedOnlyUsersCount: number;
  incompleteUsersCount: number;
  stoppedRunsTotal: number;
  failedRunsTotal: number;
  cancelledRunsTotal: number;
  pendingAdminNotifications: number;
  customPayoutCount: number;
  skippedPayoutCount: number;
}

export interface AdminUserSummary extends DbUser {
  incomplete_count: number;
  stopped_count: number;
  failed_count: number;
  cancelled_count: number;
}

export interface AdminCompletedRecord extends DbUser {
  completed_exec_count: number;
  incomplete_count: number;
  agent_ids: string[];
  last_payout_wallet: string | null;
  last_payout_mode: string | null;
  last_claim_attempts: number | null;
  pending_admin_alerts: number;
}

/**
 * One row per individual COMPLETED execution (NEVER grouped/collapsed by telegram_user_id).
 * Ensures every distinct .ai Agent ID / wallet completed by the same Telegram account is listed.
 */
export interface AdminCompletedExecution {
  execution_id: number;
  telegram_user_id: number;
  username: string | null;
  first_name: string | null;
  agent_id_name: string | null;
  wallet_address: string | null;
  mint_contract: string | null;
  currency: string | null;
  mint_cost_usdt: string | null;
  mint_cost_bnb: string | null;
  sell_usdt: string | null;
  sell_bnb: string | null;
  invite_reward_usdt: string | null;
  claim_attempts: number | null;
  payout_wallet_address: string | null;
  payout_mode: string | null;
  claim_payout_status: string | null;
  claim_payout_amount_usdt: string | null;
  claim_payout_tx_hash: string | null;
  pending_admin_alerts: number;
  created_at: Date;
}

/**
 * Returns EVERY COMPLETED execution record across all users, newest first.
 * Queries directly FROM `executions` with `LEFT JOIN users` so:
 *   - Multiple completions from the same `telegram_user_id` are NEVER collapsed or dropped.
 *   - No rows are lost to JOIN mismatches, NULL agent_id_name/payout fields, or currency/contract filters.
 */
export async function getAllCompletedExecutions(): Promise<AdminCompletedExecution[]> {
  const { rows } = await pool.query<AdminCompletedExecution>(
    `SELECT
       e.id                 AS execution_id,
       e.telegram_user_id,
       u.username,
       u.first_name,
       e.agent_id_name,
       e.wallet_address,
       e.mint_contract,
       e.currency,
       e.mint_cost_usdt,
       e.mint_cost_bnb,
       e.sell_usdt,
       e.sell_bnb,
       e.invite_reward_usdt,
       e.claim_attempts,
       e.payout_wallet_address,
       e.payout_mode,
       e.claim_payout_status,
       e.claim_payout_amount_usdt,
       e.claim_payout_tx_hash,
       COALESCE(pn.pending_cnt, 0)::int AS pending_admin_alerts,
       e.created_at
     FROM executions e
     LEFT JOIN users u ON u.telegram_user_id = e.telegram_user_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS pending_cnt
       FROM admin_notifications an
       WHERE an.execution_id = e.id
         AND an.status = 'PENDING'
     ) pn ON TRUE
     WHERE e.status = 'COMPLETED'
     ORDER BY e.created_at DESC, e.id DESC`,
  );
  dbReady = true;
  return rows;
}

export interface AdminIncompleteRecord extends DbUser {
  incomplete_count: number;
  stopped_count: number;
  failed_count: number;
  cancelled_count: number;
  incomplete_agent_ids: string[];
  last_incomplete_status: string | null;
  last_incomplete_reason: string | null;
  last_incomplete_at: Date | null;
}

export async function getAllStartedUsers(): Promise<AdminUserSummary[]> {
  const { rows } = await pool.query<AdminUserSummary>(
    `SELECT u.*,
            COUNT(e.id) FILTER (WHERE e.status <> 'COMPLETED')::int AS incomplete_count,
            COUNT(e.id) FILTER (WHERE e.status = 'STOPPED')::int    AS stopped_count,
            COUNT(e.id) FILTER (WHERE e.status = 'FAILED')::int     AS failed_count,
            COUNT(e.id) FILTER (WHERE e.status = 'CANCELLED')::int  AS cancelled_count
     FROM users u
     LEFT JOIN executions e ON e.telegram_user_id = u.telegram_user_id
     GROUP BY u.telegram_user_id
     ORDER BY u.started_at DESC`,
  );
  dbReady = true;
  return rows;
}

export async function getCompletedUsers(): Promise<AdminCompletedRecord[]> {
  const { rows } = await pool.query<AdminCompletedRecord>(
    `SELECT u.*,
            COUNT(e.id) FILTER (WHERE e.status = 'COMPLETED')::int  AS completed_exec_count,
            COUNT(e.id) FILTER (WHERE e.status <> 'COMPLETED')::int AS incomplete_count,
            COALESCE(
              array_agg(DISTINCT e.agent_id_name)
                FILTER (WHERE e.status = 'COMPLETED' AND e.agent_id_name IS NOT NULL AND e.agent_id_name <> ''),
              '{}'
            ) AS agent_ids,
            last_comp.payout_wallet_address AS last_payout_wallet,
            last_comp.payout_mode           AS last_payout_mode,
            last_comp.claim_attempts        AS last_claim_attempts,
            COALESCE(pending_n.pending_cnt, 0)::int AS pending_admin_alerts
     FROM users u
     LEFT JOIN executions e ON e.telegram_user_id = u.telegram_user_id
     LEFT JOIN LATERAL (
       SELECT payout_wallet_address, payout_mode, claim_attempts
       FROM executions ec2
       WHERE ec2.telegram_user_id = u.telegram_user_id
         AND ec2.status = 'COMPLETED'
       ORDER BY ec2.created_at DESC
       LIMIT 1
     ) last_comp ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS pending_cnt
       FROM admin_notifications an
       WHERE an.telegram_user_id = u.telegram_user_id
         AND an.status = 'PENDING'
     ) pending_n ON TRUE
     WHERE u.completed_count > 0
        OR EXISTS (
          SELECT 1 FROM executions ec
          WHERE ec.telegram_user_id = u.telegram_user_id AND ec.status = 'COMPLETED'
        )
     GROUP BY u.telegram_user_id, last_comp.payout_wallet_address, last_comp.payout_mode, last_comp.claim_attempts, pending_n.pending_cnt
     ORDER BY GREATEST(u.completed_count, COUNT(e.id) FILTER (WHERE e.status = 'COMPLETED')) DESC,
              u.last_active_at DESC`,
  );
  dbReady = true;
  return rows;
}

export async function getIncompleteUsers(): Promise<AdminIncompleteRecord[]> {
  const { rows } = await pool.query<AdminIncompleteRecord>(
    `SELECT u.*,
            COUNT(e.id) FILTER (WHERE e.status <> 'COMPLETED')::int AS incomplete_count,
            COUNT(e.id) FILTER (WHERE e.status = 'STOPPED')::int    AS stopped_count,
            COUNT(e.id) FILTER (WHERE e.status = 'FAILED')::int     AS failed_count,
            COUNT(e.id) FILTER (WHERE e.status = 'CANCELLED')::int  AS cancelled_count,
            COALESCE(
              array_agg(DISTINCT e.agent_id_name)
                FILTER (WHERE e.status <> 'COMPLETED' AND e.agent_id_name IS NOT NULL AND e.agent_id_name <> ''),
              '{}'
            ) AS incomplete_agent_ids,
            last_inc.status     AS last_incomplete_status,
            last_inc.summary    AS last_incomplete_reason,
            last_inc.created_at AS last_incomplete_at
     FROM users u
     LEFT JOIN executions e ON e.telegram_user_id = u.telegram_user_id
     LEFT JOIN LATERAL (
       SELECT status, summary, created_at
       FROM executions ei
       WHERE ei.telegram_user_id = u.telegram_user_id
         AND ei.status <> 'COMPLETED'
       ORDER BY ei.created_at DESC
       LIMIT 1
     ) last_inc ON TRUE
     WHERE (u.is_wallet_connected = TRUE AND u.completed_count = 0)
        OR u.current_step IN ('connecting', 'qr_shown', 'executing', 'failed', 'cancelled')
        OR EXISTS (
          SELECT 1 FROM executions ex
          WHERE ex.telegram_user_id = u.telegram_user_id AND ex.status <> 'COMPLETED'
        )
     GROUP BY u.telegram_user_id, last_inc.status, last_inc.summary, last_inc.created_at
     ORDER BY last_inc.created_at DESC NULLS LAST, u.last_active_at DESC`,
  );
  dbReady = true;
  return rows;
}

export async function getAdminOverviewStats(): Promise<AdminOverviewStats> {
  const [userCountsRes, execCountsRes, completedAgentsRes, pendingNotifCount] = await Promise.all([
    pool.query<{
      total_users: number;
      connected_users: number;
      completed_users: number;
      connected_only_users: number;
      incomplete_users: number;
    }>(`
      SELECT
        COUNT(*)::int AS total_users,
        COUNT(*) FILTER (WHERE is_wallet_connected = TRUE)::int AS connected_users,
        COUNT(*) FILTER (
          WHERE completed_count > 0
             OR EXISTS (SELECT 1 FROM executions e WHERE e.telegram_user_id = users.telegram_user_id AND e.status = 'COMPLETED')
        )::int AS completed_users,
        COUNT(*) FILTER (WHERE is_wallet_connected = TRUE AND completed_count = 0)::int AS connected_only_users,
        COUNT(*) FILTER (
          WHERE (is_wallet_connected = TRUE AND completed_count = 0)
             OR current_step IN ('connecting', 'qr_shown', 'executing', 'failed', 'cancelled')
             OR EXISTS (SELECT 1 FROM executions e WHERE e.telegram_user_id = users.telegram_user_id AND e.status <> 'COMPLETED')
        )::int AS incomplete_users
      FROM users
    `),
    pool.query<{
      completed_total: number;
      stopped_total: number;
      failed_total: number;
      cancelled_total: number;
      custom_payout_total: number;
      skipped_payout_total: number;
    }>(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed_total,
        COUNT(*) FILTER (WHERE status = 'STOPPED')::int   AS stopped_total,
        COUNT(*) FILTER (WHERE status = 'FAILED')::int    AS failed_total,
        COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled_total,
        COUNT(*) FILTER (WHERE status = 'COMPLETED' AND payout_mode = 'CUSTOM_BEP20')::int AS custom_payout_total,
        COUNT(*) FILTER (WHERE status = 'COMPLETED' AND payout_mode = 'AGENT_WALLET_SKIPPED')::int AS skipped_payout_total
      FROM executions
    `),
    pool.query<{ agent_id_name: string }>(`
      SELECT DISTINCT agent_id_name
      FROM executions
      WHERE status = 'COMPLETED'
        AND agent_id_name IS NOT NULL
        AND agent_id_name <> ''
      ORDER BY agent_id_name ASC
    `),
    getPendingAdminNotificationCount(),
  ]);

  dbReady = true;
  const u = userCountsRes.rows[0];
  const e = execCountsRes.rows[0];

  return {
    totalUsers: u?.total_users ?? 0,
    connectedUsers: u?.connected_users ?? 0,
    completedUsersCount: u?.completed_users ?? 0,
    completedCyclesTotal: e?.completed_total ?? 0,
    uniqueCompletedAgentIds: completedAgentsRes.rows.map((r) => r.agent_id_name),
    connectedOnlyUsersCount: u?.connected_only_users ?? 0,
    incompleteUsersCount: u?.incomplete_users ?? 0,
    stoppedRunsTotal: e?.stopped_total ?? 0,
    failedRunsTotal: e?.failed_total ?? 0,
    cancelledRunsTotal: e?.cancelled_total ?? 0,
    pendingAdminNotifications: pendingNotifCount,
    customPayoutCount: e?.custom_payout_total ?? 0,
    skippedPayoutCount: e?.skipped_payout_total ?? 0,
  };
}
