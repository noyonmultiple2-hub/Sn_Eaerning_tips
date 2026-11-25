// src/handlers/cancel.ts
// "Cancel" callback handler — resets user state safely.

import { Context } from 'telegraf';
import { cancelUser } from '../db.js';
import { clearSession } from '../wallet.js';
import { isUserLocked, requestCancelExecution, clearPendingPreview } from '../executor.js';
import { clearPendingPayout } from './execute.js';
import { isAdminId } from '../config.js';
import { KB } from '../keyboards.js';
import { logger } from '../logger.js';

// FIX #12: answerCbQuery is only valid when there is an active callback query.
// When cancel is triggered via free-text NL routing, there is no callbackQuery.
async function safeAnswerCb(ctx: Context, text?: string): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery(text);
  } catch {
    // not a callback context — ignore
  }
}

export async function handleCancel(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  if (isAdminId(userId)) {
    await safeAnswerCb(ctx, 'Admin Dashboard active');
    await ctx.reply('🛡️ Admin accounts use Admin Dashboard controls (/admin).', KB.adminMenu);
    return;
  }

  await safeAnswerCb(ctx, 'Cancelling…');

  clearPendingPreview(userId);
  clearPendingPayout(userId);
  const wasRunning = isUserLocked(userId);
  if (wasRunning) {
    requestCancelExecution(userId);
  }

  try {
    await cancelUser(userId);
  } catch (err) {
    logger.error({ err, userId }, 'handleCancel: DB cancel failed (continuing session cleanup)');
  }

  try {
    await clearSession(userId);
  } catch (err) {
    logger.error({ err, userId }, 'handleCancel: clearSession failed');
  }

  const msg = wasRunning
    ? '⚠️ Cancellation requested. The running job will stop at the next safe checkpoint.\n\n' +
      'Note: If a transaction was already broadcast, it cannot be recalled.'
    : '✅ Session cancelled and reset. Use /start to begin again.';

  await ctx.reply(msg, KB.start);
}
