// src/handlers/execute.ts — Layer 4: JAGER One-Confirm Full Cycle preview, live execution,
// pre-summary BEP-20 payment wallet selection, and HTML one-click-copy admin payout notification.

import crypto from 'crypto';
import { Context } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/types';
import { ethers } from 'ethers';
import {
  isSessionConnectedDb,
  getSession,
  clearSession,
  executeAdminUsdtTransfer,
} from '../wallet.js';
import {
  ADDR,
  REFERRER_NAME,
  TOKEN_DECIMALS,
  normalizeAddress,
  verifyAgentReferrerOnChain,
} from '../bsc.js';
import {
  isUserLocked,
  isPreviewInProgress,
  prepareCyclePreview,
  reserveExecutionFromPreview,
  releaseReservedExecutionLock,
  clearPendingPreview,
  runFullExecution,
  cancelAllNonAdminExecutions,
  ALREADY_COMPLETED_MESSAGE,
  CLAIM_MAX_ATTEMPTS,
  ExecutionSuccess,
} from '../executor.js';
import { generateExecutionSummary } from '../gemini.js';
import {
  safeUpdateUser,
  hasCompletedCycleForAgent,
  updateExecutionPayout,
  resetUserWalletBinding,
  getPendingPayoutExecution,
  getWithdrawAmountUsdt,
  setEmergencyShutdown,
  hasClaimedRewardForAgent,
  reserveRewardClaim,
  finalizeRewardClaim,
  releaseRewardClaimOnSystemFailure,
  PayoutMode,
} from '../db.js';
import {
  enqueueAndDeliverAdminNotifications,
} from '../notifications.js';
import { KB } from '../keyboards.js';
import { config, isAdminId } from '../config.js';
import { logger } from '../logger.js';

const ADMIN_EXEC_BLOCKED_MSG =
  '🛡️ Admin Role Isolation: Admin accounts cannot run regular user tasks, mint cycles, or reward claims.\n\n' +
  'Use /admin to manage the Admin Dashboard, Admin Agent Wallet, and Withdraw Amount.';

async function guardNonAdminUser(ctx: Context): Promise<boolean> {
  const userId = ctx.from?.id;
  if (isAdminId(userId)) {
    await safeAnswerCb(ctx, 'Admin accounts use Admin Dashboard');
    await ctx.reply(ADMIN_EXEC_BLOCKED_MSG, KB.adminMenu);
    return false;
  }
  return true;
}

const TELEGRAM_SAFE_MAX_LEN = 3900;
const BEP20_ADDRESS_REGEX   = /^0x[a-fA-F0-9]{40}$/;

function truncateForTelegram(text: string): string {
  if (text.length <= TELEGRAM_SAFE_MAX_LEN) return text;
  return `${text.slice(0, TELEGRAM_SAFE_MAX_LEN - 16)}\n…(truncated)`;
}

/** Escapes HTML special characters for safe Telegram `parse_mode: 'HTML'` messages. */
export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Strictly validates a BEP-20 (BSC / EVM) wallet address (`/^0x[a-fA-F0-9]{40}$/`),
 * rejects the zero address, and returns the canonical EIP-55 checksummed address.
 */
export function validateBep20Address(raw: string): string | null {
  const trimmed = raw.trim();
  if (!BEP20_ADDRESS_REGEX.test(trimmed)) return null;
  try {
    const normalized = normalizeAddress(trimmed, 'payout.bep20');
    if (normalized === ethers.ZeroAddress) return null;
    return normalized;
  } catch {
    return null;
  }
}

async function safeAnswerCb(ctx: Context, text?: string): Promise<void> {
  try { if (ctx.callbackQuery) await ctx.answerCbQuery(text); } catch { /* ok */ }
}

/**
 * Edits the tracked status message in place, falling back to sending a fresh message
 * if the original message was deleted or cannot be edited (never throws unhandled rejections).
 */
async function safeEditOrSend(
  ctx: Context,
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<void> {
  const safeText = truncateForTelegram(text);
  try {
    await ctx.telegram.editMessageText(chatId, messageId, undefined, safeText, {
      reply_markup: replyMarkup,
    });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err ?? '');
    if (/message is not modified/i.test(msg)) return;
    try {
      await ctx.telegram.sendMessage(chatId, safeText, {
        reply_markup: replyMarkup,
      });
    } catch (sendErr) {
      logger.warn({ err: sendErr, chatId }, 'safeEditOrSend fallback sendMessage failed');
    }
  }
}

// ─── Pre-Summary BEP-20 Payout Wallet & Claim Your Reward State ──────────────

interface PendingPayoutState {
  stage: 'awaiting_wallet' | 'awaiting_claim';
  userId: number;
  chatId: number;
  statusMessageId: number;
  promptMessageId: number | null;
  claimMessageId: number | null;
  userDisplayName: string;
  username: string | null;
  result: ExecutionSuccess;
  selectedPayoutWallet?: string;
  selectedPayoutMode?: PayoutMode;
  createdAt: number;
}

const pendingPayouts = new Map<number, PendingPayoutState>();
const claimInFlightUsers = new Set<number>();

export function isAwaitingPayoutWallet(userId: number): boolean {
  return pendingPayouts.has(userId);
}

export function clearPendingPayout(userId: number): void {
  pendingPayouts.delete(userId);
}

/**
 * Recovers a user's `PendingPayoutState` from PostgreSQL if the bot restarted while
 * the user was on the pre-summary Bangla payout wallet prompt OR the "Claim Your Reward" button.
 */
async function recoverPendingPayoutState(ctx: Context, userId: number): Promise<PendingPayoutState | null> {
  const inMem = pendingPayouts.get(userId);
  if (inMem) return inMem;

  const dbPending = await getPendingPayoutExecution(userId);
  if (!dbPending) return null;

  const e = dbPending.execution;
  const tx = e.tx_hashes ?? {};
  const walletAddr = e.wallet_address ?? e.agent_id_name ?? '';
  if (!walletAddr) return null;

  const mintCostUsdt = e.mint_cost_usdt ?? e.mint_cost_bnb ?? '0';
  const sellUsdt = e.sell_usdt ?? e.sell_bnb ?? '0';
  const netLoss = e.pnl_or_fee_usdt ?? e.pnl_or_fee ?? '0';
  const isClaimStage = dbPending.step === 'awaiting_claim' && Boolean(e.payout_wallet_address);
  const payoutMode: PayoutMode | undefined =
    e.payout_mode === 'AGENT_WALLET_SKIPPED'
      ? 'AGENT_WALLET_SKIPPED'
      : e.payout_wallet_address
        ? 'CUSTOM_BEP20'
        : undefined;

  const recovered: PendingPayoutState = {
    stage: isClaimStage ? 'awaiting_claim' : 'awaiting_wallet',
    userId,
    chatId: ctx.chat?.id ?? userId,
    statusMessageId: ctx.callbackQuery?.message?.message_id ?? 0,
    promptMessageId: isClaimStage ? null : (ctx.callbackQuery?.message?.message_id ?? null),
    claimMessageId: isClaimStage ? (ctx.callbackQuery?.message?.message_id ?? null) : null,
    userDisplayName: ctx.from?.first_name ?? ctx.from?.username ?? String(userId),
    username: ctx.from?.username ?? null,
    selectedPayoutWallet: e.payout_wallet_address ?? undefined,
    selectedPayoutMode: payoutMode,
    result: {
      ok: true,
      runId: crypto.randomUUID(),
      executionId: e.id,
      summary: e.summary ?? '',
      agentId: e.agent_id_name ?? walletAddr,
      walletAddress: walletAddr,
      mintCostUsdt,
      tokensReceived: e.tokens_received ?? '0',
      sellUsdt,
      netLossOrFeeUsdt: netLoss,
      inviteRewardUsdt: e.invite_reward_usdt ?? undefined,
      approveTxHash: tx.approve ?? 'N/A',
      mintTxHash: tx.mint ?? 'N/A',
      sellApproveTxHash: tx.sell_approve,
      sellTxHash: tx.sell ?? 'N/A',
      revokeTxHash: tx.revoke ?? 'N/A',
      claimTxHash: tx.claim ?? 'N/A',
      claimAttempts: e.claim_attempts ?? 0,
      claimStatusNote: e.summary ?? undefined,
      completedCount: dbPending.completedCount,
    },
    createdAt: new Date(e.created_at).getTime(),
  };

  pendingPayouts.set(userId, recovered);
  logger.info(
    { userId, executionId: e.id, agentId: recovered.result.agentId, stage: recovered.stage },
    'Recovered pending payout/claim state from DB after restart',
  );
  return recovered;
}

