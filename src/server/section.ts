/**
 * Storefront section proxy (Tier 2) — the app-server half.
 *
 * A `source = "endpoint"` storefront section is one the platform FETCHES from
 * your server, validates against its own composable schema, and renders
 * server-side with its own renderer. Your app returns DATA — a tree of the
 * platform's existing composable nodes — never HTML, never JavaScript. That is
 * the whole security model: there is no code path from your response into the
 * platform's runtime, because a tree of typed nodes is not code.
 *
 * What you get for that constraint: a server-rendered, SEO-visible,
 * design-system-native storefront surface. No iframe, no CORS, no opaque
 * origin, and no per-pageview traffic — the platform caches your response and
 * serves it stale-while-revalidate, so a busy storefront costs your server
 * roughly one request per `cache.ttl`, not one per visitor.
 *
 * REQUEST
 *
 *     GET {your_app}{endpoint_path}?profile_id=…&settings=…&schema_version=1
 *     X-App-Timestamp: 1765432100
 *     X-App-Signature: <hex hmac>
 *     X-App-Section:   events-calendar
 *
 * The signature is the SAME scheme as inbound webhooks — HMAC-SHA256 over
 * `"{timestamp}.{message}"` keyed by your `webhook_secret` — with the
 * CANONICAL QUERY STRING standing in where a webhook has its raw body. That is
 * deliberate: {@link verifySectionRequest} is a thin wrapper over
 * {@link verifyWebhook}, so it produces identical verdicts and identical
 * reason strings, and an app that has integrated webhooks has already
 * integrated this.
 *
 * CANONICALIZATION is the one part that must match byte-for-byte on both
 * sides: DECODE the query pairs, sort by key then value, and re-encode each
 * with RFC 3986 percent-encoding, joined by `&`. Decoding first is what makes
 * it stable — `%20` and `+` are the same space and two HTTP stacks will not
 * agree on which to emit, but they agree on what it decodes to. `X-App-Section`
 * is NOT signed: an app that routes one handler across several section types
 * would otherwise break.
 *
 * RESPONSE
 *
 *     200 {"schema_version": 1,
 *          "tree": [ …composable nodes… ],
 *          "cache": {"ttl": 300, "stale_ttl": 86400}}
 *
 * `cache` is a SUGGESTION. The platform clamps it into its own bounds — you
 * cannot ask for `ttl: 0` to be called on every pageview, and you cannot pin
 * content for a year.
 */

import { signWebhook, verifyWebhook, type VerifyResult } from './webhooks.js';

/**
 * One composable node. Intentionally open (`[key: string]: unknown`): the
 * platform owns the vocabulary and adds to it, and a closed type here would
 * make this package the thing that has to be republished every time it grows.
 * `type` is the only guaranteed field; `children` nest.
 */
export interface ComposableNode {
    type: string;
    children?: ComposableNode[];
    [key: string]: unknown;
}

/** Cache hints an app may suggest to the platform. */
export interface SectionCacheHints {
    /** Seconds the tree is considered fresh. Clamped by the platform. */
    ttl?: number;
    /** Extra seconds the tree may be served stale while refreshing. Clamped. */
    staleTtl?: number;
}

/** What an app's section handler returns. */
export interface SectionResult {
    tree: ComposableNode[];
    cache?: SectionCacheHints;
}

/** The body the platform expects to parse. */
export interface SectionResponseBody {
    schema_version: number;
    tree: ComposableNode[];
    cache?: { ttl?: number; stale_ttl?: number };
}

/** Context handed to an app's section handler. Both values are AUTHENTICATED. */
export interface SectionContext {
    /** The merchant profile the storefront render belongs to. */
    profileId: string;
    /** The merchant's configured settings for this placement. */
    settings: Record<string, unknown>;
    /** The section type being asked for (from `X-App-Section`, unsigned). */
    sectionType: string;
    /** The section schema version the platform is asking against. */
    schemaVersion: number;
}

/**
 * The section schema version this package speaks. Stamped onto every response
 * by {@link createSectionRoute} so the platform can reject a payload built
 * against a schema it does not understand instead of rendering it
 * unpredictably.
 */
export const SECTION_SCHEMA_VERSION = 1;

/**
 * RFC 3986 percent-encoding — the JS equivalent of PHP's `rawurlencode()`.
 *
 * `encodeURIComponent` leaves `!'()*` unescaped where `rawurlencode` escapes
 * them; without this the two sides disagree on any setting value containing
 * one of those five characters, and the app rejects a perfectly good request
 * with "signature mismatch".
 */
function rfc3986(value: string): string {
    return encodeURIComponent(value).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
}

