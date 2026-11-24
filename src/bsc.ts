// src/bsc.ts
// ═══════════════════════════════════════════════════════════════════════
// LAYER 2: Chain Layer — BSC RPC reads, JAGER live API & calldata building
//          (BNB Smart Chain Mainnet — chainId: 56)
//
// All on-chain READS use ethers.js directly (read-only, no signing needed).
// All on-chain WRITES are built here as calldata and executed in executor.ts
// via wallet.ts → executeContractCall() → baw contract-call.
//
// JAGER / $JAGENT Contracts (verified on BSC chainId 56 via Sourcify):
//   USDT           = 0x55d398326f99059fF775485246999027B3197955 (18 decimals)
//   MINT_CONTRACT  = 0x3643A907f875fA9B740e1C0747E91b5aA5222aB8 (JagentMintV2)
//   JAGENT_TOKEN   = 0x8e6442663A4F8C50b6132c68d42A30E7DFE4Ae15 (JagentTokenV2, 18 decimals)
//   PAIR           = 0xE6efCdEf2b720d1eca2b69eDB7ef357725680BEa (JAGENT/USDT PancakeSwap V2)
//   PANCAKE_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E
//   WBNB           = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
//   REFERRER       = 0x85377229b28515432cCF1e1c4999BB71C9AdBE11 (noyonislam.ai — NEVER change)
// ═══════════════════════════════════════════════════════════════════════

import { ethers } from 'ethers';
import { config } from './config.js';
import { logger } from './logger.js';

// ─── Provider (read-only) ─────────────────────────────────────────────────────

export const provider = new ethers.JsonRpcProvider(config.BSC_RPC_URL, {
  chainId: 56,
  name: 'bnb',
});

// ─── Address Normalization (EIP-55 safe for ethers v6) ───────────────────────

/**
 * Validates a 20-byte EVM hex address and returns its canonical EIP-55 checksummed
 * representation by lowercasing first so mis-cased mixed-case literals never throw
 * ethers v6 `bad address checksum` (INVALID_ARGUMENT).
 */
export function normalizeAddress(raw: string, label = 'address'): string {
  const trimmed = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    throw new Error(`Invalid EVM ${label}: "${raw}"`);
  }
  const normalized = ethers.getAddress(trimmed.toLowerCase());
  if (trimmed !== normalized) {
    logger.info(
      { label, original: trimmed, normalized },
      'Normalized EVM address to canonical EIP-55 checksum',
    );
  }
  return normalized;
}

// ─── Addresses & Platform Constants (all EIP-55 normalized at load time) ─────

export const ADDR = {
  USDT:           normalizeAddress('0x55d398326f99059fF775485246999027B3197955', 'ADDR.USDT'),
  MINT_CONTRACT:  normalizeAddress('0x3643A907f875fA9B740e1C0747E91b5aA5222aB8', 'ADDR.MINT_CONTRACT'),
  JAGENT_TOKEN:   normalizeAddress('0x8e6442663A4F8C50b6132c68d42A30E7DFE4Ae15', 'ADDR.JAGENT_TOKEN'),
  PAIR:           normalizeAddress('0xE6efCdEf2b720d1eca2b69eDB7ef357725680BEa', 'ADDR.PAIR'),
  PANCAKE_ROUTER: normalizeAddress('0x10ED43C718714eb63d5aA57B78B54704E256024E', 'ADDR.PANCAKE_ROUTER'),
  WBNB:           normalizeAddress('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', 'ADDR.WBNB'),
  REFERRER:       normalizeAddress('0x85377229b28515432cCF1e1c4999BB71C9AdBE11', 'ADDR.REFERRER'), // noyonislam.ai — NEVER change
} as const;

export const REFERRER_NAME         = 'noyonislam.ai' as const;
export const PLATFORM_REF_URL      = 'https://jager.live/?ref=noyonislam.ai' as const;
export const JAGER_STATS_API       = 'https://jager.live/api/stats' as const;
export const JAGER_STATUS_API      = 'https://jager.live/api/agent/status' as const;
export const JAGER_INVITE_API      = 'https://jager.live/api/invite-rewards' as const;

/** CRITICAL: Every JAGER mint MUST be exactly 10 shares in ONE transaction. */
export const MINT_SHARES           = 10n;
/** 2% slippage headroom for USDT approve & mint maxCost (`live_price * 10 * 1.02`). */
export const MAX_COST_BPS          = 10_200n;
/** Mandatory stop condition: stop if sell quote is > 8% below mint cost (`sell_quote < mint_cost * 0.92`). */
export const MIN_SELL_RATIO_BPS    = 9_200n;
export const MAX_SELL_LOSS_PCT     = 8;
/** Verified JagentTokenV2 sell tax: SELL_BURN_BPS (100) + SELL_KEEP_BPS (100) = 200 bps (2%). */
export const JAGENT_SELL_TAX_BPS   = 200n;
/** Verified JagentMintV2 curve discount: buyers receive tokens at 99% of pool price (9900 bps). */
export const JAGENT_MINT_PRICE_BPS = 9_900n;
/** BSC USDT & JAGENT both use 18 decimals. */
export const TOKEN_DECIMALS        = 18;

/** Minimum BNB required for LOW/MEDIUM gas across the 4-5 cycle transactions. */
export const MIN_BNB_GAS           = ethers.parseEther('0.003');
export const RECOMMENDED_BNB_GAS   = ethers.parseEther('0.005');

// ─── Verified ABIs (JagentMintV2 + JagentTokenV2 on BSC chainId 56) ──────────

const JAGENT_MINT_ABI = [
  'function costOf(uint256 shares) external view returns (uint256 cost)',
  'function totalMinted() external view returns (uint256)',
  'function TOTAL_SHARES() external view returns (uint256)',
  'function BASE_PER_ID() external view returns (uint256)',
  'function MAX_PER_TX() external view returns (uint256)',
  'function MINT_PRICE_BPS() external view returns (uint256)',
  'function paused() external view returns (bool)',
  'function opened() external view returns (bool)',
  'function registrar() external view returns (address)',
  'function pair() external view returns (address)',
  'function reserves() external view returns (uint256 rUsdt, uint256 rToken)',
  'function paidOnce(uint256 agentTokenId) external view returns (bool)',
  'function mintedCount(uint256 agentTokenId) external view returns (uint256)',
  'function quotaOf(uint256 agentTokenId) external view returns (uint256)',
  // Selector 0x836a1040 — non-payable USDT mint
  'function mint(uint256 shares, address referrer, uint256 maxCost) external',
  'event Minted(address indexed minter, uint256 indexed agentTokenId, uint256 firstSerial, uint256 shares, uint256 paid)',
  'error Paused()',
  'error BadShares()',
  'error SoldOut()',
  'error NoAgent()',
  'error Quota()',
  'error OverMaxCost()',
  'error BadPayment()',
  'error StalePrice()',
  'error SwapShort()',
  'error NotOpen()',
  'error ZeroAddress()',
  'error SafeERC20FailedOperation(address token)',
  'error ReentrancyGuardReentrantCall()',
];

const AGENT_REGISTRY_ABI = [
  'function handleOf(address owner) external view returns (string memory)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
];

const ERC20_ABI = [
  'function balanceOf(address owner) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error PoolRejected()',
  'error TransfersClosed()',
];

const ROUTER_ABI = [
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external',
  'function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory)',
];

// ─── Read-only contract interfaces ───────────────────────────────────────────

const mintIface   = new ethers.Interface(JAGENT_MINT_ABI);
const erc20Iface  = new ethers.Interface(ERC20_ABI);
const routerIface = new ethers.Interface(ROUTER_ABI);

function mintContract()   { return new ethers.Contract(ADDR.MINT_CONTRACT,  JAGENT_MINT_ABI, provider); }
function usdtContract()   { return new ethers.Contract(ADDR.USDT,           ERC20_ABI,       provider); }
function jagentContract() { return new ethers.Contract(ADDR.JAGENT_TOKEN,   ERC20_ABI,       provider); }
function routerContract() { return new ethers.Contract(ADDR.PANCAKE_ROUTER, ROUTER_ABI,      provider); }