function buildClaimRewardPromptText(opts: {
  payoutWalletAddress: string;
  payoutMode: PayoutMode;
  amountUsdt: string;
}): string {
  const modeText =
    opts.payoutMode === 'AGENT_WALLET_SKIPPED'
      ? 'Agent Wallet (স্কিপ করা হয়েছে)'
      : 'Custom BEP-20 Wallet (সাবমিট করা ওয়ালেট)';
  return [
    `🎁 Claim Your Reward (BEP-20 USDT)`,
    ``,
    `✅ আপনার পেমেন্ট ওয়ালেট সেট করা হয়েছে:`,
    `• Payout Wallet (BEP-20): ${opts.payoutWalletAddress}`,
    `• Mode: ${modeText}`,
    ``,
    `💵 রিওয়ার্ড অ্যামাউন্ট (Reward Amount): ${opts.amountUsdt} USDT`,
    `🪙 Token: BEP-20 USDT (${ADDR.USDT})`,
    ``,
    `অটো পেমেন্ট পেতে নিচের "🎁 Claim Your Reward" বাটনে ক্লিক করুন।`,
  ].join('\n');
}

function buildPayoutPromptBangla(agentWalletAddress: string): string {
  return [
    `✅ আপনার JAGER ফুল সাইকেলের সব ধাপ সফলভাবে সম্পন্ন হয়েছে!`,
    ``,
    `💳 আপনি কোন ওয়ালেট অ্যাড্রেসে পেমেন্ট নিতে চান?`,
    `অনুগ্রহ করে নিচে আপনার BEP-20 (BSC) ওয়ালেট অ্যাড্রেসটি (0x...) পেস্ট করে পাঠান, অথবা নিচের "স্কিপ" বাটনে ক্লিক করুন।`,
    ``,
    `📌 নোট: আপনি যদি স্কিপ (Skip) করেন, তাহলে আপনার কানেক্ট করা এজেন্ট ওয়ালেটে (Agent Wallet) পেমেন্ট করা হবে:`,
    `${agentWalletAddress}`,
  ].join('\n');
}

function buildInvalidBep20ReplyBangla(): string {
  return [
    `❌ অবৈধ ওয়ালেট অ্যাড্রেস!`,
    ``,
    `শুধুমাত্র বৈধ BEP-20 (BSC) ওয়ালেট অ্যাড্রেস (0x... দিয়ে শুরু, মোট ৪২ অক্ষরের হেক্স অ্যাড্রেস) গ্রহণযোগ্য।`,
    `অনুগ্রহ করে একটি সঠিক BEP-20 অ্যাড্রেস পেস্ট করুন অথবা নিচের স্কিপ (Skip) বাটনে ক্লিক করে আপনার এজেন্ট ওয়ালেটে পেমেন্ট নিন।`,
  ].join('\n');
}

/**
 * Step 1: Triggered by `/mint` or `🚀 Complete All Process`.
 * Runs silent preflight checks (fresh wallet, live jager.live/api/stats price,
 * USDT & BNB balances, Developer Mode ON, PancakeSwap V2 sell quote within 8%)
 * and presents ONE combined preview with `✅ Confirm & Execute Full Cycle` / `❌ Cancel`.
 */
export async function handleCompleteProcess(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  if (!(await guardNonAdminUser(ctx))) return;

  if (isUserLocked(userId)) {
    await safeAnswerCb(ctx, 'Job already running');
    await ctx.reply('⏳ A job is already running. Please wait or tap Cancel.', KB.cancelOnly);
    return;
  }

  const awaitingPayout = await recoverPendingPayoutState(ctx, userId);
  if (awaitingPayout) {
    if (awaitingPayout.stage === 'awaiting_claim' && awaitingPayout.selectedPayoutWallet && awaitingPayout.selectedPayoutMode) {
      const amt = getWithdrawAmountUsdt();
      await safeAnswerCb(ctx, 'রিওয়ার্ড ক্লেইম করুন');
      await ctx.reply(
        buildClaimRewardPromptText({
          payoutWalletAddress: awaitingPayout.selectedPayoutWallet,
          payoutMode: awaitingPayout.selectedPayoutMode,
          amountUsdt: amt,
        }),
        KB.claimReward(amt),
      );
      return;
    }
    await safeAnswerCb(ctx, 'পেমেন্ট ওয়ালেট দিন বা স্কিপ করুন');
    await ctx.reply(buildPayoutPromptBangla(awaitingPayout.result.walletAddress), KB.payoutWalletPrompt);
    return;
  }

  if (isPreviewInProgress(userId)) {
    await safeAnswerCb(ctx, 'Already preparing preview…');
    return;
  }

  await safeAnswerCb(ctx, 'Preparing live preview…');

  // Guard 1: wallet must be connected
  const { connected, address, dbAgentId } = await isSessionConnectedDb(userId);
  if (!connected) {
    await ctx.reply(
      '⚠️ Wallet not connected.\n\n' +
      'Steps:\n1. Tap Connect Your Binance Wallet\n2. Scan the QR code in the Binance app\n' +
      '3. Wait for confirmation, then tap Complete All Process.',
      KB.start,
    );
    return;
  }

  // Guard 2: One-time completed lock strictly scoped to JAGER Mint Contract (Agent ID / Wallet)
  const memSession = getSession(userId);
  const knownAgentId = memSession?.agentIdName ?? dbAgentId ?? null;
  const completedCheck = await hasCompletedCycleForAgent({
    mintContract: ADDR.MINT_CONTRACT,
    agentIdName: knownAgentId,
    walletAddress: address ?? null,
  });
  if (completedCheck.completed) {
    logger.info(
      { userId, mintContract: ADDR.MINT_CONTRACT, matchedBy: completedCheck.matchedBy, knownAgentId, address: address ?? null },
      'Blocked Complete All Process: Agent ID / Wallet already completed JAGER full cycle',
    );
    // Auto-signout completed wallet so user can immediately connect a different .ai wallet
    try { await clearSession(userId); } catch { /* ignore */ }
    try { await resetUserWalletBinding(userId); } catch { /* ignore */ }
    await ctx.reply(
      `${ALREADY_COMPLETED_MESSAGE}\n\n` +
      `🔄 This completed wallet has been signed out automatically. Tap "🔗 Connect Your Binance Wallet" to connect another eligible .ai wallet.`,
      KB.start,
    );
    return;
  }

  const loadingMsg = await ctx.reply(
    '🔍 Running silent preflight checks & fetching live JAGER price from jager.live/api/stats…',
  );
  const chatId    = loadingMsg.chat.id;
  const messageId = loadingMsg.message_id;

  try {
    const previewRes = await prepareCyclePreview(userId);

    if (!previewRes.ok) {
      if (previewRes.alreadyCompleted) {
        try { await clearSession(userId); } catch { /* ignore */ }
        try { await resetUserWalletBinding(userId); } catch { /* ignore */ }
        await safeUpdateUser(userId, { current_step: 'completed' });
        await safeEditOrSend(
          ctx,
          chatId,
          messageId,
          `${ALREADY_COMPLETED_MESSAGE}\n\n🔄 This completed wallet has been signed out automatically. Tap "🔗 Connect Your Binance Wallet" to connect another eligible .ai wallet.`,
          KB.start.reply_markup,
        );
        return;
      }

      if (previewRes.notEligible) {
        try { await clearSession(userId); } catch { /* ignore */ }
        try { await resetUserWalletBinding(userId); } catch { /* ignore */ }
      }

      await safeUpdateUser(userId, { current_step: previewRes.isSessionExpired ? 'connecting' : 'failed' });
      const msg =
        (previewRes.notEligible
          ? `${previewRes.reason}\n\n🔄 Tap "🔗 Connect Your Binance Wallet" to connect a different eligible .ai wallet.`
          : `❌ Preflight stopped\n\n${previewRes.reason}`) +
        (previewRes.isSessionExpired ? '\n\nTap Connect Your Binance Wallet to reconnect.' : '');

      await safeEditOrSend(
        ctx,
        chatId,
        messageId,
        msg,
        (previewRes.isSessionExpired || previewRes.notEligible ? KB.start : KB.postExecution).reply_markup,
      );
      return;
    }

    await safeUpdateUser(userId, { current_step: 'previewing' });
    await safeEditOrSend(ctx, chatId, messageId, previewRes.text, KB.confirmCycle.reply_markup);
  } catch (err) {
    logger.error({ err, userId }, 'handleCompleteProcess preview error');
    await safeEditOrSend(
      ctx,
      chatId,
      messageId,
      `❌ Failed to prepare preview: ${(err as Error)?.message ?? String(err)}`,
      KB.postExecution.reply_markup,
    );
  }
}

/**
 * Cancels only the pending cycle preview without disconnecting the user's wallet.
 */
export async function handleCancelPreview(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  if (!(await guardNonAdminUser(ctx))) return;
  await safeAnswerCb(ctx, 'Preview cancelled');
  clearPendingPreview(userId);
  await safeUpdateUser(userId, { current_step: 'connected' });

  const text = '❌ Full cycle cancelled before execution. Your wallet remains connected.\n\nTap Complete All Process anytime for a fresh live preview.';
  try {
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageText(text, { reply_markup: KB.afterConnect.reply_markup });
      return;
    }
  } catch { /* fall back to reply */ }
  await ctx.reply(text, KB.afterConnect);
}

