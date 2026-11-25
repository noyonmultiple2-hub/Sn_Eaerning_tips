// src/handlers/admin.ts
// Admin-only commands & inline dashboard views.
// Strictly restricted to configured ADMIN_ID(s) — never exposed to normal users.

import { Context } from 'telegraf';
import { ethers } from 'ethers';
import {
  getAdminOverviewStats,
  getAllStartedUsers,
  getAllCompletedExecutions,
  getIncompleteUsers,
  isBotPaused,
  setBotPaused,
  isEmergencyShutdown,
  getEmergencyShutdownReason,
  setEmergencyShutdown,
  getWithdrawAmountUsdt,
  setWithdrawAmountUsdt,
  getAdminWalletConfig,
} from '../db.js';
import {
  bawAvailable,
  generateAdminWalletPairingUri,
  verifyAndBindAdminWalletSession,
  getAdminWalletStatus,
  disconnectAdminWallet,
} from '../wallet.js';
import { ADDR, TOKEN_DECIMALS } from '../bsc.js';
import { generateQrBuffer } from '../qr.js';
import { cancelAllNonAdminExecutions } from '../executor.js';
import { isAdminId } from '../config.js';
import { KB } from '../keyboards.js';
import { logger } from '../logger.js';

const TELEGRAM_MAX_LEN = 3900;
const awaitingWithdrawAmountAdmins = new Set<number>();

async function safeAnswerCb(ctx: Context, text?: string): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery(text);
  } catch {
    // not a callback context — ignore
  }
}

async function guardAdmin(ctx: Context): Promise<boolean> {
  if (!isAdminId(ctx.from?.id)) {
    await safeAnswerCb(ctx, 'Unauthorized');
    await ctx.reply('⛔ Unauthorized. This command is restricted to bot administrators.');
    return false;
  }
  return true;
}

/** Sends plain text safely under Telegram's 4096-character limit. */
async function replyChunked(
  ctx: Context,
  text: string,
  withAdminMenu = true,
): Promise<void> {
  if (text.length <= TELEGRAM_MAX_LEN) {
    await ctx.reply(text, withAdminMenu ? KB.adminMenu : undefined);
    return;
  }

  const lines = text.split('\n');
  const chunks: string[] = [];
  let current = '';

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > TELEGRAM_MAX_LEN && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    await ctx.reply(chunks[i], isLast && withAdminMenu ? KB.adminMenu : undefined);
  }
}

async function replyDbDegraded(ctx: Context, action: string, err: unknown): Promise<void> {
  logger.error({ err, action }, 'Admin query failed (DB degraded)');
  await ctx.reply(
    '⚠️ Database is currently unavailable (degraded mode).\n\n' +
    'Could not load admin analytics from Supabase/PostgreSQL. ' +
    'Verify SUPABASE_DB_URL and database connectivity in server logs.',
    KB.adminMenu,
  );
}

function formatUserLabel(u: { first_name: string | null; username: string | null; telegram_user_id: number }): string {
  const parts: string[] = [];
  if (u.first_name) parts.push(u.first_name);
  if (u.username) parts.push(`@${u.username}`);
  const label = parts.length > 0 ? parts.join(' ') : String(u.telegram_user_id);
  return `${label} (ID: ${u.telegram_user_id})`;
}