let cachedRegistrarAddress: string | null = null;

async function getAgentRegistryContract(): Promise<ethers.Contract | null> {
  try {
    if (!cachedRegistrarAddress) {
      const regAddr = String(await mintContract().registrar());
      if (regAddr && regAddr !== ethers.ZeroAddress) {
        cachedRegistrarAddress = normalizeAddress(regAddr, 'JagentMintV2.registrar');
      }
    }
    return cachedRegistrarAddress
      ? new ethers.Contract(cachedRegistrarAddress, AGENT_REGISTRY_ABI, provider)
      : null;
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'Failed to resolve JagentMintV2.registrar()');
    return null;
  }
}

// ─── Live JAGER HTTP APIs (NEVER cached) ──────────────────────────────────────

export interface JagerLiveStats {
  priceUsdtPerShare: number;
  pricePerShareWei: bigint;
  /** Exact 10-share mint cost in USDT wei (18 decimals). */
  mintCostUsdtWei: bigint;
  /** Exact USDT approve & mint maxCost = mintCostUsdtWei * 1.02 (18 decimals). */
  maxCostUsdtWei: bigint;
  tokensPerShare: number;
  totalMinted: number;
  mintingOpen: boolean;
  paused: boolean;
  sharesPerMint: number;
  pairAddress: string;
}

/**
 * Fetches LIVE price and mint status directly from https://jager.live/api/stats.
 * Never caches results; also cross-checks on-chain `costOf(10)` so `maxCost`
 * (`live_price * 10 * 1.02`) cannot under-approve across a tier boundary.
 */
export async function fetchJagerLiveStats(): Promise<JagerLiveStats> {
  const url = `${JAGER_STATS_API}?_t=${Date.now()}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch live JAGER stats (HTTP ${res.status})`);
  }
  const raw = (await res.json()) as Record<string, unknown>;

  const priceNum = Number(raw.priceUsdtPerShare);
  if (!Number.isFinite(priceNum) || priceNum <= 0) {
    throw new Error(`Invalid live priceUsdtPerShare from jager.live/api/stats: ${String(raw.priceUsdtPerShare)}`);
  }

  // Convert exact decimal string to 18-decimal USDT wei without float rounding drift
  const rawPriceStr = typeof raw.priceUsdtPerShare === 'string' ? raw.priceUsdtPerShare.trim() : '';
  const priceStr = /^\d+(\.\d{1,18})?$/.test(rawPriceStr)
    ? rawPriceStr
    : priceNum.toFixed(6).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
  const pricePerShareWei = ethers.parseUnits(priceStr, TOKEN_DECIMALS);
  const apiCost10Wei     = pricePerShareWei * MINT_SHARES;

  // Cross-check on-chain costOf(10) in case a price tier just ticked over
  let onChainCost10Wei = 0n;
  try {
    onChainCost10Wei = await readCostOf(MINT_SHARES);
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'readCostOf(10) fallback to API live price');
  }

  const mintCostUsdtWei = onChainCost10Wei > apiCost10Wei ? onChainCost10Wei : apiCost10Wei;
  const maxCostUsdtWei  = (mintCostUsdtWei * MAX_COST_BPS + 9_999n) / 10_000n;

  const tokensPerShare = Number(raw.tokensPerShare ?? 0);
  const totalMinted    = Number(raw.totalMinted ?? 0);
  const mintingOpen    = raw.mintingOpen !== false;
  const paused         = raw.paused === true;
  const sharesPerMint  = Number(raw.sharesPerMint ?? 10);
  const pairAddress    = typeof raw.pair === 'string' && /^0x[0-9a-fA-F]{40}$/.test(raw.pair)
    ? normalizeAddress(raw.pair, 'stats.pair')
    : ADDR.PAIR;

  logger.info(
    {
      priceUsdtPerShare: priceNum,
      apiCost10Usdt: ethers.formatUnits(apiCost10Wei, TOKEN_DECIMALS),
      onChainCost10Usdt: onChainCost10Wei > 0n ? ethers.formatUnits(onChainCost10Wei, TOKEN_DECIMALS) : null,
      mintCostUsdt: ethers.formatUnits(mintCostUsdtWei, TOKEN_DECIMALS),
      maxCostUsdt: ethers.formatUnits(maxCostUsdtWei, TOKEN_DECIMALS),
      tokensPerShare,
      totalMinted,
      mintingOpen,
      paused,
    },
    'Fetched live JAGER stats',
  );

  return {
    priceUsdtPerShare: priceNum,
    pricePerShareWei,
    mintCostUsdtWei,
    maxCostUsdtWei,
    tokensPerShare: Number.isFinite(tokensPerShare) && tokensPerShare > 0 ? tokensPerShare : 0,
    totalMinted: Number.isFinite(totalMinted) ? totalMinted : 0,
    mintingOpen,
    paused,
    sharesPerMint,
    pairAddress,
  };
}

export interface JagerAgentStatusApi {
  agentId: string | null;
  minted: number | null;
  quota: number | null;
  remaining: number | null;
  open: boolean | null;
  siteEntryOpen: boolean | null;
  pendingUsdt: number;
  paidUsdt: number;
}

/** Queries live wallet status from https://jager.live/api/agent/status?address=<wallet>. */
export async function fetchJagerAgentStatus(rawWalletAddress: string): Promise<JagerAgentStatusApi | null> {
  try {
    const wallet = normalizeAddress(rawWalletAddress, 'jagerStatus.wallet');
    const url = `${JAGER_STATUS_API}?address=${encodeURIComponent(wallet)}&_t=${Date.now()}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const raw = (await res.json()) as Record<string, unknown>;
    const mint   = (raw.mint   && typeof raw.mint   === 'object' ? raw.mint   : {}) as Record<string, unknown>;
    const invite = (raw.invite && typeof raw.invite === 'object' ? raw.invite : {}) as Record<string, unknown>;

    return {
      agentId: typeof raw.agentId === 'string' && raw.agentId.trim() ? raw.agentId.trim() : null,
      minted: mint.minted != null && Number.isFinite(Number(mint.minted)) ? Number(mint.minted) : null,
      quota: mint.quota != null && Number.isFinite(Number(mint.quota)) ? Number(mint.quota) : null,
      remaining: mint.remaining != null && Number.isFinite(Number(mint.remaining)) ? Number(mint.remaining) : null,
      open: typeof mint.open === 'boolean' ? mint.open : null,
      siteEntryOpen: typeof mint.siteEntryOpen === 'boolean' ? mint.siteEntryOpen : null,
      pendingUsdt: Number.isFinite(Number(invite.pendingUsdt)) ? Number(invite.pendingUsdt) : 0,
      paidUsdt: Number.isFinite(Number(invite.paidUsdt)) ? Number(invite.paidUsdt) : 0,
    };
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'fetchJagerAgentStatus failed (non-fatal)');
    return null;
  }
}

export interface InviteRewardsStatus {
  ok: boolean;
  httpStatus?: number;
  rateLimited?: boolean;
  error?: string;
  pendingUsdt: number;
  paidUsdt: number;
  rewardsPaused: boolean;
  recentPayoutForWallet?: { hash: string; amountUsdt: string; at: number } | null;
}

/** Checks pending claimable invite rewards via https://jager.live/api/invite-rewards?address=<wallet>. */
export async function checkInviteRewards(rawWalletAddress: string): Promise<InviteRewardsStatus> {
  try {
    const wallet = normalizeAddress(rawWalletAddress, 'inviteRewards.wallet');
    const walletLower = wallet.toLowerCase();
    const url = `${JAGER_INVITE_API}?address=${encodeURIComponent(wallet)}&_t=${Date.now()}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const rateLimited = res.status === 429;
      return {
        ok: false,
        httpStatus: res.status,
        rateLimited,
        error: rateLimited ? 'HTTP 429 rate-limited by jager.live' : `HTTP ${res.status} from jager.live/api/invite-rewards`,
        pendingUsdt: 0,
        paidUsdt: 0,
        rewardsPaused: false,
        recentPayoutForWallet: null,
      };
    }
    const raw = (await res.json()) as Record<string, unknown>;
    const you = (raw.you && typeof raw.you === 'object' ? raw.you : {}) as Record<string, unknown>;

    // Pick the newest recent payout matching this wallet (largest `at` timestamp)
    let recentPayoutForWallet: { hash: string; amountUsdt: string; at: number } | null = null;
    if (Array.isArray(raw.recent)) {
      for (const item of raw.recent as Array<Record<string, unknown>>) {
        const to = typeof item?.to === 'string' ? item.to.toLowerCase() : '';
        const hash = typeof item?.hash === 'string' ? item.hash : '';
        const at = Number(item?.at ?? 0);
        if (to === walletLower && /^0x[0-9a-fA-F]{64}$/.test(hash)) {
          if (!recentPayoutForWallet || at >= recentPayoutForWallet.at) {
            recentPayoutForWallet = {
              hash,
              amountUsdt: item.n != null ? String(item.n) : '0',
              at: Number.isFinite(at) ? at : 0,
            };
          }
        }
      }
    }

    return {
      ok: true,
      httpStatus: res.status,
      pendingUsdt: Number.isFinite(Number(you.pending)) ? Number(you.pending) : 0,
      paidUsdt: Number.isFinite(Number(you.paid)) ? Number(you.paid) : 0,
      rewardsPaused: raw.rewardsPaused === true || raw.paused === true,
      recentPayoutForWallet,
    };
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    logger.warn({ err: msg }, 'checkInviteRewards request error (transient)');
    return {
      ok: false,
      error: msg,
      pendingUsdt: 0,
      paidUsdt: 0,
      rewardsPaused: false,
      recentPayoutForWallet: null,
    };
  }
}

