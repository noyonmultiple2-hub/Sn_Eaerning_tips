// src/handlers/message.ts
// Free-text message handler — routes NL input through Gemini intent classifier.

import { Context } from 'telegraf';
import { routeIntent } from '../gemini.js';
import { handleConnectWallet } from './wallet.js';
import { handleGenerateQr } from './qr.js';
import { handleCompleteProcess, handlePayoutWalletInput } from './execute.js';
import { handleMyJobs } from './jobs.js';
import { handleCancel } from './cancel.js';
import { handleAdminWithdrawAmountInput } from './admin.js';
import { KB } from '../keyboards.js';
import { isAdminId } from '../config.js';

export async function handleMessage(ctx: Context): Promise<void> {
  const text = (ctx.message as { text?: string })?.text;
  if (!text) return;

  // Skip commands — they have dedicated handlers
  if (text.startsWith('/')) return;

  // Admin interactive Adjust Withdraw Amount input
  if (await handleAdminWithdrawAmountInput(ctx, text)) return;

  // Strict Admin Role Isolation: never route admin free-text into user execution/wallet intents
  if (isAdminId(ctx.from?.id)) {
    await ctx.reply(
      '🛡️ Admin accounts are isolated to Admin Dashboard controls. Use the buttons below or /admin.',
      KB.adminMenu,
    );
    return;
  }

  // Capture pasted BEP-20 payment wallet address (or typed Skip) before Gemini routing
  if (await handlePayoutWalletInput(ctx, text)) return;

  const result = await routeIntent(text);

  switch (result.intent) {
    case 'connect_wallet':
      return handleConnectWallet(ctx);
    case 'generate_qr':
      return handleGenerateQr(ctx);
    case 'complete_process':
      return handleCompleteProcess(ctx);
    case 'my_jobs':
      return handleMyJobs(ctx);
    case 'cancel':
      return handleCancel(ctx);
    case 'general_reply':
    default:
      // FIX #10: Gemini's output_text is arbitrary text that may contain
      // MarkdownV2 special characters. Sending it with parse_mode: 'MarkdownV2'
      // will cause Telegram to reject the message with a 400 Bad Request.
      // Always send AI-generated text as plain text.
      await ctx.reply(
        result.reply ?? 'How can I help you? Use the buttons below.',
        isAdminId(ctx.from?.id) ? KB.startForAdmin : KB.start,
      );
  }
}
