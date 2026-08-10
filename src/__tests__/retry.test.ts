import { describe, expect, it } from 'vitest';

import {
    backoffDelayMs,
    DEFAULT_RETRY_POLICY,
    parseRemaining,
    parseRetryAfter,
    shouldRetry,
} from '../retry.js';

/**
 * The retry MATRIX, isolated from the bridge. The single rule this file exists
 * to protect: a POST is never retried automatically, because the SDK cannot
 * know whether the write landed before the rate limiter answered.
 */

const policy = DEFAULT_RETRY_POLICY;

describe('shouldRetry', () => {
    it.each([429, 503])('retries an idempotent GET on %i', (status) => {
        expect(shouldRetry('GET', status, 1, policy)).toBe(true);
    });

    it.each([200, 400, 401, 403, 404, 409, 422, 500, 502, 504, 0])(
        'does not retry a GET on %i',
        (status) => {
            expect(shouldRetry('GET', status, 1, policy)).toBe(false);
        },
    );

    it.each([429, 503])('NEVER auto-retries a POST on %i', (status) => {
        expect(shouldRetry('POST', status, 1, policy)).toBe(false);
    });

    it('stops at the third attempt', () => {
        expect(shouldRetry('GET', 429, 1, policy)).toBe(true);
        expect(shouldRetry('GET', 429, 2, policy)).toBe(true);
        expect(shouldRetry('GET', 429, 3, policy)).toBe(false);
    });

    it('lets a caller opt a GET out and a POST in', () => {
        expect(shouldRetry('GET', 429, 1, policy, false)).toBe(false);
        expect(shouldRetry('POST', 429, 1, policy, true)).toBe(true);
    });

    it('honours the attempt cap even when the caller opted in', () => {
        expect(shouldRetry('POST', 429, 3, policy, true)).toBe(false);
    });
});

describe('backoffDelayMs', () => {
    it('grows exponentially and stays under the ceiling with full jitter', () => {
        const max = (attempt: number) => backoffDelayMs(attempt, null, policy, () => 1);
        expect(max(1)).toBe(400);
        expect(max(2)).toBe(800);
        expect(max(3)).toBe(1600);
    });

    it('uses FULL jitter — a low random collapses the wait toward zero', () => {
        // The point of full jitter over "delay + a bit": clients released by the
        // same rate-limit window must spread across the whole interval, not
        // bunch at its lower bound.
        expect(backoffDelayMs(3, null, policy, () => 0)).toBe(0);
        expect(backoffDelayMs(3, null, policy, () => 0.5)).toBe(800);
    });

    it('never exceeds maxDelayMs however many attempts have failed', () => {
        expect(backoffDelayMs(20, null, policy, () => 1)).toBe(policy.maxDelayMs);
    });

    it('honours Retry-After over its own exponential guess', () => {
        expect(backoffDelayMs(1, 5, policy, () => 0)).toBe(5000);
    });

    it('caps a hostile Retry-After at maxDelayMs', () => {
        expect(backoffDelayMs(1, 86_400, policy, () => 0)).toBe(policy.maxDelayMs);
    });
});

describe('parseRetryAfter', () => {
    it('parses delta-seconds', () => {
        expect(parseRetryAfter('30')).toBe(30);
        expect(parseRetryAfter(30)).toBe(30);
    });

    it('parses an HTTP-date against an injected clock', () => {
        const now = Date.parse('2026-08-10T00:00:00Z');
        expect(parseRetryAfter('Mon, 10 Aug 2026 00:00:20 GMT', () => now)).toBe(20);
    });

    it('clamps a past HTTP-date to zero rather than a negative wait', () => {
        const now = Date.parse('2026-08-10T00:01:00Z');
        expect(parseRetryAfter('Mon, 10 Aug 2026 00:00:00 GMT', () => now)).toBe(0);
    });

    it('returns null for garbage, so the caller falls back to exponential', () => {
        expect(parseRetryAfter('soon')).toBeNull();
        expect(parseRetryAfter('')).toBeNull();
        expect(parseRetryAfter(null)).toBeNull();
        expect(parseRetryAfter(undefined)).toBeNull();
        expect(parseRetryAfter(-5)).toBeNull();
    });
});

describe('parseRemaining', () => {
    it('parses numbers and numeric strings', () => {
        expect(parseRemaining(7)).toBe(7);
        expect(parseRemaining('7')).toBe(7);
        expect(parseRemaining('0')).toBe(0);
    });

    it('returns null for anything else', () => {
        expect(parseRemaining('many')).toBeNull();
        expect(parseRemaining(null)).toBeNull();
    });
});