/** /admin — full overview across all users, completed Agent IDs, and incomplete/connected-only accounts */
export async function handleAdminOverview(ctx: Context): Promise<void> {
  if (!(await guardAdmin(ctx))) return;
  await safeAnswerCb(ctx, 'Loading admin overview…');

  try {
    const [stats, adminWallet] = await Promise.all([
      getAdminOverviewStats(),
      getAdminWalletStatus().catch(() => null),
    ]);
    const incompleteRunsTotal =
      stats.stoppedRunsTotal + stats.failedRunsTotal + stats.cancelledRunsTotal;

    const previewAgents = stats.uniqueCompletedAgentIds.slice(0, 15);
    const agentSection =
      previewAgents.length > 0
        ? [
            `🤖 Completed Agent IDs (${stats.uniqueCompletedAgentIds.length} unique):`,
            ...previewAgents.map((a) => `  • ${a}`),
            ...(stats.uniqueCompletedAgentIds.length > previewAgents.length
              ? [`  … and ${stats.uniqueCompletedAgentIds.length - previewAgents.length} more (use /admin_completed)`]
              : []),
          ]
        : ['🤖 Completed Agent IDs: none yet'];

    const emergencyActive = isEmergencyShutdown();
    const emergencyReason = getEmergencyShutdownReason();
    const botStatusLine = emergencyActive
      ? `🚨 EMERGENCY AUTO-SHUTDOWN (Users see maintenance notice)\n   Reason: ${emergencyReason ?? 'Auto-payment wallet issue'}`
      : isBotPaused()
        ? '🔴 STOPPED (Admin-Only Mode — normal users blocked)'
        : '🟢 RUNNING (Active for all users)';

    const cachedAdminWallet = getAdminWalletConfig();
    const adminWalletLines = adminWallet?.connected && adminWallet.address
      ? [
          `💼 Admin Agent Wallet (Auto-Pay Treasury):`,
          `  • Status: 🟢 Connected`,
          `  • Address: ${adminWallet.address}`,
          `  • BEP-20 USDT Balance: ${Number(ethers.formatUnits(adminWallet.usdtBalanceWei, TOKEN_DECIMALS)).toFixed(4)} USDT`,
          `  • BNB Gas Balance: ${Number(ethers.formatEther(adminWallet.bnbBalanceWei)).toFixed(6)} BNB`,
          `  • Dev Mode: ${adminWallet.devModeEnabled === true && !adminWallet.devModeExpired ? 'ON ✅' : adminWallet.devModeEnabled === false || adminWallet.devModeExpired ? 'OFF / Expired ⚠️' : 'Unknown'}`,
        ]
      : [
          `💼 Admin Agent Wallet (Auto-Pay Treasury):`,
          `  • Status: 🔴 ${adminWallet?.sessionExpired ? 'SESSION EXPIRED — reconnect now!' : 'NOT CONNECTED'}`,
          ...(cachedAdminWallet.address ? [`  • Last Address: ${cachedAdminWallet.address}`] : []),
          ...(adminWallet?.error ? [`  • Detail: ${adminWallet.error}`] : []),
        ];

    const lines = [
      `🛡️ Admin Dashboard Overview`,
      `Status: ${botStatusLine}`,
      `💵 Withdraw Reward Amount: ${getWithdrawAmountUsdt()} USDT (BEP-20) per claim`,
      ``,
      ...adminWalletLines,
      ``,
      `👥 Users:`,
      `  • Total started: ${stats.totalUsers}`,
      `  • Wallet connected: ${stats.connectedUsers}`,
      `  • Completed full cycle: ${stats.completedUsersCount}`,
      `  • Connected only (0 completed): ${stats.connectedOnlyUsersCount}`,
      `  • Connected / Incomplete / Failed: ${stats.incompleteUsersCount}`,
      ``,
      `📈 Full Cycles (JAGER One-Confirm):`,
      `  • Total completed runs: ${stats.completedCyclesTotal}`,
      `  • Unique completed Agent IDs: ${stats.uniqueCompletedAgentIds.length}`,
      `  • Payouts (Custom BEP-20 / Skipped→Agent): ${stats.customPayoutCount} / ${stats.skippedPayoutCount}`,
      `  • Admin Alert Queue: ${stats.pendingAdminNotifications === 0 ? '0 pending ✅' : `${stats.pendingAdminNotifications} PENDING (auto-retrying)`}`,
      ``,
      `⚠️ Non-Completed Attempts (${incompleteRunsTotal} total):`,
      `  • Stopped (preflight / guard): ${stats.stoppedRunsTotal}`,
      `  • Failed (session expired / RPC / congestion): ${stats.failedRunsTotal}`,
      `  • Cancelled: ${stats.cancelledRunsTotal}`,
      ``,
      ...agentSection,
      ``,
      `Commands: /admin | /admin_wallet | /admin_withdraw <USDT> | /admin_resume | /admin_completed | /admin_incomplete | /admin_users | /admin_stop`,
    ];

    await replyChunked(ctx, lines.join('\n'), true);
  } catch (err) {
    await replyDbDegraded(ctx, 'admin_overview', err);
  }
}

