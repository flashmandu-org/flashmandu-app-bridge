import { afterEach, describe, expect, it } from 'vitest';

import { createAppBridge } from '../app-bridge.js';
import { MessageType } from '../types.js';
import {
    applyStyleTokens,
    cacheStyleTokens,
    readStyleRevFromUrl,
    styleBootstrapScript,
    STYLE_CACHE_STORAGE_KEY,
} from '../style.js';

/**
 * Same hand-rolled fake window as `theme.test.ts`: no jsdom in this repo, and
 * Node's MessageEvent will not take a non-MessagePort `source`.
 */
const PARENT_ORIGIN = 'https://merchant.flashmandu.example';
const SEARCH = `?session_token=t&app_id=a&parent_origin=${encodeURIComponent(PARENT_ORIGIN)}`;

interface FakeStorage {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
}

/** In-memory `Storage` stand-in, and a THROWING variant for the sandboxed case. */
function memoryStorage(): FakeStorage {
    const map = new Map<string, string>();
    return {
        getItem: (key) => map.get(key) ?? null,
        setItem: (key, value) => {
            map.set(key, value);
        },
    };
}

interface FakeWindow extends EventTarget {
    parent: FakeWindow;
    postMessage: (message: unknown, targetOrigin: string) => void;
    sent: unknown[];
    location: { search: string; hash: string };
    localStorage?: FakeStorage;
}

function installFakeWindow(init: { hash?: string; localStorage?: FakeStorage | 'throw' } = {}): FakeWindow {
    const fake = new EventTarget() as FakeWindow;
    fake.parent = fake;
    fake.sent = [];
    fake.postMessage = (message: unknown): void => {
        fake.sent.push(message);
    };
    fake.location = { search: SEARCH, hash: init.hash ?? '' };
    if (init.localStorage === 'throw') {
        Object.defineProperty(fake, 'localStorage', {
            get() {
                throw new DOMException('Access is denied for this document.', 'SecurityError');
            },
        });
    } else if (init.localStorage !== undefined) {
        fake.localStorage = init.localStorage;
    }
    (globalThis as Record<string, unknown>).window = fake;
    return fake;
}

let host: FakeWindow;

afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
});

function makeBridge(opts: Parameters<typeof createAppBridge>[0] = {}): ReturnType<typeof createAppBridge> {
    return createAppBridge({
        search: SEARCH,
        parent: host.parent as unknown as Window,
        view: host as unknown as Window & typeof globalThis,
        ...opts,
    });
}

function dispatch(data: unknown): void {
    const event = new Event('message') as Event & Record<string, unknown>;
    event.data = data;
    event.origin = PARENT_ORIGIN;
    event.source = host;
    host.dispatchEvent(event);
}

describe('applyStyleTokens', () => {
    function fakeDocument(): { documentElement: Record<string, unknown> } {
        return {
            documentElement: {
                style: {
                    props: {} as Record<string, string>,
                    setProperty(this: { props: Record<string, string> }, name: string, value: string) {
                        this.props[name] = value;
                    },
                },
            },
        };
    }

    it('writes each entry with setProperty', () => {
        const doc = fakeDocument();
        applyStyleTokens({ '--tours-card-bg': '#fff', '--tours-card-radius': '12px' }, doc as unknown as Document);

        const props = (doc.documentElement.style as { props: Record<string, string> }).props;
        expect(props).toEqual({ '--tours-card-bg': '#fff', '--tours-card-radius': '12px' });
    });

    it('skips a key that is not a custom-property name and a non-string value', () => {
        const doc = fakeDocument();
        applyStyleTokens(
            { 'not-a-var': 'red', '--ok': 'blue', '--bad': 12 as unknown as string },
            doc as unknown as Document,
        );

        const props = (doc.documentElement.style as { props: Record<string, string> }).props;
        expect(props).toEqual({ '--ok': 'blue' });
    });

    it('does not throw without a document (SSR)', () => {
        expect(() => applyStyleTokens({ '--x': 'y' }, null)).not.toThrow();
    });

    it('does not throw with a malformed vars argument', () => {
        const doc = fakeDocument();
        expect(() => applyStyleTokens(null, doc as unknown as Document)).not.toThrow();
        expect(() => applyStyleTokens(undefined, doc as unknown as Document)).not.toThrow();
    });
});

