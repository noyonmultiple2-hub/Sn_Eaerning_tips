// src/handlers/start.ts
// /start command handler — displays JAGER platform link, fixed referrer notice, and role-aware menu.

import { Context } from 'telegraf';
import { upsertUser } from '../db.js';
import { ADDR, REFERRER_NAME, PLATFORM_REF_URL } from '../bsc.js';
import { isAdminId } from '../config.js';
import { KB } from '../keyboards.js';
import { logger } from '../logger.js';

export async function handleStart(ctx: Context): Promise<void> {
  const user = ctx.from;
  if (!user) return;

  try {
    await upsertUser(user.id, user.username ?? null, user.first_name ?? null);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'handleStart: DB upsert failed (continuing)');
  }

  const name = user.first_name ?? user.username ?? 'there';
  const admin = isAdminId(user.id);

  // Plain text ensures usernames/dots/addresses never fail Telegram MarkdownV2 parsing.
  const welcome = [
    `👋 Welcome, ${name}!`,
    ``,
    `🚀 JAGER MINT — ONE-CONFIRM FULL CYCLE (BNB Smart Chain, chainId: 56)`,
    `Automates exact USDT approve → 10-share $JAGENT mint (1 TX) → immediate PancakeSwap V2 sell (JAGENT → USDT) → USDT allowance revoke → invite reward claim via your non-custodial Binance Agentic Wallet.`,
    ``,
    `📌 Fixed Referrer Notice:`,
    `• Platform / Refer Link: ${PLATFORM_REF_URL}`,
    `• Referrer Code / Agent ID: ${REFERRER_NAME}`,
    `• Referrer Wallet: ${ADDR.REFERRER}`,
    `This hardcoded referrer is applied automatically on every mint (never 0x0 and cannot be overridden).`,
    ``,
    `🔒 Security Reminder:`,
    `• We will NEVER ask for your seed phrase or private key.`,
    `• Never send USDT or BNB directly to a contract address.`,
    `• Uses exact USDT approvals (no unlimited approvals) and LOW/MEDIUM gas settings only.`,
    ``,
    `Choose an action below:`,
  ].join('\n');

  await ctx.reply(welcome, admin ? KB.startForAdmin : KB.start);
}

/** Escape MarkdownV2 special characters (retained for utility compatibility) */
export function escMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}
