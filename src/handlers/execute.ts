// src/handlers/execute.ts — Layer 4: JAGER One-Confirm Full Cycle preview, live execution,
// pre-summary BEP-20 payment wallet selection, and HTML one-click-copy admin payout notification.

import { Context } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/types';
import { ethers } from 'ethers';
import { isSessionConnectedDb, getSession, clearSession } from '../wallet.js';
import { ADDR, normalizeAddress } from '../bsc.js';
import {
  isUserLocked,
  isPreviewInProgress,
  prepareCyclePreview,
  reserveExecutionFromPreview,
  releaseReservedExecutionLock,
  clearPendingPreview,
  runFullExecution,
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
  PayoutMode,
} from '../db.js';
import {
  enqueueAndDeliverAdminNotifications,
  flushPendingAdminNotifications,
} from '../notifications.js';
import { KB } from '../keyboards.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

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

// ─── Pre-Summary BEP-20 Payout Wallet State ──────────────────────────────────

interface PendingPayoutState {
  userId: number;
  chatId: number;
  statusMessageId: number;
  userDisplayName: string;
  username: string | null;
  result: ExecutionSuccess;
  createdAt: number;
}

const pendingPayouts = new Map<number, PendingPayoutState>();

export function isAwaitingPayoutWallet(userId: number): boolean {
  return pendingPayouts.has(userId);
}

export function clearPendingPayout(userId: number): void {
  pendingPayouts.delete(userId);
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

  if (isUserLocked(userId)) {
    await safeAnswerCb(ctx, 'Job already running');
    await ctx.reply('⏳ A job is already running. Please wait or tap Cancel.', KB.cancelOnly);
    return;
  }

  if (isAwaitingPayoutWallet(userId)) {
    const state = pendingPayouts.get(userId)!;
    await safeAnswerCb(ctx, 'পেমেন্ট ওয়ালেট দিন বা স্কিপ করুন');
    await ctx.reply(buildPayoutPromptBangla(state.result.walletAddress), KB.payoutWalletPrompt);
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
        // Pause final summary delivery: prompt user in Bangla for BEP-20 payout wallet or Skip
        pendingPayouts.set(userId, {
          userId,
          chatId,
          statusMessageId: messageId,
          userDisplayName,
          username,
          result,
          createdAt: Date.now(),
        });
        await safeUpdateUser(userId, { current_step: 'awaiting_payout_wallet' });
        await safeEditOrSend(
          ctx,
          chatId,
          messageId,
          buildPayoutPromptBangla(result.walletAddress),
          KB.payoutWalletPrompt.reply_markup,
        );
        // Trigger a background flush of any prior deferred DB writes / pending admin alerts
        void flushPendingAdminNotifications(ctx.telegram);
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

// ─── Pre-Summary BEP-20 Payout Handlers ──────────────────────────────────────

/**
 * Triggered when user clicks `⏭️ স্কিপ (এজেন্ট ওয়ালেটে পেমেন্ট)`.
 * Assigns payout to the user's connected Agent Wallet (`AGENT_WALLET_SKIPPED`)
 * and immediately delivers the final summary + admin payout notification.
 */
export async function handleSkipPayoutWallet(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const state = pendingPayouts.get(userId);
  if (!state) {
    await safeAnswerCb(ctx, 'ইতিমধ্যে সম্পন্ন হয়েছে');
    return;
  }
  pendingPayouts.delete(userId);
  await safeAnswerCb(ctx, 'এজেন্ট ওয়ালেট সিলেক্ট করা হয়েছে');

  await finalizePayoutAndReport(ctx, state, state.result.walletAddress, 'AGENT_WALLET_SKIPPED');
}

/**
 * Called at the very top of `handleMessage` before Gemini intent routing.
 * Returns `true` if this user is currently awaiting a payout wallet address
 * (consuming the message cleanly so Gemini never interferes).
 */
export async function handlePayoutWalletInput(ctx: Context, rawText: string): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;

  const state = pendingPayouts.get(userId);
  if (!state) return false;

  const trimmed = rawText.trim();

  // Allow typing "skip" or "স্কিপ" as an alias for the Skip button
  if (/^(skip|স্কিপ)$/i.test(trimmed)) {
    pendingPayouts.delete(userId);
    await finalizePayoutAndReport(ctx, state, state.result.walletAddress, 'AGENT_WALLET_SKIPPED');
    return true;
  }

  // Strict BEP-20 (BSC / EVM) address validation
  const validatedAddress = validateBep20Address(trimmed);
  if (!validatedAddress) {
    await ctx.reply(buildInvalidBep20ReplyBangla(), KB.payoutWalletPrompt);
    return true;
  }

  pendingPayouts.delete(userId);
  await finalizePayoutAndReport(ctx, state, validatedAddress, 'CUSTOM_BEP20');
  return true;
}

/**
 * Persists the selected payout wallet & mode to PostgreSQL, delivers the user's
 * complete final summary report (including the chosen payout address), and sends
 * the HTML one-click-copy payout notification to all configured admins.
 */
async function finalizePayoutAndReport(
  ctx: Context,
  state: PendingPayoutState,
  payoutWalletAddress: string,
  payoutMode: PayoutMode,
): Promise<void> {
  const skippedToAgentWallet = payoutMode === 'AGENT_WALLET_SKIPPED';
  const r = state.result;

  const [, , finalSummary] = await Promise.all([
    updateExecutionPayout(r.executionId, payoutWalletAddress, payoutMode, {
      telegramUserId: state.userId,
      walletAddress: r.walletAddress,
      sellTxHash: r.sellTxHash,
    }),
    safeUpdateUser(state.userId, { current_step: 'completed' }),
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
      status: 'COMPLETED',
    }),
  ]);

  logger.info(
    {
      userId: state.userId,
      executionId: r.executionId,
      agentId: r.agentId,
      payoutWalletAddress,
      payoutMode,
      skippedToAgentWallet,
    },
    'Finalized JAGER payout wallet selection — delivering final summary & admin payout alert',
  );

  // Deliver user final summary and admin HTML payout notification in parallel
  const deliverToUser = ctx.callbackQuery
    ? safeEditOrSend(ctx, state.chatId, state.statusMessageId, finalSummary, KB.postExecution.reply_markup)
    : ctx.reply(truncateForTelegram(finalSummary), KB.postExecution).then(() => {
        // Cleanly clear Skip button on the older prompt message (best-effort)
        return ctx.telegram.editMessageReplyMarkup(state.chatId, state.statusMessageId, undefined, undefined).catch(() => {});
      });

  await Promise.all([
    deliverToUser,
    notifyAdminPayout(ctx, state, payoutWalletAddress, payoutMode, skippedToAgentWallet),
  ]);
}

