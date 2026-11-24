// src/executor.ts
// ═══════════════════════════════════════════════════════════════════════
// LAYER 3: JAGER MINT — ONE-CONFIRM FULL CYCLE Engine
//
// Two-phase user experience:
//   Phase 1 (`prepareCyclePreview`):
//     - Silent preflight checks (fresh wallet minted==0 & remaining>=10,
//       live price from https://jager.live/api/stats, USDT >= live_price*10*1.02,
//       BNB >= gas minimum, baw Developer Mode ON, PancakeSwap V2 sell quote
//       within 8% of mint cost).
//     - Returns ONE combined preview so the handler asks for confirmation ONCE.
//
//   Phase 2 (`runFullExecution` — after ONE confirmation, zero further prompts):
//     - Step A: Exact USDT Approve (`live_price * 10 * 1.02`, NO unlimited approval)
//     - Step B: Mint 10 Shares in ONE TX (`mint(10, referrer, maxCost)` — NEVER < 10)
//     - Step C: Immediate Sell 100% JAGENT for USDT on PancakeSwap V2
//               (re-checks 8% sell quote guard before selling; exact JAGENT approve)
//     - Step D: Revoke leftover USDT approval for Mint Contract back to 0
//     - Step E: Automatic Referral Reward Claim via jager.live before final summary
//
// Retry Policy:
//   1. Referral Reward Claim (Step E ONLY):
//      - Retries up to a strict MAXIMUM of 50 attempts (`CLAIM_MAX_ATTEMPTS = 50`)
//        until confirmed (`receipt.state === 'confirmed'` / `status === 1`) or
//        verified settled via auto-payout/balance delta, using adaptive backoff.
//      - Respects user cancel or expired wallet session immediately.
//      - If all 50 attempts do not succeed, does NOT stall or crash — logs the
//        attempt count (50/50) and reason cleanly and proceeds to the final summary.
//   2. All Other Steps (Steps A, B, C, D):
//      - Continuous retry until completed (`status === 1` confirmed on-chain),
//        checking on-chain state before every retry to prevent double-execution.
//      - Stops immediately on user cancel, expired baw session, or any mandatory
//        stop condition (failed tx simulation revert, sell quote > 8% below mint
//        cost, underfunded USDT/BNB, already minted / remaining < 10, Dev Mode OFF).
// ═══════════════════════════════════════════════════════════════════════

import crypto from 'crypto';
import { ethers } from 'ethers';
import {
  ADDR,
  REFERRER_NAME,
  PLATFORM_REF_URL,
  MINT_SHARES,
  TOKEN_DECIMALS,
  MIN_BNB_GAS,
  fetchJagerLiveStats,
  readUsdtBalance,
  readUsdtAllowance,
  readJagentBalance,
  readJagentAllowance,
  readBnbBalance,
  pollTransactionReceipt,
  normalizeAddress,
  checkWalletFreshness,
  JAGER_ALREADY_COMPLETED_MESSAGE,
  runPreflightChecks,
  estimateExpectedJagentFor10Shares,
  simulateSellOutputUsdt,
  evaluateSellQuoteGuard,
  simulateContractCall,
  isValidAiAgentId,
  buildUsdtApproveCalldata,
  buildMintCalldata,
  buildJagentApproveCalldata,
  buildSellCalldata,
  checkInviteRewards,
  claimInviteRewards,
} from './bsc.js';
import {
  isSessionConnectedDb,
  executeContractCall,
  getSession,
  fetchBawAgentId,
  getBawWalletSettings,
  syncAgentId,
} from './wallet.js';
import { generateExecutionSummary } from './gemini.js';
import {
  insertExecution,
  queueDeferredExecutionWrite,
  withDbRetry,
  hasCompletedCycleForAgent,
  recordCompletedAgentInMemory,
  isBotPaused,
  pool,
} from './db.js';
import { isAdminId } from './config.js';
import { logger } from './logger.js';

// ─── Constants & Retry Configuration ─────────────────────────────────────────

export const ALREADY_COMPLETED_MESSAGE = JAGER_ALREADY_COMPLETED_MESSAGE;

function ensureStopPrefix(reason: string): string {
  return /^[⛔⚠️❌]/.test(reason.trim()) ? reason : `⛔ ${reason}`;
}

/** Strict retry cap applied ONLY to Step E (Referral Reward Claim). */
export const CLAIM_MAX_ATTEMPTS = 50;

const PREVIEW_TTL_MS              = 5 * 60 * 1000; // 5 minutes validity for a pending confirmation preview
const RETRY_BASE_DELAY_MS         = 1_500;         // initial backoff for continuous step retries
const RETRY_STEP_DELAY_MS         = 500;           // linear increment per retry attempt
const RETRY_MAX_DELAY_MS          = 5_000;         // backoff cap for continuous retries
const CLAIM_BASE_DELAY_MS         = 1_800;         // short initial delay for referral claim retries
const CLAIM_STEP_DELAY_MS         = 150;           // gentle ramp across normal polling attempts
const CLAIM_NORMAL_MAX_DELAY_MS   = 4_500;         // normal polling delay cap
const CLAIM_ERROR_BASE_DELAY_MS   = 3_000;         // elevated delay on rate limits / transient API errors
const CLAIM_ERROR_STEP_DELAY_MS   = 300;           // ramp on repeated rate limits / transient errors
const CLAIM_ERROR_MAX_DELAY_MS    = 6_000;         // max adaptive backoff cap (~6s)
const STATUS_THROTTLE_MS          = 3_500;         // minimum interval between Telegram status message edits

function computeRetryDelayMs(attempt: number): number {
  return Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS + Math.max(0, attempt - 1) * RETRY_STEP_DELAY_MS);
}

/**
 * Adaptive backoff for Step E referral claim retries (up to 50 attempts):
 *   - Normal indexing/pending checks: ~1.8s stepping up gently to ~4.5s
 *   - Rate limits (`too-soon` / HTTP 429) or transient API/RPC errors: ~3.0s up to ~6.0s
 */
export function computeClaimDelayMs(
  attempt: number,
  opts?: { rateLimited?: boolean; transientError?: boolean },
): number {
  if (opts?.rateLimited || opts?.transientError) {
    return Math.min(
      CLAIM_ERROR_MAX_DELAY_MS,
      CLAIM_ERROR_BASE_DELAY_MS + Math.max(0, attempt - 1) * CLAIM_ERROR_STEP_DELAY_MS,
    );
  }
  return Math.min(
    CLAIM_NORMAL_MAX_DELAY_MS,
    CLAIM_BASE_DELAY_MS + Math.max(0, attempt - 1) * CLAIM_STEP_DELAY_MS,
  );
}

/** Keeps retry error snippets compact and readable in Telegram status edits. */
function summarizeRetryError(err: unknown): string {
  const raw = String((err as Error)?.message ?? err ?? 'contract call failed')
    .replace(/\s+/g, ' ')
    .trim();
  const msgMatch = raw.match(/"message"\s*:\s*"([^"]+)"/);
  const clean = msgMatch ? msgMatch[1] : raw;
  return clean.length > 140 ? `${clean.slice(0, 140)}…` : clean;
}

/**
 * Identifies explicit mandatory/hard stop errors that must stop immediately
 * rather than retrying continuously (expired session, underfunded wallet,
 * Developer Mode OFF/expired/cap exceeded, Binance risk block, exhausted quota,
 * contract paused/sold out, or invalid CLI/address).
 */
function isHardStopError(err: unknown): boolean {
  const e = err as Error & { isSessionExpired?: boolean };
  if (e?.isSessionExpired) return true;
  const msg = String(e?.message ?? err ?? '');
  return (
    /insufficient funds|insufficient balance|not enough (bnb|usdt)/i.test(msg) ||
    /developer mode.*(not enabled|disabled|off|expired|exceeded|confirmation required)/i.test(msg) ||
    /PENDING_CONFIRMATION|\b351802\b|\b351804\b|Transaction risk is too high/i.test(msg) ||
    /quota exhausted|daily limit.*exceeded|exceed.*daily.*limit/i.test(msg) ||
    /\b(Quota|NoAgent|Paused|SoldOut|NotOpen|PoolRejected|TransfersClosed)\(\)/i.test(msg) ||
    /CLI binary not found|Invalid EVM/i.test(msg)
  );
}

// Per-user execution locks, preview locks & cancel flags
const activeLocks  = new Set<number>();
const previewLocks = new Set<number>();
const cancelFlags  = new Map<number, boolean>();

export function isUserLocked(userId: number): boolean { return activeLocks.has(userId); }
export function isPreviewInProgress(userId: number): boolean { return previewLocks.has(userId); }
export function requestCancelExecution(userId: number): void { cancelFlags.set(userId, true); }
function isCancelled(userId: number): boolean { return cancelFlags.get(userId) === true; }

/**
 * Atomically checks that no job is running, consumes a valid (non-expired)
 * pending preview, and acquires the per-user execution lock synchronously
 * BEFORE any async Telegram API call (prevents double-tap confirmation races).
 */
export function reserveExecutionFromPreview(
  userId: number,
): { ok: true; preview: CyclePreview } | { ok: false; reason: 'locked' | 'expired' } {
  if (activeLocks.has(userId)) {
    return { ok: false, reason: 'locked' };
  }
  const preview = getPendingPreview(userId);
  if (!preview) {
    return { ok: false, reason: 'expired' };
  }
  pendingPreviews.delete(userId);
  activeLocks.add(userId);
  cancelFlags.set(userId, false);
  return { ok: true, preview };
}

/** Releases a reserved lock if startup fails before `runFullExecution` begins. */
export function releaseReservedExecutionLock(userId: number): void {
  activeLocks.delete(userId);
  cancelFlags.delete(userId);
}

/**
 * Waits briefly after an ERC-20 approve receipt confirms so load-balanced BSC
 * RPC nodes reflect the updated allowance before the next `eth_call` simulation.
 */
async function waitForAllowancePropagation(
  readAllowance: () => Promise<bigint>,
  minRequired: bigint,
  userId: number,
): Promise<void> {
  for (let i = 0; i < 6; i++) {
    if (isCancelled(userId)) return;
    try {
      const current = await readAllowance();
      if (current >= minRequired) return;
    } catch { /* retry */ }
    await sleepWithCancelCheck(userId, 750);
  }
}

/** Cancels all active background executions owned by non-admin users when admin stops the bot. */
export function cancelAllNonAdminExecutions(): number {
  let cancelledCount = 0;
  for (const uid of activeLocks) {
    if (!isAdminId(uid)) {
      cancelFlags.set(uid, true);
      cancelledCount++;
    }
  }
  return cancelledCount;
}

/** Sleeps in short slices so Cancel responds almost immediately during backoff. */
async function sleepWithCancelCheck(userId: number, delayMs: number): Promise<boolean> {
  const sliceMs = 350;
  let elapsed = 0;
  while (elapsed < delayMs) {
    if (isCancelled(userId)) return true;
    const wait = Math.min(sliceMs, delayMs - elapsed);
    await new Promise((r) => setTimeout(r, wait));
    elapsed += wait;
  }
  return isCancelled(userId);
}

// ─── Pending One-Confirm Previews ─────────────────────────────────────────────

export interface CyclePreview {
  userId: number;
  walletAddress: string;
  agentId: string;
  priceUsdtPerShare: number;
  mintCostUsdtWei: bigint;
  approveUsdtWei: bigint;
  expectedJagentWei: bigint;
  estimatedSellUsdtWei: bigint;
  estimatedNetPnlUsdtWei: bigint;
  estimatedLossPct: number;
  usdtBalanceWei: bigint;
  bnbBalanceWei: bigint;
  mintedCount: bigint;
  quota: bigint;
  remainingQuota: bigint;
  createdAt: number;
}

