// src/wallet.ts
// ═══════════════════════════════════════════════════════════════════════
// LAYER 1: Wallet / Signing
//
// Uses @binance/agentic-wallet CLI ("baw") — a local npm dependency.
// Two-phase contract execution (preview → execute) through the user's
// Binance Agentic Wallet (MPC keyless). No private key is ever stored,
// collected, or requested from any user.
//
// SECURITY BOUNDARY:
//   - bot operator may set EXECUTOR_PRIVATE_KEY for a dedicated EOA wallet
//     used only by the bot itself — NEVER to hold or collect other users' keys.
//   - baw CLI manages user keys via Binance MPC infrastructure.
//   - Per-user baw session files live under ~/.baw-sessions/<userId>/
// ═══════════════════════════════════════════════════════════════════════

import { spawn }    from 'child_process';
import * as path    from 'path';
import * as fs      from 'fs';
import { ethers }   from 'ethers';
import { config }   from './config.js';
import { logger }   from './logger.js';
import { pool, setAdminWalletConfig, getAdminWalletConfig } from './db.js';
import {
  ADDR,
  MIN_ADMIN_PAYOUT_BNB_GAS,
  TOKEN_DECIMALS,
  buildUsdtTransferCalldata,
  pollTransactionReceipt,
  readBnbBalance,
  readUsdtBalance,
  readUsdtDecimals,
  simulateContractCall,
} from './bsc.js';

function normalizeEvmAddress(raw: string, label = 'wallet.address'): string {
  const trimmed = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    throw new Error(`Invalid EVM ${label}: "${raw}"`);
  }
  const normalized = ethers.getAddress(trimmed.toLowerCase());
  if (trimmed !== normalized) {
    logger.info({ label, original: trimmed, normalized }, 'Normalized EVM address to EIP-55 checksum');
  }
  return normalized;
}

// ─── baw binary path (portable across npm layouts & OSes) ───────────────────
function resolveBawBin(): string {
  const localCandidate = path.resolve(
    __dirname, '..', 'node_modules', '@binance', 'agentic-wallet', 'dist', 'index.js',
  );
  if (fs.existsSync(localCandidate)) return localCandidate;

  try {
    const pkgPath = require.resolve('@binance/agentic-wallet/package.json');
    const pkgDir  = path.dirname(pkgPath);
    const pkg     = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      bin?: string | Record<string, string>;
      main?: string;
    };
    const relBin = typeof pkg.bin === 'string'
      ? pkg.bin
      : pkg.bin?.baw ?? Object.values(pkg.bin ?? {})[0] ?? pkg.main ?? 'dist/index.js';
    const resolved = path.resolve(pkgDir, relBin);
    if (fs.existsSync(resolved)) return resolved;
  } catch {
    // Package not installed — bawAvailable() will report false
  }
  return localCandidate;
}

const BAW_BIN = resolveBawBin();

export function bawAvailable(): boolean {
  return fs.existsSync(BAW_BIN);
}

export function getBawBinPath(): string {
  return BAW_BIN;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WalletSession {
  qrCodeId: string;
  urlForWeb: string;
  pairingCode?: string;
  expireAt: number;          // ms timestamp
  walletAddress?: string;
  agentIdName?: string;
}

// Dedicated isolated baw session key for the Admin Agent Wallet (treasury for BEP-20 USDT auto-payouts).
export const ADMIN_WALLET_SESSION_KEY = 'admin-treasury' as const;

// In-memory cache; Supabase is durable source of truth.
const sessions = new Map<number, WalletSession>();
let adminWalletSession: WalletSession | null = null;
let adminPairingNonce = 0;

// Per-session execution mutex — prevents concurrent contract-calls on one session.
const execLocks = new Map<string, Promise<void>>();

// Per-user pairing generation counter — invalidates stale background verifyAndBindSession calls
// if the user restarts /connect or clicks Cancel before pairing completes.
const pairingNonces = new Map<number, number>();
function bumpPairingNonce(userId: number): number {
  const next = (pairingNonces.get(userId) ?? 0) + 1;
  pairingNonces.set(userId, next);
  return next;
}

// ─── Core baw CLI helper ─────────────────────────────────────────────────────

/**
 * Runs `node <baw> <args...> --json` with per-session HOME isolation.
 * Accepts either a numeric Telegram `userId` or a named session key (e.g. `'admin-treasury'`).
 * Returns parsed JSON output. Throws with stderr on failure.
 */
export async function callBaw(
  args: string[],
  sessionKey?: number | string,
  timeoutMs = 30_000,
): Promise<unknown> {
  if (!bawAvailable()) {
    throw new Error(
      `@binance/agentic-wallet CLI binary not found at ${BAW_BIN}. Run "npm ci" or "npm install" before starting.`,
    );
  }

  return new Promise((resolve, reject) => {
    const userHome = sessionKey != null
      ? path.join(config.BAW_SESSION_ROOT, String(sessionKey))
      : config.BAW_SESSION_ROOT;

    try {
      fs.mkdirSync(userHome, { recursive: true });
    } catch (mkdirErr) {
      return reject(new Error(
        `Cannot create baw session directory (${userHome}): ${(mkdirErr as Error).message}. ` +
        `Set BAW_SESSION_ROOT to a writable directory.`,
      ));
    }

    const child = spawn(
      process.execPath,
      [BAW_BIN, ...args, '--json'],
      { env: { ...process.env, HOME: userHome, USERPROFILE: userHome },
        stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`baw [${args.join(' ')}] timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.on('error', (spawnErr) => {
      clearTimeout(timer);
      reject(new Error(`Failed to launch baw CLI: ${spawnErr.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // Surface the most useful part of the error
        const detail = stderr.trim() || stdout.trim();
        const isExpired =
          /SESSION_EXPIRED|UNCONNECTED|TOKEN_EXPIRED|LOGIN_EXPIRED|INVALID_SESSION|not.*logged|not.*signed.?in|please sign in|unauthorized/i.test(detail);
        const err = new Error(
          isExpired
            ? 'SESSION_EXPIRED: Binance Wallet session has expired. Please reconnect.'
            : `baw error (${code}): ${detail.slice(0, 300)}`,
        );
        (err as Error & { isSessionExpired?: boolean }).isSessionExpired = isExpired;
        return reject(err);
      }
      const trimmed = stdout.trim();
      try {
        resolve(JSON.parse(trimmed));
      } catch {
        // Fallback if CLI emitted a non-JSON banner/warning line before the JSON payload
        const jsonStart = trimmed.indexOf('{');
        const jsonEnd   = trimmed.lastIndexOf('}');
        if (jsonStart >= 0 && jsonEnd > jsonStart) {
          try {
            resolve(JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)));
            return;
          } catch { /* fall through */ }
        }
        reject(new Error(`baw non-JSON output: ${trimmed.slice(0, 200)}`));
      }
    });
  });
}

// ─── Auth / pairing ──────────────────────────────────────────────────────────