function formatTimestampUtc(d: Date | string | null | undefined): string {
  if (!d) return 'unknown time';
  try {
    return `${new Date(d).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  } catch {
    return 'unknown time';
  }
}

/** /admin_completed — strictly admin-only full list of EVERY completed execution (never collapsed by Telegram user ID) */
export async function handleAdminCompleted(ctx: Context): Promise<void> {
  if (!(await guardAdmin(ctx))) return;
  await safeAnswerCb(ctx, 'Loading completed records…');

  try {
    const executions = await getAllCompletedExecutions();
    if (executions.length === 0) {
      await ctx.reply('🏆 Completed Full Cycles (0)\n\nNo Agent IDs have completed the full cycle yet.', KB.adminMenu);
      return;
    }

    const uniqueTelegramUsers = new Set<number>();
    const uniqueAgentIds = new Set<string>();
    let customPayoutCount = 0;
    let skippedPayoutCount = 0;

    const entries = executions.map((e, i) => {
      uniqueTelegramUsers.add(Number(e.telegram_user_id));
      const agentKey = (e.agent_id_name?.trim() || e.wallet_address?.trim() || '').toLowerCase();
      if (agentKey) uniqueAgentIds.add(agentKey);

      if (e.payout_mode === 'CUSTOM_BEP20') customPayoutCount += 1;
      else if (e.payout_mode === 'AGENT_WALLET_SKIPPED') skippedPayoutCount += 1;

      const userLabel = formatUserLabel({
        first_name: e.first_name,
        username: e.username,
        telegram_user_id: Number(e.telegram_user_id),
      });
      const agentDisplay = e.agent_id_name?.trim() || 'N/A';
      const walletDisplay = e.wallet_address?.trim() || 'N/A';

      const payoutLine = e.payout_wallet_address
        ? `\n    💸 Payout (${e.payout_mode ?? 'BEP-20'}): ${e.payout_wallet_address}`
        : `\n    💸 Payout: Pending user selection`;

      const claimStatusLine = e.claim_payout_status
        ? `\n    🎁 Auto-Pay Reward: ${e.claim_payout_amount_usdt ?? '?'} USDT — ${e.claim_payout_status}` +
          (e.claim_payout_tx_hash ? ` (TX: ${e.claim_payout_tx_hash})` : '')
        : '';

      const unit = e.currency === 'BNB' ? 'BNB' : 'USDT';
      const mintAmt = e.mint_cost_usdt ?? e.mint_cost_bnb;
      const sellAmt = e.sell_usdt ?? e.sell_bnb;
      const amountsPart = mintAmt || sellAmt
        ? `💰 ${mintAmt ?? '?'} → ${sellAmt ?? '?'} ${unit}`
        : `💰 ${unit}`;
      const rewardPart = e.invite_reward_usdt && Number(e.invite_reward_usdt) > 0
        ? ` | 🎁 +${e.invite_reward_usdt} USDT`
        : '';
      const claimPart = e.claim_attempts != null
        ? ` | Claim: ${e.claim_attempts}/50`
        : '';
      const alertLine = e.pending_admin_alerts > 0
        ? `\n    ⏳ Pending Admin Alert(s): ${e.pending_admin_alerts} (retrying)`
        : '';

      return (
        `${i + 1}. [Run #${e.execution_id}] ${formatTimestampUtc(e.created_at)}\n` +
        `    👤 ${userLabel}\n` +
        `    🤖 Agent ID: ${agentDisplay}\n` +
        `    💳 Agent Wallet: ${walletDisplay}` +
        payoutLine +
        claimStatusLine +
        `\n    ${amountsPart}${rewardPart}${claimPart}` +
        alertLine
      );
    });

    const header = [
      `🏆 Completed Full Cycles — All Records (Admin Only)`,
      ``,
      `• Total Completed Executions: ${executions.length}`,
      `• Unique Completed Agent IDs / Wallets: ${uniqueAgentIds.size}`,
      `• Distinct Telegram Users: ${uniqueTelegramUsers.size}`,
      `• Payouts (Custom BEP-20 / Skipped→Agent): ${customPayoutCount} / ${skippedPayoutCount}`,
      ``,
    ].join('\n');

    await replyChunked(ctx, header + entries.join('\n\n'), true);
  } catch (err) {
    await replyDbDegraded(ctx, 'admin_completed', err);
  }
}