/**
 * Step 2: Triggered ONCE when user clicks `✅ Confirm & Execute Full Cycle`.
 * Atomically reserves the preview & execution lock BEFORE any await to prevent
 * double-tap races, then runs Steps A → B → C → D → E back-to-back with zero further prompts.
 * Upon completion, pauses before final summary to ask for the user's BEP-20 payout wallet or Skip.
 */
export async function handleConfirmExecuteCycle(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  if (!(await guardNonAdminUser(ctx))) return;

  // Synchronous atomic reservation before any await (prevents double-tap race)
  const reserved = reserveExecutionFromPreview(userId);
  if (!reserved.ok) {
    if (reserved.reason === 'locked') {
      await safeAnswerCb(ctx, 'Already running…');
      await ctx.reply('⏳ Your JAGER full cycle is already running. Please wait or tap Cancel.', KB.cancelOnly);
    } else {
      await safeAnswerCb(ctx, 'Preview expired');
      await ctx.reply(
        '⏰ That preview expired or was already used.\n\nTap Complete All Process to generate a fresh live preview.',
        KB.afterConnect,
      );
    }
    return;
  }

  let chatId: number;
  let messageId: number;

  try {
    await safeAnswerCb(ctx, 'Confirmed! Starting full cycle…');

    const initialText =
      '⚙️ Confirmed! Running JAGER One-Confirm Full Cycle (Steps A → E) back-to-back.\n\n' +
      '🔍 Re-verifying live price & preflight guards…';

    try {
      if (ctx.callbackQuery?.message) {
        chatId = ctx.callbackQuery.message.chat.id;
        messageId = ctx.callbackQuery.message.message_id;
        await ctx.telegram.editMessageText(chatId, messageId, undefined, initialText, {
          reply_markup: KB.cancelOnly.reply_markup,
        });
      } else {
        const m = await ctx.reply(initialText, KB.cancelOnly);
        chatId = m.chat.id;
        messageId = m.message_id;
      }
    } catch {
      const m = await ctx.reply(initialText, KB.cancelOnly);
      chatId = m.chat.id;
      messageId = m.message_id;
    }

    await safeUpdateUser(userId, { current_step: 'executing' });
  } catch (setupErr) {
    releaseReservedExecutionLock(userId);
    logger.error({ err: setupErr, userId }, 'handleConfirmExecuteCycle setup failed before runFullExecution');
    return;
  }

  /** Edits the single live-status message in place (never crashes on Telegram rate/identical errors) */
  const onStatus = async (text: string): Promise<void> => {
    try {
      await ctx.telegram.editMessageText(chatId, messageId, undefined, truncateForTelegram(text), {
        reply_markup: KB.cancelOnly.reply_markup,
      });
    } catch { /* message may already be deleted or identical — ignore */ }
  };

  // Capture user identity before async completion
  const userDisplayName = ctx.from?.first_name ?? ctx.from?.username ?? String(userId);
  const username        = ctx.from?.username ?? null;

  // Run asynchronously so the bot stays responsive to other users & Cancel button
  runFullExecution(userId, onStatus, reserved.preview)
    .then(async (result) => {
      if (result.ok) {
        // 1. Mark user as awaiting payout wallet & send a FRESH Bangla prompt message
        //    (fresh message triggers a real Telegram notification so user sees it immediately,
        //    while also updating the progress message cleanly).
        const payoutState: PendingPayoutState = {
          stage: 'awaiting_wallet',
          userId,
          chatId,
          statusMessageId: messageId,
          promptMessageId: null,
          claimMessageId: null,
          userDisplayName,
          username,
          result,
          createdAt: Date.now(),
        };
        pendingPayouts.set(userId, payoutState);

        const promptText = buildPayoutPromptBangla(result.walletAddress);

        await Promise.all([
          safeUpdateUser(userId, { current_step: 'awaiting_payout_wallet' }),
          // Immediately notify ALL configured admins the moment all steps finish (guaranteed durable queue)
          notifyAdminCompletionImmediate(ctx, payoutState),
          // Update the in-flight status message cleanly (removes Cancel button)
          ctx.telegram
            .editMessageText(
              chatId,
              messageId,
              undefined,
              '✅ JAGER ফুল সাইকেলের সব ধাপ সফলভাবে সম্পন্ন হয়েছে! অনুগ্রহ করে নিচের মেসেজে আপনার পেমেন্ট ওয়ালেট দিন অথবা স্কিপ করুন।',
            )
            .catch(() => {}),
          // Send a brand-new Bangla payout wallet prompt message so the user gets an active alert
          ctx.telegram
            .sendMessage(chatId, promptText, {
              reply_markup: KB.payoutWalletPrompt.reply_markup,
            })
            .then((sent) => {
              payoutState.promptMessageId = sent.message_id;
            })
            .catch(async (sendErr) => {
              logger.warn({ err: sendErr, userId, chatId }, 'Fresh payout prompt sendMessage failed — falling back to status edit');
              await safeEditOrSend(ctx, chatId, messageId, promptText, KB.payoutWalletPrompt.reply_markup);
            }),
        ]);
      } else if (result.alreadyCompleted) {
        await safeUpdateUser(userId, { current_step: 'completed' });
        await safeEditOrSend(ctx, chatId, messageId, ALREADY_COMPLETED_MESSAGE, KB.start.reply_markup);
      } else {
        await safeUpdateUser(userId, { current_step: result.isSessionExpired ? 'connecting' : 'failed' });

        const partialInfo = result.partialTxHashes
          ? Object.entries(result.partialTxHashes).map(([k, v]) => `  • ${k}: ${v}`).join('\n')
          : '';
        const msg =
          `❌ JAGER Cycle Stopped\n\n${result.reason}` +
          (partialInfo ? `\n\nBroadcast TXs:\n${partialInfo}` : '') +
          (result.isSessionExpired ? '\n\nTap Connect Your Binance Wallet to reconnect.' : '');

        await safeEditOrSend(
          ctx,
          chatId,
          messageId,
          msg,
          (result.isSessionExpired ? KB.start : KB.postExecution).reply_markup,
        );
      }
    })
    .catch(async (err: Error) => {
      logger.error({ err, userId }, 'Unexpected error in runFullExecution');
      await safeEditOrSend(
        ctx,
        chatId,
        messageId,
        `❌ Unexpected error: ${err.message}`,
        KB.postExecution.reply_markup,
      );
    });
}

// ─── Pre-Summary BEP-20 Payout & Claim Your Reward Handlers ──────────────────

/**
 * Triggered when user clicks `⏭️ স্কিপ (এজেন্ট ওয়ালেটে পেমেন্ট)`.
 * Saves payout to the user's connected Agent Wallet (`AGENT_WALLET_SKIPPED`)
 * and presents the "🎁 Claim Your Reward (USDT)" step BEFORE final summary.
 */
export async function handleSkipPayoutWallet(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  if (!(await guardNonAdminUser(ctx))) return;

  const state = await recoverPendingPayoutState(ctx, userId);
  if (!state) {
    await safeAnswerCb(ctx, 'ইতিমধ্যে সম্পন্ন হয়েছে');
    return;
  }

  if (state.stage === 'awaiting_claim' && state.selectedPayoutWallet && state.selectedPayoutMode) {
    const amt = getWithdrawAmountUsdt();
    await safeAnswerCb(ctx, 'এখন Claim Your Reward বাটনে ক্লিক করুন');
    await ctx.reply(
      buildClaimRewardPromptText({
        payoutWalletAddress: state.selectedPayoutWallet,
        payoutMode: state.selectedPayoutMode,
        amountUsdt: amt,
      }),
      KB.claimReward(amt),
    );
    return;
  }

  await safeAnswerCb(ctx, 'এজেন্ট ওয়ালেট সিলেক্ট করা হয়েছে');
  await presentClaimRewardStep(ctx, state, state.result.walletAddress, 'AGENT_WALLET_SKIPPED');
}

/**
 * Called at the very top of `handleMessage` before Gemini intent routing.
 * Returns `true` if this user is currently awaiting a payout wallet address
 * OR awaiting the "Claim Your Reward" click (consuming the message cleanly).
 */