export async function generatePairingUri(userId: number): Promise<WalletSession | null> {
  try {
    const raw = await callBaw(['auth', 'signin'], userId, 15_000) as Record<string, unknown>;

    // Log raw shape BEFORE any parsing so "unexpected shape" is always diagnosable
    logger.info(
      { userId, rawKeys: Object.keys(raw), rawSnippet: JSON.stringify(raw).slice(0, 500) },
      'baw auth signin raw response',
    );

    // Handle "already connected" case
    if (raw.status === 'ALREADY_CONNECTED') {
      logger.info({ userId }, 'baw: already connected');
      const existing = sessions.get(userId);
      if (existing?.walletAddress) return existing;
      return await refreshSessionFromBaw(userId);
    }

    // Binance API sometimes wraps payload under .data or .result
    const payload: Record<string, unknown> =
      raw.data   != null && typeof raw.data   === 'object' ? raw.data   as Record<string, unknown> :
      raw.result != null && typeof raw.result === 'object' ? raw.result as Record<string, unknown> :
      raw;

    // Also bubble up nested "already connected"
    if (payload.status === 'ALREADY_CONNECTED') {
      logger.info({ userId }, 'baw: already connected (nested payload)');
      const existing = sessions.get(userId);
      if (existing?.walletAddress) return existing;
      return await refreshSessionFromBaw(userId);
    }

    const qrCodeId    = String(payload.qrCodeId    ?? payload.qrCode    ?? payload.id    ?? '');
    const urlForWeb   = String(payload.urlForWeb   ?? payload.qrCodeUrl ?? payload.url   ?? payload.link ?? '');
    const expireAt    = Number(payload.expireAt    ?? payload.expiry    ?? payload.expiresAt ?? Date.now() + 300_000);
    const pairingCode = payload.pairingCode != null ? String(payload.pairingCode) : undefined;

    if (!qrCodeId || !urlForWeb) {
      logger.error(
        { userId, payloadKeys: Object.keys(payload), rawKeys: Object.keys(raw), rawSnippet: JSON.stringify(raw).slice(0, 500) },
        'baw auth signin: unexpected shape — cannot find qrCodeId/urlForWeb',
      );
      return null;
    }

    const session: WalletSession = { qrCodeId, urlForWeb, expireAt, pairingCode };
    sessions.set(userId, session);

    try {
      await pool.query(
        `UPDATE users SET session_link=$2, is_wallet_connected=FALSE,
         current_step='connecting', last_active_at=now() WHERE telegram_user_id=$1`,
        [userId, urlForWeb],
      );
    } catch (dbErr) {
      logger.warn({ dbErr, userId }, 'generatePairingUri: DB update failed (continuing with in-memory session)');
    }

    logger.info({ userId, qrCodeId, expireAt }, 'baw auth signin ok');
    return session;
  } catch (err) {
    logger.error({ err, userId }, 'generatePairingUri failed');
    return null;
  }
}

/** Unwraps Binance API envelope: { data: {...} } or { result: {...} } or root. */
function unwrap(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.data   != null && typeof raw.data   === 'object') return raw.data   as Record<string, unknown>;
  if (raw.result != null && typeof raw.result === 'object') return raw.result as Record<string, unknown>;
  return raw;
}