/** /admin_incomplete — connected-only wallets & users/Agent IDs that did not complete the cycle */
export async function handleAdminIncomplete(ctx: Context): Promise<void> {
  if (!(await guardAdmin(ctx))) return;
  await safeAnswerCb(ctx, 'Loading incomplete records…');

  try {
    const records = await getIncompleteUsers();
    if (records.length === 0) {
      await ctx.reply(
        '⚠️ Connected / Incomplete Accounts (0)\n\nNo connected-only or incomplete/failed accounts found.',
        KB.adminMenu,
      );
      return;
    }

    const connectedOnlyCount = records.filter((r) => r.is_wallet_connected && r.completed_count === 0).length;
    const withIncompleteRuns = records.filter((r) => r.incomplete_count > 0).length;

    const entries = records.map((r, i) => {
      const boundIds = new Set<string>();
      if (r.agent_id_name) boundIds.add(r.agent_id_name);
      for (const a of r.incomplete_agent_ids) boundIds.add(a);
      const agentDisplay = boundIds.size > 0
        ? [...boundIds].join(', ')
        : (r.wallet_address ?? 'not bound yet');

      const stateTag =
        r.is_wallet_connected && r.completed_count === 0 && r.incomplete_count === 0
          ? 'Connected only (no run started)'
          : `Step: ${r.current_step} | Wallet: ${r.is_wallet_connected ? 'connected' : 'not connected'}`;

      const breakdownParts: string[] = [];
      if (r.stopped_count > 0) breakdownParts.push(`stopped=${r.stopped_count}`);
      if (r.failed_count > 0) breakdownParts.push(`failed=${r.failed_count}`);
      if (r.cancelled_count > 0) breakdownParts.push(`cancelled=${r.cancelled_count}`);
      const breakdown = breakdownParts.length > 0 ? ` (${breakdownParts.join(', ')})` : '';

      const reasonLine = r.last_incomplete_reason
        ? `\n    📝 Last ${r.last_incomplete_status ?? 'INCOMPLETE'}: ${r.last_incomplete_reason.slice(0, 140)}`
        : '';

      const walletLine =
        r.wallet_address && r.wallet_address !== agentDisplay
          ? `\n    💳 Wallet: ${r.wallet_address}`
          : '';

      return (
        `${i + 1}. ${formatUserLabel(r)}\n` +
        `    🤖 Agent ID / Wallet: ${agentDisplay}${walletLine}\n` +
        `    📍 ${stateTag}\n` +
        `    ✅ Completed: ${r.completed_count} | ⚠️ Incomplete runs: ${r.incomplete_count}${breakdown}` +
        reasonLine
      );
    });

    const header = [
      `⚠️ Connected-Only & Incomplete Accounts`,
      ``,
      `• Total flagged accounts: ${records.length}`,
      `• Connected only (0 completed): ${connectedOnlyCount}`,
      `• Accounts with failed/stopped/cancelled runs: ${withIncompleteRuns}`,
      ``,
    ].join('\n');

    await replyChunked(ctx, header + entries.join('\n\n'), true);
  } catch (err) {
    await replyDbDegraded(ctx, 'admin_incomplete', err);
  }
}

/** /admin_users — list all users who started the bot with connection & completion stats */
export async function handleAdminUsers(ctx: Context): Promise<void> {
  if (!(await guardAdmin(ctx))) return;
  await safeAnswerCb(ctx, 'Loading all users…');

  try {
    const users = await getAllStartedUsers();
    if (users.length === 0) {
      await ctx.reply('👥 All Users (0)\n\nNo users yet.', KB.adminMenu);
      return;
    }

    const lines = users.map((u, i) => {
      const date = new Date(u.started_at).toISOString().slice(0, 10);
      const conn = u.is_wallet_connected ? '🟢 connected' : '⚪ not connected';
      const agent = u.agent_id_name ?? (u.wallet_address ? `${u.wallet_address.slice(0, 8)}…` : 'no agent');
      return (
        `${i + 1}. ${formatUserLabel(u)}\n` +
        `    ${conn} | 🤖 ${agent} | step=${u.current_step}\n` +
        `    ✅ ${u.completed_count} completed | ⚠️ ${u.incomplete_count} incomplete | joined ${date}`
      );
    });

    await replyChunked(ctx, `👥 All Users (${users.length} total)\n\n${lines.join('\n\n')}`, true);
  } catch (err) {
    await replyDbDegraded(ctx, 'admin_users', err);
  }
}

