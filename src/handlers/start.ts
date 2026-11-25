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

  // Strict Admin Role Isolation: Admins see ONLY the Admin Control Center & Treasury menu
  if (admin) {
    const adminWelcome = [
      `🛡️ Welcome, Admin ${name}!`,
      ``,
      `Admin accounts are strictly isolated to the Admin Dashboard, Auto-Payment Treasury Wallet, Withdraw Amount configuration, and Bot Control commands.`,
      `(Regular user task/execution flows are disabled for admin accounts to keep treasury & user operations separated.)`,
      ``,
      `Commands: /admin | /admin_wallet | /admin_withdraw <USDT> | /admin_resume | /admin_completed | /admin_incomplete | /admin_users | /admin_stop`,
    ].join('\n');
    await ctx.reply(adminWelcome, KB.startForAdmin);
    return;
  }

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

  await ctx.reply(welcome, KB.start);
}

/** Escape MarkdownV2 special characters (retained for utility compatibility) */
export function escMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}