/** Extracts a claimed *.ai Agent ID from unwrapped baw wallet agent-id output. */
function extractAgentIdName(agentRaw: Record<string, unknown>): string | undefined {
  if (agentRaw.claimed === false) return undefined;
  const candidate = agentRaw.agentId ?? agentRaw.agent_id ?? agentRaw.name;
  if (typeof candidate !== 'string') return undefined;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Queries `baw wallet agent-id` directly for this user's isolated session and syncs it. */
export async function fetchBawAgentId(userId: number): Promise<string | undefined> {
  try {
    const raw = await callBaw(['wallet', 'agent-id'], userId, 10_000) as Record<string, unknown>;
    const payload = unwrap(raw);
    const agentIdName = extractAgentIdName(payload);
    logger.info(
      { userId, claimed: payload.claimed ?? null, agentIdName: agentIdName ?? null },
      'baw wallet agent-id lookup',
    );
    if (agentIdName) {
      await syncAgentId(userId, agentIdName);
    }
    return agentIdName;
  } catch (err) {
    logger.warn({ userId, err: (err as Error).message }, 'fetchBawAgentId failed');
    return undefined;
  }
}

/** Re-reads wallet address + agent ID from baw and updates the session cache. */
async function refreshSessionFromBaw(userId: number): Promise<WalletSession | null> {
  try {
    const [addrRaw, agentRaw] = await Promise.all([
      callBaw(['wallet', 'address'], userId, 10_000)
        .then(r => unwrap(r as Record<string, unknown>)) as Promise<Record<string, unknown>>,
      callBaw(['wallet', 'agent-id'], userId, 10_000)
        .then(r => unwrap(r as Record<string, unknown>))
        .catch(() => ({ claimed: false })) as Promise<Record<string, unknown>>,
    ]);

    const walletAddress = extractBscAddress(addrRaw);
    if (!walletAddress) return null;

    const agentIdName = extractAgentIdName(agentRaw);

    const session: WalletSession = {
      qrCodeId: '',
      urlForWeb: '',
      expireAt: Date.now() + 86_400_000, // assume connected sessions live 24h
      walletAddress,
      agentIdName,
    };
    sessions.set(userId, session);
    return session;
  } catch {
    return null;
  }
}

/** Background verify — calls onConnected / onFailed when done (ignores stale/cancelled attempts). */
export function verifyAndBindSession(
  userId: number,
  qrCodeId: string,
  onConnected: (s: WalletSession) => void,
  onFailed: (reason: string) => void,
): void {
  const myNonce = bumpPairingNonce(userId);
  // Fire-and-forget; caller does NOT await.
  (async () => {
    try {
      logger.info({ userId, qrCodeId, pairingNonce: myNonce }, 'baw auth verify: waiting for user approval');
      await callBaw(['auth', 'verify', '--qrCodeId', qrCodeId], userId, 310_000);

      if (pairingNonces.get(userId) !== myNonce) {
        logger.info({ userId, qrCodeId, pairingNonce: myNonce }, 'Ignoring stale baw auth verify completion (superseded/cancelled)');
        return;
      }

      const session = await refreshSessionFromBaw(userId);
      if (pairingNonces.get(userId) !== myNonce) return;

      if (!session?.walletAddress) {
        onFailed('Connected but could not read wallet address. Try /connect again.');
        return;
      }

      await markSessionConnected(userId, session.walletAddress, session.agentIdName ?? '');
      if (pairingNonces.get(userId) !== myNonce) return;
      onConnected(session);
    } catch (err) {
      if (pairingNonces.get(userId) !== myNonce) return;
      const msg = (err as Error).message ?? '';
      onFailed(
        msg.includes('expired') || msg.includes('QR_CODE_EXPIRED')
          ? 'Pairing link expired. Tap Connect Wallet to get a fresh one.'
          : `Pairing failed: ${msg.slice(0, 200)}`,
      );
    }
  })();
}

/** Marks connected in memory + Supabase (stores bound wallet address & Agent ID). */
export async function markSessionConnected(
  userId: number,
  walletAddress: string,
  agentIdName: string,
): Promise<void> {
  const rawAddr = walletAddress.trim();
  const agent   = agentIdName.trim();
  if (!rawAddr) throw new Error('markSessionConnected: walletAddress is required');
  const addr = normalizeEvmAddress(rawAddr, 'session.walletAddress');

  const existing = sessions.get(userId);
  sessions.set(userId, {
    ...(existing ?? { qrCodeId: '', urlForWeb: '', expireAt: 0 }),
    walletAddress: addr,
    agentIdName: agent || undefined,
  });

  try {
    await pool.query(
      `UPDATE users
       SET is_wallet_connected = TRUE,
           wallet_address      = $2,
           agent_id_name       = CASE
             WHEN LOWER(COALESCE(wallet_address, '')) = LOWER($2)
               THEN COALESCE(NULLIF($3, ''), agent_id_name)
             ELSE NULLIF($3, '')
           END,
           current_step        = 'connected',
           last_active_at      = now()
       WHERE telegram_user_id = $1`,
      [userId, addr, agent],
    );
    logger.info({ userId, addr, agent }, 'Session bound to Supabase');
  } catch (dbErr) {
    logger.warn({ dbErr, userId, addr, agent }, 'markSessionConnected: DB update failed (session active in memory)');
  }
}

/** Updates bound *.ai Agent ID in memory + Supabase once resolved on-chain. */
export async function syncAgentId(userId: number, agentIdName: string): Promise<void> {
  const clean = agentIdName.trim();
  if (!clean) return;
  const existing = sessions.get(userId);
  if (existing) {
    existing.agentIdName = clean;
  }
  try {
    await pool.query(
      `UPDATE users SET agent_id_name = $2, last_active_at = now() WHERE telegram_user_id = $1`,
      [userId, clean],
    );
  } catch (dbErr) {
    logger.warn({ dbErr, userId }, 'syncAgentId: DB update failed');
  }
}

// ─── Session queries ──────────────────────────────────────────────────────────

export function getSession(userId: number): WalletSession | undefined {
  return sessions.get(userId);
}

export async function clearSession(userId: number): Promise<void> {
  bumpPairingNonce(userId);
  sessions.delete(userId);
  try { await callBaw(['auth', 'signout'], userId, 10_000); } catch { /* ok */ }
}

export function isSessionConnected(userId: number): boolean {
  return !!sessions.get(userId)?.walletAddress;
}

export async function isSessionConnectedDb(
  userId: number,
): Promise<{ connected: boolean; address?: string; dbAgentId?: string }> {
  try {
    const { rows } = await pool.query<{
      is_wallet_connected: boolean;
      wallet_address: string | null;
      agent_id_name: string | null;
    }>(
      'SELECT is_wallet_connected, wallet_address, agent_id_name FROM users WHERE telegram_user_id=$1',
      [userId],
    );
    if (!rows.length || !rows[0].is_wallet_connected) {
      const mem = sessions.get(userId);
      if (!mem?.walletAddress) return { connected: false };
      const sameWalletAsDb =
        rows[0]?.wallet_address != null &&
        rows[0].wallet_address.toLowerCase() === mem.walletAddress.toLowerCase();
      return {
        connected: true,
        address: mem.walletAddress,
        dbAgentId: sameWalletAsDb ? (rows[0]?.agent_id_name ?? undefined) : undefined,
      };
    }
    // Restore from baw if memory is cold
    if (!sessions.get(userId)?.walletAddress) {
      const refreshed = await refreshSessionFromBaw(userId);
      if (refreshed?.walletAddress) {
        // NEVER carry over a previous wallet's agent_id_name if the user switched wallets
        const sameWalletAsDb =
          rows[0].wallet_address != null &&
          rows[0].wallet_address.toLowerCase() === refreshed.walletAddress.toLowerCase();
        const safeAgentId = refreshed.agentIdName ?? (sameWalletAsDb ? (rows[0].agent_id_name ?? '') : '');
        await markSessionConnected(userId, refreshed.walletAddress, safeAgentId);
      } else if (rows[0].wallet_address) {
        sessions.set(userId, {
          qrCodeId: '',
          urlForWeb: '',
          expireAt: Date.now() + 86_400_000,
          walletAddress: rows[0].wallet_address,
          agentIdName: rows[0].agent_id_name ?? undefined,
        });
      }
    }
    const activeAddress = sessions.get(userId)?.walletAddress ?? rows[0].wallet_address ?? undefined;
    const sameWalletAsDb =
      activeAddress != null &&
      rows[0].wallet_address != null &&
      rows[0].wallet_address.toLowerCase() === activeAddress.toLowerCase();
    return {
      connected: true,
      address: activeAddress,
      dbAgentId: sameWalletAsDb ? (rows[0].agent_id_name ?? undefined) : undefined,
    };
  } catch (dbErr) {
    logger.error({ dbErr, userId }, 'isSessionConnectedDb failed — falling back to in-memory session');
    const mem = sessions.get(userId);
    return { connected: !!mem?.walletAddress, address: mem?.walletAddress };
  }
}

export async function getSessionLinkFromDb(userId: number): Promise<string | null> {
  try {
    const { rows } = await pool.query<{ session_link: string | null }>(
      'SELECT session_link FROM users WHERE telegram_user_id=$1', [userId],
    );
    return rows[0]?.session_link ?? null;
  } catch { return null; }
}

// ─── quota check ─────────────────────────────────────────────────────────────

export interface QuotaInfo {
  quotaUsed: number;
  quotaLeft: number;
  dailyLimit: number;
}

export async function getQuota(userId: number): Promise<QuotaInfo | null> {
  try {
    const r = await callBaw(['wallet', 'left-quota'], userId, 10_000) as Record<string, unknown>;
    const p = unwrap(r);
    return {
      quotaUsed:  Number(p.quotaUsed  ?? p.quota_used  ?? 0),
      quotaLeft:  Number(p.quotaLeft  ?? p.quota_left  ?? 0),
      dailyLimit: Number(p.dailyLimit ?? p.daily_limit ?? 0),
    };
  } catch { return null; }
}

// ─── wallet settings & Developer Mode check (authoritative via baw) ──────────

export interface BawWalletSettings {
  devModeEnabled: boolean | null;
  devModeExpiresAt: string | null;
  devModeExpired: boolean;
  devModeDailyLimit: number;
  devModeQuotaUsed: number | null;
  devModeBalanceExceeded: boolean;
  dailyLimit: number;
  quotaUsed: number;
  quotaLeft: number;
  rawDevMode: unknown;
}

function parseBoolish(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'enabled' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'disabled' || s === 'no') return false;
  }
  return null;
}