/** /admin_stop (and /stop_bot) — pauses bot for all normal users; admin retains full access */
export async function handleAdminBotStop(ctx: Context): Promise<void> {
  if (!(await guardAdmin(ctx))) return;
  await safeAnswerCb(ctx, 'Stopping bot for users…');

  const { persisted } = await setBotPaused(true);
  const cancelledActive = cancelAllNonAdminExecutions();

  await ctx.reply(
    `🔴 Bot STOPPED for all normal users.\n\n` +
    `• Normal users: all commands, buttons, and processes are now blocked.\n` +
    `• Admin access: still fully active for configured ADMIN_ID(s).\n` +
    (cancelledActive > 0 ? `• Active non-admin jobs cancelled: ${cancelledActive}\n` : '') +
    `• Persistence: ${persisted ? 'Saved to database (survives restarts)' : 'Active in memory (DB degraded)'}\n\n` +
    `Use /admin_start or tap "▶️ Start Bot (Users)" to re-enable the bot for everyone.`,
    KB.adminMenu,
  );
}

/** /admin_start, /start_bot, /admin_resume — clears Emergency Auto-Shutdown & pause, re-enabling the bot for all users */
export async function handleAdminBotStart(ctx: Context): Promise<void> {
  return handleAdminResume(ctx);
}

export async function handleAdminResume(ctx: Context): Promise<void> {
  if (!(await guardAdmin(ctx))) return;
  await safeAnswerCb(ctx, 'Resuming bot operations…');

  const wasEmergency = isEmergencyShutdown();
  const prevReason = getEmergencyShutdownReason();
  const [emergRes, pauseRes, walletHealth] = await Promise.all([
    setEmergencyShutdown(false),
    setBotPaused(false),
    getAdminWalletStatus().catch(() => null),
  ]);

  const persisted = emergRes.persisted && pauseRes.persisted;
  const walletNote = walletHealth?.connected && walletHealth.address
    ? `• Admin Agent Wallet: 🟢 Connected (${walletHealth.address})\n` +
      `• Treasury Balance: ${Number(ethers.formatUnits(walletHealth.usdtBalanceWei, TOKEN_DECIMALS)).toFixed(4)} USDT | ${Number(ethers.formatEther(walletHealth.bnbBalanceWei)).toFixed(6)} BNB`
    : `• ⚠️ Warning: Admin Agent Wallet is currently NOT connected (${walletHealth?.error ?? 'run /admin_wallet to pair'}). Auto-payouts will trigger Emergency Shutdown if a claim occurs before connecting & funding it!`;

  await ctx.reply(
    `🟢 Bot RESUMED and active for everyone.\n\n` +
    (wasEmergency ? `• Cleared Emergency Auto-Shutdown (previous reason: ${prevReason ?? 'n/a'}).\n` : '') +
    `• Normal users: all commands, executions, and reward claims are enabled.\n` +
    `• Withdraw Reward Amount: ${getWithdrawAmountUsdt()} USDT (BEP-20) per claim\n` +
    `${walletNote}\n` +
    `• Persistence: ${persisted ? 'Saved to database (survives restarts)' : 'Active in memory (DB degraded)'}`,
    KB.adminMenu,
  );
}

