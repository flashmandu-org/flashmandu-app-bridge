/**
 * Retry policy for `request()` (design §4.8).
 *
 * Pure and dependency-free so the whole matrix — which statuses, which methods,
 * how long — is testable without a clock, a network, or a bridge.
 *
 * THE RULE
 * --------
 * Only idempotent GETs are retried, and only on 429 / 503. A POST is never
 * retried automatically: the SDK cannot know whether the write landed before
 * the rate limiter answered, and a duplicated order is worse than a visible
 * error. Apps that want at-most-once POST retries must implement idempotency
 * keys and ask for it explicitly (`retry: true`).
 */

import type { ProxyMethod } from './types.js';

/** Statuses worth trying again. 429 = rate limited, 503 = shedding load. */
export const RETRYABLE_STATUSES: readonly number[] = [429, 503];

export interface RetryPolicy {
    /** Total attempts including the first. 3 = one call plus two retries. */
    maxAttempts: number;
    /** First backoff step, doubled per attempt. */
    baseDelayMs: number;
    /** Ceiling for any single wait, including a server-supplied Retry-After. */
    maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
    maxAttempts: 3,
    baseDelayMs: 400,
    maxDelayMs: 20_000,
};

/**
 * Whether another attempt is allowed.
 *
 * `retryOverride` is the caller's explicit `retry` flag: `false` opts a GET
 * out, `true` opts a POST in. Undefined falls back to method idempotence.
 */
export function shouldRetry(
    method: ProxyMethod,
    status: number,
    attempt: number,
    policy: RetryPolicy,
    retryOverride?: boolean,
): boolean {
    if (attempt >= policy.maxAttempts) return false;
    if (!RETRYABLE_STATUSES.includes(status)) return false;
    if (retryOverride !== undefined) return retryOverride;
    return method === 'GET';
}

/**
 * How long to wait before attempt N+1.
 *
 * `Retry-After` wins when the server sent one — it knows when the window
 * reopens and guessing shorter just burns the app's remaining quota. A small
 * jitter is still added on top so a hundred iframes released by the same window
 * do not all fire on the same millisecond.
 *
 * Without a `Retry-After` it is exponential with FULL jitter (`random * delay`,
 * not `delay + random`): full jitter is what actually spreads a thundering
 * herd, since the classic "delay plus a bit" keeps every client bunched at the
 * same lower bound.
 *
 * @param attempt 1-based number of the attempt that just failed.
 * @param random  Injected `Math.random` substitute, for deterministic tests.
 */
export function backoffDelayMs(
    attempt: number,
    retryAfterSeconds: number | null,
    policy: RetryPolicy,
    random: () => number,
): number {
    if (retryAfterSeconds !== null && retryAfterSeconds >= 0) {
        const base = Math.min(retryAfterSeconds * 1000, policy.maxDelayMs);
        return Math.round(base + random() * 250);
    }
    const ceiling = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
    return Math.round(random() * ceiling);
}

/**
 * Parse a `Retry-After` header into seconds.
 *
 * Both RFC forms are accepted: delta-seconds and an HTTP-date. The date form
 * needs a clock, which is injected so tests are not time-dependent. Returns
 * null for anything unparseable — a garbled header must not become a 30-minute
 * wait, and must not become a zero-delay hot loop either.
 */
export function parseRetryAfter(value: unknown, now: () => number = Date.now): number | null {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        return value;
    }
    if (typeof value !== 'string' || value.trim() === '') {
        return null;
    }
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
        return Number(trimmed);
    }
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return null;
    const seconds = (at - now()) / 1000;
    return seconds > 0 ? seconds : 0;
}

/** Parse `X-RateLimit-Remaining` into a number, or null. */
export function parseRemaining(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
    return null;
}
