import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Inbound platform webhook verifier — a byte-for-byte mirror of the PHP SDK's
 * `Flashmandu\AppSdk\Webhooks\Verifier`.
 *
 * Ported from `~/nextjs/showcase/lib/hmac.ts` (207 lines), documented there
 * as THE verifier: a developer who reads the PHP SDK and then writes a Node
 * app must get identical accept/reject verdicts AND identical failure reason
 * strings, because the reason string is what ends up in their logs and in the
 * platform's delivery inspector next to the same text. Any divergence here is
 * a support ticket that cannot be closed. The internal logic, check order,
 * and every reason string below are copied verbatim from that file.
 *
 * DIVERGENCE FROM THE SOURCE: the source file's public `verifyWebhook` takes
 * four positional params `(rawBody, headers: WebhookHeaders, webhookSecret,
 * opts)` — it never imported app config, so there was nothing to
 * parameterize. Task B2 asks for a single options object instead
 * (`{ rawBody, headers, secret, now? }`), so this port wraps the ported
 * internals in that shape and additionally accepts a plain
 * `Record<string, string>` for `headers` (not just a `Headers` instance) —
 * everything downstream of header-normalization is untouched.
 *
 * The signature is an HMAC-SHA256 over `"{timestamp}.{rawBody}"` keyed by the
 * install's `webhook_secret`:
 *
 *     signature = hash_hmac('sha256', $timestamp.'.'.$rawBody, $webhookSecret)
 *
 * Headers the platform sends (case-insensitive; an EMPTY value counts as
 * absent, matching the SDK's `header()` helper):
 *
 *   - `X-App-Event`      the hook name
 *   - `X-App-Signature`  hex HMAC as above
 *   - `X-App-Timestamp`  unix seconds — also the first half of the signed string
 *   - `X-App-Delivery`   per-ATTEMPT id — the dedupe key
 *
 * **Feed it the RAW body.** Re-serializing the JSON changes bytes (key order,
 * whitespace, unicode escaping) and the HMAC will not match. In Next.js that
 * means `await req.text()` before anything touches `req.json()`.
 *
 * **Deliveries are at-least-once.** The retry ladder is 6 attempts — 1m, 5m,
 * 30m, 2h, 8h — then dead-letter. Each attempt carries its own
 * `X-App-Delivery`; record it and treat a repeat as a duplicate. Payloads carry
 * a per-resource monotonic `sequence`: drop an update at or below the one
 * already applied. Respond within 10 seconds — a timeout costs a retry.
 *
 * Unknown event names are NOT an error. The host may ship a new hook before an
 * app knows about it; the verifier's job is authenticity, not vocabulary.
 */

/** Header trio + event name, already normalized to `string | null`. */
export interface WebhookHeaders {
    signature: string | null;
    timestamp: string | null;
    delivery: string | null;
    event: string | null;
}

/**
 * Normalize a `Headers` bag the way the SDK's `header()` helper does.
 *
 * `Headers.get()` is already case-insensitive, so the only behaviour to port is
 * the SDK's `if (! is_string($value) || $value === '') return null;` — an empty
 * header value is treated as ABSENT, not as an empty signature. Without this a
 * proxy that helpfully materializes `X-App-Timestamp: ` would fail with
 * "is not a unix timestamp" instead of the correct "missing …" reason.
 */
export function readWebhookHeaders(h: Headers): WebhookHeaders {
    const read = (name: string): string | null => {
        const value = h.get(name);
        return value === null || value === '' ? null : value;
    };

    return {
        signature: read('x-app-signature'),
        timestamp: read('x-app-timestamp'),
        delivery: read('x-app-delivery'),
        event: read('x-app-event'),
    };
}

function normalizeHeaders(input: Headers | Record<string, string>): WebhookHeaders {
    return readWebhookHeaders(input instanceof Headers ? input : new Headers(input));
}

/**
 * Constant-time string compare with an equal-length guard, mirroring PHP's
 * `hash_equals()`.
 *
 * Compares the UTF-8 BYTES of the two hex strings rather than the bytes they
 * decode to. That is deliberate: `Buffer.from(s, 'hex')` silently truncates at
 * the first non-hex character, so a decode-then-compare would treat
 * `"ab" + garbage` as equal to `"ab"`. `hash_equals` compares the strings, and
 * so do we.
 *
 * `timingSafeEqual` throws on length mismatch, hence the guard — which is not a
 * leak: the signature length is a public constant (64 hex chars for SHA-256).
 */
function timingSafeStringEqual(a: string, b: string): boolean {
    const aBuf = Buffer.from(a, 'utf8');
    const bBuf = Buffer.from(b, 'utf8');
    if (aBuf.length !== bBuf.length || aBuf.length === 0) {
        return false;
    }
    return timingSafeEqual(aBuf, bBuf);
}

export interface VerifyWebhookInput {
    /** The RAW request body — never a re-serialized `JSON.stringify(parsed)`. */
    rawBody: string;
    /** Either a Fetch `Headers` instance or a plain lowercase-or-not map. */
    headers: Headers | Record<string, string>;
    /** The install's `webhook_secret`. */
    secret: string;
    /**
     * Reject timestamps further from now than this, in EITHER direction.
     * Boundary inclusive: `age === maxSkewSeconds` passes. Default 300.
     */
    maxSkewSeconds?: number;
    /**
     * Unix SECONDS to treat as "now". The SDK's `?int $now` parameter; injected
     * by tests so the skew boundary is assertable rather than flaky.
     */
    now?: number;
}

/**
 * The SDK's `VerificationResult`, as a plain object.
 *
 * `event` and `deliveryId` are populated on FAILURE too, because they are
 * readable before the signature is checked and they are what makes a rejection
 * traceable against the platform's own delivery log. They are **not
 * authenticated** on a failed result — never act on them.
 *
 * `timestamp` is the parsed `X-App-Timestamp`, present only on success (the
 * SDK's `VerificationResult::pass()` takes a non-null `int $timestamp`).
 */
export interface VerifyResult {
    ok: boolean;
    reason?: string;
    event?: string;
    deliveryId?: string;
    timestamp?: number;
}

/** Default skew window, in seconds. Mirrors `Verifier::$maxSkewSeconds`. */
export const DEFAULT_MAX_SKEW_SECONDS = 300;

/**
 * Verify the HMAC + timestamp over the RAW body bytes.
 *
 * The ORDER of the checks below is part of the contract — it decides which
 * reason a delivery that is wrong in two ways reports. Do not reorder:
 *
 *   1. read headers (empty ⇒ absent)
 *   2. missing signature or timestamp ⇒ `missing X-App-Signature or X-App-Timestamp`
 *   3. timestamp not `/^\d+$/`        ⇒ `X-App-Timestamp is not a unix timestamp`
 *   4. `abs(now - ts) > max`          ⇒ `timestamp skew {age}s exceeds the {max}s window`
 *   5. HMAC mismatch                  ⇒ `signature mismatch`
 *   6. otherwise ok
 */
export function verifyWebhook(input: VerifyWebhookInput): VerifyResult {
    const headers = normalizeHeaders(input.headers);
    const maxSkew = input.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
    const event = headers.event ?? undefined;
    const deliveryId = headers.delivery ?? undefined;

    if (headers.signature === null || headers.timestamp === null) {
        return { ok: false, reason: 'missing X-App-Signature or X-App-Timestamp', event, deliveryId };
    }

    // Digits only. `Number.parseInt` would accept "123abc" (and "0x1f", and
    // leading whitespace) and then happily verify a delivery whose timestamp is
    // not the string that was signed — the SDK's `preg_match('/^\d+$/')` is the
    // contract.
    //
    // (PHP's `$` also matches before ONE trailing newline; JS's does not. A
    // header value cannot contain a newline over HTTP, so the stricter side is
    // the safe one to be on.)
    if (!/^\d+$/.test(headers.timestamp)) {
        return { ok: false, reason: 'X-App-Timestamp is not a unix timestamp', event, deliveryId };
    }

    const timestamp = Number(headers.timestamp);
    // Whole seconds, like PHP's `time()`. Using `Date.now() / 1000` unrounded
    // would render the reason as "timestamp skew 412.338s …" and never match the
    // SDK's text.
    const now = input.now ?? Math.floor(Date.now() / 1000);
    const age = Math.abs(now - timestamp);
    if (age > maxSkew) {
        return {
            ok: false,
            reason: `timestamp skew ${age}s exceeds the ${maxSkew}s window`,
            event,
            deliveryId,
        };
    }

    // Sign the RAW header string, not the parsed number: "0300" and "300" are the
    // same integer and different signed bytes.
    const expected = createHmac('sha256', input.secret)
        .update(`${headers.timestamp}.${input.rawBody}`, 'utf8')
        .digest('hex');

    if (!timingSafeStringEqual(expected, headers.signature)) {
        return { ok: false, reason: 'signature mismatch', event, deliveryId };
    }

    return { ok: true, event, deliveryId, timestamp };
}

/**
 * Compute the signature the platform would send for a body.
 *
 * The SDK's `Verifier::sign()`, and it carries the same warning: this is for
 * TESTS and local fixtures. Never call it on an inbound request and compare by
 * hand — that is what {@see verifyWebhook} and its constant-time compare are
 * for.
 */
export function signWebhook(rawBody: string, timestamp: number | string, webhookSecret: string): string {
    return createHmac('sha256', webhookSecret)
        .update(`${timestamp}.${rawBody}`, 'utf8')
        .digest('hex');
}