describe('readStyleRevFromUrl', () => {
    it('reads the fragment', () => {
        expect(readStyleRevFromUrl({ hash: '#fm_style_rev=abc123', search: '' })).toBe('abc123');
    });

    it('reads the query string as a fallback', () => {
        expect(readStyleRevFromUrl({ hash: '', search: '?fm_style_rev=xyz789' })).toBe('xyz789');
    });

    it('prefers the fragment over the query when both are present', () => {
        expect(readStyleRevFromUrl({ hash: '#fm_style_rev=fromhash', search: '?fm_style_rev=fromquery' })).toBe('fromhash');
    });

    it('is read out of a fragment that also carries app router state', () => {
        expect(readStyleRevFromUrl({ hash: '#/reports?tab=2&fm_style_rev=rev1', search: '' })).toBe('rev1');
    });

    it('rejects a value with characters outside the safe revision charset', () => {
        expect(readStyleRevFromUrl({ hash: '#fm_style_rev=abc;DROP TABLE', search: '' })).toBeNull();
    });

    it('is null with nothing present', () => {
        expect(readStyleRevFromUrl({ hash: '', search: '' })).toBeNull();
        expect(readStyleRevFromUrl(null)).toBeNull();
        expect(readStyleRevFromUrl(undefined)).toBeNull();
    });
});

describe('cacheStyleTokens', () => {
    it('writes {rev, vars} as JSON under the shared storage key', () => {
        const storage = memoryStorage();
        cacheStyleTokens('rev1', { '--x': 'y' }, storage as unknown as Storage);

        expect(JSON.parse(storage.getItem(STYLE_CACHE_STORAGE_KEY)!)).toEqual({ rev: 'rev1', vars: { '--x': 'y' } });
    });

    it('is a no-op with no revision', () => {
        const storage = memoryStorage();
        cacheStyleTokens(null, { '--x': 'y' }, storage as unknown as Storage);
        cacheStyleTokens('', { '--x': 'y' }, storage as unknown as Storage);

        expect(storage.getItem(STYLE_CACHE_STORAGE_KEY)).toBeNull();
    });

    it('is a silent no-op when storage access itself throws — the storefront sandbox case', () => {
        const throwingStorage = {
            getItem() {
                throw new DOMException('denied', 'SecurityError');
            },
            setItem() {
                throw new DOMException('denied', 'SecurityError');
            },
        };

        expect(() => cacheStyleTokens('rev1', { '--x': 'y' }, throwingStorage as unknown as Storage)).not.toThrow();
    });

    it('is a silent no-op with no storage at all', () => {
        expect(() => cacheStyleTokens('rev1', { '--x': 'y' }, null)).not.toThrow();
    });
});

describe('pre-paint bootstrap script', () => {
    /** Exercises the generated source directly, same technique as `theme.test.ts`. */
    function runBootstrap(init: {
        hash?: string;
        search?: string;
        storage?: FakeStorage | 'throw';
    }): { props: Record<string, string> } {
        const props: Record<string, string> = {};
        const root = {
            style: { setProperty: (k: string, v: string) => { props[k] = v; } },
        };

        let localStorageDescriptor: FakeStorage | undefined;
        const scope: Record<string, unknown> = {
            location: { hash: init.hash ?? '', search: init.search ?? '' },
            document: { documentElement: root },
        };

        if (init.storage === 'throw') {
            Object.defineProperty(scope, 'localStorage', {
                get() {
                    throw new DOMException('denied', 'SecurityError');
                },
            });
        } else {
            localStorageDescriptor = init.storage ?? memoryStorage();
            scope.localStorage = localStorageDescriptor;
        }
        scope.window = scope;

        // eslint-disable-next-line no-new-func -- exercising generated source is the point
        new Function('location', 'document', 'window', styleBootstrapScript())(
            scope.location,
            scope.document,
            scope.window,
        );

        return { props };
    }

    it('is dependency-free: runs standalone with no bridge module loaded', () => {
        expect(() => runBootstrap({ hash: '#fm_style_rev=rev1' })).not.toThrow();
    });

    it('no-ops with no revision in the URL at all', () => {
        const storage = memoryStorage();
        storage.setItem(STYLE_CACHE_STORAGE_KEY, JSON.stringify({ rev: 'rev1', vars: { '--x': 'y' } }));

        expect(runBootstrap({ storage }).props).toEqual({});
    });

    it('no-ops without storage (sandboxed storefront iframe — no allow-same-origin)', () => {
        expect(runBootstrap({ hash: '#fm_style_rev=rev1', storage: 'throw' }).props).toEqual({});
    });

    it('no-ops with no cache entry at all', () => {
        expect(runBootstrap({ hash: '#fm_style_rev=rev1', storage: memoryStorage() }).props).toEqual({});
    });

    it('applies the cached map when the revision matches', () => {
        const storage = memoryStorage();
        storage.setItem(
            STYLE_CACHE_STORAGE_KEY,
            JSON.stringify({ rev: 'rev1', vars: { '--tours-card-bg': '#161616', '--tours-card-radius': '12px' } }),
        );

        expect(runBootstrap({ hash: '#fm_style_rev=rev1', storage }).props).toEqual({
            '--tours-card-bg': '#161616',
            '--tours-card-radius': '12px',
        });
    });

    it('does NOT apply a stale cache entry for a different revision', () => {
        const storage = memoryStorage();
        storage.setItem(STYLE_CACHE_STORAGE_KEY, JSON.stringify({ rev: 'old-rev', vars: { '--x': 'stale' } }));

        expect(runBootstrap({ hash: '#fm_style_rev=new-rev', storage }).props).toEqual({});
    });

    it('reads the query string when the host put the revision there instead', () => {
        const storage = memoryStorage();
        storage.setItem(STYLE_CACHE_STORAGE_KEY, JSON.stringify({ rev: 'rev1', vars: { '--x': 'y' } }));

        expect(runBootstrap({ search: '?fm_style_rev=rev1', storage }).props).toEqual({ '--x': 'y' });
    });

    it('never throws on a corrupt cache entry', () => {
        const storage = memoryStorage();
        storage.setItem(STYLE_CACHE_STORAGE_KEY, 'not json at all');

        expect(() => runBootstrap({ hash: '#fm_style_rev=rev1', storage })).not.toThrow();
    });
});