function toFiniteNumber(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Queries `baw wallet settings --json` for the user's isolated session.
 * This is the authoritative source for Binance Agentic Wallet Developer Mode
 * (`devMode.enabled`, `devMode.expiresAt`, `devMode.dailyLimit`, `devMode.balanceExceeded`)
 * and daily trading / developer-mode quotas.
 *
 * Propagates `isSessionExpired` errors so callers can prompt re-pairing.
 */
export async function getBawWalletSettings(
  userId: number,
): Promise<{ ok: true; settings: BawWalletSettings } | { ok: false; error: string }> {
  try {
    const raw = await callBaw(['wallet', 'settings'], userId, 15_000) as Record<string, unknown>;
    const p   = unwrap(raw);

    const devModeObj =
      p.devMode != null && typeof p.devMode === 'object'
        ? (p.devMode as Record<string, unknown>)
        : null;

    // `baw wallet settings --json` returns `devMode: { enabled, expiresAt, dailyLimit, balanceExceeded }`
    // or `devMode: null` if Developer Mode is not configured/enabled.
    let devModeEnabled: boolean | null = null;
    if (devModeObj) {
      devModeEnabled = parseBoolish(devModeObj.enabled ?? devModeObj.isEnabled ?? devModeObj.status);
    } else if ('devMode' in p && p.devMode === null) {
      devModeEnabled = false;
    } else {
      devModeEnabled = parseBoolish(p.developerModeEnabled ?? p.devModeEnabled);
    }

    const rawExpires = devModeObj?.expiresAt ?? null;
    const devModeExpiresAt = rawExpires != null ? String(rawExpires) : null;
    let devModeExpired = false;
    if (devModeExpiresAt) {
      const ts = /^\d+$/.test(devModeExpiresAt)
        ? (devModeExpiresAt.length <= 10 ? Number(devModeExpiresAt) * 1000 : Number(devModeExpiresAt))
        : Date.parse(devModeExpiresAt);
      if (Number.isFinite(ts) && ts > 0 && ts < Date.now()) {
        devModeExpired = true;
      }
    }

    const devModeDailyLimit = toFiniteNumber(devModeObj?.dailyLimit, 0);
    const devModeQuotaUsed =
      p.developerModeQuotaUsed == null ? null : toFiniteNumber(p.developerModeQuotaUsed, 0);
    const devModeBalanceExceeded = parseBoolish(devModeObj?.balanceExceeded) === true;

    const dailyLimit = toFiniteNumber(p.dailyLimit, 0);
    const quotaUsed  = toFiniteNumber(p.quotaUsed, 0);
    const quotaLeft  =
      p.quotaLeft != null ? toFiniteNumber(p.quotaLeft, Math.max(0, dailyLimit - quotaUsed)) : Math.max(0, dailyLimit - quotaUsed);

    const settings: BawWalletSettings = {
      devModeEnabled,
      devModeExpiresAt,
      devModeExpired,
      devModeDailyLimit,
      devModeQuotaUsed,
      devModeBalanceExceeded,
      dailyLimit,
      quotaUsed,
      quotaLeft,
      rawDevMode: p.devMode ?? null,
    };

    logger.info(
      {
        userId,
        rawKeys: Object.keys(p),
        devMode: settings.rawDevMode,
        evaluatedDevModeEnabled: settings.devModeEnabled,
        devModeExpired: settings.devModeExpired,
        devModeDailyLimit: settings.devModeDailyLimit,
        devModeQuotaUsed: settings.devModeQuotaUsed,
        devModeBalanceExceeded: settings.devModeBalanceExceeded,
        quotaUsed: settings.quotaUsed,
        quotaLeft: settings.quotaLeft,
        dailyLimit: settings.dailyLimit,
      },
      'baw wallet settings check',
    );

    return { ok: true, settings };
  } catch (err) {
    const e = err as Error & { isSessionExpired?: boolean };
    if (e.isSessionExpired) throw e;
    logger.warn({ userId, err: e.message }, 'getBawWalletSettings failed');
    return { ok: false, error: e.message };
  }
}

// ─── Contract call (signing layer) ───────────────────────────────────────────

export interface ContractCallResult {
  txHash: string;
  requestId: string;
  appliedGasLimit: number;
}

const BAW_MIN_GAS_LIMIT  = 21_000;
const BAW_SAFE_MAX_GAS   = 2_500_000; // safe LOW/MEDIUM ceiling well inside baw's 15,000,000 max
const PRIMARY_GAS_BUFFER = 1.25;      // 25% LOW/MEDIUM buffer over live RPC estimateGas
const RETRY_GAS_BUFFER   = 1.5;       // 50% buffer over live RPC estimateGas if 351805 recurs
const RETRY_BUMP_FACTOR  = 1.3;       // conservative bump factor over primary appliedGasLimit on retry

function clampGasLimit(gas: number): number {
  return Math.min(BAW_SAFE_MAX_GAS, Math.max(BAW_MIN_GAS_LIMIT, Math.ceil(gas)));
}

function isOutOfGasPreviewError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err ?? '');
  return /351805|ran out of gas|out of gas|increase the gas limit/i.test(msg);
}

function formatWeiAsBnb(wei: bigint): string {
  const whole = wei / 1_000_000_000_000_000_000n;
  const frac  = (wei % 1_000_000_000_000_000_000n).toString().padStart(18, '0').slice(0, 6);
  return `${whole}.${frac}`;
}

/**
 * Executes a contract call through the user's Binance Agentic Wallet.
 * Two phases: preview (get requestId) → execute (submit via MPC signer).
 *
 * Dynamic gas resolution at execution time:
 *   1. If live BSC RPC `rpcEstimatedGas` is provided, computes `Math.ceil(estimated * 1.4)`
 *      clamped to safe bounds [21_000, 5_000_000].
 *   2. If RPC estimation is unavailable, uses the step's sensible `fallbackGasLimit` ceiling.
 *   3. If `baw contract-call preview` still fails with code 351805 (ran out of gas),
 *      retries preview once with a higher buffered gasLimit (`max(estimated * 1.75, applied * 1.45)`).
 *
 * Session expiry is detected and the error is tagged `isSessionExpired=true`
 * so the caller can prompt re-connection.
 *
 * Uses per-user mutex to prevent nonce races from concurrent calls.
 */
export async function executeContractCall(opts: {
  userId: number;
  walletAddress: string;
  to: string;
  inputData: string;        // 0x-prefixed calldata
  value?: bigint;           // wei (default 0)
  gasLimit?: number;        // optional explicit override
  step?: string;            // diagnostic label: 'mint' | 'approve' | 'sell'
  rpcEstimatedGas?: bigint; // live BSC RPC estimateGas result
  fallbackGasLimit?: number;// sensible ceiling if RPC estimation is unavailable
}): Promise<ContractCallResult> {
  return executeContractCallForSession({
    ...opts,
    sessionKey: opts.userId,
  });
}

/**
 * Executes a contract call through any isolated `baw` session (user ID or `'admin-treasury'`).
 */
