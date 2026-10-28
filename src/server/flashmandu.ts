/**
 * Minimal Flashmandu API client. The host exposes:
 *
 *   GET  /api/apps/me         — identity of the installed app (Bearer token)
 *   GET  /api/apps/hooks      — public hook catalog
 *   POST /api/apps/graphql    — the Apps GraphQL API (lighthouse.php:23-24;
 *                                mounted off /graphql on purpose, behind the
 *                                remote-app + throttle:60,1 middleware)
 *   POST /api/apps/media      — upload into the merchant's Media Library
 *                                (0.6.4, needs `write:media`; 0.6.5 adds
 *                                `visibility`, host default private → url
 *                                null); deletes ride
 *                                GraphQL `deleteMediaItem` (only items this
 *                                app added)
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

/** A Media Library item the host created for this app (201 body of POST /api/apps/media). */
export interface UploadedMedia {
    id: number;
    /** Public URL; null for a `private` item (the host default). Send `visibility: 'public'` to get one. */
    url: string | null;
    filename: string;
    mimeType: string;
    size: number;
    collection: string;
}

export interface MediaUploadOptions {
    /** File name the Media Library shows (and the extension the host checks). Required. */
    filename: string;
    /** Media Library collection, e.g. `tours`. Omitted → the host's default. */
    collection?: string;
    /** Alt text stored with the item. */
    alt?: string;
    /** MIME type for a Buffer/Uint8Array body. Default: guessed from `filename`. */
    mimeType?: string;
    /**
     * `public` items get a URL a storefront can load; `private` items answer
     * `url: null`. Omitted → the host default (`private`). 0.6.5.
     */
    visibility?: 'public' | 'private';
}

/** Bytes `media.upload()` accepts: a Blob/File as-is, or raw bytes (a Node Buffer is a Uint8Array). */
export type MediaUploadBody = Blob | Uint8Array | ArrayBuffer;

/**
 * The merchant's Media Library — the ONE store for app-made files, so every
 * app shares the profile's library and quota instead of keeping its own bucket.
 */
export interface FlashmanduMediaClient {
    /**
     * POST /api/apps/media. Resolves with the created item; rejects with a
     * {@link FlashmanduMediaError} subclass per host refusal: 403
     * {@link MediaScopeError} (the merchant has not granted `write:media`), 413
     * {@link MediaTooLargeError}, 422 {@link MediaInvalidError}, 507
     * {@link MediaQuotaError}. The error's `message` is the host's own words
     * (it may name the limit), meant for logs: show merchants your own copy
     * keyed on `code` / `serverCode`, never the host text.
     */
    upload(file: MediaUploadBody, options: MediaUploadOptions): Promise<UploadedMedia>;
    /**
     * GraphQL `deleteMediaItem(id)`. The host only lets an app delete items it
     * added; anything else is a GraphQL error (rejects). Resolves with the
     * host's boolean.
     */
    delete(id: number | string): Promise<boolean>;
}

/** Why `media.upload()` failed — the cause an app can act on, not the raw status. */
export type MediaErrorCode =
    /** 403: the install's scopes do not include `write:media` (not yet approved). */
    | 'scope_denied'
    /** 413: the file is over the platform's per-file limit. */
    | 'too_large'
    /** 422: the host refused the file or a field (type, name, collection). */
    | 'invalid'
    /** 507: the profile's media storage quota is used up. */
    | 'quota_exceeded'
    /** Any other non-2xx status. */
    | 'http'
    /** The request never completed (DNS, refused, timeout). */
    | 'network'
    /** A 2xx whose body is not the documented shape. */
    | 'bad_response';

/** A `media.upload()` rejection that names its cause. Subclassed per documented status. */
export class FlashmanduMediaError extends Error {
    readonly code: MediaErrorCode;
    /** HTTP status when a response arrived; null for `network`. */
    readonly status: number | null;
    /** The host's `error` slug, when the body carried one. */
    readonly serverCode: string | null;

    constructor(
        code: MediaErrorCode,
        message: string,
        options: { status?: number | null; serverCode?: string | null; cause?: unknown } = {},
    ) {
        super(message);
        this.name = 'FlashmanduMediaError';
        this.code = code;
        this.status = options.status ?? null;
        this.serverCode = options.serverCode ?? null;
        if (options.cause !== undefined) {
            (this as { cause?: unknown }).cause = options.cause;
        }
    }
}

/** 403 — `write:media` is not granted (yet). */
export class MediaScopeError extends FlashmanduMediaError {
    constructor(message: string, serverCode: string | null) {
        super('scope_denied', message, { status: 403, serverCode });
        this.name = 'MediaScopeError';
    }
}

/** 413 — over the platform's per-file limit; `message` names the limit. */
export class MediaTooLargeError extends FlashmanduMediaError {
    constructor(message: string, serverCode: string | null) {
        super('too_large', message, { status: 413, serverCode });
        this.name = 'MediaTooLargeError';
    }
}

/** 422 — the host refused the file or a field. */
export class MediaInvalidError extends FlashmanduMediaError {
    constructor(message: string, serverCode: string | null) {
        super('invalid', message, { status: 422, serverCode });
        this.name = 'MediaInvalidError';
    }
}