/**
 * Formats an HTML-safe admin payout notification where the payout BEP-20 address
 * is wrapped in `<code>0x...</code>` for one-click tap-to-copy in Telegram.
 */
export function buildAdminPayoutHtmlMessage(opts: {
  userId: number;
  userDisplayName: string;
  username: string | null;
  result: ExecutionSuccess;
  payoutWalletAddress: string;
  payoutMode: PayoutMode;
  skippedToAgentWallet: boolean;
}): string {
  const { userId, userDisplayName, username, result, payoutWalletAddress, payoutMode, skippedToAgentWallet } = opts;
  const userTag = username ? `${escapeHtml(userDisplayName)} (@${escapeHtml(username)})` : escapeHtml(userDisplayName);
  const modeDisplay = skippedToAgentWallet
    ? '⏭️ Skipped → Agent Wallet (<code>AGENT_WALLET_SKIPPED</code>)'
    : '✅ Custom BEP-20 Submitted (<code>CUSTOM_BEP20</code>)';

  const lines = [
    `<b>✅ JAGER Cycle Completed — Payout Ready</b>`,
    ``,
    `<b>👤 User:</b> ${userTag} (ID: <code>${userId}</code>)`,
    `<b>🤖 Agent ID:</b> <code>${escapeHtml(result.agentId)}</code>`,
    `<b>💳 Agent Wallet:</b> <code>${escapeHtml(result.walletAddress)}</code>`,
    ``,
    `<b>💸 Payout Mode:</b> ${modeDisplay}`,
    `<b>📋 Payout Address (BEP-20 — tap to copy):</b>`,
    `<code>${escapeHtml(payoutWalletAddress)}</code>`,
    ``,
    `<b>📊 Cycle Summary:</b>`,
    `• Mint Cost: ${escapeHtml(result.mintCostUsdt)} USDT`,
    `• Sell Received: ${escapeHtml(result.sellUsdt)} USDT`,
    `• Net Loss / Fees: ${escapeHtml(result.netLossOrFeeUsdt)} USDT`,
    ...(result.inviteRewardUsdt ? [`• Invite Reward: +${escapeHtml(result.inviteRewardUsdt)} USDT`] : []),
    `• Claim Attempts: ${result.claimAttempts}/${CLAIM_MAX_ATTEMPTS}` +
      (result.claimStatusNote ? ` (${escapeHtml(result.claimStatusNote)})` : ''),
    `• Payout Status: ${escapeHtml(payoutMode)}`,
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

async function notifyAdminPayout(
  ctx: Context,
  state: PendingPayoutState,
  payoutWalletAddress: string,
  payoutMode: PayoutMode,
  skippedToAgentWallet: boolean,
): Promise<void> {
  const htmlText = buildAdminPayoutHtmlMessage({
    userId: state.userId,
    userDisplayName: state.userDisplayName,
    username: state.username,
    result: state.result,
    payoutWalletAddress,
    payoutMode,
    skippedToAgentWallet,
  });

  const plainFallback =
    `✅ JAGER Cycle Completed — Payout Ready\n\n` +
    `User: ${state.userDisplayName}${state.username ? ` (@${state.username})` : ''} (ID: ${state.userId})\n` +
    `Agent ID: ${state.result.agentId}\n` +
    `Agent Wallet: ${state.result.walletAddress}\n` +
    `Payout Mode: ${payoutMode}\n` +
    `Payout Wallet (BEP-20): ${payoutWalletAddress}\n` +
    `Mint: ${state.result.mintCostUsdt} USDT | Sell: ${state.result.sellUsdt} USDT | Net: ${state.result.netLossOrFeeUsdt} USDT\n` +
    `Claim Attempts: ${state.result.claimAttempts}/${CLAIM_MAX_ATTEMPTS}\n` +
    `TXs: approve=${state.result.approveTxHash} | mint=${state.result.mintTxHash} | sell=${state.result.sellTxHash} | revoke=${state.result.revokeTxHash} | claim=${state.result.claimTxHash}`;

  const r = state.result;
  // Globally unique dedupe anchor per execution (NEVER keyed by telegram_user_id or non-unique fallback tx labels)
  // so the same Telegram user completing many distinct .ai Agent IDs gets a guaranteed dedicated alert for EVERY run.
  const anchor = r.executionId != null
    ? `exec_${r.executionId}`
    : `run_${r.runId}`;

  const structuredPayload: Record<string, unknown> = {
    telegramUserId: state.userId,
    userDisplayName: state.userDisplayName,
    username: state.username,
    agentId: r.agentId,
    agentWalletAddress: r.walletAddress,
    payoutWalletAddress,
    payoutMode,
    skippedToAgentWallet,
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

  // Persist in durable pending queue FIRST, then flush immediately (auto-retrying on failure)
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
}