export async function executeContractCallForSession(opts: {
  sessionKey: number | string;
  walletAddress: string;
  to: string;
  inputData: string;
  value?: bigint;
  gasLimit?: number;
  step?: string;
  rpcEstimatedGas?: bigint;
  fallbackGasLimit?: number;
}): Promise<ContractCallResult> {
  const {
    sessionKey,
    inputData,
    value = 0n,
    gasLimit,
    step = 'contract-call',
    rpcEstimatedGas,
    fallbackGasLimit = 900_000,
  } = opts;
  const userId = sessionKey;
  const lockKey = String(sessionKey);

  const walletAddress = normalizeEvmAddress(opts.walletAddress, `${step}.from`);
  const to            = normalizeEvmAddress(opts.to, `${step}.to`);

  const fnSelector    = inputData.slice(0, 10);
  const calldataBytes = Math.max(0, (inputData.length - 2) / 2);
  const valueBnb      = formatWeiAsBnb(value);

  // Resolve primary gas limit dynamically at execution time
  const gasSource =
    gasLimit != null
      ? 'explicit'
      : rpcEstimatedGas != null
        ? 'rpc_estimate_x1.4'
        : 'fallback_ceiling';
  const primaryGasLimit = clampGasLimit(
    gasLimit != null
      ? gasLimit
      : rpcEstimatedGas != null
        ? Number(rpcEstimatedGas) * PRIMARY_GAS_BUFFER
        : fallbackGasLimit,
  );

  // Serialize per-session to prevent nonce races
  const prev = execLocks.get(lockKey) ?? Promise.resolve();
  let releaseLock!: () => void;
  const thisLock = new Promise<void>(r => { releaseLock = r; });
  const chainedLock = prev.then(() => thisLock);
  execLocks.set(lockKey, chainedLock);

  try {
    await prev; // wait for any previous call to finish

    const runPreview = async (appliedGasLimit: number, attemptLabel: string): Promise<Record<string, unknown>> => {
      const args = [
        'contract-call', 'preview',
        '--binanceChainId', '56',
        '--from', walletAddress,
        '--to', to,
        '--value', value.toString(),
        '--inputData', inputData,
        '--gasLimit', String(appliedGasLimit),
      ];

      logger.info(
        {
          userId,
          step,
          attempt: attemptLabel,
          to,
          fnSelector,
          calldataBytes,
          valueWei: value.toString(),
          valueBnb,
          rpcEstimatedGas: rpcEstimatedGas?.toString() ?? null,
          gasSource,
          appliedGasLimit,
        },
        'baw contract-call preview request',
      );

      return (await callBaw(args, userId, 30_000)) as Record<string, unknown>;
    };

    // Phase 1: preview with dynamically buffered gasLimit; retry once with higher buffer on 351805
    let previewRaw: Record<string, unknown>;
    let appliedGasLimit = primaryGasLimit;

    try {
      previewRaw = await runPreview(appliedGasLimit, 'primary');
    } catch (previewErr) {
      const e = previewErr as Error & { isSessionExpired?: boolean };
      if (e.isSessionExpired) throw e;

      if (isOutOfGasPreviewError(previewErr)) {
        const rpcHigher = rpcEstimatedGas != null ? Number(rpcEstimatedGas) * RETRY_GAS_BUFFER : 0;
        const bumped    = appliedGasLimit * RETRY_BUMP_FACTOR;
        const retryGas  = clampGasLimit(Math.max(rpcHigher, bumped));

        logger.warn(
          {
            userId,
            step,
            to,
            fnSelector,
            valueBnb,
            rpcEstimatedGas: rpcEstimatedGas?.toString() ?? null,
            primaryGasLimit: appliedGasLimit,
            retryGasLimit: retryGas,
            err: e.message.slice(0, 240),
          },
          'baw contract-call preview hit out-of-gas (351805) — retrying once with higher gas buffer',
        );

        appliedGasLimit = retryGas;
        try {
          previewRaw = await runPreview(retryGas, 'retry_higher_gas');
        } catch (retryErr) {
          const re = retryErr as Error & { isSessionExpired?: boolean };
          if (re.isSessionExpired) throw re;
          logger.error(
            {
              userId,
              step,
              to,
              fnSelector,
              valueBnb,
              rpcEstimatedGas: rpcEstimatedGas?.toString() ?? null,
              retryGasLimit: retryGas,
              err: re.message.slice(0, 300),
            },
            'baw contract-call preview failed after higher gas buffer retry',
          );
          throw new Error(
            `[${step}] preview failed on ${to} (value=${valueBnb} BNB, gasLimit=${retryGas}): ${re.message}`,
          );
        }
      } else {
        logger.error(
          { userId, step, to, fnSelector, valueBnb, appliedGasLimit, err: e.message.slice(0, 300) },
          'baw contract-call preview failed',
        );
        throw previewErr;
      }
    }

    const previewPayload = unwrap(previewRaw);
    const requestId  = String(previewPayload.requestId ?? previewPayload.request_id ?? '');
    if (!requestId) {
      throw new Error(`baw contract-call preview returned no requestId: ${JSON.stringify(previewRaw).slice(0, 200)}`);
    }

    logger.info(
      {
        userId,
        step,
        requestId,
        to,
        fnSelector,
        valueBnb,
        rpcEstimatedGas: rpcEstimatedGas?.toString() ?? null,
        appliedGasLimit,
        previewGasLimit: previewPayload.gasLimit ?? previewPayload.estimatedGas ?? null,
      },
      'contract-call preview ok',
    );

    // Phase 2: execute
    const execRaw = await callBaw(['contract-call', 'execute', '--requestId', requestId], userId, 60_000) as Record<string, unknown>;

    // txHash may be at root or inside .data / .result (Binance API envelope)
    const execPayload = unwrap(execRaw);
    if (String(execPayload.status ?? '').toUpperCase() === 'PENDING_CONFIRMATION') {
      throw new Error(
        `Developer Mode confirmation required in Binance App for [${step}] (status=PENDING_CONFIRMATION). ` +
        `Ensure Developer Mode is enabled and within cap.`,
      );
    }
    const txHash = String(execPayload.txHash ?? execPayload.transactionHash ?? execPayload.tx_hash ?? '');
    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new Error(`baw contract-call execute returned invalid txHash: ${JSON.stringify(execRaw).slice(0, 200)}`);
    }

    logger.info({ userId, step, txHash, requestId, appliedGasLimit }, 'contract-call execute ok');
    return { txHash, requestId, appliedGasLimit };
  } finally {
    releaseLock();
    if (execLocks.get(lockKey) === chainedLock) {
      execLocks.delete(lockKey);
    }
  }
}

// ─── Admin Agent Wallet (Treasury for BEP-20 USDT Auto-Payments) ─────────────

async function refreshAdminWalletSessionFromBaw(): Promise<WalletSession | null> {
  try {
    const addrRaw = unwrap(
      (await callBaw(['wallet', 'address'], ADMIN_WALLET_SESSION_KEY, 12_000)) as Record<string, unknown>,
    );
    const walletAddress = extractBscAddress(addrRaw);
    if (!walletAddress) return null;

    const session: WalletSession = {
      qrCodeId: '',
      urlForWeb: '',
      expireAt: Date.now() + 86_400_000,
      walletAddress,
    };
    adminWalletSession = session;
    await setAdminWalletConfig(walletAddress, true);
    return session;
  } catch (err) {
    const e = err as Error & { isSessionExpired?: boolean };
    if (e.isSessionExpired) throw e;
    return null;
  }
}

