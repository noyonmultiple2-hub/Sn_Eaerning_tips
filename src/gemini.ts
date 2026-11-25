// src/gemini.ts
// Gemini AI client — intent routing and user-facing response generation.
// Uses @google/genai Interactions API (function calling / tool routing).

import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';
import { logger } from './logger.js';

const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

// ─── Tool definitions ─────────────────────────────────────────────────────────
// Gemini routes user NL input to one of these intents.

const INTENT_TOOLS = [
  {
    type: 'function' as const,
    name: 'connect_wallet',
    description: 'User wants to connect their Binance wallet or start pairing.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function' as const,
    name: 'generate_qr',
    description: 'User wants to see a QR code to scan with their Binance app.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function' as const,
    name: 'complete_process',
    description:
      'User wants to preview or execute the JAGER ($JAGENT) full mint-sell-revoke-claim cycle on BSC.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function' as const,
    name: 'my_jobs',
    description: 'User wants to see their own status, completed jobs, incomplete/failed attempts, or bound Agent IDs.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function' as const,
    name: 'cancel',
    description: 'User wants to cancel or reset their current session.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function' as const,
    name: 'general_reply',
    description:
      'User sent a general message; respond helpfully without triggering a flow.',
    parameters: {
      type: 'object',
      properties: {
        reply: { type: 'string', description: 'The helpful reply text.' },
      },
      required: ['reply'],
    },
  },
];

export type Intent =
  | 'connect_wallet'
  | 'generate_qr'
  | 'complete_process'
  | 'my_jobs'
  | 'cancel'
  | 'general_reply';

export interface IntentResult {
  intent: Intent;
  reply?: string; // set for general_reply
}

const SYSTEM_INSTRUCTION = `You are the assistant for a Telegram bot that automates the JAGER ($JAGENT) One-Confirm Full Cycle on BNB Smart Chain (chainId 56): exact USDT approve, 10-share mint with fixed referrer noyonislam.ai, immediate JAGENT→USDT PancakeSwap V2 sell, USDT allowance revoke, and invite reward claim.
Your job is to classify user intent and route it to the correct action.
Never ask the user for seed phrases, private keys, or to send USDT or BNB directly to any contract address.
Be concise, friendly, and security-conscious.
Always respond in the same language the user writes in.`;

function isGeminiRateLimitError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err ?? '');
  return /429|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(msg);
}

/**
 * Routes a user message to an intent using Gemini function calling.
 * Falls back to 'general_reply' if no tool is called.
 */
export async function routeIntent(
  userMessage: string,
  conversationHistory: Array<{ role: 'user' | 'model'; text: string }> = [],
): Promise<IntentResult> {
  try {
    const historySteps = conversationHistory.flatMap((turn) => [
      {
        type: turn.role === 'user' ? ('user_input' as const) : ('model_output' as const),
        content: [{ type: 'text' as const, text: turn.text }],
      },
    ]);

    const input =
      historySteps.length > 0
        ? [...historySteps, { type: 'user_input' as const, content: [{ type: 'text' as const, text: userMessage }] }]
        : userMessage;

    const response = await ai.interactions.create({
      model: 'gemini-3.8-flash',
      input,
      system_instruction: SYSTEM_INSTRUCTION,
      tools: INTENT_TOOLS,
      store: false,
    });

    for (const step of response.steps ?? []) {
      if (step.type === 'function_call') {
        const intent = step.name as Intent;
        const args = step.arguments as Record<string, unknown> | undefined;
        logger.info({ intent, args }, 'Gemini routed intent');
        return {
          intent,
          reply: typeof args?.reply === 'string' ? args.reply : undefined,
        };
      }
    }

    const text = response.output_text ?? 'How can I help you?';
    return { intent: 'general_reply', reply: text };
  } catch (err) {
    if (isGeminiRateLimitError(err)) {
      logger.warn({ err }, 'Gemini free-tier rate limit / quota reached in routeIntent');
      return {
        intent: 'general_reply',
        reply: 'AI assistant is temporarily rate-limited. Please use the buttons below directly.',
      };
    }
    logger.error({ err }, 'Gemini routeIntent failed');
    return { intent: 'general_reply', reply: 'Sorry, I had trouble understanding that. Please use the buttons below.' };
  }
}

// ─── Final Report / Summary Generation ───────────────────────────────────────

export interface ExecutionSummaryInput {
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
  claimAttempts?: number;
  claimMaxAttempts?: number;
  claimStatusNote?: string;
  payoutWalletAddress?: string;
  payoutMode?: 'CUSTOM_BEP20' | 'AGENT_WALLET_SKIPPED';
  skippedToAgentWallet?: boolean;
  rewardClaimAmountUsdt?: string;
  rewardClaimStatus?: 'PAID' | 'MANUAL_REVIEW' | 'FAILED_SYSTEM' | 'PENDING';
  rewardClaimTxHash?: string;
  status: 'COMPLETED' | 'STOPPED' | 'FAILED';
  stopReason?: string;
}