/** /admin_wallet or "💼 Connect Admin Wallet" — pairs the dedicated Admin Agent Wallet (treasury) via baw */
export async function handleAdminConnectWallet(ctx: Context): Promise<void> {
  if (!(await guardAdmin(ctx))) return;
  await safeAnswerCb(ctx, 'Checking Admin Agent Wallet…');

  if (!bawAvailable()) {
    await ctx.reply(
      '❌ @binance/agentic-wallet CLI binary is not installed on this server. Run "npm ci" and restart.',
      KB.adminMenu,
    );
    return;
  }

  try {
    let session = await generateAdminWalletPairingUri();
    if (!session) {
      await ctx.reply('❌ Could not start Admin Agent Wallet pairing via baw CLI. Check server logs.', KB.adminMenu);
      return;
    }

    if (session.walletAddress) {
      const health = await getAdminWalletStatus();
      if (!health.connected || health.sessionExpired) {
        // Stale baw session — sign out cleanly and generate a fresh pairing QR immediately
        await disconnectAdminWallet();
        session = await generateAdminWalletPairingUri();
        if (!session) {
          await ctx.reply('❌ Previous Admin Agent Wallet session expired and could not generate a new QR. Try again.', KB.adminMenu);
          return;
        }
      } else {
        const usdtText = health.balanceReadOk
          ? `${Number(ethers.formatUnits(health.usdtBalanceWei, health.usdtDecimals)).toFixed(4)} USDT`
          : 'RPC read failed (retry /admin)';
        const bnbText = health.balanceReadOk
          ? `${Number(ethers.formatEther(health.bnbBalanceWei)).toFixed(6)} BNB`
          : 'RPC read failed (retry /admin)';
        const devText =
          health.devModeEnabled === true && !health.devModeExpired && !health.devModeBalanceExceeded && !health.quotaExhausted
            ? 'ON ✅'
            : '⚠️ Check Developer Mode / Quota in Binance App';
        await ctx.reply(
          `✅ Admin Agent Wallet is ALREADY connected!\n\n` +
          `• Address (BSC): ${session.walletAddress}\n` +
          `• BEP-20 USDT (${ADDR.USDT.slice(0, 10)}…): ${usdtText}\n` +
          `• BNB Gas: ${bnbText}\n` +
          `• Dev Mode: ${devText}\n` +
          `• Withdraw Amount: ${getWithdrawAmountUsdt()} USDT per claim\n\n` +
          `To switch to a different Admin Agent Wallet, run /admin_wallet_disconnect first.`,
          KB.adminMenu,
        );
        return;
      }
    }

    const expiresMin = Math.max(1, Math.round((session.expireAt - Date.now()) / 60_000));
    try {
      const qrBuf = await generateQrBuffer(session.urlForWeb);
      await ctx.replyWithPhoto(
        { source: qrBuf, filename: 'admin_wallet_connect.png' },
        {
          caption:
            `💼 Connect Admin Agent Wallet (Auto-Payment Treasury)\n\n` +
            `Scan with the Admin Binance App (keep BEP-20 USDT + BNB for gas & Developer Mode ON).\n` +
            (session.pairingCode ? `Pairing code: ${session.pairingCode}\n` : '') +
            `Expires in: ${expiresMin} min\n\n` +
            `Or open: ${session.urlForWeb}\n\n` +
            `✅ Confirmation will arrive automatically once approved.`,
        },
      );
    } catch {
      await ctx.reply(`💼 Open in Admin Binance app to connect Treasury Wallet:\n${session.urlForWeb}`, KB.adminMenu);
    }

    verifyAndBindAdminWalletSession(
      session.qrCodeId,
      async (connected) => {
        try {
          const health = await getAdminWalletStatus();
          await ctx.reply(
            `✅ Admin Agent Wallet Connected!\n\n` +
            `• Treasury Address (BSC): ${connected.walletAddress}\n` +
            `• BEP-20 USDT Balance: ${Number(ethers.formatUnits(health.usdtBalanceWei, TOKEN_DECIMALS)).toFixed(4)} USDT\n` +
            `• BNB Gas Balance: ${Number(ethers.formatEther(health.bnbBalanceWei)).toFixed(6)} BNB\n` +
            `• Dev Mode: ${health.devModeEnabled === true && !health.devModeExpired ? 'ON ✅' : '⚠️ Ensure Developer Mode is ON in Binance App'}\n` +
            `• Current Withdraw Amount: ${getWithdrawAmountUsdt()} USDT per claim\n\n` +
            (isEmergencyShutdown() ? `⚠️ Emergency Auto-Shutdown is currently active. Tap "✅ Resume / Start Bot" or run /admin_resume to re-enable users.` : `Auto-payment system is ready.`),
            KB.adminMenu,
          );
        } catch (err) {
          logger.warn({ err }, 'Could not send admin wallet connected notice');
        }
      },
      async (reason) => {
        try {
          await ctx.reply(`❌ Admin Agent Wallet pairing failed:\n${reason}`, KB.adminMenu);
        } catch { /* ignore */ }
      },
    );
  } catch (err) {
    logger.error({ err }, 'handleAdminConnectWallet error');
    await ctx.reply('❌ Failed to start Admin Agent Wallet pairing.', KB.adminMenu);
  }
}