describe('STYLE_TOKENS message, via the bridge', () => {
    it('applies the pushed vars to the document root by default', () => {
        host = installFakeWindow({ localStorage: memoryStorage() });
        const bridge = makeBridge();

        dispatch({
            type: MessageType.StyleTokens,
            payload: { surface: 'pin_card', vars: { '--tours-card-bg': '#161616' }, rev: 'rev1' },
        });

        expect(bridge.styleTokens).toEqual({ '--tours-card-bg': '#161616' });
    });

    it('merges rather than replaces across successive pushes', () => {
        host = installFakeWindow({ localStorage: memoryStorage() });
        const bridge = makeBridge();

        dispatch({ type: MessageType.StyleTokens, payload: { surface: 's', vars: { '--a': '1' }, rev: 'r1' } });
        dispatch({ type: MessageType.StyleTokens, payload: { surface: 's', vars: { '--b': '2' }, rev: 'r2' } });

        expect(bridge.styleTokens).toEqual({ '--a': '1', '--b': '2' });
    });

    it('notifies onStyleTokens with the full merged map, not just the delta', () => {
        host = installFakeWindow({ localStorage: memoryStorage() });
        const bridge = makeBridge();
        const seen: Record<string, string>[] = [];
        bridge.onStyleTokens((vars) => seen.push(vars));

        dispatch({ type: MessageType.StyleTokens, payload: { surface: 's', vars: { '--a': '1' }, rev: 'r1' } });
        dispatch({ type: MessageType.StyleTokens, payload: { surface: 's', vars: { '--b': '2' }, rev: 'r2' } });

        expect(seen).toEqual([{ '--a': '1' }, { '--a': '1', '--b': '2' }]);
    });

    it('drops a non-object vars payload rather than throwing', () => {
        host = installFakeWindow({ localStorage: memoryStorage() });
        const bridge = makeBridge();

        dispatch({ type: MessageType.StyleTokens, payload: { surface: 's', vars: null, rev: 'r1' } });
        dispatch({ type: MessageType.StyleTokens, payload: null });

        expect(bridge.styleTokens).toEqual({});
    });

    it('drops a key that is not a custom-property name from the pushed vars', () => {
        host = installFakeWindow({ localStorage: memoryStorage() });
        const bridge = makeBridge();

        dispatch({
            type: MessageType.StyleTokens,
            payload: { surface: 's', vars: { 'not-a-var': 'red', '--ok': 'blue' }, rev: 'r1' },
        });

        expect(bridge.styleTokens).toEqual({ '--ok': 'blue' });
    });

    it('drops a STYLE_TOKENS message from an origin that is not the parent', () => {
        host = installFakeWindow({ localStorage: memoryStorage() });
        const bridge = makeBridge();

        const event = new Event('message') as Event & Record<string, unknown>;
        event.data = { type: MessageType.StyleTokens, payload: { surface: 's', vars: { '--a': '1' }, rev: 'r1' } };
        event.origin = 'https://evil.example';
        event.source = host;
        host.dispatchEvent(event);

        expect(bridge.styleTokens).toEqual({});
    });

    it('caches the merged map for the next pre-paint bootstrap, keyed by the pushed revision', () => {
        const storage = memoryStorage();
        host = installFakeWindow({ localStorage: storage });
        const bridge = makeBridge();

        dispatch({
            type: MessageType.StyleTokens,
            payload: { surface: 's', vars: { '--a': '1' }, rev: 'rev-cached' },
        });

        expect(JSON.parse(storage.getItem(STYLE_CACHE_STORAGE_KEY)!)).toEqual({
            rev: 'rev-cached',
            vars: { '--a': '1' },
        });
        void bridge; // keep bridge alive for lint; assertions are on storage
    });

    it('stops calling a listener after it unsubscribes', () => {
        host = installFakeWindow({ localStorage: memoryStorage() });
        const bridge = makeBridge();
        const seen: Record<string, string>[] = [];
        const off = bridge.onStyleTokens((vars) => seen.push(vars));

        dispatch({ type: MessageType.StyleTokens, payload: { surface: 's', vars: { '--a': '1' }, rev: 'r1' } });
        off();
        dispatch({ type: MessageType.StyleTokens, payload: { surface: 's', vars: { '--b': '2' }, rev: 'r2' } });

        expect(seen).toEqual([{ '--a': '1' }]);
    });
});

