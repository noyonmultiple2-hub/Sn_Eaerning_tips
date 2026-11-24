// src/notifications.ts
// ═══════════════════════════════════════════════════════════════════════
// Guaranteed Admin Notification Delivery Queue & Background Retry Worker
//
// Persists every completion/payout notification in PostgreSQL
// (`admin_notifications`, with in-memory fallback if DB is temporarily
// unavailable), deduplicates by `dedupeKey`, and retries automatically on
// startup, after events, and on a periodic interval until DELIVERED.
//
// Also flushes any deferred DB execution/payout writes buffered during a
// transient PostgreSQL outage.
// ═══════════════════════════════════════════════════════════════════════

import type { Telegram } from 'telegraf';
import {
  enqueueAdminNotification,
  getDuePendingAdminNotifications,
  markAdminNotificationDelivered,
  markAdminNotificationRetry,
  flushDeferredDbWrites,
  QueuedAdminNotification,
} from './db.js';
import { logger } from './logger.js';

const FLUSH_INTERVAL_MS = 15_000; // background retry sweep every 15s
const MAX_BACKOFF_SEC   = 300;    // cap retry backoff at 5 minutes

let workerTelegram: Telegram | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let isFlushing = false;
const inFlightKeys = new Set<string>();

/** Computes retry delay in seconds, honoring Telegram `retry_after` on 429 rate limits. */
export function computeNotificationBackoffSec(retryCount: number, err: unknown): number {
  const e = err as {
    response?: { error_code?: number; parameters?: { retry_after?: number } };
    parameters?: { retry_after?: number };
    message?: string;
  };
  const retryAfter = e?.response?.parameters?.retry_after ?? e?.parameters?.retry_after;
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(MAX_BACKOFF_SEC, Math.ceil(retryAfter) + 2);
  }
  const msgMatch = String(e?.message ?? '').match(/retry after (\d+)/i);
  if (msgMatch) {
    const parsed = Number(msgMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(MAX_BACKOFF_SEC, parsed + 2);
    }
  }
  return Math.min(MAX_BACKOFF_SEC, Math.round(5 * Math.pow(2, Math.max(0, retryCount - 1))));
}

function isHtmlParseError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err ?? '');
  return /can't parse entities|unsupported start tag|unexpected end tag|parse_mode/i.test(msg);
}

/**
 * Attempts delivery of a single queued notification.
 * Uses `parse_mode: 'HTML'` first (for one-click copy `<code>0x...</code>`), falling back
 * immediately to plain text ONLY if Telegram reports an HTML entity parse error.
 * Any network/429/5xx failure schedules a retry without ever dropping the notification.
 */
async function deliverOne(telegram: Telegram, item: QueuedAdminNotification): Promise<boolean> {
  if (inFlightKeys.has(item.dedupeKey)) return false;
  inFlightKeys.add(item.dedupeKey);

  try {
    try {
      await telegram.sendMessage(item.adminId, item.htmlMessage, { parse_mode: 'HTML' });
    } catch (htmlErr) {
      if (isHtmlParseError(htmlErr)) {
        logger.warn(
          { dedupeKey: item.dedupeKey, adminId: item.adminId, err: (htmlErr as Error)?.message },
          'Telegram HTML parse error on admin notification — delivering plain-text fallback',
        );
        await telegram.sendMessage(item.adminId, item.plainMessage);
      } else {
        throw htmlErr;
      }
    }

    await markAdminNotificationDelivered(item.dedupeKey);
    logger.info(
      {
        dedupeKey: item.dedupeKey,
        adminId: item.adminId,
        telegramUserId: item.telegramUserId,
        executionId: item.executionId,
        priorRetries: item.retryCount,
      },
      'Admin notification delivered',
    );
    return true;
  } catch (err) {
    const nextRetryCount = item.retryCount + 1;
    const delaySec       = computeNotificationBackoffSec(nextRetryCount, err);
    const errMsg         = String((err as Error)?.message ?? err ?? 'sendMessage failed');

    await markAdminNotificationRetry(item.dedupeKey, nextRetryCount, errMsg, delaySec);
    logger.warn(
      {
        dedupeKey: item.dedupeKey,
        adminId: item.adminId,
        retryCount: nextRetryCount,
        nextRetryInSec: delaySec,
        err: errMsg.slice(0, 200),
      },
      'Admin notification delivery failed — scheduled for automatic retry',
    );
    return false;
  } finally {
    inFlightKeys.delete(item.dedupeKey);
  }
}

/**
 * Flushes deferred DB writes and retries all due PENDING admin notifications.
 * Safe to call concurrently (guarded by single-flight `isFlushing`).
 */
export async function flushPendingAdminNotifications(telegram?: Telegram): Promise<number> {
  const tg = telegram ?? workerTelegram;
  if (!tg || isFlushing) return 0;

  isFlushing = true;
  let deliveredCount = 0;
  try {
    // 1. Flush any execution/payout DB writes buffered during a transient DB outage
    await flushDeferredDbWrites();

    // 2. Deliver all due PENDING admin notifications
    const due = await getDuePendingAdminNotifications(25);
    for (const item of due) {
      const ok = await deliverOne(tg, item);
      if (ok) deliveredCount++;
    }
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'flushPendingAdminNotifications sweep error');
  } finally {
    isFlushing = false;
  }
  return deliveredCount;
}

/**
 * Enqueues notifications for one or more admins durably (deduplicated by `dedupeKey`)
 * and triggers an immediate delivery flush. Any undelivered notifications remain in the
 * durable PENDING queue and are retried automatically by the background worker until delivered.
 */
export async function enqueueAndDeliverAdminNotifications(
  telegram: Telegram,
  items: Array<{
    dedupeKey: string;
    adminId: number;
    telegramUserId: number;
    executionId?: number | null;
    htmlMessage: string;
    plainMessage: string;
    payload?: Record<string, unknown> | null;
  }>,
): Promise<void> {
  await Promise.all(items.map((item) => enqueueAdminNotification(item)));
  await flushPendingAdminNotifications(telegram);
}

/** Starts the background retry worker and performs an immediate startup flush. */
export function startAdminNotificationWorker(telegram: Telegram): void {
  workerTelegram = telegram;
  if (flushTimer) clearInterval(flushTimer);

  // Immediate startup sweep to deliver any notifications left PENDING across restarts
  void flushPendingAdminNotifications(telegram);

  flushTimer = setInterval(() => {
    void flushPendingAdminNotifications(telegram);
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();

  logger.info({ intervalMs: FLUSH_INTERVAL_MS }, 'Admin notification retry worker started');
}

/** Stops the background retry worker cleanly during graceful shutdown. */
export function stopAdminNotificationWorker(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  workerTelegram = null;
}