export async function handlePayoutWalletInput(ctx: Context, rawText: string): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;

  const state = await recoverPendingPayoutState(ctx, userId);
  if (!state) return false;

  // If wallet is already selected, remind user to tap the Claim Your Reward button
  if (state.stage === 'awaiting_claim' && state.selectedPayoutWallet && state.selectedPayoutMode) {
    const amt = getWithdrawAmountUsdt();
    await ctx.reply(
      buildClaimRewardPromptText({
        payoutWalletAddress: state.selectedPayoutWallet,
        payoutMode: state.selectedPayoutMode,
        amountUsdt: amt,
      }),
      KB.claimReward(amt),
    );
    return true;
  }

  const trimmed = rawText.trim();

  // Allow typing "skip" or "স্কিপ" as an alias for the Skip button
  if (/^(skip|স্কিপ)$/i.test(trimmed)) {
    await presentClaimRewardStep(ctx, state, state.result.walletAddress, 'AGENT_WALLET_SKIPPED');
    return true;
  }

  // Strict BEP-20 (BSC / EVM) address validation
  const validatedAddress = validateBep20Address(trimmed);
  if (!validatedAddress) {
    await ctx.reply(buildInvalidBep20ReplyBangla(), KB.payoutWalletPrompt);
    return true;
  }

  await presentClaimRewardStep(ctx, state, validatedAddress, 'CUSTOM_BEP20');
  return true;
}

/**
 * Persists the chosen BEP-20 payout address & mode and displays the
 * "🎁 Claim Your Reward ($X.XX USDT)" confirmation button before auto-payment & final summary.
 */
async function presentClaimRewardStep(
  ctx: Context,
  state: PendingPayoutState,
  payoutWalletAddress: string,
  payoutMode: PayoutMode,
): Promise<void> {
  const r = state.result;
  const amountUsdt = getWithdrawAmountUsdt();

  state.stage = 'awaiting_claim';
  state.selectedPayoutWallet = payoutWalletAddress;
  state.selectedPayoutMode = payoutMode;
  pendingPayouts.set(state.userId, state);

  await Promise.all([
    updateExecutionPayout(r.executionId, payoutWalletAddress, payoutMode, {
      telegramUserId: state.userId,
      walletAddress: r.walletAddress,
      sellTxHash: r.sellTxHash,
    }),
    safeUpdateUser(state.userId, { current_step: 'awaiting_claim' }),
  ]);

  const claimPromptText = buildClaimRewardPromptText({
    payoutWalletAddress,
    payoutMode,
    amountUsdt,
  });

  const promptMsgToClear = state.promptMessageId ?? state.statusMessageId;
  if (ctx.callbackQuery && promptMsgToClear > 0) {
    await safeEditOrSend(
      ctx,
      state.chatId,
      promptMsgToClear,
      claimPromptText,
      KB.claimReward(amountUsdt).reply_markup,
    );
    state.claimMessageId = promptMsgToClear;
  } else {
    const sent = await ctx.reply(claimPromptText, KB.claimReward(amountUsdt));
    state.claimMessageId = sent.message_id;
    if (promptMsgToClear > 0) {
      ctx.telegram.editMessageReplyMarkup(state.chatId, promptMsgToClear, undefined, undefined).catch(() => {});
    }
  }
}

/**
 * Triggered when user clicks `🎁 Claim Your Reward ($X.XX USDT)`:
 *   1. Enforces strict anti-abuse lock: same Agent ID or same Agent Wallet can NEVER
 *      be claimed/paid more than once (while allowing unlimited distinct Agent IDs per BEP-20 wallet).
 *   2. Runs strict on-chain + account-state referral verification confirming the Agent ID / Wallet
 *      worked under our hardcoded referrer (`noyonislam.ai` / `0x85377229b28515432cCF1e1c4999BB71C9AdBE11`).
 *      - On mismatch/failure → blocks auto-payout, tells user in Bangla manual payment requested,
 *        sends fast final summary, and alerts admins titled **`রিভিউ টু পেমেন্ট`**.
 *   3. Checks Admin Agent Wallet health & executes real BEP-20 USDT (`0x55d398...`) transfer on BSC:
 *      - On Admin Agent Wallet disconnect / expired session / low USDT / low BNB / transfer failure →
 *        tells user *"অটো পেমেন্ট সিস্টেম একটু ঝামেলা হয়েছে, ১০ মিনিট অপেক্ষা করুন।"*, activates
 *        Emergency Auto-Shutdown (*"কিছু যান্ত্রিক ত্রুটির কারণে সমস্যা হচ্ছে, বটটা আপডেট হচ্ছে।"*),
 *        and sends urgent strict alert to admins!
 *      - On success → marks `reward_claims` PAID, delivers fast final summary to user, and sends
 *        guaranteed HTML admin alert with copyable `<code>0x...</code>`, USDT claimed, and PAID status!
 */