export interface InviteRewardClaimResult {
  claimed: boolean;
  paidUsdt?: string;
  txHash?: string;
  reason?: string;
  rateLimited?: boolean;
  isPendingInFlight?: boolean;
}

/**
 * Claims pending USDT invite rewards via POST https://jager.live/api/invite-rewards.
 * Per jager.live/skill.md, no signature is required — the official payer transfers
 * pending USDT directly to the wallet and returns `{ ok: true, paid, hash }`.
 */
export async function claimInviteRewards(rawWalletAddress: string): Promise<InviteRewardClaimResult> {
  try {
    const wallet = normalizeAddress(rawWalletAddress, 'claimInviteRewards.wallet');
    const res = await fetch(JAGER_INVITE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ address: wallet }),
      signal: AbortSignal.timeout(30_000),
    });

    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    logger.info({ wallet, status: res.status, raw }, 'jager.live invite-rewards claim response');

    if (raw.ok === true && typeof raw.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(raw.hash)) {
      return {
        claimed: true,
        paidUsdt: raw.paid != null ? String(raw.paid) : undefined,
        txHash: raw.hash,
      };
    }

    const reason = String(raw.reason ?? raw.error ?? `HTTP ${res.status}`);
    const rateLimited = res.status === 429 || /too-soon|rate.?limit|429/i.test(reason);
    const isPendingInFlight = /too-soon|busy|pending/i.test(reason);
    return { claimed: false, reason, rateLimited, isPendingInFlight };
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    logger.warn({ err: msg }, 'claimInviteRewards request failed');
    return { claimed: false, reason: msg, rateLimited: /429|rate.?limit/i.test(msg) };
  }
}

// ─── On-chain READS ───────────────────────────────────────────────────────────

export async function readCostOf(shares = MINT_SHARES): Promise<bigint> {
  return BigInt(await mintContract().costOf(shares));
}

export async function readTotalMinted(): Promise<bigint> {
  return BigInt(await mintContract().totalMinted());
}

export async function readMintPaused(): Promise<boolean> {
  return Boolean(await mintContract().paused());
}

export async function readUsdtBalance(address: string): Promise<bigint> {
  const owner = normalizeAddress(address, 'readUsdtBalance.owner');
  return BigInt(await usdtContract().balanceOf(owner));
}

export async function readUsdtAllowance(
  ownerAddress: string,
  spenderAddress = ADDR.MINT_CONTRACT,
): Promise<bigint> {
  const owner   = normalizeAddress(ownerAddress, 'readUsdtAllowance.owner');
  const spender = normalizeAddress(spenderAddress, 'readUsdtAllowance.spender');
  try {
    return BigInt(await usdtContract().allowance(owner, spender));
  } catch (err) {
    logger.warn({ owner, spender, err: (err as Error)?.message }, 'readUsdtAllowance failed — returning 0');
    return 0n;
  }
}

export async function readJagentBalance(address: string): Promise<bigint> {
  const owner = normalizeAddress(address, 'readJagentBalance.owner');
  return BigInt(await jagentContract().balanceOf(owner));
}

export async function readJagentAllowance(
  ownerAddress: string,
  spenderAddress = ADDR.PANCAKE_ROUTER,
): Promise<bigint> {
  const owner   = normalizeAddress(ownerAddress, 'readJagentAllowance.owner');
  const spender = normalizeAddress(spenderAddress, 'readJagentAllowance.spender');
  try {
    return BigInt(await jagentContract().allowance(owner, spender));
  } catch (err) {
    logger.warn({ owner, spender, err: (err as Error)?.message }, 'readJagentAllowance failed — returning 0');
    return 0n;
  }
}

export async function readBnbBalance(address: string): Promise<bigint> {
  const wallet = normalizeAddress(address, 'readBnbBalance.address');
  return await provider.getBalance(wallet);
}

// ─── Receipt Polling & Log Parsing ────────────────────────────────────────────

export type ReceiptPollResult =
  | {
      state: 'confirmed';
      receipt: ethers.TransactionReceipt;
      mintedJagentFromLogs: bigint;
      mintPaidUsdtFromLogs: bigint;
      usdtReceivedFromLogs: bigint;
    }
  | { state: 'reverted'; receipt: ethers.TransactionReceipt }
  | { state: 'cancelled' }
  | { state: 'timeout' };

/**
 * Polls BSC (`chainId: 56`) for a transaction receipt while respecting user cancellation.
 * Parses confirmed (`status === 1`) receipts for:
 *   - JAGENT Transfer logs into `walletAddress` (exact tokens received from mint)
 *   - JagentMintV2 `Minted` event `paid` (exact USDT spent on mint)
 *   - USDT Transfer logs into `walletAddress` (exact USDT received from PancakeSwap sell)
 */
