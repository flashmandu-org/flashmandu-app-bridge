import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Runtime config for a Flashmandu embedded app's server code.
 *
 * Ported from the tours/orbit app template's `lib/config.ts` — the env var
 * names, resolution order (`process.env` first, then the newest
 * `.flashmandu/sandbox-secrets.<app>.json` written by `autohisab-business
 * dev`), and the sandbox-secrets file lookup are copied verbatim.
 *
 * DIVERGENCE FROM THE APP-LOCAL SOURCE: the app-local `loadConfig()` throws
 * synchronously via a `required()` helper when `apiToken`/`webhookSecret` are
 * absent, so importing it in a route or a `next build` without provisioned
 * credentials already explodes there. The packaged version must not — a
 * config object has to be constructible in tests and at cold `next build`
 * time before any request has arrived. So `loadConfig()` itself never throws;
 * `apiToken`/`webhookSecret`/`devBoxBaseUrl` resolve to `''` when absent, and
 * `appSecret()` is the one lazy, memoized method that throws — but only when
 * something actually calls it (mirrors the app-local `server-auth.ts`
 * `appSecret()` lazy-secret pattern, which is the documented canonical
 * doctrine for this package per the consolidation spec §2.1/§4.1).
 */

export interface AppConfig {
    /** Bearer token issued once by the dev-box at install/dev-register time. */
    apiToken: string;
    /** HMAC secret used to verify inbound webhook signatures. */
    webhookSecret: string;
    /** Dev-box base URL (never a production host). */
    devBoxBaseUrl: string;
    /**
     * HMAC secret the platform signs storefront embed tokens with. Sourced
     * from the delivered `webhook_secret` (same value as `webhookSecret`,
     * exposed under the name the token verifier expects).
     *
     * Resolved LAZILY and memoized — never at module scope or inside
     * `loadConfig()` itself — so importing a route, or running `next build`
     * / a test, without provisioned credentials never throws. It throws only
     * when a caller actually needs the secret (e.g. verifying an embed
     * token).
     */
    appSecret(): string;
}

/** Map env var names to their key in the sandbox-secrets JSON file. */
const SANDBOX_KEY: Record<string, string> = {
    FLASHMANDU_API_TOKEN: 'api_token',
    FLASHMANDU_WEBHOOK_SECRET: 'webhook_secret',
    FLASHMANDU_APP_SECRET: 'webhook_secret',
    FLASHMANDU_DEV_BOX_BASE_URL: 'dev_box_base_url',
};

function fromSandboxSecrets(name: string): string | undefined {
    try {
        const dir = path.join(process.cwd(), '.flashmandu');
        const file = readdirSync(dir)
            .filter((f) => /^sandbox-secrets\..+\.json$/.test(f))
            .sort()
            .pop();
        if (!file) {
            return undefined;
        }
        const parsed = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as Record<
            string,
            unknown
        >;
        const value = parsed[SANDBOX_KEY[name] ?? ''];
        return typeof value === 'string' && value !== '' ? value : undefined;
    } catch {
        return undefined;
    }
}

function resolve(env: NodeJS.ProcessEnv, name: string): string | undefined {
    return env[name] || fromSandboxSecrets(name);
}

/**
 * Load the app's runtime config.
 *
 * `env` defaults to `process.env` and is otherwise injectable for tests.
 * Never throws — a missing `FLASHMANDU_APP_SECRET` only surfaces when a
 * caller invokes `appSecret()`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
    const apiToken = resolve(env, 'FLASHMANDU_API_TOKEN') ?? '';
    const webhookSecret = resolve(env, 'FLASHMANDU_WEBHOOK_SECRET') ?? '';
    const devBoxBaseUrl = (resolve(env, 'FLASHMANDU_DEV_BOX_BASE_URL') ?? '').replace(/\/+$/, '');

    let memoizedSecret: string | null = null;

    function appSecret(): string {
        if (memoizedSecret !== null) {
            return memoizedSecret;
        }
        const value = resolve(env, 'FLASHMANDU_APP_SECRET');
        if (!value) {
            throw new Error(
                'Missing FLASHMANDU_APP_SECRET. Run `autohisab-business dev` — it registers ' +
                    'your app on the dev-box and writes .flashmandu/sandbox-secrets.<app>.json, ' +
                    'which this loader reads.',
            );
        }
        memoizedSecret = value;
        return memoizedSecret;
    }

    return { apiToken, webhookSecret, devBoxBaseUrl, appSecret };
}