const pendingPreviews = new Map<number, CyclePreview>();

export function getPendingPreview(userId: number): CyclePreview | null {
  const p = pendingPreviews.get(userId);
  if (!p) return null;
  if (Date.now() - p.createdAt > PREVIEW_TTL_MS) {
    pendingPreviews.delete(userId);
    return null;
  }
  return p;
}

export function clearPendingPreview(userId: number): void {
  pendingPreviews.delete(userId);
}

export type PreviewResult =
  | { ok: true; preview: CyclePreview; text: string }
  | {
      ok: false;
      reason: string;
      alreadyCompleted?: boolean;
      notEligible?: boolean;
      isSessionExpired?: boolean;
    };

export function formatCyclePreviewText(p: CyclePreview): string {
  const mintCostF = Number(ethers.formatUnits(p.mintCostUsdtWei, TOKEN_DECIMALS));
  const approveF  = Number(ethers.formatUnits(p.approveUsdtWei, TOKEN_DECIMALS));
  const sellEstF  = Number(ethers.formatUnits(p.estimatedSellUsdtWei, TOKEN_DECIMALS));
  const pnlEstF   = sellEstF - mintCostF;
  const pnlSign   = pnlEstF > 0 ? '+' : '';
  const usdtBalF  = Number(ethers.formatUnits(p.usdtBalanceWei, TOKEN_DECIMALS));
  const bnbBalF   = Number(ethers.formatEther(p.bnbBalanceWei));
  const expectedTokensF = Number(ethers.formatUnits(p.expectedJagentWei, TOKEN_DECIMALS));

  return [
    `📋 JAGER MINT — ONE-CONFIRM FULL CYCLE PREVIEW`,
    ``,
    `🤖 Agent ID: ${p.agentId}`,
    `💳 Wallet: ${p.walletAddress}`,
    `📊 Quota: minted ${p.mintedCount.toString()} / remaining ${p.remainingQuota.toString()} (Fresh ✅)`,
    `💰 Balances: ${usdtBalF.toFixed(4)} USDT | ${bnbBalF.toFixed(5)} BNB`,
    `📌 Fixed Referrer: ${REFERRER_NAME} (${ADDR.REFERRER})`,
    `🌐 Platform: ${PLATFORM_REF_URL}`,
    ``,
    `── Live Cycle Numbers ──`,
    `• Live Price: ${p.priceUsdtPerShare} USDT / share (from jager.live/api/stats)`,
    `• Exact USDT Approve Amount: ${approveF.toFixed(4)} USDT (10 shares × 1.02, NO unlimited approval)`,
    `• Mint Cost (10 shares in 1 TX): ${mintCostF.toFixed(4)} USDT`,
    `• Expected Output: ~${expectedTokensF.toLocaleString('en-US', { maximumFractionDigits: 0 })} JAGENT`,
    `• Est. PancakeSwap V2 Sell Value: ~${sellEstF.toFixed(4)} USDT (JAGENT → USDT, net of 2% sell tax)`,
    `• Est. Net Loss / Fees: ${pnlSign}${pnlEstF.toFixed(4)} USDT (${p.estimatedLossPct.toFixed(2)}% vs mint cost)`,
    ``,
    `── Automated Back-to-Back Steps (after 1 confirmation) ──`,
    `A. Exact USDT Approve (${approveF.toFixed(4)} USDT → Mint Contract)`,
    `B. Mint 10 Shares in ONE TX (referrer: ${REFERRER_NAME})`,
    `C. Immediate Sell 100% JAGENT → USDT (stops if quote < 92% of mint cost)`,
    `D. Revoke Leftover USDT Approval back to 0`,
    `E. Claim Referral Reward (up to ${CLAIM_MAX_ATTEMPTS} attempts if due)`,
    ``,
    `⚠️ LOW/MEDIUM gas settings only. Confirm ONCE below to execute all steps automatically:`,
  ].join('\n');
}

// ─── Phase 1: Silent Preflight + Single Combined Preview ──────────────────────

export async function prepareCyclePreview(userId: number): Promise<PreviewResult> {
  if (isBotPaused() && !isAdminId(userId)) {
    return { ok: false, reason: '⛔ The bot is currently stopped by the administrator. Please try again later.' };
  }

  if (activeLocks.has(userId) || previewLocks.has(userId)) {
    return { ok: false, reason: '⏳ A job or preview is already running for your account. Please wait or tap Cancel.' };
  }

  previewLocks.add(userId);
  try {
    // 1. Verify wallet session
    const { connected, address: rawWalletAddress, dbAgentId } = await isSessionConnectedDb(userId);
    if (!connected || !rawWalletAddress) {
      return { ok: false, reason: 'Wallet not connected. Tap Connect Your Binance Wallet and complete pairing first.' };
    }

    const walletAddress = normalizeAddress(rawWalletAddress, 'preview.walletAddress');
    const session = getSession(userId);
    const sessionAgentId   = session?.agentIdName?.trim() || '';
    const persistedAgentId = dbAgentId?.trim() || '';

    let bawAgentId = '';
    if (!isValidAiAgentId(sessionAgentId) && !isValidAiAgentId(persistedAgentId)) {
      bawAgentId = (await fetchBawAgentId(userId))?.trim() || '';
    }

    let agentId =
      (isValidAiAgentId(sessionAgentId) ? sessionAgentId : '') ||
      (isValidAiAgentId(persistedAgentId) ? persistedAgentId : '') ||
      (isValidAiAgentId(bawAgentId) ? bawAgentId : '') ||
      walletAddress;

    // 2. Contract-scoped completed cycle guard (JAGER Mint Contract only; ignores legacy SPACE ID/BNB rows)
    const earlyLock = await hasCompletedCycleForAgent({
      mintContract: ADDR.MINT_CONTRACT,
      agentIdName: isValidAiAgentId(agentId) ? agentId : null,
      walletAddress,
    });
    if (earlyLock.completed) {
      return { ok: false, alreadyCompleted: true, reason: ALREADY_COMPLETED_MESSAGE };
    }

    // 3. Fetch LIVE JAGER price from https://jager.live/api/stats + baw wallet settings
    const [liveStats, bawSettingsRes] = await Promise.all([
      fetchJagerLiveStats(),
      getBawWalletSettings(userId),
    ]);

    if (!liveStats.mintingOpen || liveStats.paused) {
      const reason = 'JAGER minting is currently closed or paused on jager.live.';
      await logExecution(userId, walletAddress, 'STOPPED', 0n, 0n, 0n, 0n, {}, agentId, reason);
      return { ok: false, reason: ensureStopPrefix(reason) };
    }

    // 4. Silent preflight checks (fresh wallet, .ai Agent ID, Dev Mode ON, USDT >= maxCost, BNB >= gas)
    const preflight = await runPreflightChecks(walletAddress, liveStats.maxCostUsdtWei, {
      sessionAgentId: sessionAgentId || null,
      dbAgentId: persistedAgentId || null,
      bawAgentId: bawAgentId || null,
      bawSettings: bawSettingsRes.ok ? bawSettingsRes.settings : null,
      bawSettingsError: bawSettingsRes.ok ? null : bawSettingsRes.error,
    });

    if (preflight.resolvedAgentId) {
      agentId = preflight.resolvedAgentId;
      await syncAgentId(userId, agentId);

      const resolvedLock = await hasCompletedCycleForAgent({
        mintContract: ADDR.MINT_CONTRACT,
        agentIdName: agentId,
        walletAddress,
      });
      if (resolvedLock.completed) {
        return { ok: false, alreadyCompleted: true, reason: ALREADY_COMPLETED_MESSAGE };
      }
    }

    if (!preflight.ok) {
      const reason = preflight.reason ?? 'Silent preflight checks failed.';
      const isWalletIneligible = /Wallet Not Eligible|নট ইলিজিবল/i.test(reason);
      await logExecution(userId, walletAddress, 'STOPPED', 0n, 0n, 0n, 0n, {}, agentId, reason);
      return { ok: false, notEligible: isWalletIneligible, reason: ensureStopPrefix(reason) };
    }

    // 5. Expected JAGENT output & PancakeSwap V2 sell quote (JAGENT → USDT)
    const expectedJagentWei = await estimateExpectedJagentFor10Shares(
      liveStats.mintCostUsdtWei,
      liveStats.tokensPerShare,
    );
    const estimatedSellUsdtWei = await simulateSellOutputUsdt(expectedJagentWei);

    // 6. Mandatory 8% stop-loss check (`sell_quote < mint_cost * 0.92`)
    const sellGuard = evaluateSellQuoteGuard(liveStats.mintCostUsdtWei, estimatedSellUsdtWei);
    if (!sellGuard.ok) {
      const reason = sellGuard.reason ?? 'Sell quote is more than 8% below mint cost.';
      await logExecution(userId, walletAddress, 'STOPPED', liveStats.mintCostUsdtWei, 0n, 0n, 0n, {}, agentId, reason);
      return { ok: false, reason: `⛔ ${reason}` };
    }

    const preview: CyclePreview = {
      userId,
      walletAddress,
      agentId,
      priceUsdtPerShare: liveStats.priceUsdtPerShare,
      mintCostUsdtWei: liveStats.mintCostUsdtWei,
      approveUsdtWei: liveStats.maxCostUsdtWei,
      expectedJagentWei,
      estimatedSellUsdtWei,
      estimatedNetPnlUsdtWei: estimatedSellUsdtWei - liveStats.mintCostUsdtWei,
      estimatedLossPct: sellGuard.lossPct,
      usdtBalanceWei: preflight.usdtBalanceWei ?? 0n,
      bnbBalanceWei: preflight.bnbBalanceWei ?? 0n,
      mintedCount: preflight.mintedCount ?? 0n,
      quota: preflight.quota ?? MINT_SHARES,
      remainingQuota: preflight.remainingQuota ?? MINT_SHARES,
      createdAt: Date.now(),
    };

    pendingPreviews.set(userId, preview);

    logger.info(
      {
        userId,
        walletAddress,
        agentId,
        priceUsdtPerShare: preview.priceUsdtPerShare,
        mintCostUsdt: ethers.formatUnits(preview.mintCostUsdtWei, TOKEN_DECIMALS),
        approveUsdt: ethers.formatUnits(preview.approveUsdtWei, TOKEN_DECIMALS),
        estimatedSellUsdt: ethers.formatUnits(preview.estimatedSellUsdtWei, TOKEN_DECIMALS),
        estimatedLossPct: preview.estimatedLossPct.toFixed(2),
      },
      'Prepared JAGER One-Confirm Full Cycle preview',
    );

    return { ok: true, preview, text: formatCyclePreviewText(preview) };
  } catch (err: unknown) {
    const e = err as Error & { isSessionExpired?: boolean };
    if (e?.isSessionExpired) {
      return {
        ok: false,
        isSessionExpired: true,
        reason: 'Binance Wallet session expired. Please reconnect and try again.',
      };
    }
    logger.error({ err, userId }, 'prepareCyclePreview failed');
    return { ok: false, reason: `❌ Preflight preview failed: ${e?.message ?? String(err)}` };
  } finally {
    previewLocks.delete(userId);
  }
}

// ─── Result Types ─────────────────────────────────────────────────────────────

export type CycleTxKey = 'approve' | 'mint' | 'sell_approve' | 'sell' | 'revoke' | 'claim';