export async function pollTransactionReceipt(
  txHash: string,
  opts?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    walletAddress?: string;
    isCancelled?: () => boolean;
  },
): Promise<ReceiptPollResult> {
  const timeoutMs      = opts?.timeoutMs ?? 90_000;
  const pollIntervalMs = opts?.pollIntervalMs ?? 1_500;
  const targetWallet   = opts?.walletAddress
    ? normalizeAddress(opts.walletAddress, 'pollReceipt.walletAddress').toLowerCase()
    : null;
  const jagentLower    = ADDR.JAGENT_TOKEN.toLowerCase();
  const usdtLower      = ADDR.USDT.toLowerCase();
  const mintLower      = ADDR.MINT_CONTRACT.toLowerCase();
  const deadline       = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (opts?.isCancelled?.()) return { state: 'cancelled' };

    try {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt) {
        if (receipt.status === 1) {
          let mintedJagentFromLogs = 0n;
          let mintPaidUsdtFromLogs = 0n;
          let usdtReceivedFromLogs = 0n;
          let usdtSpentToMintLogs  = 0n;

          for (const log of receipt.logs) {
            const addrLower = log.address.toLowerCase();
            if (addrLower === mintLower) {
              try {
                const parsed = mintIface.parseLog({ topics: [...log.topics], data: log.data });
                if (parsed?.name === 'Minted') {
                  mintPaidUsdtFromLogs = BigInt(parsed.args[4]);
                }
              } catch { /* non-Minted log */ }
            } else if (targetWallet && addrLower === jagentLower) {
              try {
                const parsed = erc20Iface.parseLog({ topics: [...log.topics], data: log.data });
                if (parsed?.name === 'Transfer') {
                  const toAddr = String(parsed.args[1] ?? '').toLowerCase();
                  if (toAddr === targetWallet) {
                    mintedJagentFromLogs += BigInt(parsed.args[2]);
                  }
                }
              } catch { /* non-Transfer log */ }
            } else if (targetWallet && addrLower === usdtLower) {
              try {
                const parsed = erc20Iface.parseLog({ topics: [...log.topics], data: log.data });
                if (parsed?.name === 'Transfer') {
                  const fromAddr = String(parsed.args[0] ?? '').toLowerCase();
                  const toAddr   = String(parsed.args[1] ?? '').toLowerCase();
                  const val      = BigInt(parsed.args[2]);
                  if (toAddr === targetWallet) {
                    usdtReceivedFromLogs += val;
                  }
                  if (fromAddr === targetWallet && toAddr === mintLower) {
                    usdtSpentToMintLogs += val;
                  }
                }
              } catch { /* non-Transfer log */ }
            }
          }

          if (mintPaidUsdtFromLogs === 0n && usdtSpentToMintLogs > 0n) {
            mintPaidUsdtFromLogs = usdtSpentToMintLogs;
          }

          logger.info(
            {
              txHash,
              status: 1,
              blockNumber: receipt.blockNumber,
              gasUsed: receipt.gasUsed.toString(),
              mintedJagentFromLogs: mintedJagentFromLogs.toString(),
              mintPaidUsdtFromLogs: mintPaidUsdtFromLogs.toString(),
              usdtReceivedFromLogs: usdtReceivedFromLogs.toString(),
            },
            'BSC transaction receipt confirmed',
          );
          return {
            state: 'confirmed',
            receipt,
            mintedJagentFromLogs,
            mintPaidUsdtFromLogs,
            usdtReceivedFromLogs,
          };
        }

        logger.warn(
          {
            txHash,
            status: receipt.status,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
          },
          'BSC transaction receipt reverted on-chain (status=0)',
        );
        return { state: 'reverted', receipt };
      }
    } catch (err) {
      logger.warn({ txHash, err: (err as Error)?.message }, 'getTransactionReceipt transient RPC error — retrying poll');
    }

    const slice = 400;
    let slept = 0;
    while (slept < pollIntervalMs && Date.now() < deadline) {
      if (opts?.isCancelled?.()) return { state: 'cancelled' };
      const step = Math.min(slice, pollIntervalMs - slept);
      await new Promise((r) => setTimeout(r, step));
      slept += step;
    }
  }

  logger.warn({ txHash, timeoutMs }, 'pollTransactionReceipt timed out waiting for receipt');
  return { state: 'timeout' };
}

// ─── Agent ID, Freshness & Quota Checks ───────────────────────────────────────

export interface OnChainAgentQuotaInfo {
  available: boolean;
  handle: string;
  agentTokenId: bigint | null;
  ownerValid: boolean;
  mintedCount: bigint;
  quota: bigint;
  remainingQuota: bigint;
  paidOnce: boolean;
}

/**
 * Mirrors JagentMintV2.sol `_agent(address)` + `mintedCount(id)` / `quotaOf(id)` / `paidOnce(id)`:
 *   registrar.handleOf(wallet) -> id = keccak256(bytes(handle)) -> registrar.ownerOf(id) == wallet.
 */
export async function readOnChainAgentQuota(address: string): Promise<OnChainAgentQuotaInfo> {
  const wallet = normalizeAddress(address, 'readOnChainAgentQuota.address');
  const empty: OnChainAgentQuotaInfo = {
    available: false,
    handle: '',
    agentTokenId: null,
    ownerValid: false,
    mintedCount: 0n,
    quota: 0n,
    remainingQuota: 0n,
    paidOnce: false,
  };

  try {
    const registry = await getAgentRegistryContract();
    if (!registry) return empty;

    const rawHandle = String(await registry.handleOf(wallet) ?? '').trim();
    if (!rawHandle) {
      return { ...empty, available: true };
    }

    const tokenId = BigInt(ethers.keccak256(ethers.toUtf8Bytes(rawHandle)));
    let ownerValid = false;
    try {
      const owner = normalizeAddress(String(await registry.ownerOf(tokenId)), 'AgentRegistry.ownerOf');
      ownerValid = owner.toLowerCase() === wallet.toLowerCase();
    } catch {
      ownerValid = false;
    }

    const mint = mintContract();
    const [minted, quota, paidOnce] = await Promise.all([
      mint.mintedCount(tokenId).then((v: unknown) => BigInt(v as bigint | string | number)),
      mint.quotaOf(tokenId).then((v: unknown) => BigInt(v as bigint | string | number)),
      mint.paidOnce(tokenId).then((v: unknown) => Boolean(v)),
    ]);
    const remainingQuota = quota > minted ? quota - minted : 0n;

    return {
      available: true,
      handle: rawHandle,
      agentTokenId: tokenId,
      ownerValid,
      mintedCount: minted,
      quota,
      remainingQuota,
      paidOnce,
    };
  } catch (err) {
    logger.warn({ walletAddress: wallet, err: (err as Error)?.message }, 'readOnChainAgentQuota failed');
    return empty;
  }
}

export async function readSpaceIdName(address: string): Promise<string> {
  const info = await readOnChainAgentQuota(address);
  if (!info.available || !info.ownerValid || !info.handle) return '';
  return info.handle.toLowerCase().endsWith('.ai') ? info.handle : `${info.handle}.ai`;
}

/** True when the candidate is a non-empty *.ai SPACE ID Agent name (e.g. noyonislam.ai). */
export function isValidAiAgentId(name?: string | null): boolean {
  if (typeof name !== 'string') return false;
  return /^[^\s]+\.ai$/i.test(name.trim());
}

/** Maximum allowed completed JAGER full cycles per `.ai` Agent ID / Wallet. */
export const MAX_CYCLES_PER_ID = 1;

/** Clear bilingual message when a wallet / .ai Agent ID already reached its 1-time JAGER limit. */
export const JAGER_ALREADY_COMPLETED_MESSAGE = [
  `⛔ আহা অশান্তি! একটা আইডি দিয়ে কতবার করতে চাচ্ছেন?`,
  ``,
  `📌 নিয়ম (Per-ID Limit): প্রতি ১টি .ai Agent ID / Wallet দিয়ে JAGER Full Cycle সর্বোচ্চ ১ বারই (10 shares, 1 TX) করা যায়।`,
  `এই .ai আইডি / ওয়ালেট দিয়ে ইতিমধ্যেই JAGER সাইকেল সম্পন্ন হয়েছে, তাই একই আইডি দিয়ে পুনরায় করা যাবে না।`,
  ``,
  `(Limit: 1 full cycle per .ai Agent ID / Wallet on JAGER Mint Contract ${ADDR.MINT_CONTRACT.slice(0, 10)}…${ADDR.MINT_CONTRACT.slice(-4)} — already completed. Connect a fresh .ai wallet to run again.)`,
].join('\n');

export type FreshnessCode =
  | 'FRESH'
  | 'NO_AGENT_ID'
  | 'ALREADY_MINTED'
  | 'INSUFFICIENT_QUOTA'
  | 'MINT_PAUSED'
  | 'CHECK_UNAVAILABLE';

export interface WalletFreshnessResult {
  fresh: boolean;
  reasonCode: FreshnessCode;
  reason?: string;
  /** Ready-to-send bilingual user notification (Bangla + English) explaining ineligibility / per-ID limit. */
  userMessage?: string;
  agentId?: string;
  minted: bigint;
  quota: bigint;
  remaining: bigint;
  paidOnce: boolean;
}