export async function handleClaimReward(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  if (!(await guardNonAdminUser(ctx))) return;

  if (claimInFlightUsers.has(userId)) {
    await safeAnswerCb(ctx, 'আপনার রিওয়ার্ড প্রসেস হচ্ছে…');
    return;
  }

  const state = await recoverPendingPayoutState(ctx, userId);
  if (!state || !state.selectedPayoutWallet || !state.selectedPayoutMode) {
    await safeAnswerCb(ctx, 'ইতিমধ্যে ক্লেইম করা হয়েছে');
    return;
  }

  claimInFlightUsers.add(userId);
  await safeAnswerCb(ctx, 'রিওয়ার্ড যাচাই ও পেমেন্ট প্রসেস হচ্ছে…');

  const r = state.result;
  const payoutWalletAddress = state.selectedPayoutWallet;
  const payoutMode = state.selectedPayoutMode;
  const skippedToAgentWallet = payoutMode === 'AGENT_WALLET_SKIPPED';
  const amountUsdt = getWithdrawAmountUsdt();
  const claimMsgId = state.claimMessageId ?? ctx.callbackQuery?.message?.message_id ?? state.statusMessageId;

  let claimId: number | null = null;
  let lockReserved = false;
  let claimFinalized = false;
  let txBroadcasted = false;

  try {
    // 1. Strict Anti-Abuse Lock: check & atomically reserve (per Agent ID & per Agent Wallet ONLY)
    const priorClaim = await hasClaimedRewardForAgent({
      agentIdName: r.agentId,
      agentWalletAddress: r.walletAddress,
    });
    if (priorClaim.claimed) {
      pendingPayouts.delete(userId);
      await safeUpdateUser(userId, { current_step: 'completed' });
      const dupMsg =
        `⛔ এই Agent ID (${r.agentId}) / Agent Wallet এর জন্য ইতিমধ্যেই রিওয়ার্ড ক্লেইম/পেমেন্ট সম্পন্ন হয়েছে।\n` +
        `(একই Agent ID বা Agent Wallet দিয়ে একাধিকবার রিওয়ার্ড ক্লেইম করা যাবে না। নতুন .ai Agent ID কানেক্ট করে কাজ করলে আবার পেমেন্ট পাবেন।)`;
      if (claimMsgId > 0) {
        await safeEditOrSend(ctx, state.chatId, claimMsgId, dupMsg, KB.postExecution.reply_markup);
      } else {
        await ctx.reply(dupMsg, KB.postExecution);
      }
      return;
    }

    const reservation = await reserveRewardClaim({
      executionId: r.executionId,
      telegramUserId: userId,
      agentIdName: r.agentId,
      agentWalletAddress: r.walletAddress,
      payoutWalletAddress,
      payoutMode,
      amountUsdt,
    });

    if (!reservation.reserved) {
      pendingPayouts.delete(userId);
      await safeUpdateUser(userId, { current_step: 'completed' });
      const blockedMsg =
        `⛔ এই Agent ID (${r.agentId}) / Agent Wallet এর রিওয়ার্ড ক্লেইম ইতিমধ্যেই লক/সম্পন্ন হয়েছে।`;
      if (claimMsgId > 0) {
        await safeEditOrSend(ctx, state.chatId, claimMsgId, blockedMsg, KB.postExecution.reply_markup);
      } else {
        await ctx.reply(blockedMsg, KB.postExecution);
      }
      return;
    }

    claimId = reservation.claimId;
    lockReserved = true;

    if (claimMsgId > 0) {
      await safeEditOrSend(
        ctx,
        state.chatId,
        claimMsgId,
        `🔍 আপনার রেফারেল (${REFERRER_NAME}) যাচাই এবং ${amountUsdt} USDT (BEP-20) অটো পেমেন্ট প্রসেস হচ্ছে… অনুগ্রহ করে কয়েক সেকেন্ড অপেক্ষা করুন।`,
      );
    }

    // 2. Strict On-Chain & Account-State Referral Verification (both custom BEP-20 & skipped Agent Wallet)
    const refCheck = await verifyAgentReferrerOnChain({
      agentWalletAddress: r.walletAddress,
      agentIdName: r.agentId,
      mintTxHash: r.mintTxHash,
    });

    if (!refCheck.verified) {
      const failReason = refCheck.reason ?? `Agent ID / Wallet could not be verified under referrer ${REFERRER_NAME} (${ADDR.REFERRER}).`;
      logger.warn(
        {
          userId,
          executionId: r.executionId,
          agentId: r.agentId,
          agentWallet: r.walletAddress,
          payoutWalletAddress,
          payoutMode,
          failReason,
        },
        'Strict referral verification FAILED — blocking auto-payout and routing to Manual Review (রিভিউ টু পেমেন্ট)',
      );

      pendingPayouts.delete(userId);
      claimFinalized = true;
      await Promise.all([
        finalizeRewardClaim({
          claimId,
          executionId: r.executionId,
          status: 'MANUAL_REVIEW',
          referralVerified: false,
          amountUsdt,
          failureReason: failReason,
          agentIdName: r.agentId,
          agentWalletAddress: r.walletAddress,
        }),
        safeUpdateUser(userId, { current_step: 'completed' }),
      ]);

      const finalSummary = await generateExecutionSummary({
        agentId: r.agentId,
        walletAddress: r.walletAddress,
        mintCostUsdt: r.mintCostUsdt,
        tokensReceived: r.tokensReceived,
        sellUsdt: r.sellUsdt,
        netLossOrFeeUsdt: r.netLossOrFeeUsdt,
        inviteRewardUsdt: r.inviteRewardUsdt,
        approveTxHash: r.approveTxHash,
        mintTxHash: r.mintTxHash,
        sellApproveTxHash: r.sellApproveTxHash,
        sellTxHash: r.sellTxHash,
        revokeTxHash: r.revokeTxHash,
        claimTxHash: r.claimTxHash,
        claimAttempts: r.claimAttempts,
        claimMaxAttempts: CLAIM_MAX_ATTEMPTS,
        claimStatusNote: r.claimStatusNote,
        payoutWalletAddress,
        payoutMode,
        skippedToAgentWallet,
        rewardClaimAmountUsdt: amountUsdt,
        rewardClaimStatus: 'MANUAL_REVIEW',
        status: 'COMPLETED',
      });

      const userNotice =
        `⚠️ আপনার ক্লেইম / রেফারেল ভেরিফিকেশনে একটি সমস্যা দেখা দিয়েছে।\n` +
        `আপনার পেমেন্টটি ম্যানুয়াল পেমেন্টের (Manual Payment) জন্য অ্যাডমিনের কাছে পাঠানো হয়েছে। অ্যাডমিন যাচাই করে আপনাকে পেমেন্ট করে দেবেন।\n\n` +
        `${finalSummary}`;

      await Promise.all([
        claimMsgId > 0
          ? safeEditOrSend(ctx, state.chatId, claimMsgId, userNotice, KB.postExecution.reply_markup)
          : ctx.reply(truncateForTelegram(userNotice), KB.postExecution),
        notifyAdminManualReview(ctx, state, {
          payoutWalletAddress,
          payoutMode,
          skippedToAgentWallet,
          amountUsdt,
          failureReason: failReason,
        }),
      ]);
      return;
    }

    // 3. Execute Real BEP-20 USDT Auto-Payment from Connected Admin Agent Wallet
    //    Passes exact canonical decimal string so executeAdminUsdtTransfer scales with verified on-chain decimals.
    const transferRes = await executeAdminUsdtTransfer(payoutWalletAddress, amountUsdt);

    if (!transferRes.ok) {
      txBroadcasted = transferRes.txBroadcasted;
      logger.error(
        {
          userId,
          executionId: r.executionId,
          failureCode: transferRes.failureCode,
          reason: transferRes.reason,
          txBroadcasted: transferRes.txBroadcasted,
          txHash: transferRes.txHash ?? null,
          adminWalletAddress: transferRes.adminWalletAddress,
          payoutWalletAddress,
          amountUsdt,
        },
        'Admin Agent Wallet auto-payment did not confirm cleanly',
      );

      if (transferRes.txBroadcasted) {
        // CRITICAL DOUBLE-SPEND PROTECTION: TX was already broadcast to BSC!
        // Keep the anti-abuse lock PERMANENTLY engaged as MANUAL_REVIEW so the user can NEVER double-claim.
        pendingPayouts.delete(userId);
        claimFinalized = true;
        await Promise.all([
          finalizeRewardClaim({
            claimId,
            executionId: r.executionId,
            status: 'MANUAL_REVIEW',
            referralVerified: true,
            amountUsdt,
            payoutTxHash: transferRes.txHash ?? null,
            failureReason: transferRes.reason,
            agentIdName: r.agentId,
            agentWalletAddress: r.walletAddress,
          }),
          safeUpdateUser(userId, { current_step: 'completed' }),
        ]);

        const finalSummary = await generateExecutionSummary({
          agentId: r.agentId,
          walletAddress: r.walletAddress,
          mintCostUsdt: r.mintCostUsdt,
          tokensReceived: r.tokensReceived,
          sellUsdt: r.sellUsdt,
          netLossOrFeeUsdt: r.netLossOrFeeUsdt,
          inviteRewardUsdt: r.inviteRewardUsdt,
          approveTxHash: r.approveTxHash,
          mintTxHash: r.mintTxHash,
          sellApproveTxHash: r.sellApproveTxHash,
          sellTxHash: r.sellTxHash,
          revokeTxHash: r.revokeTxHash,
          claimTxHash: r.claimTxHash,
          claimAttempts: r.claimAttempts,
          claimMaxAttempts: CLAIM_MAX_ATTEMPTS,
          claimStatusNote: r.claimStatusNote,
          payoutWalletAddress,
          payoutMode,
          skippedToAgentWallet,
          rewardClaimAmountUsdt: amountUsdt,
          rewardClaimStatus: 'MANUAL_REVIEW',
          rewardClaimTxHash: transferRes.txHash,
          status: 'COMPLETED',
        });

        const timeoutNotice =
          `⚠️ আপনার পেমেন্ট ট্রানজেকশনটি ব্লকচেইনে পাঠানো হয়েছে, কিন্তু কনফার্মেশন ভেরিফিকেশনে দেরি হচ্ছে। আপনার পেমেন্টটি ম্যানুয়াল রিভিউর জন্য অ্যাডমিনের কাছে পাঠানো হয়েছে।\n\n` +
          `${finalSummary}`;

        await Promise.all([
          claimMsgId > 0
            ? safeEditOrSend(ctx, state.chatId, claimMsgId, timeoutNotice, KB.postExecution.reply_markup)
            : ctx.reply(truncateForTelegram(timeoutNotice), KB.postExecution),
          notifyAdminManualReview(ctx, state, {
            payoutWalletAddress,
            payoutMode,
            skippedToAgentWallet,
            amountUsdt,
            failureReason: transferRes.reason,
          }),
        ]);
        return;
      }

      // Pre-broadcast failure (or on-chain revert with 0 USDT moved): safe to release claim lock
      claimFinalized = true;
      await releaseRewardClaimOnSystemFailure({
        claimId,
        executionId: r.executionId,
        amountUsdt,
        failureReason: transferRes.reason,
        agentIdName: r.agentId,
        agentWalletAddress: r.walletAddress,
      });

      // Immediately activate Emergency Auto-Shutdown & cancel running non-admin executions
      const cancelledJobs = cancelAllNonAdminExecutions();
      await setEmergencyShutdown(true, `[${transferRes.failureCode}] ${transferRes.reason}`);

      const userTroubleMsg = '⚠️ অটো পেমেন্ট সিস্টেম একটু ঝামেলা হয়েছে, ১০ মিনিট অপেক্ষা করুন।';
      await Promise.all([
        claimMsgId > 0
          ? safeEditOrSend(ctx, state.chatId, claimMsgId, userTroubleMsg)
          : ctx.reply(userTroubleMsg),
        notifyAdminEmergencyShutdown(ctx, state, {
          payoutWalletAddress,
          payoutMode,
          amountUsdt,
          failureCode: transferRes.failureCode,
          failureReason: transferRes.reason,
          adminWalletAddress: transferRes.adminWalletAddress,
          usdtBalanceWei: transferRes.usdtBalanceWei,
          bnbBalanceWei: transferRes.bnbBalanceWei,
          cancelledJobs,
        }),
      ]);
      return;
    }

    // 4. Auto-Payment CONFIRMED on BSC — finalize DB, deliver fast final summary, and notify admins!
    pendingPayouts.delete(userId);
    claimFinalized = true;
    const [, , finalSummary] = await Promise.all([
      finalizeRewardClaim({
        claimId,
        executionId: r.executionId,
        status: 'PAID',
        referralVerified: true,
        amountUsdt,
        payoutTxHash: transferRes.txHash,
        agentIdName: r.agentId,
        agentWalletAddress: r.walletAddress,
      }),
      safeUpdateUser(userId, { current_step: 'completed' }),
      generateExecutionSummary({
        agentId: r.agentId,
        walletAddress: r.walletAddress,
        mintCostUsdt: r.mintCostUsdt,
        tokensReceived: r.tokensReceived,
        sellUsdt: r.sellUsdt,
        netLossOrFeeUsdt: r.netLossOrFeeUsdt,
        inviteRewardUsdt: r.inviteRewardUsdt,
        approveTxHash: r.approveTxHash,
        mintTxHash: r.mintTxHash,
        sellApproveTxHash: r.sellApproveTxHash,
        sellTxHash: r.sellTxHash,
        revokeTxHash: r.revokeTxHash,
        claimTxHash: r.claimTxHash,
        claimAttempts: r.claimAttempts,
        claimMaxAttempts: CLAIM_MAX_ATTEMPTS,
        claimStatusNote: r.claimStatusNote,
        payoutWalletAddress,
        payoutMode,
        skippedToAgentWallet,
        rewardClaimAmountUsdt: amountUsdt,
        rewardClaimStatus: 'PAID',
        rewardClaimTxHash: transferRes.txHash,
        status: 'COMPLETED',
      }),
    ]);

    await Promise.all([
      claimMsgId > 0
        ? safeEditOrSend(ctx, state.chatId, claimMsgId, finalSummary, KB.postExecution.reply_markup)
        : ctx.reply(truncateForTelegram(finalSummary), KB.postExecution),
      notifyAdminPayout(ctx, state, {
        payoutWalletAddress,
        payoutMode,
        skippedToAgentWallet,
        amountUsdt,
        claimStatus: 'PAID',
        payoutTxHash: transferRes.txHash,
      }),
    ]);
  } catch (err) {
    const errMsg = (err as Error)?.message ?? String(err);
    logger.error({ err: errMsg, userId, lockReserved, claimFinalized, txBroadcasted }, 'Unexpected error in handleClaimReward');

    // Never leak a PROCESSING lock if an unexpected exception occurs before broadcast
    if (lockReserved && !claimFinalized && !txBroadcasted) {
      await releaseRewardClaimOnSystemFailure({
        claimId,
        executionId: r.executionId,
        amountUsdt,
        failureReason: `Unexpected claim handler error: ${errMsg.slice(0, 220)}`,
        agentIdName: r.agentId,
        agentWalletAddress: r.walletAddress,
      }).catch(() => {});
    }

    await ctx.reply(
      '⚠️ অটো পেমেন্ট সিস্টেম একটু ঝামেলা হয়েছে, ১০ মিনিট অপেক্ষা করুন।',
    );
  } finally {
    claimInFlightUsers.delete(userId);
  }
}