/**
 * Build the canonical query string the platform signed.
 *
 * Accepts a `URLSearchParams` (the normal case — `new URL(req.url).searchParams`)
 * or a plain record. Pairs are sorted by key, then by value, so repeated keys
 * are ordered deterministically rather than by arrival.
 */
export function canonicalQuery(
    input: URLSearchParams | Record<string, string | number | boolean>,
): string {
    const pairs: Array<[string, string]> = [];

    if (input instanceof URLSearchParams) {
        for (const [key, value] of input.entries()) {
            pairs.push([key, value]);
        }
    } else {
        for (const [key, value] of Object.entries(input)) {
            pairs.push([key, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value)]);
        }
    }

    pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));

    return pairs.map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`).join('&');
}

export interface VerifySectionRequestInput {
    /** The inbound request URL — its query string is what was signed. */
    url: string;
    /** Either a Fetch `Headers` instance or a plain map. */
    headers: Headers | Record<string, string>;
    /** The install's `webhook_secret`. */
    secret: string;
    /** Reject timestamps further than this from now, either direction. Default 300. */
    maxSkewSeconds?: number;
    /** Unix SECONDS to treat as "now". Injected by tests. */
    now?: number;
}

/**
 * Verify a platform section request.
 *
 * A wrapper over {@link verifyWebhook} with the canonical query in the
 * `rawBody` position — same HMAC, same check order, same reason strings. The
 * reason string is what ends up in your logs AND in the platform's inspector,
 * so the two must never diverge.
 */
export function verifySectionRequest(input: VerifySectionRequestInput): VerifyResult {
    let query: URLSearchParams;

    try {
        query = new URL(input.url).searchParams;
    } catch {
        return { ok: false, reason: 'request URL could not be parsed' };
    }

    return verifyWebhook({
        rawBody: canonicalQuery(query),
        headers: input.headers,
        secret: input.secret,
        maxSkewSeconds: input.maxSkewSeconds,
        now: input.now,
    });
}

/**
 * Read the platform's section parameters out of a verified request.
 *
 * Call this only AFTER {@link verifySectionRequest} passes — the values are
 * attacker-controlled until the signature says otherwise. A malformed
 * `settings` param yields `{}` rather than throwing: a section that renders
 * with default settings beats a 500 on a merchant's storefront.
 */
export function readSectionContext(url: string, headers?: Headers | Record<string, string>): SectionContext {
    const params = new URL(url).searchParams;

    let settings: Record<string, unknown> = {};

    try {
        const raw = params.get('settings');
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            settings = parsed as Record<string, unknown>;
        }
    } catch {
        settings = {};
    }

    const sectionHeader =
        headers instanceof Headers
            ? headers.get('x-app-section')
            : headers
              ? (Object.entries(headers).find(([k]) => k.toLowerCase() === 'x-app-section')?.[1] ?? null)
              : null;

    const declared = Number(params.get('schema_version'));

    return {
        profileId: params.get('profile_id') ?? '',
        settings,
        sectionType: sectionHeader ?? '',
        schemaVersion: Number.isFinite(declared) && declared > 0 ? declared : SECTION_SCHEMA_VERSION,
    };
}

/**
 * Shape a handler result into the platform's response body.
 *
 * Exported separately from the route factory so an app on another framework
 * (Express, Hono, a Worker) can reuse the contract without adopting the Fetch
 * route shape.
 */
export function sectionResponseBody(result: SectionResult): SectionResponseBody {
    const body: SectionResponseBody = {
        schema_version: SECTION_SCHEMA_VERSION,
        tree: Array.isArray(result.tree) ? result.tree : [],
    };

    if (result.cache) {
        const cache: { ttl?: number; stale_ttl?: number } = {};
        if (typeof result.cache.ttl === 'number') cache.ttl = result.cache.ttl;
        if (typeof result.cache.staleTtl === 'number') cache.stale_ttl = result.cache.staleTtl;
        if (Object.keys(cache).length > 0) body.cache = cache;
    }

    return body;
}

/**
 * Compute the signature the platform would send for a section request.
 *
 * For TESTS and local fixtures only — same warning as `signWebhook`. Never
 * call it on an inbound request and compare by hand; that is what
 * {@link verifySectionRequest} and its constant-time compare are for.
 */
export function signSectionRequest(
    url: string,
    timestamp: number | string,
    webhookSecret: string,
): string {
    // Routed through `signWebhook` so this package contains exactly one HMAC.
    return signWebhook(canonicalQuery(new URL(url).searchParams), timestamp, webhookSecret);
}
