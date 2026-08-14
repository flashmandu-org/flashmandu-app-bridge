/**
 * Minimal Flashmandu API client. The host exposes:
 *
 *   GET  /api/apps/me         — identity of the installed app (Bearer token)
 *   GET  /api/apps/hooks      — public hook catalog
 *   POST /api/apps/graphql    — the Apps GraphQL API (lighthouse.php:23-24;
 *                                mounted off /graphql on purpose, behind the
 *                                remote-app + throttle:60,1 middleware)
 *
 * `me()`/`hooks()` are ported verbatim from the byte-identical
 * `lib/flashmandu.ts` shipped by all four remote apps
 * (tours/orbit/interactive-map/showcase) — that file predates GraphQL and
 * only ever called those two REST endpoints; it has no `graphql()` method.
 * DIVERGENCE: Task B1 asks for `createFlashmanduClient` to expose
 * `graphql<T>(query, variables?)`, so this port adds it as a thin wrapper
 * over `/api/apps/graphql`, alongside the two ported REST methods rather
 * than replacing them.
 *
 * The app-local version read `AppConfig` (`devBoxBaseUrl`/`apiToken`)
 * directly via `loadConfig()`; this package version takes `{ apiBase, token
 * }` as explicit options instead, so callers control config resolution.
 *
 * Intentionally framework-free (fetch only) so it can be lifted into any
 * runtime.
 */

export interface FlashmanduClientOptions {
    /** Dev-box / platform base URL (never a production host in dev). */
    apiBase: string;
    /** Bearer token issued once at install/dev-register time. */
    token: string;
}

export interface FlashmanduClient {
    graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
    /** GET /api/apps/me — verify the install + read scopes. */
    me(): Promise<{
        app_id: string;
        name: string;
        profile_id: number;
        scopes: string[];
        subscribed_events: string[];
    }>;
    /** GET /api/apps/hooks — public hook catalog (no auth needed). */
    hooks(): Promise<Record<string, { description: string; category: string; type?: string }>>;
}

async function request<T>(opts: FlashmanduClientOptions, p: string, init: RequestInit = {}): Promise<T> {
    if (!opts.apiBase) {
        throw new Error('apiBase is not set.');
    }
    const res = await fetch(`${opts.apiBase}${p}`, {
        ...init,
        headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${opts.token}`,
            ...(init.headers ?? {}),
        },
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Flashmandu API ${res.status} ${res.statusText}: ${text}`);
    }
    if (res.status === 204) {
        return undefined as T;
    }
    return (await res.json()) as T;
}

/**
 * Create a Flashmandu API client bound to `{ apiBase, token }`.
 *
 * `graphql()` is the general-purpose entry point new callers should reach
 * for; `me()`/`hooks()` are the two REST endpoints the app template already
 * relied on, kept for parity with the ported source.
 */
export function createFlashmanduClient(opts: FlashmanduClientOptions): FlashmanduClient {
    return {
        graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
            return request<{ data?: T; errors?: Array<{ message: string }> }>(opts, '/api/apps/graphql', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, variables }),
            }).then((res) => {
                if (res.errors && res.errors.length > 0) {
                    throw new Error(`Flashmandu GraphQL error: ${res.errors.map((e) => e.message).join('; ')}`);
                }
                return res.data as T;
            });
        },
        me() {
            return request(opts, '/api/apps/me');
        },
        hooks() {
            return request(opts, '/api/apps/hooks');
        },
    };
}