/**
 * Formats an HTML-safe immediate admin completion notification sent the instant
 * all required cycle steps finish (`COMPLETED`), BEFORE waiting for the user to
 * paste a payout wallet or tap Skip.
 */
export function buildAdminCompletionImmediateHtmlMessage(opts: {
  userId: number;
  userDisplayName: string;
  username: string | null;
  result: ExecutionSuccess;
}): string {
  const { userId, userDisplayName, username, result } = opts;
  const userTag = username ? `${escapeHtml(userDisplayName)} (@${escapeHtml(username)})` : escapeHtml(userDisplayName);

  const lines = [
    `<b>🎉 JAGER Full Cycle Completed (Immediate Alert)</b>`,
    ``,
    `<b>👤 User:</b> ${userTag} (ID: <code>${userId}</code>)`,
    `<b>🤖 Agent ID:</b> <code>${escapeHtml(result.agentId)}</code>`,
    `<b>💳 Connected Agent Wallet (tap to copy):</b>`,
    `<code>${escapeHtml(result.walletAddress)}</code>`,
    `<b>⏳ Payout Wallet Status:</b> Awaiting user BEP-20 address or Skip (follow-up alert will arrive automatically)`,
    ``,
    `<b>📊 Cycle Summary:</b>`,
    `• Mint Cost: ${escapeHtml(result.mintCostUsdt)} USDT`,
    `• Sell Received: ${escapeHtml(result.sellUsdt)} USDT`,
    `• Net Loss / Fees: ${escapeHtml(result.netLossOrFeeUsdt)} USDT`,
    ...(result.inviteRewardUsdt ? [`• Invite Reward: +${escapeHtml(result.inviteRewardUsdt)} USDT`] : []),
    `• Claim Attempts: ${result.claimAttempts}/${CLAIM_MAX_ATTEMPTS}` +
      (result.claimStatusNote ? ` (${escapeHtml(result.claimStatusNote)})` : ''),
    ``,
    `<b>🔗 TX Hashes:</b>`,
    `• approve: <code>${escapeHtml(result.approveTxHash)}</code>`,
    `• mint: <code>${escapeHtml(result.mintTxHash)}</code>`,
    ...(result.sellApproveTxHash ? [`• sell_approve: <code>${escapeHtml(result.sellApproveTxHash)}</code>`] : []),
    `• sell: <code>${escapeHtml(result.sellTxHash)}</code>`,
    `• revoke: <code>${escapeHtml(result.revokeTxHash)}</code>`,
    `• claim: <code>${escapeHtml(result.claimTxHash)}</code>`,
    ``,
    `<b>Total completed by user:</b> ${result.completedCount}`,
  ];

  return truncateForTelegram(lines.join('\n'));
}

async function notifyAdminCompletionImmediate(
  ctx: Context,
  state: PendingPayoutState,
): Promise<void> {
  const r = state.result;
  const htmlText = buildAdminCompletionImmediateHtmlMessage({
    userId: state.userId,
    userDisplayName: state.userDisplayName,
    username: state.username,
    result: r,
  });

  const plainFallback =
    `🎉 JAGER Full Cycle Completed (Immediate Alert)\n\n` +
    `User: ${state.userDisplayName}${state.username ? ` (@${state.username})` : ''} (ID: ${state.userId})\n` +
    `Agent ID: ${r.agentId}\n` +
    `Agent Wallet: ${r.walletAddress}\n` +
    `Payout Wallet Status: Awaiting user BEP-20 address or Skip\n` +
    `Mint: ${r.mintCostUsdt} USDT | Sell: ${r.sellUsdt} USDT | Net: ${r.netLossOrFeeUsdt} USDT\n` +
    `Claim Attempts: ${r.claimAttempts}/${CLAIM_MAX_ATTEMPTS}\n` +
    `TXs: approve=${r.approveTxHash} | mint=${r.mintTxHash} | sell=${r.sellTxHash} | revoke=${r.revokeTxHash} | claim=${r.claimTxHash}`;

  const anchor = r.executionId != null
    ? `exec_${r.executionId}`
    : `run_${r.runId}`;

  const structuredPayload: Record<string, unknown> = {
    event: 'CYCLE_COMPLETED_IMMEDIATE',
    telegramUserId: state.userId,
    userDisplayName: state.userDisplayName,
    username: state.username,
    agentId: r.agentId,
    agentWalletAddress: r.walletAddress,
    payoutStatus: 'AWAITING_USER_SELECTION',
    mintCostUsdt: r.mintCostUsdt,
    sellUsdt: r.sellUsdt,
    netLossOrFeeUsdt: r.netLossOrFeeUsdt,
    inviteRewardUsdt: r.inviteRewardUsdt ?? null,
    claimAttempts: r.claimAttempts,
    claimMaxAttempts: CLAIM_MAX_ATTEMPTS,
    claimStatusNote: r.claimStatusNote ?? null,
    txHashes: {
      approve: r.approveTxHash,
      mint: r.mintTxHash,
      ...(r.sellApproveTxHash ? { sell_approve: r.sellApproveTxHash } : {}),
      sell: r.sellTxHash,
      revoke: r.revokeTxHash,
      claim: r.claimTxHash,
    },
    completedCount: r.completedCount,
  };

  try {
    await enqueueAndDeliverAdminNotifications(
      ctx.telegram,
      config.ADMIN_IDS.map((adminId) => ({
        dedupeKey: `jager_complete:${anchor}:${adminId}`,
        adminId,
        telegramUserId: state.userId,
        executionId: r.executionId,
        htmlMessage: htmlText,
        plainMessage: plainFallback,
        payload: structuredPayload,
      })),
    );
  } catch (err) {
    logger.error(
      { err: (err as Error)?.message, userId: state.userId, executionId: r.executionId, anchor },
      'notifyAdminCompletionImmediate unexpected error (background worker will continue retrying)',
    );
  }
}

/**
 * Formats an HTML-safe admin payout/claim notification showing user info,
 * one-click copyable `<code>0x...</code>` wallet address, how much BEP-20 USDT
 * the user claimed, and whether the auto-payment succeeded or failed.
 */