/** /admin_wallet_disconnect — signs out the Admin Agent Wallet so another treasury wallet can be paired */
export async function handleAdminDisconnectWallet(ctx: Context): Promise<void> {
  if (!(await guardAdmin(ctx))) return;
  await safeAnswerCb(ctx, 'Disconnecting Admin Wallet…');
  await disconnectAdminWallet();
  await ctx.reply(
    '🔌 Admin Agent Wallet disconnected.\n\nUse "💼 Connect Admin Wallet" or /admin_wallet to pair a new treasury wallet before resuming auto-payments.',
    KB.adminMenu,
  );
}

/**
 * /admin_withdraw [amount] or "💵 Adjust Withdraw Amount" button —
 * lets admin configure how many BEP-20 USDT ($) a user receives per completed claim.
 */
export async function handleAdminAdjustWithdraw(ctx: Context): Promise<void> {
  if (!(await guardAdmin(ctx))) return;
  const adminId = ctx.from?.id;
  if (!adminId) return;

  // Check if called as `/admin_withdraw 1.5` with inline argument
  const rawText = (ctx.message as { text?: string } | undefined)?.text?.trim() ?? '';
  const argMatch = rawText.match(/^\/admin_withdraw(?:@\S+)?\s+(.+)$/i);
  if (argMatch && argMatch[1]) {
    awaitingWithdrawAmountAdmins.delete(adminId);
    const res = await setWithdrawAmountUsdt(argMatch[1]);
    if (!res.ok) {
      await ctx.reply(`❌ ${res.error}`, KB.adminMenu);
      return;
    }
    await ctx.reply(
      `✅ অ্যাডজাস্ট উইথড্র অ্যামাউন্ট আপডেট হয়েছে! (Withdraw Amount Updated)\n\n` +
      `• New Reward per Claim: ${res.amount} USDT (BEP-20)\n` +
      `• Persistence: ${res.persisted ? 'Saved to database (survives restarts)' : 'Saved in memory (DB degraded)'}`,
      KB.adminMenu,
    );
    return;
  }

  await safeAnswerCb(ctx, 'Enter new USDT reward amount');
  awaitingWithdrawAmountAdmins.add(adminId);

  await ctx.reply(
    `💵 অ্যাডজাস্ট উইথড্র অ্যামাউন্ট (Adjust Withdraw Amount)\n\n` +
    `• Current Reward per Claim: ${getWithdrawAmountUsdt()} USDT (BEP-20)\n\n` +
    `নতুন USDT ($) পরিমাণ লিখে পাঠান (যেমন: 1, 1.5, 2.25) অথবা বাতিল করতে "cancel" লিখুন।\n` +
    `(Reply with the new USDT reward amount per completed claim, or type "cancel" to abort.)`,
  );
}

/**
 * Intercepts admin text input while awaiting a new Withdraw Amount (BEP-20 USDT).
 * Returns `true` if consumed.
 */
export async function handleAdminWithdrawAmountInput(ctx: Context, rawText: string): Promise<boolean> {
  const adminId = ctx.from?.id;
  if (!adminId || !isAdminId(adminId) || !awaitingWithdrawAmountAdmins.has(adminId)) {
    return false;
  }

  const trimmed = rawText.trim();
  if (/^(cancel|বাতিল)$/i.test(trimmed)) {
    awaitingWithdrawAmountAdmins.delete(adminId);
    await ctx.reply(
      `❌ Withdraw amount update cancelled. Current amount remains ${getWithdrawAmountUsdt()} USDT.`,
      KB.adminMenu,
    );
    return true;
  }

  const res = await setWithdrawAmountUsdt(trimmed);
  if (!res.ok) {
    await ctx.reply(`❌ ${res.error}\n\nTry again (e.g. 1.5) or type "cancel".`);
    return true;
  }

  awaitingWithdrawAmountAdmins.delete(adminId);
  await ctx.reply(
    `✅ অ্যাডজাস্ট উইথড্র অ্যামাউন্ট আপডেট হয়েছে! (Withdraw Amount Updated)\n\n` +
    `• New Reward per Claim: ${res.amount} USDT (BEP-20)\n` +
    `• Persistence: ${res.persisted ? 'Saved to database (survives restarts)' : 'Saved in memory (DB degraded)'}`,
    KB.adminMenu,
  );
  return true;
}