/** Builds a clear Bangla/English "Wallet Not Eligible" or limit message for users. */
export function formatWalletNotEligibleMessage(
  code: Exclude<FreshnessCode, 'FRESH'>,
  info?: { minted?: bigint; remaining?: bigint; detail?: string },
): string {
  const mintedStr    = (info?.minted ?? 0n).toString();
  const remainingStr = (info?.remaining ?? 0n).toString();
  const shortMint    = `${ADDR.MINT_CONTRACT.slice(0, 10)}…${ADDR.MINT_CONTRACT.slice(-4)}`;

  switch (code) {
    case 'NO_AGENT_ID':
      return [
        `⛔ আপনার ওয়ালেট নট ইলিজিবল (Wallet Not Eligible)`,
        ``,
        `এই ওয়ালেটে কোনো .ai Agent ID নেই। JAGER মিন্ট করার জন্য Binance App → Agentic Wallet থেকে একটি .ai Agent ID ক্লেইম করা বাধ্যতামূলক।`,
        ``,
        `(Wallet Not Eligible: No .ai Agent ID owned by this wallet on BSC. Claim a .ai Agent ID in Binance App → Agentic Wallet first.)`,
      ].join('\n');

    case 'ALREADY_MINTED':
      return [
        `⛔ আপনার ওয়ালেট নট ইলিজিবল (Wallet Not Eligible)`,
        ``,
        `এই .ai আইডি / ওয়ালেট দিয়ে ইতিমধ্যেই JAGER কন্ট্রাক্টে মিন্ট করা হয়ে গেছে (minted: ${mintedStr}, remaining: ${remainingStr})।`,
        `📌 নিয়ম (Per-ID Limit): প্রতি ১টি .ai Agent ID / Wallet দিয়ে JAGER Full Cycle সর্বোচ্চ ১ বারই (10 shares, 1 TX) করা যায় — এবং শুধুমাত্র ফ্রেশ ওয়ালেট (minted == 0, remaining >= 10) ইলিজিবল।`,
        ``,
        `(Wallet Not Eligible: Already minted on JAGER contract ${shortMint}. Limit is 1 time per ID/wallet and requires a fresh wallet with minted == 0 and remaining >= 10.)`,
      ].join('\n');

    case 'INSUFFICIENT_QUOTA':
      return [
        `⛔ আপনার ওয়ালেট নট ইলিজিবল (Wallet Not Eligible)`,
        ``,
        `এই আইডির পর্যাপ্ত মিন্ট কোটা নেই (minted: ${mintedStr}, remaining: ${remainingStr} — এক ট্রানজেকশনে ১০ শেয়ার মিন্ট করার জন্য কমপক্ষে remaining >= 10 প্রয়োজন)।`,
        `📌 নিয়ম (Per-ID Limit): প্রতি ১টি .ai Agent ID / Wallet দিয়ে ১০ শেয়ার একবারে (1 TX) মিন্ট করতে হয় (সর্বোচ্চ ১ বার)।`,
        ``,
        `(Wallet Not Eligible: Remaining quota is ${remainingStr}, need >= 10 shares in one transaction on JAGER contract ${shortMint}.)`,
      ].join('\n');

    case 'MINT_PAUSED':
      return [
        `⛔ JAGER মিন্টিং বর্তমানে বন্ধ/পজ আছে (Minting Paused / Closed)`,
        ``,
        `jager.live অথবা JAGER মিন্ট কন্ট্রাক্টে মিন্টিং এই মুহূর্তে বন্ধ আছে। অনুগ্রহ করে পরে আবার চেষ্টা করুন।`,
      ].join('\n');

    case 'CHECK_UNAVAILABLE':
    default:
      return [
        `⚠️ এই মুহূর্তে JAGER কন্ট্রাক্ট থেকে ওয়ালেট ইলিজিবিলিটি যাচাই করা যায়নি।`,
        ``,
        `অনুগ্রহ করে একটু পর আবার চেষ্টা করুন।` + (info?.detail ? `\n(${info.detail})` : ''),
      ].join('\n');
  }
}

/**
 * Authoritative JAGER Mint V2 (`0x3643A907f875fA9B740e1C0747E91b5aA5222aB8`) eligibility & freshness check:
 *   - Wallet MUST hold a valid `.ai` Agent ID (`ownerValid === true`)
 *   - Wallet MUST be fresh: `minted == 0`, `paidOnce == false`, and `remaining >= 10`
 *   - JAGER Mint Contract & jager.live entry MUST be open & unpaused
 *
 * Returns both a structured machine reason and a ready-to-send bilingual `userMessage`
 * so `/connect`, `/mint` preview, and execution preflight stay 100% consistent.
 */
export async function checkWalletFreshness(rawWalletAddress: string): Promise<WalletFreshnessResult> {
  const walletAddress = normalizeAddress(rawWalletAddress, 'checkWalletFreshness.walletAddress');

  try {
    const [onChain, apiStatus, paused] = await Promise.all([
      readOnChainAgentQuota(walletAddress),
      fetchJagerAgentStatus(walletAddress),
      readMintPaused().catch(() => false),
    ]);

    if (paused || apiStatus?.open === false || apiStatus?.siteEntryOpen === false) {
      return {
        fresh: false,
        reasonCode: 'MINT_PAUSED',
        reason: 'JAGER minting is currently paused or closed on jager.live.',
        userMessage: formatWalletNotEligibleMessage('MINT_PAUSED'),
        minted: onChain.mintedCount,
        quota: onChain.quota,
        remaining: onChain.remainingQuota,
        paidOnce: onChain.paidOnce,
      };
    }

    const handleName =
      onChain.ownerValid && onChain.handle
        ? (onChain.handle.toLowerCase().endsWith('.ai') ? onChain.handle : `${onChain.handle}.ai`)
        : (apiStatus?.agentId ?? '');

    // Missing .ai Agent ID on BSC registrar (or confirmed absent by jager.live status API)
    if ((onChain.available && !onChain.ownerValid) || (!onChain.available && apiStatus && !apiStatus.agentId)) {
      return {
        fresh: false,
        reasonCode: 'NO_AGENT_ID',
        reason: 'No .ai Agent ID found on this wallet. Claim a .ai Agent ID in Binance App → Agentic Wallet first.',
        userMessage: formatWalletNotEligibleMessage('NO_AGENT_ID'),
        minted: 0n,
        quota: 0n,
        remaining: 0n,
        paidOnce: false,
      };
    }

    const minted    = onChain.available ? onChain.mintedCount    : BigInt(apiStatus?.minted ?? 0);
    const quota     = onChain.available ? onChain.quota          : BigInt(apiStatus?.quota ?? 0);
    const remaining = onChain.available ? onChain.remainingQuota : BigInt(apiStatus?.remaining ?? 0);
    const paidOnce  = onChain.available ? onChain.paidOnce       : minted > 0n;

    if (!onChain.available && !apiStatus) {
      const detail = 'Could not verify wallet eligibility from BSC or jager.live.';
      return {
        fresh: false,
        reasonCode: 'CHECK_UNAVAILABLE',
        reason: detail,
        userMessage: formatWalletNotEligibleMessage('CHECK_UNAVAILABLE', { detail }),
        minted: 0n,
        quota: 0n,
        remaining: 0n,
        paidOnce: false,
      };
    }

    // Strict JAGER freshness & 1-time per-ID rule: minted == 0, paidOnce == false, remaining >= 10
    if (minted > 0n || paidOnce) {
      return {
        fresh: false,
        reasonCode: 'ALREADY_MINTED',
        reason: `Wallet is not fresh — already minted ${minted.toString()} share(s) (remaining: ${remaining.toString()}). Fresh wallet with minted == 0 / remaining >= 10 is required (limit: 1 cycle per ID/wallet).`,
        userMessage: formatWalletNotEligibleMessage('ALREADY_MINTED', { minted, remaining }),
        agentId: handleName || undefined,
        minted,
        quota,
        remaining,
        paidOnce,
      };
    }

    if (remaining < MINT_SHARES) {
      return {
        fresh: false,
        reasonCode: 'INSUFFICIENT_QUOTA',
        reason: `Insufficient mint quota (minted: ${minted.toString()}, remaining: ${remaining.toString()} — need >= 10 shares in one transaction).`,
        userMessage: formatWalletNotEligibleMessage('INSUFFICIENT_QUOTA', { minted, remaining }),
        agentId: handleName || undefined,
        minted,
        quota,
        remaining,
        paidOnce,
      };
    }

    logger.info(
      {
        walletAddress,
        mintContract: ADDR.MINT_CONTRACT,
        agentId: handleName || null,
        minted: minted.toString(),
        quota: quota.toString(),
        remaining: remaining.toString(),
        paidOnce,
      },
      'JAGER wallet eligibility & freshness verified (minted == 0, remaining >= 10)',
    );

    return {
      fresh: true,
      reasonCode: 'FRESH',
      agentId: handleName || undefined,
      minted,
      quota,
      remaining,
      paidOnce,
    };
  } catch (err) {
    const detail = (err as Error)?.message ?? 'RPC error';
    logger.warn({ walletAddress, err: detail }, 'checkWalletFreshness failed');
    return {
      fresh: false,
      reasonCode: 'CHECK_UNAVAILABLE',
      reason: `Could not verify wallet eligibility: ${detail}`,
      userMessage: formatWalletNotEligibleMessage('CHECK_UNAVAILABLE', { detail }),
      minted: 0n,
      quota: 0n,
      remaining: 0n,
      paidOnce: false,
    };
  }
}