export function buildAdminPayoutHtmlMessage(opts: {
  userId: number;
  userDisplayName: string;
  username: string | null;
  result: ExecutionSuccess;
  payoutWalletAddress: string;
  payoutMode: PayoutMode;
  skippedToAgentWallet: boolean;
  amountUsdt?: string;
  claimStatus?: 'PAID' | 'FAILED_SYSTEM' | 'MANUAL_REVIEW';
  payoutTxHash?: string;
}): string {
  const {
    userId,
    userDisplayName,
    username,
    result,
    payoutWalletAddress,
    payoutMode,
    skippedToAgentWallet,
    amountUsdt,
    claimStatus = 'PAID',
    payoutTxHash,
  } = opts;
  const userTag = username ? `${escapeHtml(userDisplayName)} (@${escapeHtml(username)})` : escapeHtml(userDisplayName);
  const modeDisplay = skippedToAgentWallet
    ? '⏭️ Skipped → Agent Wallet (<code>AGENT_WALLET_SKIPPED</code>)'
    : '✅ Custom BEP-20 Submitted (<code>CUSTOM_BEP20</code>)';
  const statusDisplay =
    claimStatus === 'PAID'
      ? '✅ <b>SUCCEEDED (BEP-20 USDT Auto-Paid)</b>'
      : claimStatus === 'MANUAL_REVIEW'
        ? '⚠️ <b>রিভিউ টু পেমেন্ট (Manual Review)</b>'
        : '❌ <b>FAILED (Auto-Payment System Error)</b>';

  const lines = [
    `<b>✅ JAGER Claim &amp; Auto-Payment Report</b>`,
    ``,
    `<b>👤 User:</b> ${userTag} (ID: <code>${userId}</code>)`,
    `<b>🤖 Agent ID:</b> <code>${escapeHtml(result.agentId)}</code>`,
    `<b>💳 Agent Wallet:</b> <code>${escapeHtml(result.walletAddress)}</code>`,
    ``,
    `<b>💸 Payout Mode:</b> ${modeDisplay}`,
    `<b>📋 Payout Address (BEP-20 — tap to copy):</b>`,
    `<code>${escapeHtml(payoutWalletAddress)}</code>`,
    `<b>💵 Claimed Reward Amount:</b> <b>${escapeHtml(amountUsdt ?? getWithdrawAmountUsdt())} USDT</b> (BEP-20)`,
    `<b>📌 Claim / Payment Status:</b> ${statusDisplay}`,
    ...(payoutTxHash ? [`<b>🔗 Auto-Payout TX:</b> <code>${escapeHtml(payoutTxHash)}</code>`] : []),
    ``,
    `<b>📊 Cycle Summary:</b>`,
    `• Mint Cost: ${escapeHtml(result.mintCostUsdt)} USDT`,
    `• Sell Received: ${escapeHtml(result.sellUsdt)} USDT`,
    `• Net Loss / Fees: ${escapeHtml(result.netLossOrFeeUsdt)} USDT`,
    ...(result.inviteRewardUsdt ? [`• Invite Reward: +${escapeHtml(result.inviteRewardUsdt)} USDT`] : []),
    `• Claim Attempts: ${result.claimAttempts}/${CLAIM_MAX_ATTEMPTS}` +
      (result.claimStatusNote ? ` (${escapeHtml(result.claimStatusNote)})` : ''),
    ``,
    `<b>🔗 Cycle TX Hashes:</b>`,
    `• approve: <code>${escapeHtml(result.approveTxHash)}</code>`,
    `• mint: <code>${escapeHtml(result.mintTxHash)}</code>`,
    ...(result.sellApproveTxHash ? [`• sell_approve: <code>${escapeHtml(result.sellApproveTxHash)}</code>`] : []),
    `• sell: <code>${escapeHtml(result.sellTxHash)}</code>`,
    `• revoke: <code>${escapeHtml(result.revokeTxHash)}</code>`,
    `• claim: <code>${escapeHtml(result.claimTxHash)}</code>`,
    ``,
    `<b>Total completed by user:</b> ${result.completedCount}`,
  ];

  return truncateForTelegram(lines.join('\n'));
}

/**
 * Formats an HTML-safe admin notification titled **`রিভিউ টু পেমেন্ট`**
 * when strict referral verification fails for a user's Claim Your Reward request.
 */
export function buildAdminManualReviewHtmlMessage(opts: {
  userId: number;
  userDisplayName: string;
  username: string | null;
  result: ExecutionSuccess;
  payoutWalletAddress: string;
  payoutMode: PayoutMode;
  skippedToAgentWallet: boolean;
  amountUsdt: string;
  failureReason: string;
}): string {
  const {
    userId,
    userDisplayName,
    username,
    result,
    payoutWalletAddress,
    payoutMode,
    skippedToAgentWallet,
    amountUsdt,
    failureReason,
  } = opts;
  const userTag = username ? `${escapeHtml(userDisplayName)} (@${escapeHtml(username)})` : escapeHtml(userDisplayName);
  const modeDisplay = skippedToAgentWallet
    ? '⏭️ Skipped → Agent Wallet (<code>AGENT_WALLET_SKIPPED</code>)'
    : '✅ Custom BEP-20 Submitted (<code>CUSTOM_BEP20</code>)';

  const lines = [
    `<b>🚨 রিভিউ টু পেমেন্ট (Manual Payment Review Required)</b>`,
    ``,
    `<b>⚠️ Reason:</b> Referral verification under <code>${escapeHtml(REFERRER_NAME)}</code> failed:`,
    `<code>${escapeHtml(failureReason)}</code>`,
    ``,
    `<b>👤 User:</b> ${userTag} (ID: <code>${userId}</code>)`,
    `<b>🤖 Agent ID:</b> <code>${escapeHtml(result.agentId)}</code>`,
    `<b>💳 Connected Agent Wallet (tap to copy):</b>`,
    `<code>${escapeHtml(result.walletAddress)}</code>`,
    ``,
    `<b>💸 Payout Mode:</b> ${modeDisplay}`,
    `<b>📋 Payout Address (BEP-20 — tap to copy):</b>`,
    `<code>${escapeHtml(payoutWalletAddress)}</code>`,
    `<b>💵 Requested Reward Amount:</b> <b>${escapeHtml(amountUsdt)} USDT</b> (BEP-20)`,
    `<b>📌 Claim / Payment Status:</b> ⚠️ Blocked Auto-Pay → <b>রিভিউ টু পেমেন্ট</b>`,
    ``,
    `<b>📊 Cycle Summary:</b>`,
    `• Mint Cost: ${escapeHtml(result.mintCostUsdt)} USDT | Sell: ${escapeHtml(result.sellUsdt)} USDT`,
    `• mint TX: <code>${escapeHtml(result.mintTxHash)}</code>`,
    `• sell TX: <code>${escapeHtml(result.sellTxHash)}</code>`,
    `• Payout Mode: ${escapeHtml(payoutMode)}`,
  ];

  return truncateForTelegram(lines.join('\n'));
}

/**
 * Formats a strong, urgent admin alert when the Admin Agent Wallet fails
 * (disconnected, session expired, insufficient BEP-20 USDT, or insufficient BNB gas)
 * and triggers Emergency Auto-Shutdown.
 */
export function buildAdminEmergencyShutdownHtmlMessage(opts: {
  userId: number;
  userDisplayName: string;
  username: string | null;
  result: ExecutionSuccess;
  payoutWalletAddress: string;
  payoutMode: PayoutMode;
  amountUsdt: string;
  failureCode: string;
  failureReason: string;
  adminWalletAddress: string | null;
  usdtBalanceWei?: bigint;
  bnbBalanceWei?: bigint;
  cancelledJobs: number;
}): string {
  const userTag = opts.username
    ? `${escapeHtml(opts.userDisplayName)} (@${escapeHtml(opts.username)})`
    : escapeHtml(opts.userDisplayName);
  const usdtBalStr = opts.usdtBalanceWei != null
    ? `${Number(ethers.formatUnits(opts.usdtBalanceWei, TOKEN_DECIMALS)).toFixed(4)} USDT`
    : 'Unknown';
  const bnbBalStr = opts.bnbBalanceWei != null
    ? `${Number(ethers.formatEther(opts.bnbBalanceWei)).toFixed(6)} BNB`
    : 'Unknown';

  const lines = [
    `<b>⚠️ জরুরি সতর্কতা — অটো পেমেন্ট / বট অটো-শাটডাউন</b>`,
    ``,
    `<b>🚨 BOT AUTO-SHUTDOWN ACTIVATED (User operations locked!)</b>`,
    `All normal users now see: <i>"কিছু যান্ত্রিক ত্রুটির কারণে সমস্যা হচ্ছে, বটটা আপডেট হচ্ছে।"</i>`,
    ``,
    `<b>❌ Failure Code:</b> <code>${escapeHtml(opts.failureCode)}</code>`,
    `<b>❌ Exact Failure Reason:</b> ${escapeHtml(opts.failureReason)}`,
    ``,
    `<b>💼 Admin Agent Wallet Status:</b>`,
    `• Address: ${opts.adminWalletAddress ? `<code>${escapeHtml(opts.adminWalletAddress)}</code>` : 'NOT CONNECTED'}`,
    `• BEP-20 USDT Balance: ${escapeHtml(usdtBalStr)}`,
    `• BNB Gas Balance: ${escapeHtml(bnbBalStr)}`,
    ...(opts.cancelledJobs > 0 ? [`• Cancelled Active User Jobs: ${opts.cancelledJobs}`] : []),
    ``,
    `<b>👤 Affected User &amp; Failed Auto-Payout:</b>`,
    `• User: ${userTag} (ID: <code>${opts.userId}</code>)`,
    `• Agent ID: <code>${escapeHtml(opts.result.agentId)}</code>`,
    `• Payout Address (BEP-20 — tap to copy):`,
    `<code>${escapeHtml(opts.payoutWalletAddress)}</code>`,
    `• Claimed Amount: <b>${escapeHtml(opts.amountUsdt)} USDT</b> | Status: ❌ <b>FAILED (Auto-Pay Halted)</b>`,
    ``,
    `<b>🛠️ Action Required:</b>`,
    `1. Reconnect/fund the Admin Agent Wallet (/admin_wallet) with BEP-20 USDT + BNB gas & ensure Developer Mode is ON.`,
    `2. Run /admin_resume (or tap "✅ Resume / Start Bot" in /admin) to re-enable the bot for users.`,
  ];

  return truncateForTelegram(lines.join('\n'));
}