export async function generateAdminWalletPairingUri(): Promise<WalletSession | null> {
  try {
    const raw = (await callBaw(['auth', 'signin'], ADMIN_WALLET_SESSION_KEY, 15_000)) as Record<string, unknown>;
    const payload = unwrap(raw);

    if (raw.status === 'ALREADY_CONNECTED' || payload.status === 'ALREADY_CONNECTED') {
      logger.info('Admin Agent Wallet baw: already connected');
      const refreshed = await refreshAdminWalletSessionFromBaw().catch(() => null);
      if (refreshed?.walletAddress) return refreshed;
      if (adminWalletSession?.walletAddress) return adminWalletSession;
      return null;
    }

    const qrCodeId    = String(payload.qrCodeId    ?? payload.qrCode    ?? payload.id    ?? '');
    const urlForWeb   = String(payload.urlForWeb   ?? payload.qrCodeUrl ?? payload.url   ?? payload.link ?? '');
    const expireAt    = Number(payload.expireAt    ?? payload.expiry    ?? payload.expiresAt ?? Date.now() + 300_000);
    const pairingCode = payload.pairingCode != null ? String(payload.pairingCode) : undefined;

    if (!qrCodeId || !urlForWeb) {
      logger.error({ payloadKeys: Object.keys(payload) }, 'Admin Agent Wallet baw auth signin: unexpected shape');
      return null;
    }

    const session: WalletSession = { qrCodeId, urlForWeb, expireAt, pairingCode };
    adminWalletSession = session;
    return session;
  } catch (err) {
    logger.error({ err: (err as Error)?.message }, 'generateAdminWalletPairingUri failed');
    return null;
  }
}

export function verifyAndBindAdminWalletSession(
  qrCodeId: string,
  onConnected: (s: WalletSession) => void,
  onFailed: (reason: string) => void,
): void {
  adminPairingNonce += 1;
  const myNonce = adminPairingNonce;
  (async () => {
    try {
      await callBaw(['auth', 'verify', '--qrCodeId', qrCodeId], ADMIN_WALLET_SESSION_KEY, 310_000);
      if (adminPairingNonce !== myNonce) return;

      const session = await refreshAdminWalletSessionFromBaw();
      if (adminPairingNonce !== myNonce) return;
      if (!session?.walletAddress) {
        onFailed('Connected Admin Agent Wallet, but could not read its BSC address. Try again.');
        return;
      }
      onConnected(session);
    } catch (err) {
      if (adminPairingNonce !== myNonce) return;
      const msg = (err as Error)?.message ?? String(err);
      onFailed(
        msg.includes('expired') || msg.includes('QR_CODE_EXPIRED')
          ? 'Admin wallet pairing link expired. Tap Connect Admin Wallet to generate a fresh QR.'
          : `Admin wallet pairing failed: ${msg.slice(0, 200)}`,
      );
    }
  })();
}

export async function disconnectAdminWallet(): Promise<void> {
  adminPairingNonce += 1;
  adminWalletSession = null;
  try { await callBaw(['auth', 'signout'], ADMIN_WALLET_SESSION_KEY, 10_000); } catch { /* ok */ }
  await setAdminWalletConfig(null, false);
}

export interface AdminWalletHealth {
  connected: boolean;
  sessionExpired: boolean;
  address: string | null;
  usdtBalanceWei: bigint;
  bnbBalanceWei: bigint;
  usdtDecimals: number;
  balanceReadOk: boolean;
  devModeEnabled: boolean | null;
  devModeExpired: boolean;
  devModeBalanceExceeded: boolean;
  quotaExhausted: boolean;
  error?: string;
}

async function readChainValueWithRetry<T>(label: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let lastErr = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      lastErr = (err as Error)?.message ?? String(err);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 400));
    }
  }
  logger.warn({ label, err: lastErr }, 'Admin wallet on-chain balance read failed after retry');
  return { ok: false, error: lastErr };
}

/**
 * Checks LIVE Admin Agent Wallet connectivity, baw session validity, Developer Mode
 * (enabled, expiry, balance cap, daily quota), and on-chain BSC BEP-20 USDT + BNB balances.
 * Never masks RPC errors as `0n` balances.
 */
export async function getAdminWalletStatus(): Promise<AdminWalletHealth> {
  const stored = getAdminWalletConfig();
  const base: AdminWalletHealth = {
    connected: false,
    sessionExpired: false,
    address: adminWalletSession?.walletAddress ?? stored.address,
    usdtBalanceWei: 0n,
    bnbBalanceWei: 0n,
    usdtDecimals: TOKEN_DECIMALS,
    balanceReadOk: false,
    devModeEnabled: null,
    devModeExpired: false,
    devModeBalanceExceeded: false,
    quotaExhausted: false,
  };

  if (!bawAvailable()) {
    return { ...base, error: '@binance/agentic-wallet CLI binary is missing on this server.' };
  }

  let liveAddr: string | null = null;
  try {
    const addrRaw = unwrap(
      (await callBaw(['wallet', 'address'], ADMIN_WALLET_SESSION_KEY, 12_000)) as Record<string, unknown>,
    );
    liveAddr = extractBscAddress(addrRaw);
  } catch (err) {
    const e = err as Error & { isSessionExpired?: boolean };
    if (e.isSessionExpired) {
      await setAdminWalletConfig(base.address, false);
      return {
        ...base,
        connected: false,
        sessionExpired: true,
        error: 'Admin Agent Wallet session expired or disconnected (baw SESSION_EXPIRED).',
      };
    }
    return {
      ...base,
      connected: false,
      error: `Admin Agent Wallet unreachable: ${e.message.slice(0, 180)}`,
    };
  }

  if (!liveAddr) {
    await setAdminWalletConfig(null, false);
    return {
      ...base,
      connected: false,
      error: 'Admin Agent Wallet is not connected.',
    };
  }

  adminWalletSession = {
    qrCodeId: '',
    urlForWeb: '',
    expireAt: Date.now() + 86_400_000,
    walletAddress: liveAddr,
  };
  await setAdminWalletConfig(liveAddr, true);

  let devModeEnabled: boolean | null = null;
  let devModeExpired = false;
  let devModeBalanceExceeded = false;
  let quotaExhausted = false;
  try {
    const settingsRaw = unwrap(
      (await callBaw(['wallet', 'settings'], ADMIN_WALLET_SESSION_KEY, 12_000)) as Record<string, unknown>,
    );
    const devModeObj =
      settingsRaw.devMode != null && typeof settingsRaw.devMode === 'object'
        ? (settingsRaw.devMode as Record<string, unknown>)
        : null;
    if (devModeObj) {
      devModeEnabled = parseBoolish(devModeObj.enabled ?? devModeObj.isEnabled ?? devModeObj.status);
      devModeBalanceExceeded = parseBoolish(devModeObj.balanceExceeded) === true;
      const rawExp = devModeObj.expiresAt;
      if (rawExp != null) {
        const s = String(rawExp);
        const ts = /^\d+$/.test(s) ? (s.length <= 10 ? Number(s) * 1000 : Number(s)) : Date.parse(s);
        if (Number.isFinite(ts) && ts > 0 && ts < Date.now()) devModeExpired = true;
      }
      const devDaily = toFiniteNumber(devModeObj.dailyLimit, 0);
      const devUsed = settingsRaw.developerModeQuotaUsed == null ? null : toFiniteNumber(settingsRaw.developerModeQuotaUsed, 0);
      if (devDaily > 0 && devUsed != null && devUsed >= devDaily) {
        quotaExhausted = true;
      }
    } else if ('devMode' in settingsRaw && settingsRaw.devMode === null) {
      devModeEnabled = false;
    }
    const dailyLimit = toFiniteNumber(settingsRaw.dailyLimit, 0);
    const quotaUsed  = toFiniteNumber(settingsRaw.quotaUsed, 0);
    const quotaLeft  = settingsRaw.quotaLeft != null
      ? toFiniteNumber(settingsRaw.quotaLeft, Math.max(0, dailyLimit - quotaUsed))
      : Math.max(0, dailyLimit - quotaUsed);
    if (dailyLimit > 0 && quotaLeft <= 0) {
      quotaExhausted = true;
    }
  } catch (err) {
    const e = err as Error & { isSessionExpired?: boolean };
    if (e.isSessionExpired) {
      await setAdminWalletConfig(liveAddr, false);
      return {
        ...base,
        address: liveAddr,
        connected: false,
        sessionExpired: true,
        error: 'Admin Agent Wallet session expired during settings check.',
      };
    }
  }

  const [usdtRes, bnbRes, usdtDecimals] = await Promise.all([
    readChainValueWithRetry('admin.usdtBalance', () => readUsdtBalance(liveAddr)),
    readChainValueWithRetry('admin.bnbBalance', () => readBnbBalance(liveAddr)),
    readUsdtDecimals(),
  ]);

  const balanceReadOk = usdtRes.ok && bnbRes.ok;

  return {
    connected: true,
    sessionExpired: false,
    address: liveAddr,
    usdtBalanceWei: usdtRes.ok ? usdtRes.value : 0n,
    bnbBalanceWei: bnbRes.ok ? bnbRes.value : 0n,
    usdtDecimals,
    balanceReadOk,
    devModeEnabled,
    devModeExpired,
    devModeBalanceExceeded,
    quotaExhausted,
    ...(!balanceReadOk
      ? { error: `BSC RPC balance read failed: ${!usdtRes.ok ? usdtRes.error : !bnbRes.ok ? bnbRes.error : 'unknown'}` }
      : {}),
  };
}