// ─── Expected Mint Output & PancakeSwap V2 Sell Quote (JAGENT → USDT) ────────

/**
 * Estimates the expected JAGENT tokens received when minting 10 shares at `mintCostUsdtWei`.
 * Uses JagentMintV2's on-chain `reserves()` and exact `_curveShare` formula
 * (`userT = pay * rToken * 10_000 / (rUsdt * 9_900)`), falling back to `apiTokensPerShare * 10`.
 */
export async function estimateExpectedJagentFor10Shares(
  mintCostUsdtWei: bigint,
  apiTokensPerShare = 0,
): Promise<bigint> {
  try {
    const [rUsdtRaw, rTokenRaw] = await mintContract().reserves();
    const rUsdt  = BigInt(rUsdtRaw);
    const rToken = BigInt(rTokenRaw);
    if (rUsdt > 0n && rToken > 0n) {
      const expected = (mintCostUsdtWei * rToken * 10_000n) / (rUsdt * JAGENT_MINT_PRICE_BPS);
      if (expected > 0n) {
        logger.debug(
          {
            rUsdt: ethers.formatUnits(rUsdt, TOKEN_DECIMALS),
            rToken: ethers.formatUnits(rToken, TOKEN_DECIMALS),
            expectedJagent: ethers.formatUnits(expected, TOKEN_DECIMALS),
          },
          'Estimated 10-share JAGENT output from JagentMintV2.reserves()',
        );
        return expected;
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'JagentMintV2.reserves() failed — using API tokensPerShare estimate');
  }

  if (apiTokensPerShare > 0 && Number.isFinite(apiTokensPerShare)) {
    const wholeTokens = Math.floor(apiTokensPerShare);
    return ethers.parseUnits(String(wholeTokens), TOKEN_DECIMALS) * MINT_SHARES;
  }

  return 0n;
}

/**
 * Simulates the JAGENT → USDT sell on PancakeSwap V2 and returns expected net USDT wei.
 *
 * Verified from JagentTokenV2.sol:
 *   - The ONLY allowed pool is the official `JAGENT / USDT` pair (`0xE6efCdEf...`);
 *     all other pairs revert with `PoolRejected()`.
 *   - Selling to the pair applies a 2% transfer tax (`SELL_BURN_BPS = 100` + `SELL_KEEP_BPS = 100`),
 *     computed identically to Solidity (`value - burnt - kept`).
 *   - `getAmountsOut(effectiveIn, [JAGENT, USDT])` then computes the exact net USDT out
 *     including PancakeSwap V2's 0.25% swap fee and pool price impact.
 *
 * When `throwOnRpcError` is true, transient RPC transport failures throw so continuous
 * retry loops can retry instead of triggering a false-positive 0-USDT stop-loss abort.
 */
export async function simulateSellOutputUsdt(
  jagentAmount: bigint,
  opts?: { throwOnRpcError?: boolean },
): Promise<bigint> {
  if (jagentAmount <= 0n) return 0n;
  const burnt       = (jagentAmount * 100n) / 10_000n;
  const kept        = (jagentAmount * 100n) / 10_000n;
  const effectiveIn = jagentAmount - burnt - kept;
  if (effectiveIn <= 0n) return 0n;

  const router = routerContract();
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const amounts: bigint[] = await router.getAmountsOut(effectiveIn, [ADDR.JAGENT_TOKEN, ADDR.USDT]);
      const netUsdtOut = BigInt(amounts[amounts.length - 1]);
      logger.debug(
        {
          jagentIn: ethers.formatUnits(jagentAmount, TOKEN_DECIMALS),
          effectiveIn: ethers.formatUnits(effectiveIn, TOKEN_DECIMALS),
          netUsdtOut: ethers.formatUnits(netUsdtOut, TOKEN_DECIMALS),
        },
        'simulateSellOutputUsdt (JAGENT -> USDT, net of 2% sell tax)',
      );
      return netUsdtOut;
    } catch (err: unknown) {
      lastErr = err;
      const e = err as { code?: string; message?: string };
      const isContractRevert = e?.code === 'CALL_EXCEPTION' || /revert|INSUFFICIENT_LIQUIDITY/i.test(e?.message ?? '');
      if (isContractRevert) {
        logger.warn({ err: e?.message }, 'simulateSellOutputUsdt reverted on-chain — returning 0');
        return 0n;
      }
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  logger.warn({ err: (lastErr as Error)?.message }, 'simulateSellOutputUsdt RPC failed');
  if (opts?.throwOnRpcError) {
    throw new Error(`PancakeSwap V2 sell quote RPC error: ${(lastErr as Error)?.message ?? String(lastErr)}`);
  }
  return 0n;
}

/**
 * Checks the mandatory 8% stop-loss condition:
 *   STOP if `sell_quote < mint_cost * 0.92`.
 */
export function evaluateSellQuoteGuard(
  mintCostUsdtWei: bigint,
  sellQuoteUsdtWei: bigint,
): { ok: boolean; lossPct: number; reason?: string } {
  if (mintCostUsdtWei <= 0n) {
    return { ok: false, lossPct: 100, reason: 'Invalid mint cost (0 USDT).' };
  }
  if (sellQuoteUsdtWei <= 0n) {
    return {
      ok: false,
      lossPct: 100,
      reason: 'Could not obtain a valid PancakeSwap V2 JAGENT → USDT sell quote (quote returned 0 USDT).',
    };
  }

  const mintF = Number(ethers.formatUnits(mintCostUsdtWei, TOKEN_DECIMALS));
  const sellF = Number(ethers.formatUnits(sellQuoteUsdtWei, TOKEN_DECIMALS));
  const lossPct = mintF > 0 ? ((mintF - sellF) / mintF) * 100 : 100;

  // Exact BigInt comparison: sellQuote < mintCost * 92 / 100
  if (sellQuoteUsdtWei * 10_000n < mintCostUsdtWei * MIN_SELL_RATIO_BPS) {
    return {
      ok: false,
      lossPct,
      reason:
        `Sell quote is more than ${MAX_SELL_LOSS_PCT}% below mint cost ` +
        `(Est. sell: ${sellF.toFixed(4)} USDT vs Mint cost: ${mintF.toFixed(4)} USDT — ` +
        `${lossPct.toFixed(2)}% below mint cost; minimum required is 92% = ${(mintF * 0.92).toFixed(4)} USDT).`,
    };
  }

  return { ok: true, lossPct };
}

// ─── Silent Preflight Checks ──────────────────────────────────────────────────

export interface PreflightBawSettings {
  devModeEnabled: boolean | null;
  devModeExpiresAt: string | null;
  devModeExpired: boolean;
  devModeDailyLimit: number;
  devModeQuotaUsed: number | null;
  devModeBalanceExceeded: boolean;
  dailyLimit: number;
  quotaUsed: number;
  quotaLeft: number;
  rawDevMode?: unknown;
}

export interface PreflightContext {
  sessionAgentId?: string | null;
  dbAgentId?: string | null;
  bawAgentId?: string | null;
  bawSettings?: PreflightBawSettings | null;
  bawSettingsError?: string | null;
}

export interface PreflightResult {
  ok: boolean;
  reason?: string;
  resolvedAgentId?: string;
  usdtBalanceWei?: bigint;
  bnbBalanceWei?: bigint;
  mintedCount?: bigint;
  quota?: bigint;
  remainingQuota?: bigint;
}

/**
 * Silent preflight checks before preview / execution:
 *   1. Wallet is fresh (`minted == 0`, `remaining >= 10`, `paidOnce == false`) and holds a `.ai` Agent ID
 *   2. JAGER minting is open & unpaused
 *   3. USDT balance >= `maxCostUsdtWei` (`live_price * 10 * 1.02`)
 *   4. BNB balance >= `MIN_BNB_GAS` (LOW/MEDIUM gas)
 *   5. `baw` Developer Mode is ON, not expired, not balance-exceeded, and daily quota is available
 */
export async function runPreflightChecks(
  rawWalletAddress: string,
  maxCostUsdtWei: bigint,
  ctx?: PreflightContext,
): Promise<PreflightResult> {
  const walletAddress = normalizeAddress(rawWalletAddress, 'preflight.walletAddress');

  const [usdtBal, bnbBal, freshness] = await Promise.all([
    readUsdtBalance(walletAddress),
    readBnbBalance(walletAddress),
    checkWalletFreshness(walletAddress),
  ]);

  const onChainName = freshness.agentId?.trim() ?? '';
  const bawName     = ctx?.bawAgentId?.trim() ?? '';
  const sessionName = ctx?.sessionAgentId?.trim() ?? '';
  const dbName      = ctx?.dbAgentId?.trim() ?? '';

  let resolvedAgentId = '';
  if (isValidAiAgentId(onChainName)) resolvedAgentId = onChainName;
  else if (isValidAiAgentId(bawName)) resolvedAgentId = bawName;
  else if (isValidAiAgentId(sessionName)) resolvedAgentId = sessionName;
  else if (isValidAiAgentId(dbName)) resolvedAgentId = dbName;

  const bawSettings = ctx?.bawSettings ?? null;

  logger.info(
    {
      walletAddress,
      resolvedAgentId: resolvedAgentId || null,
      usdtBalance: ethers.formatUnits(usdtBal, TOKEN_DECIMALS),
      requiredUsdt: ethers.formatUnits(maxCostUsdtWei, TOKEN_DECIMALS),
      bnbBalance: ethers.formatEther(bnbBal),
      freshness: {
        fresh: freshness.fresh,
        reasonCode: freshness.reasonCode,
        minted: freshness.minted.toString(),
        quota: freshness.quota.toString(),
        remaining: freshness.remaining.toString(),
      },
      devModeEnabled: bawSettings?.devModeEnabled ?? null,
      devModeExpired: bawSettings?.devModeExpired ?? false,
      devModeBalanceExceeded: bawSettings?.devModeBalanceExceeded ?? false,
      bawSettingsError: ctx?.bawSettingsError ?? null,
    },
    'JAGER silent preflight checks',
  );

  // 1. Freshness & .ai Agent ID check (minted == 0 / remaining >= 10)
  if (!freshness.fresh) {
    return {
      ok: false,
      resolvedAgentId: resolvedAgentId || undefined,
      usdtBalanceWei: usdtBal,
      bnbBalanceWei: bnbBal,
      mintedCount: freshness.minted,
      quota: freshness.quota,
      remainingQuota: freshness.remaining,
      reason: freshness.userMessage ?? freshness.reason ?? 'Wallet failed JAGER eligibility / freshness check.',
    };
  }

  if (!resolvedAgentId) {
    return {
      ok: false,
      usdtBalanceWei: usdtBal,
      bnbBalanceWei: bnbBal,
      reason: formatWalletNotEligibleMessage('NO_AGENT_ID'),
    };
  }

  // 2. Developer Mode check (mandatory)
  if (!bawSettings || bawSettings.devModeEnabled === null) {
    return {
      ok: false,
      resolvedAgentId,
      usdtBalanceWei: usdtBal,
      bnbBalanceWei: bnbBal,
      reason:
        `Could not verify Developer Mode status from Binance Agentic Wallet` +
        (ctx?.bawSettingsError ? ` (${ctx.bawSettingsError.slice(0, 120)})` : '') +
        '. Ensure Developer Mode is ON in Binance App → Agentic Wallet → Settings → Developer Mode.',
    };
  }

  if (bawSettings.devModeEnabled === false) {
    return {
      ok: false,
      resolvedAgentId,
      usdtBalanceWei: usdtBal,
      bnbBalanceWei: bnbBal,
      reason:
        'Developer Mode is OFF in your Binance Agentic Wallet. ' +
        'Turn it ON in Binance App → Agentic Wallet → Settings → Developer Mode and try again.',
    };
  }

  if (bawSettings.devModeExpired) {
    return {
      ok: false,
      resolvedAgentId,
      usdtBalanceWei: usdtBal,
      bnbBalanceWei: bnbBal,
      reason:
        `Developer Mode expired (${bawSettings.devModeExpiresAt ?? 'past expiry'}). ` +
        'Re-enable it in Binance App → Agentic Wallet → Settings → Developer Mode.',
    };
  }

  if (bawSettings.devModeBalanceExceeded) {
    return {
      ok: false,
      resolvedAgentId,
      usdtBalanceWei: usdtBal,
      bnbBalanceWei: bnbBal,
      reason:
        'Developer Mode balance cap is exceeded in your Binance Agentic Wallet settings. ' +
        'Review your Developer Mode settings in the Binance App.',
    };
  }

  if (
    bawSettings.devModeDailyLimit > 0 &&
    bawSettings.devModeQuotaUsed != null &&
    bawSettings.devModeQuotaUsed >= bawSettings.devModeDailyLimit
  ) {
    return {
      ok: false,
      resolvedAgentId,
      usdtBalanceWei: usdtBal,
      bnbBalanceWei: bnbBal,
      reason:
        `Developer Mode daily quota exhausted ($${bawSettings.devModeQuotaUsed.toFixed(2)} / $${bawSettings.devModeDailyLimit.toFixed(2)}).`,
    };
  }

  if (bawSettings.dailyLimit > 0 && bawSettings.quotaLeft <= 0) {
    return {
      ok: false,
      resolvedAgentId,
      usdtBalanceWei: usdtBal,
      bnbBalanceWei: bnbBal,
      reason: 'Daily trading quota exhausted in Binance Agentic Wallet. Wait for daily reset.',
    };
  }

  // 3. USDT balance check (must cover live_price * 10 * 1.02)
  if (usdtBal < maxCostUsdtWei) {
    const haveUsdt = Number(ethers.formatUnits(usdtBal, TOKEN_DECIMALS)).toFixed(4);
    const needUsdt = Number(ethers.formatUnits(maxCostUsdtWei, TOKEN_DECIMALS)).toFixed(4);
    return {
      ok: false,
      resolvedAgentId,
      usdtBalanceWei: usdtBal,
      bnbBalanceWei: bnbBal,
      mintedCount: freshness.minted,
      quota: freshness.quota,
      remainingQuota: freshness.remaining,
      reason:
        `Insufficient USDT balance. Need ≥ ${needUsdt} USDT (10 shares live price × 1.02 buffer), ` +
        `have ${haveUsdt} USDT.`,
    };
  }

  // 4. BNB gas balance check (LOW/MEDIUM gas)
  if (bnbBal < MIN_BNB_GAS) {
    return {
      ok: false,
      resolvedAgentId,
      usdtBalanceWei: usdtBal,
      bnbBalanceWei: bnbBal,
      mintedCount: freshness.minted,
      quota: freshness.quota,
      remainingQuota: freshness.remaining,
      reason:
        `Insufficient BNB for gas. Need ≥ ${ethers.formatEther(MIN_BNB_GAS)} BNB ` +
        `(recommended ${ethers.formatEther(RECOMMENDED_BNB_GAS)} BNB for LOW/MEDIUM gas), ` +
        `have ${ethers.formatEther(bnbBal)} BNB.`,
    };
  }

  return {
    ok: true,
    resolvedAgentId,
    usdtBalanceWei: usdtBal,
    bnbBalanceWei: bnbBal,
    mintedCount: freshness.minted,
    quota: freshness.quota,
    remainingQuota: freshness.remaining,
  };
}

// ─── Calldata Builders (for baw contract-call) ────────────────────────────────

/**
 * Step A / Step D: Exact USDT approval calldata for the JAGER Mint Contract.
 *   - Step A passes exact `maxCostUsdtWei` (`live_price * 10 * 1.02`) — NO unlimited approval.
 *   - Step D passes `0n` to revoke any leftover USDT allowance back to 0.
 */
export function buildUsdtApproveCalldata(
  amount: bigint,
  spenderAddress = ADDR.MINT_CONTRACT,
): string {
  const spender = normalizeAddress(spenderAddress, 'usdtApprove.spender');
  return erc20Iface.encodeFunctionData('approve', [spender, amount]);
}

/**
 * Step B: JagentMintV2 `mint(uint256 shares, address referrer, uint256 maxCost)` (selector 0x836a1040).
 *   - CRITICAL: `shares` MUST ALWAYS be 10n (never < 10, never 1 at a time).
 *   - CRITICAL: `referrer` is ALWAYS hardcoded to `ADDR.REFERRER` (`noyonislam.ai`).
 *   - `value` is ALWAYS `0n` (USDT payment via ERC-20 transferFrom).
 */
export function buildMintCalldata(
  maxCostUsdtWei: bigint,
  shares: bigint = MINT_SHARES,
): {
  inputData: string;
  value: bigint;
  maxCost: bigint;
  shares: bigint;
  referrer: string;
} {
  if (shares !== MINT_SHARES) {
    throw new Error(`CRITICAL: JAGER mint must always be exactly ${MINT_SHARES.toString()} shares in ONE transaction (got ${shares.toString()})`);
  }
  if (maxCostUsdtWei <= 0n) {
    throw new Error('Invalid maxCostUsdtWei (must be > 0)');
  }

  const inputData = mintIface.encodeFunctionData('mint', [
    MINT_SHARES,
    ADDR.REFERRER, // noyonislam.ai — NEVER change
    maxCostUsdtWei,
  ]);

  logger.debug(
    {
      selector: inputData.slice(0, 10),
      shares: MINT_SHARES.toString(),
      referrer: ADDR.REFERRER,
      maxCostUsdt: ethers.formatUnits(maxCostUsdtWei, TOKEN_DECIMALS),
    },
    'buildMintCalldata (JagentMintV2)',
  );

  return {
    inputData,
    value: 0n,
    maxCost: maxCostUsdtWei,
    shares: MINT_SHARES,
    referrer: ADDR.REFERRER,
  };
}

/**
 * Step C (pre-swap): Exact JAGENT token approval to PancakeSwap V2 Router.
 * No unlimited approval — amount is the exact wallet JAGENT balance.
 */
export function buildJagentApproveCalldata(
  amount: bigint,
  spenderAddress = ADDR.PANCAKE_ROUTER,
): string {
  const spender = normalizeAddress(spenderAddress, 'jagentApprove.spender');
  return erc20Iface.encodeFunctionData('approve', [spender, amount]);
}

/**
 * Step C: PancakeSwap V2 `swapExactTokensForTokensSupportingFeeOnTransferTokens`
 * swapping 100% of JAGENT → USDT on the official JAGENT/USDT pair.
 */
export function buildSellCalldata(
  jagentAmount: bigint,
  walletAddress: string,
  amountOutMin = 0n,
): string {
  const recipient = normalizeAddress(walletAddress, 'sell.recipient');
  const tokenIn   = normalizeAddress(ADDR.JAGENT_TOKEN, 'sell.tokenIn');
  const tokenOut  = normalizeAddress(ADDR.USDT, 'sell.tokenOut');
  const deadline  = BigInt(Math.floor(Date.now() / 1000) + 600);
  return routerIface.encodeFunctionData(
    'swapExactTokensForTokensSupportingFeeOnTransferTokens',
    [jagentAmount, amountOutMin, [tokenIn, tokenOut], recipient, deadline],
  );
}

// ─── On-Chain Transaction Simulation (`eth_call` + `eth_estimateGas`) ────────

export interface RpcSimulationResult {
  ok: boolean;
  estimatedGas?: bigint;
  isRevert?: boolean;
  revertData?: string;
  revertReason?: string;
  error?: string;
}

/**
 * Runs a read-only BSC RPC `eth_call` + `eth_estimateGas` simulation before calling `baw`.
 * Surfaces real contract reverts (including JagentMintV2 / ERC-20 custom errors) and
 * provides an on-chain gas estimate for LOW/MEDIUM gasLimit sizing.
 */
export async function simulateContractCall(opts: {
  step: string;
  from: string;
  to: string;
  data: string;
  value?: bigint;
}): Promise<RpcSimulationResult> {
  const { step, data, value = 0n } = opts;
  const from = normalizeAddress(opts.from, `${step}.from`);
  const to   = normalizeAddress(opts.to, `${step}.to`);
  const fnSelector = data.slice(0, 10);

  try {
    // Run eth_call + eth_estimateGas in parallel to verify execution succeeds cleanly
    const [, estimatedGas] = await Promise.all([
      provider.call({ from, to, data, value }),
      provider.estimateGas({ from, to, data, value }),
    ]);

    logger.info(
      {
        step,
        to,
        fnSelector,
        valueBnb: ethers.formatEther(value),
        estimatedGas: estimatedGas.toString(),
      },
      'BSC RPC simulation (eth_call + estimateGas) succeeded',
    );
    return { ok: true, estimatedGas };
  } catch (err: unknown) {
    const e = err as {
      code?: string;
      data?: string;
      reason?: string;
      shortMessage?: string;
      message?: string;
      info?: { error?: { data?: string; message?: string } };
    };
    const revertData =
      typeof e?.data === 'string' && e.data.startsWith('0x') && e.data.length > 2
        ? e.data
        : typeof e?.info?.error?.data === 'string' && e.info.error.data.startsWith('0x') && e.info.error.data.length > 2
          ? e.info.error.data
          : undefined;
    const rawMsg = e?.shortMessage ?? e?.message ?? String(err);

    let decodedCustomError: string | undefined;
    if (revertData) {
      for (const iface of [mintIface, erc20Iface]) {
        try {
          const parsed = iface.parseError(revertData);
          if (parsed?.name) {
            decodedCustomError = `${parsed.name}()`;
            break;
          }
        } catch { /* try next */ }
      }
    }

    const revertReason =
      decodedCustomError ??
      e?.reason ??
      e?.info?.error?.message ??
      (revertData ? `custom error ${revertData.slice(0, 10)}` : undefined);

    const isRevert = Boolean(
      e?.code === 'CALL_EXCEPTION' ||
      revertData ||
      /revert|execution reverted|invalid opcode/i.test(rawMsg),
    );

    logger.warn(
      {
        step,
        to,
        fnSelector,
        valueBnb: ethers.formatEther(value),
        code: e?.code ?? null,
        isRevert,
        revertData: revertData ? revertData.slice(0, 74) : null,
        revertReason: revertReason ?? null,
        error: rawMsg.slice(0, 240),
      },
      'BSC RPC simulation failed',
    );

    return {
      ok: false,
      isRevert,
      revertData,
      revertReason,
      error: rawMsg,
    };
  }
}

/** Returns LOW/MEDIUM gas price (base gas price + 5%, never aggressive/high). */
export async function getLowGasPrice(): Promise<bigint> {
  const feeData = await provider.getFeeData();
  const base = feeData.gasPrice != null ? BigInt(feeData.gasPrice) : ethers.parseUnits('1', 'gwei');
  return (base * 105n) / 100n;
}