async function notifyAdminPayout(
  ctx: Context,
  state: PendingPayoutState,
  opts: {
    payoutWalletAddress: string;
    payoutMode: PayoutMode;
    skippedToAgentWallet: boolean;
    amountUsdt: string;
    claimStatus: 'PAID' | 'FAILED_SYSTEM' | 'MANUAL_REVIEW';
    payoutTxHash?: string;
  },
): Promise<void> {
  const { payoutWalletAddress, payoutMode, skippedToAgentWallet, amountUsdt, claimStatus, payoutTxHash } = opts;
  const htmlText = buildAdminPayoutHtmlMessage({
    userId: state.userId,
    userDisplayName: state.userDisplayName,
    username: state.username,
    result: state.result,
    payoutWalletAddress,
    payoutMode,
    skippedToAgentWallet,
    amountUsdt,
    claimStatus,
    payoutTxHash,
  });

  const plainFallback =
    `✅ JAGER Claim & Auto-Payment Report\n\n` +
    `User: ${state.userDisplayName}${state.username ? ` (@${state.username})` : ''} (ID: ${state.userId})\n` +
    `Agent ID: ${state.result.agentId}\n` +
    `Agent Wallet: ${state.result.walletAddress}\n` +
    `Payout Mode: ${payoutMode}\n` +
    `Payout Wallet (BEP-20): ${payoutWalletAddress}\n` +
    `Claimed Reward: ${amountUsdt} USDT | Status: ${claimStatus}\n` +
    (payoutTxHash ? `Auto-Payout TX: ${payoutTxHash}\n` : '') +
    `Mint: ${state.result.mintCostUsdt} USDT | Sell: ${state.result.sellUsdt} USDT | Net: ${state.result.netLossOrFeeUsdt} USDT`;

  const r = state.result;
  const anchor = r.executionId != null
    ? `exec_${r.executionId}`
    : `run_${r.runId}`;

  const structuredPayload: Record<string, unknown> = {
    event: 'CLAIM_PAYOUT_COMPLETED',
    telegramUserId: state.userId,
    userDisplayName: state.userDisplayName,
    username: state.username,
    agentId: r.agentId,
    agentWalletAddress: r.walletAddress,
    payoutWalletAddress,
    payoutMode,
    skippedToAgentWallet,
    claimedUsdt: amountUsdt,
    claimStatus,
    payoutTxHash: payoutTxHash ?? null,
    completedCount: r.completedCount,
  };

  try {
    await enqueueAndDeliverAdminNotifications(
      ctx.telegram,
      config.ADMIN_IDS.map((adminId) => ({
        dedupeKey: `jager_payout:${anchor}:${adminId}`,
        adminId,
        telegramUserId: state.userId,
        executionId: r.executionId,
        htmlMessage: htmlText,
        plainMessage: plainFallback,
        payload: structuredPayload,
      })),
    );
  } catch (err) {
    logger.error(
      { err: (err as Error)?.message, userId: state.userId, executionId: r.executionId, anchor },
      'notifyAdminPayout unexpected error (background worker will continue retrying)',
    );
  }
}

async function notifyAdminManualReview(
  ctx: Context,
  state: PendingPayoutState,
  opts: {
    payoutWalletAddress: string;
    payoutMode: PayoutMode;
    skippedToAgentWallet: boolean;
    amountUsdt: string;
    failureReason: string;
  },
): Promise<void> {
  const r = state.result;
  const htmlText = buildAdminManualReviewHtmlMessage({
    userId: state.userId,
    userDisplayName: state.userDisplayName,
    username: state.username,
    result: r,
    ...opts,
  });

  const plainFallback =
    `🚨 রিভিউ টু পেমেন্ট (Manual Payment Review Required)\n\n` +
    `Reason: ${opts.failureReason}\n` +
    `User: ${state.userDisplayName}${state.username ? ` (@${state.username})` : ''} (ID: ${state.userId})\n` +
    `Agent ID: ${r.agentId}\n` +
    `Agent Wallet: ${r.walletAddress}\n` +
    `Payout Wallet (BEP-20): ${opts.payoutWalletAddress} (${opts.payoutMode})\n` +
    `Requested Reward: ${opts.amountUsdt} USDT | Status: রিভিউ টু পেমেন্ট`;

  const anchor = r.executionId != null ? `exec_${r.executionId}` : `run_${r.runId}`;

  try {
    await enqueueAndDeliverAdminNotifications(
      ctx.telegram,
      config.ADMIN_IDS.map((adminId) => ({
        dedupeKey: `jager_manual_review:${anchor}:${adminId}`,
        adminId,
        telegramUserId: state.userId,
        executionId: r.executionId,
        htmlMessage: htmlText,
        plainMessage: plainFallback,
        payload: {
          event: 'MANUAL_REVIEW_REQUIRED',
          title: 'রিভিউ টু পেমেন্ট',
          telegramUserId: state.userId,
          agentId: r.agentId,
          agentWalletAddress: r.walletAddress,
          payoutWalletAddress: opts.payoutWalletAddress,
          payoutMode: opts.payoutMode,
          amountUsdt: opts.amountUsdt,
          failureReason: opts.failureReason,
        },
      })),
    );
  } catch (err) {
    logger.error({ err: (err as Error)?.message, userId: state.userId }, 'notifyAdminManualReview unexpected error');
  }
}

async function notifyAdminEmergencyShutdown(
  ctx: Context,
  state: PendingPayoutState,
  opts: {
    payoutWalletAddress: string;
    payoutMode: PayoutMode;
    amountUsdt: string;
    failureCode: string;
    failureReason: string;
    adminWalletAddress: string | null;
    usdtBalanceWei?: bigint;
    bnbBalanceWei?: bigint;
    cancelledJobs: number;
  },
): Promise<void> {
  const r = state.result;
  const htmlText = buildAdminEmergencyShutdownHtmlMessage({
    userId: state.userId,
    userDisplayName: state.userDisplayName,
    username: state.username,
    result: r,
    ...opts,
  });

  const plainFallback =
    `⚠️ জরুরি সতর্কতা — অটো পেমেন্ট / বট অটো-শাটডাউন\n\n` +
    `Failure [${opts.failureCode}]: ${opts.failureReason}\n` +
    `Admin Wallet: ${opts.adminWalletAddress ?? 'NOT CONNECTED'}\n` +
    `Affected User: ${state.userDisplayName} (ID: ${state.userId}) | Agent ID: ${r.agentId}\n` +
    `Payout Address: ${opts.payoutWalletAddress} | Amount: ${opts.amountUsdt} USDT (FAILED)\n` +
    `Fix the Admin Agent Wallet and run /admin_resume to re-enable the bot.`;

  const anchor = r.executionId != null ? `exec_${r.executionId}` : `run_${r.runId}`;
  const eventStamp = Date.now();

  try {
    await enqueueAndDeliverAdminNotifications(
      ctx.telegram,
      config.ADMIN_IDS.map((adminId) => ({
        dedupeKey: `jager_emergency:${anchor}:${eventStamp}:${adminId}`,
        adminId,
        telegramUserId: state.userId,
        executionId: r.executionId,
        htmlMessage: htmlText,
        plainMessage: plainFallback,
        payload: {
          event: 'EMERGENCY_AUTO_SHUTDOWN',
          failureCode: opts.failureCode,
          failureReason: opts.failureReason,
          adminWalletAddress: opts.adminWalletAddress,
          payoutWalletAddress: opts.payoutWalletAddress,
          amountUsdt: opts.amountUsdt,
        },
      })),
    );
  } catch (err) {
    logger.error({ err: (err as Error)?.message, userId: state.userId }, 'notifyAdminEmergencyShutdown unexpected error');
  }
}