export interface ExecutionSuccess {
  ok: true;
  /** Globally unique per-execution identifier used for notification deduplication (never per telegram_user_id). */
  runId: string;
  executionId: number | null;
  summary: string;
  agentId: string;
  walletAddress: string;
  mintCostUsdt: string;
  tokensReceived: string;
  sellUsdt: string;
  netLossOrFeeUsdt: string;
  inviteRewardUsdt?: string;
  approveTxHash: string;
  mintTxHash: string;
  sellApproveTxHash?: string;
  sellTxHash: string;
  revokeTxHash: string;
  claimTxHash: string;
  claimAttempts: number;
  claimStatusNote?: string;
  completedCount: number;
}

export interface ExecutionFailure {
  ok: false;
  reason: string;
  alreadyCompleted?: boolean;
  isSessionExpired?: boolean;
  partialTxHashes?: Partial<Record<CycleTxKey, string>>;
}

export type ExecutionResult = ExecutionSuccess | ExecutionFailure;

/** Called by the handler to edit the live status message. */
export type StatusUpdater = (text: string) => Promise<void>;

// ─── Phase 2: Automated Back-to-Back Execution (Steps A → E) ─────────────────

export async function runFullExecution(
  userId: number,
  onStatus: StatusUpdater,
  reservedPreview?: CyclePreview,
): Promise<ExecutionResult> {
  if (isBotPaused() && !isAdminId(userId)) {
    if (reservedPreview) {
      activeLocks.delete(userId);
      cancelFlags.delete(userId);
    }
    return { ok: false, reason: '⛔ The bot is currently stopped by the administrator. Please try again later.' };
  }

  let preview: CyclePreview;
  if (reservedPreview) {
    // Caller already atomically consumed preview and acquired activeLocks via reserveExecutionFromPreview()
    preview = reservedPreview;
  } else {
    const reserved = reserveExecutionFromPreview(userId);
    if (!reserved.ok) {
      return {
        ok: false,
        reason:
          reserved.reason === 'locked'
            ? '⏳ A job is already running for your account. Please wait.'
            : '⏰ Confirmation preview expired or not found. Tap Complete All Process to generate a fresh live preview.',
      };
    }
    preview = reserved.preview;
  }

  const txHashes: Partial<Record<CycleTxKey, string>> = {};
  let resolvedWallet = preview.walletAddress;
  let resolvedAgentId = preview.agentId;
  let trackedMintCostUsdtWei = 0n;
  let trackedTokensWei = 0n;
  let trackedSellUsdtWei = 0n;
  let trackedInviteRewardWei = 0n;

  const stopNow = async (
    status: 'STOPPED' | 'CANCELLED' | 'FAILED',
    reason: string,
    extra?: { isSessionExpired?: boolean; alreadyCompleted?: boolean },
  ): Promise<ExecutionFailure> => {
    await logExecution(
      userId,
      resolvedWallet,
      status,
      trackedMintCostUsdtWei,
      trackedTokensWei,
      trackedSellUsdtWei,
      trackedInviteRewardWei,
      txHashes,
      resolvedAgentId,
      reason,
    );
    return {
      ok: false,
      reason: status === 'STOPPED' ? ensureStopPrefix(reason) : reason,
      isSessionExpired: extra?.isSessionExpired,
      alreadyCompleted: extra?.alreadyCompleted,
      partialTxHashes: Object.keys(txHashes).length > 0 ? { ...txHashes } : undefined,
    };
  };

  try {
    // ── Re-verify session & fresh live price right before Step A ──────────────
    await onStatus('🔍 Re-verifying live JAGER price, freshness & preflight guards…');

    const { connected, address: rawWalletAddress, dbAgentId } = await isSessionConnectedDb(userId);
    if (!connected || !rawWalletAddress) {
      return await stopNow('FAILED', 'Wallet session disconnected. Please reconnect and try again.', {
        isSessionExpired: true,
      });
    }

    const walletAddress = normalizeAddress(rawWalletAddress, 'executor.walletAddress');
    resolvedWallet = walletAddress;

    if (walletAddress.toLowerCase() !== preview.walletAddress.toLowerCase()) {
      return await stopNow(
        'STOPPED',
        'Connected wallet changed since preview was generated. Please tap Complete All Process for a fresh preview.',
      );
    }

    const earlyLock = await hasCompletedCycleForAgent({
      mintContract: ADDR.MINT_CONTRACT,
      agentIdName: isValidAiAgentId(resolvedAgentId) ? resolvedAgentId : null,
      walletAddress,
    });
    if (earlyLock.completed) {
      return { ok: false, alreadyCompleted: true, reason: ALREADY_COMPLETED_MESSAGE };
    }

    let liveStats = await fetchJagerLiveStats();
    const bawSettingsRes = await getBawWalletSettings(userId);

    if (!liveStats.mintingOpen || liveStats.paused) {
      return await stopNow('STOPPED', 'JAGER minting is currently closed or paused on jager.live.');
    }

    const session = getSession(userId);
    const preflight = await runPreflightChecks(walletAddress, liveStats.maxCostUsdtWei, {
      sessionAgentId: session?.agentIdName ?? null,
      dbAgentId: dbAgentId ?? null,
      bawSettings: bawSettingsRes.ok ? bawSettingsRes.settings : null,
      bawSettingsError: bawSettingsRes.ok ? null : bawSettingsRes.error,
    });

    if (preflight.resolvedAgentId) {
      resolvedAgentId = preflight.resolvedAgentId;
      await syncAgentId(userId, resolvedAgentId);
    }

    if (!preflight.ok) {
      return await stopNow('STOPPED', preflight.reason ?? 'Preflight guard failed.');
    }

    // Re-check 8% sell quote guard on fresh live price before sending any tx
    const expectedJagentWei = await estimateExpectedJagentFor10Shares(
      liveStats.mintCostUsdtWei,
      liveStats.tokensPerShare,
    );
    const preMintSellQuote = await simulateSellOutputUsdt(expectedJagentWei);
    const preMintGuard = evaluateSellQuoteGuard(liveStats.mintCostUsdtWei, preMintSellQuote);
    if (!preMintGuard.ok) {
      return await stopNow('STOPPED', preMintGuard.reason ?? 'Sell quote is more than 8% below mint cost.');
    }

    if (isCancelled(userId)) {
      return await stopNow('CANCELLED', 'Cancelled by user before Step A.');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP A — Exact USDT Approve (`live_price * 10 * 1.02`, NO unlimited approval)
    // Continuous retry until confirmed (stops on cancel, expired session, or mandatory guard)
    // ═══════════════════════════════════════════════════════════════════════════
    let exactApproveWei = liveStats.maxCostUsdtWei;
    let approveTxHash = '';
    let approveAttempt = 0;
    let lastApproveEditAt = 0;

    while (true) {
      if (isCancelled(userId)) {
        return await stopNow('CANCELLED', `Cancelled by user during Step A USDT approve (after ${approveAttempt} attempt(s)).`);
      }

      try {
        if (approveAttempt > 0) {
          liveStats = await fetchJagerLiveStats();
          if (!liveStats.mintingOpen || liveStats.paused) {
            return await stopNow('STOPPED', 'JAGER minting is currently closed or paused on jager.live.');
          }
          exactApproveWei = liveStats.maxCostUsdtWei;
        }

        const [liveUsdtBal, liveBnbBal, currentAllowance] = await Promise.all([
          readUsdtBalance(walletAddress),
          readBnbBalance(walletAddress),
          readUsdtAllowance(walletAddress, ADDR.MINT_CONTRACT),
        ]);

        // Mandatory balance guards
        if (liveUsdtBal < exactApproveWei) {
          return await stopNow(
            'STOPPED',
            `Insufficient USDT balance. Need ≥ ${Number(ethers.formatUnits(exactApproveWei, TOKEN_DECIMALS)).toFixed(4)} USDT, ` +
            `have ${Number(ethers.formatUnits(liveUsdtBal, TOKEN_DECIMALS)).toFixed(4)} USDT.`,
          );
        }
        if (liveBnbBal < MIN_BNB_GAS) {
          return await stopNow(
            'STOPPED',
            `Insufficient BNB for gas. Need ≥ ${ethers.formatEther(MIN_BNB_GAS)} BNB, have ${ethers.formatEther(liveBnbBal)} BNB.`,
          );
        }

        // Idempotency check: if a prior attempt already confirmed exact allowance on-chain
        if (currentAllowance === exactApproveWei) {
          if (!approveTxHash) approveTxHash = txHashes.approve ?? 'already-approved-exact';
          logger.info(
            { userId, step: 'approve_usdt', attempt: approveAttempt, exactApproveWei: exactApproveWei.toString() },
            'Exact USDT allowance confirmed on-chain — proceeding to Step B',
          );
          break;
        }

        approveAttempt++;
        const exactApproveStr = Number(ethers.formatUnits(exactApproveWei, TOKEN_DECIMALS)).toFixed(4);
        const now = Date.now();
        if (approveAttempt <= 2 || now - lastApproveEditAt >= STATUS_THROTTLE_MS) {
          lastApproveEditAt = now;
          await onStatus(
            `⚙️ Step A/E — Exact USDT Approve${approveAttempt > 1 ? ` (attempt #${approveAttempt})` : ''}\n` +
            `Approving exactly ${exactApproveStr} USDT (10 shares × 1.02) for JAGER Mint Contract…`,
          );
        }

        const approveUsdtData = buildUsdtApproveCalldata(exactApproveWei, ADDR.MINT_CONTRACT);
        const approveUsdtSim = await simulateContractCall({
          step: 'approve_usdt',
          from: walletAddress,
          to: ADDR.USDT,
          data: approveUsdtData,
          value: 0n,
        });

        // Mandatory stop condition: explicit transaction simulation revert
        if (!approveUsdtSim.ok && approveUsdtSim.isRevert) {
          const reason = `Step A (USDT Approve) simulation failed: ${approveUsdtSim.revertReason ?? approveUsdtSim.error ?? 'reverted'}`;
          return await stopNow('STOPPED', reason);
        }
        if (!approveUsdtSim.ok) {
          throw new Error(`RPC simulation unavailable: ${approveUsdtSim.error ?? 'transient RPC error'}`);
        }

        const approveUsdtRes = await executeContractCall({
          userId,
          step: 'approve_usdt',
          walletAddress,
          to: ADDR.USDT,
          inputData: approveUsdtData,
          value: 0n,
          rpcEstimatedGas: approveUsdtSim.estimatedGas,
          fallbackGasLimit: 100_000,
        });
        approveTxHash = approveUsdtRes.txHash;
        txHashes.approve = approveTxHash;

        await onStatus(`⏳ Step A/E — USDT Approve submitted (${approveTxHash.slice(0, 10)}…). Waiting for BSC confirmation…`);
        const approveReceipt = await pollTransactionReceipt(approveTxHash, {
          timeoutMs: 90_000,
          pollIntervalMs: 1_500,
          walletAddress,
          isCancelled: () => isCancelled(userId),
        });

        if (approveReceipt.state === 'cancelled') {
          return await stopNow('CANCELLED', `Cancelled while waiting for Step A USDT approve (${approveTxHash}).`);
        }
        if (approveReceipt.state === 'reverted') {
          const rev = approveTxHash;
          delete txHashes.approve;
          approveTxHash = '';
          throw new Error(`Step A USDT approve TX ${rev.slice(0, 12)}… reverted on-chain (status=0)`);
        }
        if (approveReceipt.state === 'timeout') {
          throw new Error(`Step A USDT approve TX ${approveTxHash.slice(0, 12)}… confirmation timed out — verifying on-chain`);
        }

        logger.info({ userId, step: 'approve_usdt', attempts: approveAttempt, approveTxHash }, 'Step A USDT approve confirmed');
        // Wait briefly for load-balanced BSC RPC nodes to reflect the confirmed allowance
        await waitForAllowancePropagation(
          () => readUsdtAllowance(walletAddress, ADDR.MINT_CONTRACT),
          exactApproveWei,
          userId,
        );
        break;
      } catch (err) {
        const e = err as Error & { isSessionExpired?: boolean };
        if (e?.isSessionExpired) {
          return await stopNow('FAILED', 'Binance Wallet session expired during Step A (USDT Approve). Please reconnect.', {
            isSessionExpired: true,
          });
        }
        if (isHardStopError(err)) {
          return await stopNow('STOPPED', `Step A stopped by mandatory guard: ${summarizeRetryError(err)}`);
        }

        const delayMs = computeRetryDelayMs(approveAttempt);
        const shortErr = summarizeRetryError(err);
        logger.warn(
          { userId, step: 'approve_usdt', attempt: approveAttempt, retryDelayMs: delayMs, err: shortErr },
          'Step A USDT approve failed — retrying until confirmed',
        );
        const now = Date.now();
        if (approveAttempt <= 3 || now - lastApproveEditAt >= STATUS_THROTTLE_MS) {
          lastApproveEditAt = now;
          await onStatus(
            `🔁 Step A/E USDT Approve attempt #${approveAttempt} failed — retrying…\n` +
            `Reason: ${shortErr}\nNext retry in ${(delayMs / 1000).toFixed(1)}s (tap Cancel to stop).`,
          );
        }
        if (await sleepWithCancelCheck(userId, delayMs)) {
          return await stopNow('CANCELLED', `Cancelled by user during Step A retries (after ${approveAttempt} attempt(s)).`);
        }
      }
    }

    if (isCancelled(userId)) {
      return await stopNow('CANCELLED', `Cancelled by user after Step A USDT approve (${approveTxHash}).`);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP B — Mint 10 Shares in ONE Transaction (`mint(10, referrer, maxCost)`)
    // Continuous retry until confirmed (stops on cancel, expired session, or mandatory guard)
    // ═══════════════════════════════════════════════════════════════════════════
    let mintTxHash = '';
    let actualMintCostUsdtWei = 0n;
    let jagentReceivedWei = 0n;
    let mintAttempt = 0;
    let lastMintEditAt = 0;

    while (true) {
      if (isCancelled(userId)) {
        return await stopNow('CANCELLED', `Cancelled by user during Step B mint (after ${mintAttempt} attempt(s)).`);
      }

      // Idempotency guard before retry: check if a prior mint attempt already landed on-chain
      if (mintAttempt > 0) {
        try {
          const [onChainJagentNow, freshnessNow] = await Promise.all([
            readJagentBalance(walletAddress),
            checkWalletFreshness(walletAddress),
          ]);
          if (onChainJagentNow > 0n) {
            jagentReceivedWei = onChainJagentNow;
            trackedTokensWei  = jagentReceivedWei;
            if (!mintTxHash) mintTxHash = txHashes.mint ?? 'confirmed-onchain';
            txHashes.mint = mintTxHash;
            // Attempt quick receipt read to recover exact on-chain USDT paid from Minted event
            if (actualMintCostUsdtWei === 0n && /^0x[0-9a-fA-F]{64}$/.test(mintTxHash)) {
              const recoveredRcpt = await pollTransactionReceipt(mintTxHash, { timeoutMs: 3_000, walletAddress });
              if (recoveredRcpt.state === 'confirmed' && recoveredRcpt.mintPaidUsdtFromLogs > 0n) {
                actualMintCostUsdtWei = recoveredRcpt.mintPaidUsdtFromLogs;
              }
            }
            if (actualMintCostUsdtWei === 0n) actualMintCostUsdtWei = liveStats.mintCostUsdtWei;
            trackedMintCostUsdtWei = actualMintCostUsdtWei;
            logger.info(
              { userId, step: 'mint', mintAttempt, mintTxHash, jagentReceived: ethers.formatUnits(jagentReceivedWei, TOKEN_DECIMALS) },
              'Detected confirmed JAGENT balance on-chain before retry — skipping redundant mint',
            );
            break;
          }
          if (!freshnessNow.fresh && (freshnessNow.reasonCode === 'ALREADY_MINTED' || freshnessNow.reasonCode === 'INSUFFICIENT_QUOTA')) {
            return await stopNow('STOPPED', freshnessNow.userMessage ?? freshnessNow.reason ?? 'Wallet already minted or remaining quota < 10.');
          }
        } catch (checkErr) {
          logger.warn({ userId, err: (checkErr as Error)?.message }, 'Pre-retry mint state check failed — continuing');
        }
      }

      mintAttempt++;
      try {
        // Refresh live stats & check sell quote + balances before each mint attempt
        liveStats = await fetchJagerLiveStats();
        if (!liveStats.mintingOpen || liveStats.paused) {
          return await stopNow('STOPPED', 'JAGER minting is currently closed or paused on jager.live.');
        }

        const neededMaxCost = liveStats.maxCostUsdtWei;
        const [liveUsdtBal, liveBnbBal, currentAllowance, freshExpectedTokens] = await Promise.all([
          readUsdtBalance(walletAddress),
          readBnbBalance(walletAddress),
          readUsdtAllowance(walletAddress, ADDR.MINT_CONTRACT),
          estimateExpectedJagentFor10Shares(liveStats.mintCostUsdtWei, liveStats.tokensPerShare),
        ]);

        if (liveUsdtBal < neededMaxCost) {
          return await stopNow(
            'STOPPED',
            `Insufficient USDT for live mint price. Need ≥ ${Number(ethers.formatUnits(neededMaxCost, TOKEN_DECIMALS)).toFixed(4)} USDT, ` +
            `have ${Number(ethers.formatUnits(liveUsdtBal, TOKEN_DECIMALS)).toFixed(4)} USDT.`,
          );
        }
        if (liveBnbBal < MIN_BNB_GAS) {
          return await stopNow(
            'STOPPED',
            `Insufficient BNB for mint gas. Need ≥ ${ethers.formatEther(MIN_BNB_GAS)} BNB, have ${ethers.formatEther(liveBnbBal)} BNB.`,
          );
        }

        const preMintQuoteNow = await simulateSellOutputUsdt(freshExpectedTokens, { throwOnRpcError: true });
        const preMintGuardNow = evaluateSellQuoteGuard(liveStats.mintCostUsdtWei, preMintQuoteNow);
        if (!preMintGuardNow.ok) {
          return await stopNow('STOPPED', preMintGuardNow.reason ?? 'Sell quote is more than 8% below mint cost.');
        }

        // If live price moved slightly above Step A allowance, refresh exact USDT approval before minting
        if (currentAllowance < neededMaxCost) {
          const topUpData = buildUsdtApproveCalldata(neededMaxCost, ADDR.MINT_CONTRACT);
          const topUpSim = await simulateContractCall({
            step: 'approve_usdt_refresh',
            from: walletAddress,
            to: ADDR.USDT,
            data: topUpData,
            value: 0n,
          });
          if (!topUpSim.ok && topUpSim.isRevert) {
            return await stopNow('STOPPED', `USDT allowance refresh simulation failed: ${topUpSim.revertReason ?? topUpSim.error ?? 'reverted'}`);
          }
          if (!topUpSim.ok) {
            throw new Error(`USDT allowance refresh RPC simulation unavailable: ${topUpSim.error ?? 'transient RPC error'}`);
          }
          const topUpRes = await executeContractCall({
            userId,
            step: 'approve_usdt_refresh',
            walletAddress,
            to: ADDR.USDT,
            inputData: topUpData,
            value: 0n,
            rpcEstimatedGas: topUpSim.estimatedGas,
            fallbackGasLimit: 100_000,
          });
          approveTxHash = topUpRes.txHash;
          txHashes.approve = approveTxHash;
          const topUpRcpt = await pollTransactionReceipt(approveTxHash, {
            timeoutMs: 90_000,
            pollIntervalMs: 1_500,
            walletAddress,
            isCancelled: () => isCancelled(userId),
          });
          if (topUpRcpt.state === 'cancelled') {
            return await stopNow('CANCELLED', `Cancelled while refreshing USDT approval (${approveTxHash}).`);
          }
          if (topUpRcpt.state !== 'confirmed') {
            throw new Error(`USDT allowance refresh TX ${approveTxHash.slice(0, 12)}… did not confirm (${topUpRcpt.state})`);
          }
          exactApproveWei = neededMaxCost;
          await waitForAllowancePropagation(
            () => readUsdtAllowance(walletAddress, ADDR.MINT_CONTRACT),
            neededMaxCost,
            userId,
          );
        }

        const liveMintCostStr = Number(ethers.formatUnits(liveStats.mintCostUsdtWei, TOKEN_DECIMALS)).toFixed(4);
        const maxCostStr      = Number(ethers.formatUnits(neededMaxCost, TOKEN_DECIMALS)).toFixed(4);
        const now = Date.now();
        if (mintAttempt <= 2 || now - lastMintEditAt >= STATUS_THROTTLE_MS) {
          lastMintEditAt = now;
          await onStatus(
            `⚙️ Step B/E — Minting 10 Shares in ONE Transaction${mintAttempt > 1 ? ` (attempt #${mintAttempt})` : ''}\n` +
            `Live cost: ${liveMintCostStr} USDT | MaxCost: ${maxCostStr} USDT | Referrer: ${REFERRER_NAME}\n` +
            `Simulating mint(10, referrer, maxCost)…`,
          );
        }

        const { inputData: mintData, value: mintValue } = buildMintCalldata(neededMaxCost, MINT_SHARES);
        const mintSim = await simulateContractCall({
          step: 'mint',
          from: walletAddress,
          to: ADDR.MINT_CONTRACT,
          data: mintData,
          value: mintValue,
        });

        // Mandatory stop condition: explicit transaction simulation revert
        if (!mintSim.ok && mintSim.isRevert) {
          const reason = `Step B (Mint 10 shares) simulation failed: ${mintSim.revertReason ?? mintSim.error ?? 'reverted'}`;
          return await stopNow('STOPPED', reason);
        }
        if (!mintSim.ok) {
          throw new Error(`Step B RPC simulation unavailable: ${mintSim.error ?? 'transient RPC error'}`);
        }

        const mintRes = await executeContractCall({
          userId,
          step: 'mint',
          walletAddress,
          to: ADDR.MINT_CONTRACT,
          inputData: mintData,
          value: mintValue,
          rpcEstimatedGas: mintSim.estimatedGas,
          fallbackGasLimit: 750_000,
        });
        mintTxHash = mintRes.txHash;
        txHashes.mint = mintTxHash;

        await onStatus(`⏳ Step B/E — Mint TX submitted (${mintTxHash.slice(0, 10)}…). Waiting for BSC confirmation…`);
        const mintReceipt = await pollTransactionReceipt(mintTxHash, {
          timeoutMs: 90_000,
          pollIntervalMs: 1_500,
          walletAddress,
          isCancelled: () => isCancelled(userId),
        });

        if (mintReceipt.state === 'cancelled') {
          return await stopNow('CANCELLED', `Cancelled while waiting for Step B mint receipt (${mintTxHash}).`);
        }
        if (mintReceipt.state === 'reverted') {
          const rev = mintTxHash;
          delete txHashes.mint;
          mintTxHash = '';
          // Re-check freshness so we immediately stop if wallet was minted elsewhere
          const postRevFresh = await checkWalletFreshness(walletAddress);
          if (!postRevFresh.fresh && (postRevFresh.reasonCode === 'ALREADY_MINTED' || postRevFresh.reasonCode === 'INSUFFICIENT_QUOTA')) {
            return await stopNow('STOPPED', postRevFresh.userMessage ?? postRevFresh.reason ?? 'Wallet already minted or remaining quota < 10.');
          }
          throw new Error(`Step B mint TX ${rev.slice(0, 12)}… reverted on-chain (status=0)`);
        }
        if (mintReceipt.state === 'timeout') {
          throw new Error(`Step B mint TX ${mintTxHash.slice(0, 12)}… confirmation timed out — verifying on-chain`);
        }

        actualMintCostUsdtWei =
          mintReceipt.mintPaidUsdtFromLogs > 0n
            ? mintReceipt.mintPaidUsdtFromLogs
            : liveStats.mintCostUsdtWei;
        trackedMintCostUsdtWei = actualMintCostUsdtWei;

        // Confirm JAGENT balance received (handle brief RPC read lag)
        await onStatus(`✅ Step B/E — Mint confirmed in block #${mintReceipt.receipt.blockNumber}. Verifying JAGENT balance…`);
        jagentReceivedWei = 0n;
        for (let poll = 0; poll < 10; poll++) {
          if (isCancelled(userId)) {
            return await stopNow('CANCELLED', `Cancelled after Step B mint confirmed (${mintTxHash}).`);
          }
          try {
            jagentReceivedWei = await readJagentBalance(walletAddress);
            if (jagentReceivedWei > 0n) break;
          } catch (balErr) {
            logger.warn({ userId, poll, err: (balErr as Error)?.message }, 'Post-mint readJagentBalance transient error');
          }
          await sleepWithCancelCheck(userId, 1_200);
        }

        if (jagentReceivedWei === 0n && mintReceipt.mintedJagentFromLogs > 0n) {
          jagentReceivedWei = mintReceipt.mintedJagentFromLogs;
        }
        trackedTokensWei = jagentReceivedWei;

        if (jagentReceivedWei === 0n) {
          return await stopNow(
            'FAILED',
            `Step B mint TX ${mintTxHash} confirmed, but JAGENT wallet balance is 0. Stopping safely.`,
          );
        }

        logger.info(
          {
            userId,
            step: 'mint',
            attempts: mintAttempt,
            mintTxHash,
            paidUsdt: ethers.formatUnits(actualMintCostUsdtWei, TOKEN_DECIMALS),
            jagentReceived: ethers.formatUnits(jagentReceivedWei, TOKEN_DECIMALS),
          },
          'Step B mint confirmed & JAGENT balance verified',
        );
        break;
      } catch (err) {
        const e = err as Error & { isSessionExpired?: boolean };
        if (e?.isSessionExpired) {
          return await stopNow('FAILED', 'Binance Wallet session expired during Step B (Mint). Please reconnect.', {
            isSessionExpired: true,
          });
        }
        if (isHardStopError(err)) {
          return await stopNow('STOPPED', `Step B stopped by mandatory guard: ${summarizeRetryError(err)}`);
        }

        const delayMs = computeRetryDelayMs(mintAttempt);
        const shortErr = summarizeRetryError(err);
        logger.warn(
          { userId, step: 'mint', attempt: mintAttempt, retryDelayMs: delayMs, err: shortErr },
          'Step B mint attempt failed — retrying with fresh live price',
        );
        const now = Date.now();
        if (mintAttempt <= 3 || now - lastMintEditAt >= STATUS_THROTTLE_MS) {
          lastMintEditAt = now;
          await onStatus(
            `🔁 Step B/E Mint attempt #${mintAttempt} failed — retrying automatically…\n` +
            `Reason: ${shortErr}\nNext retry in ${(delayMs / 1000).toFixed(1)}s (tap Cancel to stop).`,
          );
        }
        if (await sleepWithCancelCheck(userId, delayMs)) {
          return await stopNow('CANCELLED', `Cancelled by user during Step B retries (after ${mintAttempt} attempt(s)).`);
        }
      }
    }

    if (isCancelled(userId)) {
      return await stopNow('CANCELLED', `Cancelled by user before Step C sell (${mintTxHash}).`);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP C — Immediate Sell 100% JAGENT for USDT on PancakeSwap V2
    // Continuous retry until confirmed (stops on cancel, expired session, failed
    // simulation, sell quote > 8% below mint cost, or underfunded gas)
    // ═══════════════════════════════════════════════════════════════════════════
    let sellApproveTxHash = '';
    let sellTxHash = '';
    let soldAmountWei = jagentReceivedWei;
    let usdtReceivedWei = 0n;
    const usdtBeforeSell = await readUsdtBalance(walletAddress);

    let sellAttempt = 0;
    let lastSellEditAt = 0;

    while (true) {
      if (isCancelled(userId)) {
        return await stopNow('CANCELLED', `Cancelled by user during Step C sell (after ${sellAttempt} attempt(s)).`);
      }

      sellAttempt++;
      try {
        const [liveJagentBal, liveJagentAllowance, liveBnbBal] = await Promise.all([
          readJagentBalance(walletAddress),
          readJagentAllowance(walletAddress, ADDR.PANCAKE_ROUTER),
          readBnbBalance(walletAddress),
        ]);

        // Idempotency check: if JAGENT balance is now 0, a prior sell tx already landed on-chain
        if (liveJagentBal === 0n) {
          if (sellAttempt > 1 || txHashes.sell) {
            if (!sellTxHash) sellTxHash = txHashes.sell ?? 'confirmed-onchain';
            txHashes.sell = sellTxHash;
            if (usdtReceivedWei === 0n && /^0x[0-9a-fA-F]{64}$/.test(sellTxHash)) {
              const recoveredSell = await pollTransactionReceipt(sellTxHash, { timeoutMs: 3_000, walletAddress });
              if (recoveredSell.state === 'confirmed' && recoveredSell.usdtReceivedFromLogs > 0n) {
                usdtReceivedWei = recoveredSell.usdtReceivedFromLogs;
              }
            }
            if (usdtReceivedWei === 0n) {
              const usdtAfter = await readUsdtBalance(walletAddress).catch(() => usdtBeforeSell);
              if (usdtAfter > usdtBeforeSell) {
                usdtReceivedWei = usdtAfter - usdtBeforeSell;
              }
            }
            trackedSellUsdtWei = usdtReceivedWei;
            logger.info({ userId, step: 'sell', attempts: sellAttempt, sellTxHash }, 'JAGENT balance is 0 — previous sell confirmed on-chain');
            break;
          }
          return await stopNow('STOPPED', 'No JAGENT token balance remaining in wallet to sell.');
        }

        soldAmountWei    = liveJagentBal;
        trackedTokensWei = liveJagentBal;

        if (liveBnbBal < MIN_BNB_GAS / 2n) {
          return await stopNow(
            'STOPPED',
            `Insufficient BNB for Step C sell gas (have ${ethers.formatEther(liveBnbBal)} BNB).`,
          );
        }

        // Mandatory 8% sell quote guard checked live before EVERY approve/sell attempt
        const liveSellQuoteUsdtWei = await simulateSellOutputUsdt(liveJagentBal, { throwOnRpcError: true });
        const liveSellGuard = evaluateSellQuoteGuard(actualMintCostUsdtWei, liveSellQuoteUsdtWei);
        if (!liveSellGuard.ok) {
          return await stopNow(
            'STOPPED',
            `Step C Sell stopped — ${liveSellGuard.reason ?? 'sell quote is more than 8% below mint cost.'}`,
          );
        }

        // Exact JAGENT approval to PancakeSwap V2 Router if needed (NO unlimited approval)
        if (liveJagentAllowance < liveJagentBal) {
          const nowApprove = Date.now();
          if (sellAttempt <= 2 || nowApprove - lastSellEditAt >= STATUS_THROTTLE_MS) {
            lastSellEditAt = nowApprove;
            await onStatus(
              `⚙️ Step C/E — Approving exact JAGENT balance for PancakeSwap V2 Router${sellAttempt > 1 ? ` (attempt #${sellAttempt})` : ''}…\n` +
              `Est. sell output: ~${Number(ethers.formatUnits(liveSellQuoteUsdtWei, TOKEN_DECIMALS)).toFixed(4)} USDT`,
            );
          }

          const jagentApproveData = buildJagentApproveCalldata(liveJagentBal, ADDR.PANCAKE_ROUTER);
          const jagentApproveSim = await simulateContractCall({
            step: 'sell_approve',
            from: walletAddress,
            to: ADDR.JAGENT_TOKEN,
            data: jagentApproveData,
            value: 0n,
          });

          if (!jagentApproveSim.ok && jagentApproveSim.isRevert) {
            return await stopNow(
              'STOPPED',
              `Step C (JAGENT Approve) simulation failed: ${jagentApproveSim.revertReason ?? jagentApproveSim.error ?? 'reverted'}`,
            );
          }
          if (!jagentApproveSim.ok) {
            throw new Error(`JAGENT approve RPC simulation unavailable: ${jagentApproveSim.error ?? 'transient RPC error'}`);
          }

          const jagentApproveRes = await executeContractCall({
            userId,
            step: 'sell_approve',
            walletAddress,
            to: ADDR.JAGENT_TOKEN,
            inputData: jagentApproveData,
            value: 0n,
            rpcEstimatedGas: jagentApproveSim.estimatedGas,
            fallbackGasLimit: 100_000,
          });
          sellApproveTxHash = jagentApproveRes.txHash;
          txHashes.sell_approve = sellApproveTxHash;

          await onStatus(`⏳ Step C/E — JAGENT Approve submitted (${sellApproveTxHash.slice(0, 10)}…). Waiting for confirmation…`);
          const jagentApproveReceipt = await pollTransactionReceipt(sellApproveTxHash, {
            timeoutMs: 90_000,
            pollIntervalMs: 1_500,
            walletAddress,
            isCancelled: () => isCancelled(userId),
          });

          if (jagentApproveReceipt.state === 'cancelled') {
            return await stopNow('CANCELLED', `Cancelled while waiting for JAGENT approve (${sellApproveTxHash}).`);
          }
          if (jagentApproveReceipt.state === 'reverted') {
            const rev = sellApproveTxHash;
            delete txHashes.sell_approve;
            sellApproveTxHash = '';
            throw new Error(`JAGENT approve TX ${rev.slice(0, 12)}… reverted on-chain (status=0)`);
          }
          if (jagentApproveReceipt.state === 'timeout') {
            throw new Error(`JAGENT approve TX ${sellApproveTxHash.slice(0, 12)}… confirmation timed out — verifying on-chain`);
          }

          await waitForAllowancePropagation(
            () => readJagentAllowance(walletAddress, ADDR.PANCAKE_ROUTER),
            liveJagentBal,
            userId,
          );
        }

        if (isCancelled(userId)) {
          return await stopNow('CANCELLED', 'Cancelled by user before executing JAGENT → USDT swap.');
        }

        // Re-check live sell quote right before swap simulation
        const freshSellQuoteWei = await simulateSellOutputUsdt(liveJagentBal, { throwOnRpcError: true });
        const freshSellGuard = evaluateSellQuoteGuard(actualMintCostUsdtWei, freshSellQuoteWei);
        if (!freshSellGuard.ok) {
          return await stopNow(
            'STOPPED',
            `Step C Sell stopped — ${freshSellGuard.reason ?? 'sell quote dropped more than 8% below mint cost.'}`,
          );
        }

        // 3% MEV slippage protection relative to live PancakeSwap V2 net quote
        const amountOutMin = (freshSellQuoteWei * 97n) / 100n;
        const sellData = buildSellCalldata(liveJagentBal, walletAddress, amountOutMin);

        const nowSell = Date.now();
        if (sellAttempt <= 2 || nowSell - lastSellEditAt >= STATUS_THROTTLE_MS) {
          lastSellEditAt = nowSell;
          await onStatus(
            `⚙️ Step C/E — Selling 100% JAGENT → USDT on PancakeSwap V2${sellAttempt > 1 ? ` (attempt #${sellAttempt})` : ''}…\n` +
            `Live quote: ~${Number(ethers.formatUnits(freshSellQuoteWei, TOKEN_DECIMALS)).toFixed(4)} USDT`,
          );
        }

        const sellSim = await simulateContractCall({
          step: 'sell',
          from: walletAddress,
          to: ADDR.PANCAKE_ROUTER,
          data: sellData,
          value: 0n,
        });

        // Mandatory stop condition: explicit simulation revert
        if (!sellSim.ok && sellSim.isRevert) {
          return await stopNow(
            'STOPPED',
            `Step C (JAGENT → USDT Swap) simulation failed: ${sellSim.revertReason ?? sellSim.error ?? 'reverted'}`,
          );
        }
        if (!sellSim.ok) {
          throw new Error(`Step C sell RPC simulation unavailable: ${sellSim.error ?? 'transient RPC error'}`);
        }

        const sellRes = await executeContractCall({
          userId,
          step: 'sell',
          walletAddress,
          to: ADDR.PANCAKE_ROUTER,
          inputData: sellData,
          value: 0n,
          rpcEstimatedGas: sellSim.estimatedGas,
          fallbackGasLimit: 450_000,
        });
        sellTxHash = sellRes.txHash;
        txHashes.sell = sellTxHash;

        await onStatus(`⏳ Step C/E — Sell TX submitted (${sellTxHash.slice(0, 10)}…). Waiting for BSC confirmation…`);
        const sellReceipt = await pollTransactionReceipt(sellTxHash, {
          timeoutMs: 90_000,
          pollIntervalMs: 1_500,
          walletAddress,
          isCancelled: () => isCancelled(userId),
        });

        if (sellReceipt.state === 'cancelled') {
          return await stopNow('CANCELLED', `Cancelled while waiting for Step C sell receipt (${sellTxHash}).`);
        }
        if (sellReceipt.state === 'reverted') {
          const rev = sellTxHash;
          delete txHashes.sell;
          sellTxHash = '';
          throw new Error(`Step C sell TX ${rev.slice(0, 12)}… reverted on-chain (status=0)`);
        }
        if (sellReceipt.state === 'timeout') {
          throw new Error(`Step C sell TX ${sellTxHash.slice(0, 12)}… confirmation timed out — verifying on-chain`);
        }

        usdtReceivedWei = sellReceipt.usdtReceivedFromLogs;
        if (usdtReceivedWei === 0n) {
          const usdtAfterSell = await readUsdtBalance(walletAddress).catch(() => usdtBeforeSell);
          usdtReceivedWei = usdtAfterSell > usdtBeforeSell ? usdtAfterSell - usdtBeforeSell : 0n;
        }
        trackedSellUsdtWei = usdtReceivedWei;

        logger.info(
          {
            userId,
            step: 'sell',
            attempts: sellAttempt,
            sellTxHash,
            usdtReceived: ethers.formatUnits(usdtReceivedWei, TOKEN_DECIMALS),
          },
          'Step C JAGENT → USDT sell confirmed',
        );
        break;
      } catch (err) {
        const e = err as Error & { isSessionExpired?: boolean };
        if (e?.isSessionExpired) {
          return await stopNow('FAILED', 'Binance Wallet session expired during Step C (Sell). Please reconnect.', {
            isSessionExpired: true,
          });
        }
        if (isHardStopError(err)) {
          return await stopNow('STOPPED', `Step C stopped by mandatory guard: ${summarizeRetryError(err)}`);
        }

        const delayMs = computeRetryDelayMs(sellAttempt);
        const shortErr = summarizeRetryError(err);
        logger.warn(
          { userId, step: 'sell', attempt: sellAttempt, retryDelayMs: delayMs, err: shortErr },
          'Step C sell attempt failed — retrying until confirmed',
        );
        const now = Date.now();
        if (sellAttempt <= 3 || now - lastSellEditAt >= STATUS_THROTTLE_MS) {
          lastSellEditAt = now;
          await onStatus(
            `🔁 Step C/E Sell attempt #${sellAttempt} failed — retrying automatically…\n` +
            `Reason: ${shortErr}\nNext retry in ${(delayMs / 1000).toFixed(1)}s (tap Cancel to stop).`,
          );
        }
        if (await sleepWithCancelCheck(userId, delayMs)) {
          return await stopNow('CANCELLED', `Cancelled by user during Step C sell retries (after ${sellAttempt} attempt(s)).`);
        }
      }
    }

    if (isCancelled(userId)) {
      return await stopNow('CANCELLED', `Cancelled after Step C sell (${sellTxHash}). Note: USDT allowance revoke was not executed.`);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP D — Revoke Leftover USDT Approval for Mint Contract back to 0
    // Continuous retry until confirmed (stops on cancel, expired session, or mandatory guard)
    // ═══════════════════════════════════════════════════════════════════════════
    let revokeTxHash = 'N/A (already 0)';
    let revokeAttempt = 0;
    let lastRevokeEditAt = 0;

    while (true) {
      if (isCancelled(userId)) {
        return await stopNow('CANCELLED', `Cancelled by user during Step D revoke (after ${revokeAttempt} attempt(s)).`);
      }

      try {
        const [leftoverAllowance, liveBnbBal] = await Promise.all([
          readUsdtAllowance(walletAddress, ADDR.MINT_CONTRACT),
          readBnbBalance(walletAddress),
        ]);

        if (leftoverAllowance === 0n) {
          if (revokeAttempt === 0) {
            await onStatus('✅ Step D/E — USDT allowance is already 0 (no revoke needed).');
          } else {
            if (!txHashes.revoke) revokeTxHash = 'confirmed-onchain (0)';
            logger.info({ userId, step: 'revoke_usdt', attempts: revokeAttempt }, 'USDT allowance confirmed 0 on-chain');
          }
          break;
        }

        if (liveBnbBal < MIN_BNB_GAS / 3n) {
          return await stopNow(
            'STOPPED',
            `Insufficient BNB for Step D USDT revoke gas (have ${ethers.formatEther(liveBnbBal)} BNB).`,
          );
        }

        revokeAttempt++;
        const now = Date.now();
        if (revokeAttempt <= 2 || now - lastRevokeEditAt >= STATUS_THROTTLE_MS) {
          lastRevokeEditAt = now;
          await onStatus(
            `⚙️ Step D/E — Revoking leftover USDT approval (${Number(ethers.formatUnits(leftoverAllowance, TOKEN_DECIMALS)).toFixed(4)} USDT → 0)` +
            `${revokeAttempt > 1 ? ` (attempt #${revokeAttempt})` : ''}…`,
          );
        }

        const revokeData = buildUsdtApproveCalldata(0n, ADDR.MINT_CONTRACT);
        const revokeSim = await simulateContractCall({
          step: 'revoke_usdt',
          from: walletAddress,
          to: ADDR.USDT,
          data: revokeData,
          value: 0n,
        });

        if (!revokeSim.ok && revokeSim.isRevert) {
          return await stopNow(
            'STOPPED',
            `Step D (Revoke USDT approval) simulation failed: ${revokeSim.revertReason ?? revokeSim.error ?? 'reverted'}`,
          );
        }
        if (!revokeSim.ok) {
          throw new Error(`Step D revoke RPC simulation unavailable: ${revokeSim.error ?? 'transient RPC error'}`);
        }

        const revokeRes = await executeContractCall({
          userId,
          step: 'revoke_usdt',
          walletAddress,
          to: ADDR.USDT,
          inputData: revokeData,
          value: 0n,
          rpcEstimatedGas: revokeSim.estimatedGas,
          fallbackGasLimit: 90_000,
        });
        revokeTxHash = revokeRes.txHash;
        txHashes.revoke = revokeTxHash;

        await onStatus(`⏳ Step D/E — Revoke TX submitted (${revokeTxHash.slice(0, 10)}…). Waiting for confirmation…`);
        const revokeReceipt = await pollTransactionReceipt(revokeTxHash, {
          timeoutMs: 90_000,
          pollIntervalMs: 1_500,
          walletAddress,
          isCancelled: () => isCancelled(userId),
        });

        if (revokeReceipt.state === 'cancelled') {
          return await stopNow('CANCELLED', `Cancelled while waiting for Step D revoke receipt (${revokeTxHash}).`);
        }
        if (revokeReceipt.state === 'reverted') {
          const rev = revokeTxHash;
          delete txHashes.revoke;
          revokeTxHash = '';
          throw new Error(`Step D revoke TX ${rev.slice(0, 12)}… reverted on-chain (status=0)`);
        }
        if (revokeReceipt.state === 'timeout') {
          throw new Error(`Step D revoke TX ${revokeTxHash.slice(0, 12)}… confirmation timed out — verifying on-chain`);
        }

        logger.info({ userId, step: 'revoke_usdt', attempts: revokeAttempt, revokeTxHash }, 'Step D USDT revoke confirmed');
        break;
      } catch (err) {
        const e = err as Error & { isSessionExpired?: boolean };
        if (e?.isSessionExpired) {
          return await stopNow('FAILED', 'Binance Wallet session expired during Step D (USDT Revoke). Please reconnect.', {
            isSessionExpired: true,
          });
        }
        if (isHardStopError(err)) {
          return await stopNow('STOPPED', `Step D stopped by mandatory guard: ${summarizeRetryError(err)}`);
        }

        const delayMs = computeRetryDelayMs(revokeAttempt);
        const shortErr = summarizeRetryError(err);
        logger.warn(
          { userId, step: 'revoke_usdt', attempt: revokeAttempt, retryDelayMs: delayMs, err: shortErr },
          'Step D revoke attempt failed — retrying until confirmed',
        );
        const now = Date.now();
        if (revokeAttempt <= 3 || now - lastRevokeEditAt >= STATUS_THROTTLE_MS) {
          lastRevokeEditAt = now;
          await onStatus(
            `🔁 Step D/E USDT Revoke attempt #${revokeAttempt} failed — retrying…\n` +
            `Reason: ${shortErr}\nNext retry in ${(delayMs / 1000).toFixed(1)}s (tap Cancel to stop).`,
          );
        }
        if (await sleepWithCancelCheck(userId, delayMs)) {
          return await stopNow('CANCELLED', `Cancelled by user during Step D retries (after ${revokeAttempt} attempt(s)).`);
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP E — Automatic Referral Reward Claim (STRICT MAX 50 ATTEMPTS CAP)
    //
    // Retries ONLY this step up to `CLAIM_MAX_ATTEMPTS` (50) times until the
    // claim tx receipt is confirmed on-chain (`status === 1`) or verified
    // settled via auto-payout / balance delta.
    // - Adaptive backoff (~1.8s–4.5s normal; ~3s–6s on rate limits / transient errors)
    // - Polls any already-submitted `pendingClaimTxHash` before firing another claim
    // - Respects user cancel or expired wallet session immediately
    // - If all 50 attempts do not succeed, does NOT stall or crash — records
    //   50/50 attempts and latest reason cleanly and proceeds to the final summary.
    // ═══════════════════════════════════════════════════════════════════════════
    await onStatus(`⚙️ Step E/E — Checking & claiming referral reward (max ${CLAIM_MAX_ATTEMPTS} attempts)…`);

    let claimTxHash = 'N/A';
    let inviteRewardUsdtStr: string | undefined;
    let claimConfirmed = false;
    let claimAttempts = 0;
    let lastClaimReason = '';
    let lastClaimEditAt = 0;
    let pendingClaimTxHash = '';
    let pendingClaimPaidUsdt: string | undefined;
    let initialPaidUsdt: number | null = null;
    const stepEStartedAt = Date.now();
    const usdtBeforeClaim = await readUsdtBalance(walletAddress).catch(() => null);

    for (let attempt = 1; attempt <= CLAIM_MAX_ATTEMPTS; attempt++) {
      if (isCancelled(userId)) {
        lastClaimReason = `cancelled by user at referral claim attempt ${attempt - 1}/${CLAIM_MAX_ATTEMPTS}`;
        logger.info({ userId, walletAddress, claimAttempts }, 'Step E referral claim stopped due to user cancel');
        break;
      }

      // Respect expired/disconnected wallet session immediately during referral claim retries
      const sessionNow = await isSessionConnectedDb(userId).catch(() => ({ connected: true, address: walletAddress }));
      if (!sessionNow.connected) {
        lastClaimReason = `wallet session disconnected at attempt ${attempt}/${CLAIM_MAX_ATTEMPTS}`;
        logger.warn({ userId, walletAddress, attempt }, 'Step E referral claim stopped — wallet session expired/disconnected');
        break;
      }

      claimAttempts = attempt;
      let attemptRateLimited = false;
      let attemptTransientError = false;

      try {
        // 1. If a previous attempt already submitted a claim TX, poll its receipt first
        //    so we never fire duplicate/conflicting claims or miss an in-flight confirmation.
        if (pendingClaimTxHash) {
          const prevRcpt = await pollTransactionReceipt(pendingClaimTxHash, {
            timeoutMs: 15_000,
            pollIntervalMs: 1_500,
            walletAddress,
            isCancelled: () => isCancelled(userId),
          });
          if (prevRcpt.state === 'confirmed') {
            claimConfirmed = true;
            claimTxHash = pendingClaimTxHash;
            txHashes.claim = pendingClaimTxHash;
            if (prevRcpt.usdtReceivedFromLogs > 0n) {
              trackedInviteRewardWei = prevRcpt.usdtReceivedFromLogs;
              inviteRewardUsdtStr = Number(ethers.formatUnits(prevRcpt.usdtReceivedFromLogs, TOKEN_DECIMALS)).toFixed(4);
            } else if (pendingClaimPaidUsdt) {
              inviteRewardUsdtStr = pendingClaimPaidUsdt;
              try {
                trackedInviteRewardWei = ethers.parseUnits(inviteRewardUsdtStr, TOKEN_DECIMALS);
              } catch { /* ignore parse issue */ }
            }
            logger.info(
              {
                userId,
                walletAddress,
                step: 'claim',
                attempt,
                maxAttempts: CLAIM_MAX_ATTEMPTS,
                claimTxHash,
                paidUsdt: inviteRewardUsdtStr ?? null,
              },
              'Step E previously submitted referral claim TX confirmed on BSC',
            );
            break;
          }
          if (prevRcpt.state === 'cancelled') {
            lastClaimReason = `cancelled while checking claim TX ${pendingClaimTxHash.slice(0, 12)}… (attempt ${attempt}/${CLAIM_MAX_ATTEMPTS})`;
            break;
          }
          if (prevRcpt.state === 'reverted') {
            lastClaimReason = `claim TX ${pendingClaimTxHash.slice(0, 12)}… reverted on-chain (status=0)`;
            pendingClaimTxHash = '';
            pendingClaimPaidUsdt = undefined;
          } else {
            lastClaimReason = `claim TX ${pendingClaimTxHash.slice(0, 12)}… still awaiting BSC confirmation`;
            if (attempt < CLAIM_MAX_ATTEMPTS) {
              const delayMs = computeClaimDelayMs(attempt, { transientError: true });
              const now = Date.now();
              if (attempt <= 2 || now - lastClaimEditAt >= STATUS_THROTTLE_MS) {
                lastClaimEditAt = now;
                await onStatus(
                  `⏳ Step E/E — Checking pending referral claim TX (${pendingClaimTxHash.slice(0, 10)}…, attempt ${attempt}/${CLAIM_MAX_ATTEMPTS})…`,
                );
              }
              if (await sleepWithCancelCheck(userId, delayMs)) {
                lastClaimReason = `cancelled by user during referral claim retry (${attempt}/${CLAIM_MAX_ATTEMPTS})`;
                break;
              }
            }
            continue;
          }
        }

        // 2. Check current invite reward status before firing a claim
        const rewardStatus = await checkInviteRewards(walletAddress);
        if (!rewardStatus.ok) {
          attemptRateLimited = Boolean(rewardStatus.rateLimited);
          attemptTransientError = true;
          lastClaimReason = rewardStatus.error ?? 'invite-rewards API temporarily unavailable';
          logger.warn(
            {
              userId,
              walletAddress,
              attempt,
              maxAttempts: CLAIM_MAX_ATTEMPTS,
              httpStatus: rewardStatus.httpStatus ?? null,
              rateLimited: attemptRateLimited,
              err: lastClaimReason,
            },
            'Step E checkInviteRewards transient/rate-limit error — retrying with adaptive backoff',
          );
        } else {
          if (initialPaidUsdt === null) initialPaidUsdt = rewardStatus.paidUsdt;

          // 2a. Detect confirmed auto-payout or prior-attempt settlement via `recent` list
          if (
            rewardStatus.pendingUsdt === 0 &&
            rewardStatus.recentPayoutForWallet &&
            (rewardStatus.paidUsdt > initialPaidUsdt || rewardStatus.recentPayoutForWallet.at >= stepEStartedAt - 120_000)
          ) {
            const autoHash = rewardStatus.recentPayoutForWallet.hash;
            const autoRcpt = await pollTransactionReceipt(autoHash, {
              timeoutMs: 15_000,
              pollIntervalMs: 1_500,
              walletAddress,
              isCancelled: () => isCancelled(userId),
            });
            if (autoRcpt.state === 'confirmed') {
              claimConfirmed = true;
              claimTxHash = autoHash;
              txHashes.claim = autoHash;
              if (autoRcpt.usdtReceivedFromLogs > 0n) {
                trackedInviteRewardWei = autoRcpt.usdtReceivedFromLogs;
                inviteRewardUsdtStr = Number(ethers.formatUnits(autoRcpt.usdtReceivedFromLogs, TOKEN_DECIMALS)).toFixed(4);
              } else {
                inviteRewardUsdtStr = rewardStatus.recentPayoutForWallet.amountUsdt;
                try {
                  trackedInviteRewardWei = ethers.parseUnits(inviteRewardUsdtStr, TOKEN_DECIMALS);
                } catch { /* ignore */ }
              }
              logger.info(
                { userId, walletAddress, step: 'claim', attempt, maxAttempts: CLAIM_MAX_ATTEMPTS, claimTxHash, paidUsdt: inviteRewardUsdtStr },
                'Step E detected confirmed jager.live auto-payout / settled referral reward',
              );
              break;
            }
            if (autoRcpt.state === 'timeout') {
              // Track this in-flight payout TX hash so next attempt polls it instead of double-claiming
              pendingClaimTxHash = autoHash;
              pendingClaimPaidUsdt = rewardStatus.recentPayoutForWallet.amountUsdt;
              lastClaimReason = `detected in-flight payout TX ${autoHash.slice(0, 12)}… awaiting confirmation`;
            }
          }

          // 2b. Fallback settlement detection: paidUsdt increased + on-chain USDT balance increased
          if (
            !claimConfirmed &&
            !pendingClaimTxHash &&
            rewardStatus.pendingUsdt === 0 &&
            rewardStatus.paidUsdt > initialPaidUsdt &&
            usdtBeforeClaim !== null
          ) {
            const usdtNow = await readUsdtBalance(walletAddress).catch(() => usdtBeforeClaim);
            const deltaWei = usdtNow > usdtBeforeClaim ? usdtNow - usdtBeforeClaim : 0n;
            if (deltaWei > 0n) {
              claimConfirmed = true;
              claimTxHash = 'settled-onchain (auto-payout)';
              txHashes.claim = claimTxHash;
              trackedInviteRewardWei = deltaWei;
              inviteRewardUsdtStr = Number(ethers.formatUnits(deltaWei, TOKEN_DECIMALS)).toFixed(4);
              logger.info(
                {
                  userId,
                  walletAddress,
                  step: 'claim',
                  attempt,
                  maxAttempts: CLAIM_MAX_ATTEMPTS,
                  paidUsdtDelta: rewardStatus.paidUsdt - initialPaidUsdt,
                  onChainUsdtDelta: inviteRewardUsdtStr,
                },
                'Step E verified referral reward settled on-chain via paidUsdt + USDT balance delta',
              );
              break;
            }
          }

          if (rewardStatus.rewardsPaused) {
            lastClaimReason = 'invite rewards payouts paused on jager.live';
            logger.info(
              { userId, walletAddress, attempt, maxAttempts: CLAIM_MAX_ATTEMPTS, reason: lastClaimReason },
              'Step E referral claim attempt — rewards paused',
            );
          } else if (rewardStatus.pendingUsdt > 0) {
            const now = Date.now();
            if (attempt <= 2 || now - lastClaimEditAt >= STATUS_THROTTLE_MS) {
              lastClaimEditAt = now;
              await onStatus(
                `🎁 Step E/E — Claiming ${rewardStatus.pendingUsdt} USDT referral reward (attempt ${attempt}/${CLAIM_MAX_ATTEMPTS})…`,
              );
            }

            const claimRes = await claimInviteRewards(walletAddress);
            if (claimRes.claimed && claimRes.txHash) {
              const candidateHash = claimRes.txHash;
              const candidatePaid = claimRes.paidUsdt ?? rewardStatus.pendingUsdt.toFixed(4);
              pendingClaimTxHash = candidateHash;
              pendingClaimPaidUsdt = candidatePaid;

              await onStatus(
                `⏳ Step E/E — Referral claim TX submitted (${candidateHash.slice(0, 10)}…, attempt ${attempt}/${CLAIM_MAX_ATTEMPTS}). Waiting for receipt…`,
              );

              const claimReceipt = await pollTransactionReceipt(candidateHash, {
                timeoutMs: 45_000,
                pollIntervalMs: 1_500,
                walletAddress,
                isCancelled: () => isCancelled(userId),
              });

              if (claimReceipt.state === 'confirmed') {
                claimConfirmed = true;
                claimTxHash = candidateHash;
                txHashes.claim = candidateHash;
                if (claimReceipt.usdtReceivedFromLogs > 0n) {
                  trackedInviteRewardWei = claimReceipt.usdtReceivedFromLogs;
                  inviteRewardUsdtStr = Number(ethers.formatUnits(claimReceipt.usdtReceivedFromLogs, TOKEN_DECIMALS)).toFixed(4);
                } else {
                  inviteRewardUsdtStr = candidatePaid;
                  try {
                    trackedInviteRewardWei = ethers.parseUnits(inviteRewardUsdtStr, TOKEN_DECIMALS);
                  } catch { /* ignore parse issue */ }
                }

                logger.info(
                  {
                    userId,
                    walletAddress,
                    step: 'claim',
                    attempt,
                    maxAttempts: CLAIM_MAX_ATTEMPTS,
                    claimTxHash,
                    paidUsdt: inviteRewardUsdtStr,
                    blockNumber: claimReceipt.receipt.blockNumber,
                  },
                  'Step E referral reward claim confirmed on BSC',
                );
                break;
              }

              if (claimReceipt.state === 'cancelled') {
                lastClaimReason = `cancelled while waiting for claim TX ${candidateHash.slice(0, 12)}… (attempt ${attempt}/${CLAIM_MAX_ATTEMPTS})`;
                break;
              }

              if (claimReceipt.state === 'timeout') {
                // Keep pendingClaimTxHash set so the next attempt polls this receipt rather than double-claiming
                lastClaimReason = `claim TX ${candidateHash.slice(0, 12)}… receipt timed out (will re-poll)`;
              } else {
                pendingClaimTxHash = '';
                pendingClaimPaidUsdt = undefined;
                lastClaimReason = `claim TX ${candidateHash.slice(0, 12)}… reverted on-chain (status=0)`;
              }
              logger.warn(
                { userId, walletAddress, attempt, maxAttempts: CLAIM_MAX_ATTEMPTS, candidateHash, state: claimReceipt.state },
                'Step E referral claim TX did not confirm — retrying within 50-attempt cap',
              );
            } else {
              attemptRateLimited = Boolean(claimRes.rateLimited || claimRes.isPendingInFlight);
              lastClaimReason = claimRes.reason ?? 'claim endpoint returned not claimed';
              logger.info(
                {
                  userId,
                  walletAddress,
                  attempt,
                  maxAttempts: CLAIM_MAX_ATTEMPTS,
                  pendingUsdt: rewardStatus.pendingUsdt,
                  rateLimited: attemptRateLimited,
                  isPendingInFlight: Boolean(claimRes.isPendingInFlight),
                  reason: lastClaimReason,
                },
                'Step E referral claim attempt did not succeed — retrying within 50-attempt cap',
              );
            }
          } else {
            lastClaimReason = 'no pending referral reward credited yet';
            logger.info(
              { userId, walletAddress, attempt, maxAttempts: CLAIM_MAX_ATTEMPTS, pendingUsdt: rewardStatus.pendingUsdt },
              'Step E referral claim check — pendingUsdt is 0, waiting for indexer within 50-attempt cap',
            );
          }
        }
      } catch (claimErr) {
        const e = claimErr as Error & { isSessionExpired?: boolean };
        if (e?.isSessionExpired) {
          lastClaimReason = `wallet session expired at attempt ${attempt}/${CLAIM_MAX_ATTEMPTS}`;
          logger.warn({ userId, walletAddress, attempt }, 'Step E referral claim aborted — session expired');
          break;
        }
        attemptTransientError = true;
        attemptRateLimited = /429|rate.?limit|too.?many/i.test(String(e?.message ?? ''));
        lastClaimReason = summarizeRetryError(claimErr);
        logger.warn(
          { userId, walletAddress, attempt, maxAttempts: CLAIM_MAX_ATTEMPTS, err: lastClaimReason },
          'Step E referral claim attempt threw error — retrying within 50-attempt cap',
        );
      }

      if (attempt < CLAIM_MAX_ATTEMPTS) {
        const delayMs = computeClaimDelayMs(attempt, {
          rateLimited: attemptRateLimited,
          transientError: attemptTransientError,
        });
        const now = Date.now();
        if (attempt <= 2 || now - lastClaimEditAt >= STATUS_THROTTLE_MS) {
          lastClaimEditAt = now;
          await onStatus(
            `🔁 Step E/E — Referral reward claim attempt ${attempt}/${CLAIM_MAX_ATTEMPTS} pending (${lastClaimReason}).\n` +
            `Retrying in ${(delayMs / 1000).toFixed(1)}s…`,
          );
        }
        const cancelledDuringWait = await sleepWithCancelCheck(userId, delayMs);
        if (cancelledDuringWait) {
          lastClaimReason = `cancelled by user during referral claim retry (${attempt}/${CLAIM_MAX_ATTEMPTS})`;
          break;
        }
      }
    }

    let claimStatusNote: string | undefined;
    if (claimConfirmed) {
      claimStatusNote = `Confirmed on attempt ${claimAttempts}/${CLAIM_MAX_ATTEMPTS}`;
    } else {
      const reasonDetail = lastClaimReason || 'no claimable reward confirmed';
      claimTxHash = `N/A (not confirmed after ${claimAttempts}/${CLAIM_MAX_ATTEMPTS} attempts: ${reasonDetail})`;
      claimStatusNote = `Referral reward claim did not confirm after ${claimAttempts}/${CLAIM_MAX_ATTEMPTS} attempts (${reasonDetail}). Cycle completed without stalling.`;
      logger.warn(
        {
          userId,
          walletAddress,
          step: 'claim',
          claimAttempts,
          maxAttempts: CLAIM_MAX_ATTEMPTS,
          reason: reasonDetail,
        },
        'Step E referral reward claim reached cap/stopped without confirmation — proceeding to final summary',
      );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Final Report & PostgreSQL Persistence
    // ═══════════════════════════════════════════════════════════════════════════
    const mintCostUsdtF   = Number(ethers.formatUnits(actualMintCostUsdtWei, TOKEN_DECIMALS));
    const sellUsdtF       = Number(ethers.formatUnits(usdtReceivedWei, TOKEN_DECIMALS));
    const netLossOrFeeF   = sellUsdtF - mintCostUsdtF;
    const mintCostUsdtStr = mintCostUsdtF.toFixed(4);
    const sellUsdtStr     = sellUsdtF.toFixed(4);
    const netLossOrFeeStr = netLossOrFeeF.toFixed(4);
    const tokensStr       = ethers.formatUnits(soldAmountWei, TOKEN_DECIMALS);

    const dbSummaryNote = !claimConfirmed ? claimStatusNote : undefined;

    const [logRes, summary] = await Promise.all([
      logExecution(
        userId,
        walletAddress,
        'COMPLETED',
        actualMintCostUsdtWei,
        soldAmountWei,
        usdtReceivedWei,
        trackedInviteRewardWei,
        txHashes,
        resolvedAgentId,
        dbSummaryNote,
        claimAttempts,
      ),
      generateExecutionSummary({
        agentId: resolvedAgentId,
        walletAddress,
        mintCostUsdt: mintCostUsdtStr,
        tokensReceived: tokensStr,
        sellUsdt: sellUsdtStr,
        netLossOrFeeUsdt: netLossOrFeeStr,
        inviteRewardUsdt: inviteRewardUsdtStr,
        approveTxHash,
        mintTxHash,
        sellApproveTxHash: sellApproveTxHash || undefined,
        sellTxHash,
        revokeTxHash,
        claimTxHash,
        claimAttempts,
        claimMaxAttempts: CLAIM_MAX_ATTEMPTS,
        claimStatusNote,
        status: 'COMPLETED',
      }),
    ]);

    return {
      ok: true,
      runId: crypto.randomUUID(),
      executionId: logRes.executionId,
      summary,
      agentId: resolvedAgentId,
      walletAddress,
      mintCostUsdt: mintCostUsdtStr,
      tokensReceived: tokensStr,
      sellUsdt: sellUsdtStr,
      netLossOrFeeUsdt: netLossOrFeeStr,
      inviteRewardUsdt: inviteRewardUsdtStr,
      approveTxHash,
      mintTxHash,
      sellApproveTxHash: sellApproveTxHash || undefined,
      sellTxHash,
      revokeTxHash,
      claimTxHash,
      claimAttempts,
      claimStatusNote,
      completedCount: logRes.completedCount,
    };
  } catch (err: unknown) {
    const e = err as Error & { isSessionExpired?: boolean; step?: string };
    const msg = e?.message ?? String(err);
    logger.error({ userId, err: msg, txHashes }, 'JAGER execution failed');
    if (e?.isSessionExpired) {
      return await stopNow(
        'FAILED',
        `Binance Wallet session expired during ${e.step ?? 'execution'}. Please reconnect and try again.`,
        { isSessionExpired: true },
      );
    }
    return await stopNow('FAILED', `Execution failed: ${msg}`);
  } finally {
    activeLocks.delete(userId);
    cancelFlags.delete(userId);
  }
}

// ─── DB Persistence ───────────────────────────────────────────────────────────

async function logExecution(
  userId: number,
  walletAddress: string,
  status: string,
  mintCostUsdtWei: bigint,
  tokensWei: bigint,
  sellUsdtWei: bigint,
  inviteRewardUsdtWei: bigint,
  txHashes: Partial<Record<string, string>>,
  agentId: string,
  summaryNote?: string,
  claimAttempts?: number,
): Promise<{ completedCount: number; executionId: number | null }> {
  const mintCostUsdt = Number(ethers.formatUnits(mintCostUsdtWei, TOKEN_DECIMALS));
  const tokensF      = Number(ethers.formatUnits(tokensWei, TOKEN_DECIMALS));
  const sellUsdtF    = Number(ethers.formatUnits(sellUsdtWei, TOKEN_DECIMALS));
  const pnlUsdt      = sellUsdtF - mintCostUsdt;
  const rewardUsdt   = Number(ethers.formatUnits(inviteRewardUsdtWei, TOKEN_DECIMALS));

  const agentIdName: string | null =
    agentId?.trim() ? agentId.trim()
    : walletAddress?.trim() ? walletAddress.trim()
    : null;

  const mintStr   = mintCostUsdt !== 0 ? mintCostUsdt.toFixed(6) : null;
  const sellStr   = sellUsdtF    !== 0 ? sellUsdtF.toFixed(6)    : null;
  const pnlStr    = pnlUsdt.toFixed(6);
  const rewardStr = rewardUsdt   > 0   ? rewardUsdt.toFixed(6)   : null;

  const execPayload = {
    telegram_user_id:   userId,
    wallet_address:     walletAddress?.trim() || null,
    agent_id_name:      agentIdName,
    mint_contract:      ADDR.MINT_CONTRACT,
    status,
    currency:           'USDT',
    mint_cost_bnb:      mintStr,
    mint_cost_usdt:     mintStr,
    tokens_received:    tokensF !== 0 ? tokensF.toFixed(6) : null,
    sell_bnb:           sellStr,
    sell_usdt:          sellStr,
    pnl_or_fee:         pnlStr,
    pnl_or_fee_usdt:    pnlStr,
    invite_reward_usdt: rewardStr,
    claim_attempts:     claimAttempts ?? null,
    tx_hashes: Object.keys(txHashes).length > 0
      ? (txHashes as Record<string, string>) : null,
    summary: summaryNote ?? null,
  };

  if (status === 'COMPLETED') {
    recordCompletedAgentInMemory({
      mintContract: ADDR.MINT_CONTRACT,
      agentIdName,
      walletAddress,
    });
  }

  try {
    const insertPromise = insertExecution(execPayload);

    if (status === 'COMPLETED') {
      const [executionId, userRes] = await Promise.all([
        insertPromise,
        withDbRetry('incrementCompletedCount', () =>
          pool.query<{ completed_count: number }>(
            `UPDATE users
             SET completed_count = completed_count + 1,
                 current_step    = 'completed',
                 last_active_at  = now()
             WHERE telegram_user_id = $1
             RETURNING completed_count`,
            [userId],
          ),
        ),
      ]);
      return { completedCount: userRes.rows[0]?.completed_count ?? 1, executionId };
    }

    const executionId = await insertPromise;
    return { completedCount: 0, executionId };
  } catch (dbErr) {
    logger.error({ dbErr, userId, status }, 'logExecution: DB write failed after retries — buffering for background flush');
    queueDeferredExecutionWrite(execPayload, status === 'COMPLETED');
    return { completedCount: status === 'COMPLETED' ? 1 : 0, executionId: null };
  }
}