export type AdminUsdtTransferResult =
  | {
      ok: true;
      txHash: string;
      adminWalletAddress: string;
    }
  | {
      ok: false;
      triggerEmergencyShutdown: boolean;
      /** TRUE only if a transaction was actually broadcast to BSC and confirmation timed out (MUST NOT release anti-abuse lock!). */
      txBroadcasted: boolean;
      txHash?: string;
      failureCode:
        | 'WALLET_DISCONNECTED'
        | 'SESSION_EXPIRED'
        | 'DEV_MODE_OFF'
        | 'INSUFFICIENT_USDT'
        | 'INSUFFICIENT_BNB'
        | 'RPC_UNAVAILABLE'
        | 'TRANSFER_TIMEOUT'
        | 'TRANSFER_FAILED';
      reason: string;
      adminWalletAddress: string | null;
      usdtBalanceWei?: bigint;
      bnbBalanceWei?: bigint;
    };

/**
 * Executes a real BEP-20 USDT (`0x55d398326f99059fF775485246999027B3197955`) transfer
 * on BSC Mainnet (`chainId: 56`) from the connected Admin Agent Wallet via `baw contract-call`.
 *
 * Guarantees:
 *   - Verifies exact on-chain BEP-20 USDT decimals (`readUsdtDecimals()`, 18) & parses exact amountWei.
 *   - Verifies Admin Agent Wallet connectivity, session validity, Developer Mode, USDT balance, and BNB gas BEFORE broadcast.
 *   - Simulates ERC-20 `transfer(recipient, amountWei)` via BSC RPC before calling `baw`.
 *   - Polls BSC receipt until `status === 1` AND confirms ERC-20 `Transfer(adminWallet → recipient, amountWei)` log on-chain!
 *   - Distinguishes pre-broadcast failures (`txBroadcasted: false`) from post-broadcast timeouts (`txBroadcasted: true`)
 *     so an in-flight transfer can NEVER be double-paid.
 */