/**
 * Formats a clean, lightweight plain-text final execution report instantaneously
 * from verified run data (no external LLM network round-trip latency).
 */
export async function generateExecutionSummary(
  data: ExecutionSummaryInput,
): Promise<string> {
  return formatFastExecutionSummary(data);
}

function formatNumber(raw: string, decimals = 4): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

export function formatFastExecutionSummary(data: ExecutionSummaryInput): string {
  const pnlNum  = Number(data.netLossOrFeeUsdt);
  const pnlSign = Number.isFinite(pnlNum) && pnlNum > 0 ? '+' : '';
  const header  =
    data.status === 'COMPLETED'
      ? '✅ JAGER Full Cycle Completed!'
      : data.status === 'STOPPED'
        ? '⚠️ JAGER Cycle Stopped'
        : '❌ JAGER Cycle Failed';

  const lines = [
    header,
    ``,
    `🤖 Agent ID: ${data.agentId}`,
    `💳 Wallet: ${data.walletAddress}`,
    ``,
    `💰 Mint Cost (10 shares): ${data.mintCostUsdt} USDT`,
    `🪙 JAGENT Minted & Sold: ${formatNumber(data.tokensReceived, 2)} JAGENT`,
    `💵 USDT Received from Sell: ${data.sellUsdt} USDT`,
    `📊 Net Loss / Fees: ${pnlSign}${data.netLossOrFeeUsdt} USDT`,
  ];

  if (data.inviteRewardUsdt && Number(data.inviteRewardUsdt) > 0) {
    lines.push(`🎁 Invite Reward Claimed: +${data.inviteRewardUsdt} USDT`);
  }

  if (data.payoutWalletAddress) {
    const isSkipped =
      data.skippedToAgentWallet === true || data.payoutMode === 'AGENT_WALLET_SKIPPED';
    const modeLabel = isSkipped
      ? 'Agent Wallet (স্কিপ করা হয়েছে / Skipped to Agent Wallet)'
      : 'Custom BEP-20 Wallet (সাবমিট করা BEP-20 ওয়ালেট)';
    lines.push(
      ``,
      `💸 পেমেন্ট ওয়ালেট ও রিওয়ার্ড (Payment & Reward):`,
      `• Address (BEP-20): ${data.payoutWalletAddress}`,
      `• Mode: ${modeLabel}`,
    );
    if (data.rewardClaimAmountUsdt) {
      lines.push(`• Reward Amount: ${data.rewardClaimAmountUsdt} USDT (BEP-20)`);
    }
    if (data.rewardClaimStatus === 'PAID') {
      lines.push(`• Payment Status: ✅ অটো পেমেন্ট সম্পন্ন (Auto-Paid Successfully)`);
      if (data.rewardClaimTxHash) {
        lines.push(`• Payout TX Hash: ${data.rewardClaimTxHash}`);
      }
    } else if (data.rewardClaimStatus === 'MANUAL_REVIEW') {
      lines.push(`• Payment Status: ⚠️ ম্যানুয়াল পেমেন্ট রিভিউতে পাঠানো হয়েছে (Sent for Manual Payment Review)`);
    } else if (data.rewardClaimStatus === 'FAILED_SYSTEM') {
      lines.push(`• Payment Status: ⏳ অটো পেমেন্ট সাময়িকভাবে পেন্ডিং (Pending System Recovery)`);
    }
  }

  lines.push(
    ``,
    `🔗 Transaction Hashes (BSC):`,
    `• approve (USDT): ${data.approveTxHash || 'N/A'}`,
    `• mint (10 shares): ${data.mintTxHash || 'N/A'}`,
  );

  if (data.sellApproveTxHash) {
    lines.push(`• sell_approve (JAGENT): ${data.sellApproveTxHash}`);
  }

  lines.push(
    `• sell (JAGENT → USDT): ${data.sellTxHash || 'N/A'}`,
    `• revoke (USDT → 0): ${data.revokeTxHash || 'N/A'}`,
    `• claim (Referral Reward): ${data.claimTxHash || 'N/A'}`,
  );

  if (data.claimAttempts != null && data.claimAttempts > 0) {
    const cap = data.claimMaxAttempts ?? 50;
    const detail = data.claimStatusNote ? ` — ${data.claimStatusNote}` : '';
    lines.push(`• Referral Claim Attempts: ${data.claimAttempts}/${cap}${detail}`);
  }

  if (data.stopReason) {
    lines.push(``, `⚠️ Note: ${data.stopReason}`);
  }

  return lines.join('\n');
}