/** 507 — the profile's media storage is full. */
export class MediaQuotaError extends FlashmanduMediaError {
    constructor(message: string, serverCode: string | null) {
        super('quota_exceeded', message, { status: 507, serverCode });
        this.name = 'MediaQuotaError';
    }
}

/**
 * A non-2xx answer from `me()` / `hooks()` / `graphql()` (0.6.6). Same
 * message as before (it is still an `Error`); `status` lets a caller tell a
 * rejected token (401) from an unreachable host without parsing the text.
 */
export class FlashmanduApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'FlashmanduApiError';
        this.status = status;
    }
}

export interface FlashmanduClient {
    graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
    /** Media Library writes (0.6.4). Needs the `write:media` scope. */
    media: FlashmanduMediaClient;
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
        throw new FlashmanduApiError(res.status, `Flashmandu API ${res.status} ${res.statusText}: ${text}`);
    }
    if (res.status === 204) {
        return undefined as T;
    }
    return (await res.json()) as T;
}

const MIME_BY_EXT: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    webm: 'video/webm',
    pdf: 'application/pdf',
};

function guessMime(filename: string): string {
    const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
    return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function readBodyField(body: unknown, field: 'error' | 'message'): string | null {
    if (typeof body !== 'object' || body === null) return null;
    const v = (body as Record<string, unknown>)[field];
    return typeof v === 'string' && v !== '' ? v : null;
}

/** Map a non-2xx upload response onto its typed error (host message wins). */
function mediaErrorFor(status: number, body: unknown): FlashmanduMediaError {
    const slug = readBodyField(body, 'error');
    const message = readBodyField(body, 'message');
    switch (status) {
        case 403:
            return new MediaScopeError(message ?? 'The app is not allowed to add media (write:media is not granted).', slug);
        case 413:
            return new MediaTooLargeError(message ?? 'The file is larger than the platform allows.', slug);
        case 422:
            return new MediaInvalidError(message ?? 'The platform refused this file.', slug);
        case 507:
            return new MediaQuotaError(message ?? 'The media storage is full.', slug);
        default:
            return new FlashmanduMediaError('http', message ?? `The media upload failed (HTTP ${String(status)}).`, {
                status,
                serverCode: slug,
            });
    }
}

async function uploadMedia(
    opts: FlashmanduClientOptions,
    file: MediaUploadBody,
    options: MediaUploadOptions,
): Promise<UploadedMedia> {
    if (!opts.apiBase) {
        throw new Error('apiBase is not set.');
    }
    if (typeof options?.filename !== 'string' || options.filename.trim() === '') {
        throw new Error('media.upload() needs a filename.');
    }
    const blob = file instanceof Blob
        ? file
        : new Blob([file as BlobPart], { type: options.mimeType ?? guessMime(options.filename) });
    const form = new FormData();
    form.append('file', blob, options.filename);
    if (options.collection !== undefined && options.collection !== '') {
        form.append('collection', options.collection);
    }
    if (options.alt !== undefined && options.alt !== '') {
        form.append('alt', options.alt);
    }
    if (options.visibility !== undefined) {
        form.append('visibility', options.visibility);
    }

    let res: Response;
    try {
        // No Content-Type: fetch writes the multipart boundary itself.
        res = await fetch(`${opts.apiBase}/api/apps/media`, {
            method: 'POST',
            headers: { Accept: 'application/json', Authorization: `Bearer ${opts.token}` },
            body: form,
        });
    } catch (cause) {
        throw new FlashmanduMediaError('network', 'The media upload could not reach the platform.', { cause });
    }
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
        throw mediaErrorFor(res.status, body);
    }
    const item = body as Partial<UploadedMedia> | null;
    if (item === null || item.id === undefined || item.id === null || !(typeof item.url === 'string' || item.url === null)) {
        throw new FlashmanduMediaError('bad_response', 'The platform answered the upload without a media id.', {
            status: res.status,
        });
    }
    return { ...(item as UploadedMedia), id: Number(item.id), url: item.url ?? null };
}

/**
 * Create a Flashmandu API client bound to `{ apiBase, token }`.
 *
 * `graphql()` is the general-purpose entry point new callers should reach
 * for; `me()`/`hooks()` are the two REST endpoints the app template already
 * relied on, kept for parity with the ported source.
 */
export function createFlashmanduClient(opts: FlashmanduClientOptions): FlashmanduClient {
    const graphql = <T>(query: string, variables?: Record<string, unknown>): Promise<T> =>
        request<{ data?: T; errors?: Array<{ message: string }> }>(opts, '/api/apps/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, variables }),
        }).then((res) => {
            if (res.errors && res.errors.length > 0) {
                throw new Error(`Flashmandu GraphQL error: ${res.errors.map((e) => e.message).join('; ')}`);
            }
            return res.data as T;
        });

    return {
        graphql,
        media: {
            upload: (file, options) => uploadMedia(opts, file, options),
            async delete(id) {
                const data = await graphql<{ deleteMediaItem: boolean }>(
                    'mutation AppDeleteMedia($id: ID!) { deleteMediaItem(id: $id) }',
                    { id: String(id) },
                );
                return data?.deleteMediaItem === true;
            },
        },
        me() {
            return request(opts, '/api/apps/me');
        },
        hooks() {
            return request(opts, '/api/apps/hooks');
        },
    };
}