export async function executeAdminUsdtTransfer(
  recipientAddress: string,
  amountUsdtStr: string,
): Promise<AdminUsdtTransferResult> {
  const recipient = normalizeEvmAddress(recipientAddress, 'adminPayout.recipient');
  if (recipient === ethers.ZeroAddress) {
    return {
      ok: false,
      triggerEmergencyShutdown: false,
      txBroadcasted: false,
      failureCode: 'TRANSFER_FAILED',
      reason: 'Recipient payout address cannot be zero address.',
      adminWalletAddress: null,
    };
  }

  const health = await getAdminWalletStatus();

  if (!health.connected || !health.address) {
    return {
      ok: false,
      triggerEmergencyShutdown: true,
      txBroadcasted: false,
      failureCode: health.sessionExpired ? 'SESSION_EXPIRED' : 'WALLET_DISCONNECTED',
      reason: health.error ?? 'Admin Agent Wallet is disconnected or session expired.',
      adminWalletAddress: health.address,
      usdtBalanceWei: health.usdtBalanceWei,
      bnbBalanceWei: health.bnbBalanceWei,
    };
  }

  if (health.devModeEnabled === false || health.devModeExpired || health.devModeBalanceExceeded || health.quotaExhausted) {
    const devReason = health.devModeExpired
      ? 'Admin Agent Wallet Developer Mode has expired.'
      : health.devModeBalanceExceeded
        ? 'Admin Agent Wallet Developer Mode balance cap is exceeded.'
        : health.quotaExhausted
          ? 'Admin Agent Wallet daily quota is exhausted.'
          : 'Admin Agent Wallet Developer Mode is turned OFF.';
    return {
      ok: false,
      triggerEmergencyShutdown: true,
      txBroadcasted: false,
      failureCode: 'DEV_MODE_OFF',
      reason: devReason,
      adminWalletAddress: health.address,
      usdtBalanceWei: health.usdtBalanceWei,
      bnbBalanceWei: health.bnbBalanceWei,
    };
  }

  if (!health.balanceReadOk) {
    return {
      ok: false,
      triggerEmergencyShutdown: true,
      txBroadcasted: false,
      failureCode: 'RPC_UNAVAILABLE',
      reason: health.error ?? 'Could not verify Admin Agent Wallet USDT/BNB balances on BSC RPC.',
      adminWalletAddress: health.address,
    };
  }

  let amountWei: bigint;
  try {
    amountWei = ethers.parseUnits(amountUsdtStr.trim(), health.usdtDecimals);
    if (amountWei <= 0n) throw new Error('Amount must be > 0');
  } catch (parseErr) {
    return {
      ok: false,
      triggerEmergencyShutdown: true,
      txBroadcasted: false,
      failureCode: 'TRANSFER_FAILED',
      reason: `Malformed USDT payout amount "${amountUsdtStr}": ${(parseErr as Error)?.message}`,
      adminWalletAddress: health.address,
      usdtBalanceWei: health.usdtBalanceWei,
      bnbBalanceWei: health.bnbBalanceWei,
    };
  }

  if (health.usdtBalanceWei < amountWei) {
    const have = Number(ethers.formatUnits(health.usdtBalanceWei, health.usdtDecimals)).toFixed(4);
    const need = Number(ethers.formatUnits(amountWei, health.usdtDecimals)).toFixed(4);
    return {
      ok: false,
      triggerEmergencyShutdown: true,
      txBroadcasted: false,
      failureCode: 'INSUFFICIENT_USDT',
      reason: `Admin Agent Wallet has insufficient BEP-20 USDT (need ${need} USDT, have ${have} USDT).`,
      adminWalletAddress: health.address,
      usdtBalanceWei: health.usdtBalanceWei,
      bnbBalanceWei: health.bnbBalanceWei,
    };
  }

  if (health.bnbBalanceWei < MIN_ADMIN_PAYOUT_BNB_GAS) {
    return {
      ok: false,
      triggerEmergencyShutdown: true,
      txBroadcasted: false,
      failureCode: 'INSUFFICIENT_BNB',
      reason: `Admin Agent Wallet has insufficient BNB for gas (need ≥ ${ethers.formatEther(MIN_ADMIN_PAYOUT_BNB_GAS)} BNB, have ${ethers.formatEther(health.bnbBalanceWei)} BNB).`,
      adminWalletAddress: health.address,
      usdtBalanceWei: health.usdtBalanceWei,
      bnbBalanceWei: health.bnbBalanceWei,
    };
  }

  const inputData = buildUsdtTransferCalldata(recipient, amountWei);
  const sim = await simulateContractCall({
    step: 'admin_usdt_payout',
    from: health.address,
    to: ADDR.USDT,
    data: inputData,
    value: 0n,
  });

  if (!sim.ok && sim.isRevert) {
    return {
      ok: false,
      triggerEmergencyShutdown: true,
      txBroadcasted: false,
      failureCode: 'TRANSFER_FAILED',
      reason: `BEP-20 USDT transfer simulation reverted: ${sim.revertReason ?? sim.error ?? 'reverted'}`,
      adminWalletAddress: health.address,
      usdtBalanceWei: health.usdtBalanceWei,
      bnbBalanceWei: health.bnbBalanceWei,
    };
  }

  try {
    const execRes = await executeContractCallForSession({
      sessionKey: ADMIN_WALLET_SESSION_KEY,
      walletAddress: health.address,
      to: ADDR.USDT,
      inputData,
      value: 0n,
      rpcEstimatedGas: sim.ok ? sim.estimatedGas : undefined,
      fallbackGasLimit: 100_000,
      step: 'admin_usdt_payout',
    });

    const receipt = await pollTransactionReceipt(execRes.txHash, {
      timeoutMs: 90_000,
      pollIntervalMs: 1_500,
      walletAddress: recipient,
      expectedUsdtFrom: health.address,
      expectedUsdtAmountWei: amountWei,
    });

    if (receipt.state === 'confirmed') {
      if (!receipt.usdtTransferredExactMatch) {
        logger.error(
          {
            adminWallet: health.address,
            recipient,
            expectedWei: amountWei.toString(),
            receivedWei: receipt.usdtReceivedFromLogs.toString(),
            txHash: execRes.txHash,
          },
          'Admin BEP-20 USDT payout TX confirmed on BSC but Transfer log did not match exact expected amount',
        );
        return {
          ok: false,
          triggerEmergencyShutdown: true,
          txBroadcasted: true,
          txHash: execRes.txHash,
          failureCode: 'TRANSFER_FAILED',
          reason: `Payout TX ${execRes.txHash} confirmed on BSC, but USDT Transfer log did not match exact expected amount (${amountUsdtStr} USDT).`,
          adminWalletAddress: health.address,
          usdtBalanceWei: health.usdtBalanceWei,
          bnbBalanceWei: health.bnbBalanceWei,
        };
      }

      logger.info(
        {
          adminWallet: health.address,
          recipient,
          amountUsdt: amountUsdtStr,
          amountWei: amountWei.toString(),
          usdtDecimals: health.usdtDecimals,
          txHash: execRes.txHash,
          blockNumber: receipt.receipt.blockNumber,
        },
        'Admin Agent Wallet BEP-20 USDT auto-payout confirmed & Transfer log verified on BSC',
      );
      return {
        ok: true,
        txHash: execRes.txHash,
        adminWalletAddress: health.address,
      };
    }

    if (receipt.state === 'reverted') {
      return {
        ok: false,
        triggerEmergencyShutdown: true,
        txBroadcasted: false, // Reverted on-chain: 0 USDT moved, safe to retry after admin fixes wallet
        txHash: execRes.txHash,
        failureCode: 'TRANSFER_FAILED',
        reason: `Admin BEP-20 USDT transfer TX ${execRes.txHash} reverted on-chain (status=0).`,
        adminWalletAddress: health.address,
        usdtBalanceWei: health.usdtBalanceWei,
        bnbBalanceWei: health.bnbBalanceWei,
      };
    }

    // Timeout after broadcast: TX may still confirm on BSC — MUST NOT release anti-abuse lock!
    return {
      ok: false,
      triggerEmergencyShutdown: false,
      txBroadcasted: true,
      txHash: execRes.txHash,
      failureCode: 'TRANSFER_TIMEOUT',
      reason: `Admin BEP-20 USDT transfer TX ${execRes.txHash} was broadcast to BSC but receipt confirmation timed out after 90s. Manual verification required to prevent double payout.`,
      adminWalletAddress: health.address,
      usdtBalanceWei: health.usdtBalanceWei,
      bnbBalanceWei: health.bnbBalanceWei,
    };
  } catch (err) {
    const e = err as Error & { isSessionExpired?: boolean };
    const msg = e?.message ?? String(err);
    const isExpired = Boolean(e?.isSessionExpired || /SESSION_EXPIRED|UNCONNECTED/i.test(msg));
    if (isExpired) {
      await setAdminWalletConfig(health.address, false);
    }
    return {
      ok: false,
      triggerEmergencyShutdown: true,
      txBroadcasted: false,
      failureCode: isExpired ? 'SESSION_EXPIRED' : 'TRANSFER_FAILED',
      reason: `Admin BEP-20 USDT payout failed: ${msg.slice(0, 220)}`,
      adminWalletAddress: health.address,
      usdtBalanceWei: health.usdtBalanceWei,
      bnbBalanceWei: health.bnbBalanceWei,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractBscAddress(raw: Record<string, unknown>): string | null {
  // Unwrap envelope first
  const p = unwrap(raw);
  if (Array.isArray(p.addresses)) {
    for (const e of p.addresses as Array<{ chain?: string; address?: string }>) {
      const chain = (e.chain ?? '').replace(/\s/g, '').toUpperCase();
      if (['BSC','BNB','BNBCHAIN','BNBSMARTCHAIN'].includes(chain) &&
          e.address && /^0x[0-9a-fA-F]{40}$/.test(e.address)) {
        return normalizeEvmAddress(e.address, 'baw.bscAddress');
      }
    }
    for (const e of p.addresses as Array<{ address?: string }>) {
      if (e.address && /^0x[0-9a-fA-F]{40}$/.test(e.address)) {
        return normalizeEvmAddress(e.address, 'baw.evmAddress');
      }
    }
  }
  for (const key of ['bsc','bnb','bnbChain','address']) {
    const v = p[key];
    if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) {
      return normalizeEvmAddress(v, `baw.${key}`);
    }
  }
  logger.warn({ raw }, 'extractBscAddress: no BSC address found');
  return null;
}
