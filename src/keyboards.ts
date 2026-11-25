// src/keyboards.ts
// Telegram inline keyboard definitions — one place for all button layouts.

import { Markup } from 'telegraf';

export const KB = {
  /** Shown on /start for normal users */
  start: Markup.inlineKeyboard([
    [Markup.button.callback('🔗 Connect Your Binance Wallet', 'connect_wallet')],
    [Markup.button.callback('📱 Generate QR Code', 'generate_qr')],
    [Markup.button.callback('📊 My Status & Jobs', 'my_jobs')],
    [Markup.button.callback('❌ Cancel', 'cancel')],
  ]),

  /** Shown on /start ONLY for configured ADMIN_ID(s) — strict role isolation (no user execution buttons) */
  startForAdmin: Markup.inlineKeyboard([
    [Markup.button.callback('🛡️ Admin Dashboard', 'admin_overview')],
    [
      Markup.button.callback('💼 Connect Admin Wallet', 'admin_connect_wallet'),
      Markup.button.callback('💵 Adjust Withdraw Amount', 'admin_adjust_withdraw'),
    ],
    [
      Markup.button.callback('🏆 Completed Agent IDs', 'admin_completed'),
      Markup.button.callback('✅ Resume / Start Bot', 'admin_resume'),
    ],
  ]),

  /** Admin dashboard navigation (strictly gated by ADMIN_ID check in handlers) */
  adminMenu: Markup.inlineKeyboard([
    [
      Markup.button.callback('🏆 Completed Agent IDs', 'admin_completed'),
      Markup.button.callback('⚠️ Incomplete / Connected', 'admin_incomplete'),
    ],
    [
      Markup.button.callback('👥 All Users', 'admin_users'),
      Markup.button.callback('🔄 Refresh Overview', 'admin_overview'),
    ],
    [
      Markup.button.callback('💼 Connect Admin Wallet', 'admin_connect_wallet'),
      Markup.button.callback('💵 Adjust Withdraw Amount', 'admin_adjust_withdraw'),
    ],
    [
      Markup.button.callback('⏸️ Stop Bot (Users)', 'admin_bot_stop'),
      Markup.button.callback('✅ Resume / Start Bot', 'admin_resume'),
    ],
  ]),

  /** Shown after wallet connection link is generated */
  afterConnect: Markup.inlineKeyboard([
    [Markup.button.callback('📱 Generate QR Code', 'generate_qr')],
    [Markup.button.callback('🚀 Complete All Process', 'complete_process')],
    [Markup.button.callback('📊 My Status & Jobs', 'my_jobs')],
    [Markup.button.callback('❌ Cancel', 'cancel')],
  ]),

  /** Shown after QR code is sent */
  afterQr: Markup.inlineKeyboard([
    [Markup.button.callback('🚀 Complete All Process', 'complete_process')],
    [Markup.button.callback('❌ Cancel', 'cancel')],
  ]),

  /** Shown on the single combined JAGER full-cycle preview (ONE confirmation) */
  confirmCycle: Markup.inlineKeyboard([
    [Markup.button.callback('✅ Confirm & Execute Full Cycle', 'confirm_execute_cycle')],
    [Markup.button.callback('❌ Cancel', 'cancel_preview')],
  ]),

  /** Shown after cycle completes while awaiting user's BEP-20 payout wallet or Skip */
  payoutWalletPrompt: Markup.inlineKeyboard([
    [Markup.button.callback('⏭️ স্কিপ (এজেন্ট ওয়ালেটে পেমেন্ট)', 'skip_payout_wallet')],
  ]),

  /** Shown right after valid BEP-20 submission or Skip, before final summary */
  claimReward: (amountUsdt: string) =>
    Markup.inlineKeyboard([
      [Markup.button.callback(`🎁 Claim Your Reward (${amountUsdt} USDT)`, 'claim_reward')],
    ]),

  /** Shown when execution is running (single cancel button) */
  cancelOnly: Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel Job', 'cancel')],
  ]),

  /** Shown after completion / error */
  postExecution: Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Connect New Wallet (Next .ai ID)', 'switch_wallet')],
    [Markup.button.callback('🚀 Complete All Process', 'complete_process')],
    [Markup.button.callback('📊 My Status & Jobs', 'my_jobs')],
    [Markup.button.callback('❌ Cancel', 'cancel')],
  ]),
};