describe('the { applyStyleTokens: false } opt-out', () => {
    function fakeDoc(): { documentElement: Record<string, unknown>; props: Record<string, string> } {
        const props: Record<string, string> = {};
        return {
            documentElement: { style: { setProperty: (k: string, v: string) => { props[k] = v; } } },
            props,
        };
    }

    it('still tracks bridge.styleTokens and notifies onStyleTokens, but never paints the DOM', () => {
        const doc = fakeDoc();
        host = installFakeWindow({ localStorage: memoryStorage() });
        (host as unknown as { document: unknown }).document = doc;
        const bridge = makeBridge({ applyStyleTokens: false });
        const seen: Record<string, string>[] = [];
        bridge.onStyleTokens((vars) => seen.push(vars));

        dispatch({
            type: MessageType.StyleTokens,
            payload: { surface: 'pin_card', vars: { '--tours-card-bg': '#161616' }, rev: 'rev1' },
        });

        expect(bridge.styleTokens).toEqual({ '--tours-card-bg': '#161616' });
        expect(seen).toEqual([{ '--tours-card-bg': '#161616' }]);
        expect(doc.props).toEqual({});
    });

    it('defaults to applying (opt-out requires an explicit false, not merely omitting the option)', () => {
        const doc = fakeDoc();
        host = installFakeWindow({ localStorage: memoryStorage() });
        (host as unknown as { document: unknown }).document = doc;
        makeBridge();

        dispatch({ type: MessageType.StyleTokens, payload: { surface: 's', vars: { '--a': 'red' }, rev: 'r1' } });

        expect(doc.props).toEqual({ '--a': 'red' });
    });
});

describe('CONTEXT.styleTokens', () => {
    it('is applied and merged into bridge.styleTokens on handshake', async () => {
        const doc = { documentElement: { style: { props: {} as Record<string, string>, setProperty(this: { props: Record<string, string> }, k: string, v: string) { this.props[k] = v; } } } };
        host = installFakeWindow({ localStorage: memoryStorage() });
        (host as unknown as { document: unknown }).document = doc;
        const bridge = makeBridge();

        dispatch({
            type: MessageType.Context,
            payload: { origin: PARENT_ORIGIN, styleTokens: { '--tours-card-bg': '#fff' } },
        });
        await bridge.ready();

        expect(bridge.styleTokens).toEqual({ '--tours-card-bg': '#fff' });
        expect((doc.documentElement.style as { props: Record<string, string> }).props).toEqual({
            '--tours-card-bg': '#fff',
        });
    });

    it('lands on the resolved context object', async () => {
        host = installFakeWindow({ localStorage: memoryStorage() });
        const bridge = makeBridge();

        dispatch({
            type: MessageType.Context,
            payload: { origin: PARENT_ORIGIN, styleTokens: { '--a': '1' } },
        });

        await expect(bridge.ready()).resolves.toMatchObject({ styleTokens: { '--a': '1' } });
    });

    it('defaults to an empty object when the host declares none — never undefined', async () => {
        host = installFakeWindow({ localStorage: memoryStorage() });
        const bridge = makeBridge();

        dispatch({ type: MessageType.Context, payload: { origin: PARENT_ORIGIN } });
        await bridge.ready();

        expect(bridge.styleTokens).toEqual({});
        expect(bridge.context?.styleTokens).toEqual({});
    });

    it('a later STYLE_TOKENS push still merges on top of the CONTEXT map', async () => {
        host = installFakeWindow({ localStorage: memoryStorage() });
        const bridge = makeBridge();

        dispatch({ type: MessageType.Context, payload: { origin: PARENT_ORIGIN, styleTokens: { '--a': '1' } } });
        await bridge.ready();
        dispatch({ type: MessageType.StyleTokens, payload: { surface: 's', vars: { '--b': '2' }, rev: 'r1' } });

        expect(bridge.styleTokens).toEqual({ '--a': '1', '--b': '2' });
        expect(bridge.context?.styleTokens).toEqual({ '--a': '1', '--b': '2' });
    });
});
