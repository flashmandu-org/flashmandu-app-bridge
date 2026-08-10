import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAppBridge } from '../app-bridge.js';
import { MessageType } from '../types.js';
import {
    applyColorScheme,
    normaliseColorScheme,
    readThemeFromUrl,
    resolveInitialColorScheme,
    themeBootstrapScript,
    THEME_ATTRIBUTE,
    THEME_CLASS,
} from '../theme.js';

/**
 * The bug this whole feature exists for: an embedded app followed the OS of
 * whoever was looking at it instead of the merchant's admin theme, so a light
 * admin on a dark-OS machine framed a dark app.
 *
 * Three things have to hold, and each has a test below:
 *   1. INITIAL — the scheme is known synchronously, at construction, from the
 *      embed URL fragment. Not after `ready()`, because anything after the
 *      first paint is a flash.
 *   2. LIVE — a THEME message mid-session moves it, without a reload.
 *   3. FALLBACK — with no host and no fragment (a standalone app, or any
 *      pre-0.3 host), `prefers-color-scheme` still decides.
 *
 * Same hand-rolled fake window as the other suites here: no jsdom in this repo,
 * and Node's MessageEvent will not take a non-MessagePort `source`.
 */

const PARENT_ORIGIN = 'https://merchant.flashmandu.example';
const SEARCH = `?session_token=t&app_id=a&parent_origin=${encodeURIComponent(PARENT_ORIGIN)}`;

interface FakeWindow extends EventTarget {
    parent: FakeWindow;
    postMessage: (message: unknown, targetOrigin: string) => void;
    sent: unknown[];
    location: { search: string; hash: string };
    matchMedia?: (query: string) => { matches: boolean };
}

function installFakeWindow(init: { hash?: string; prefersDark?: boolean } = {}): FakeWindow {
    const fake = new EventTarget() as FakeWindow;
    fake.parent = fake;
    fake.sent = [];
    fake.postMessage = (message: unknown): void => {
        fake.sent.push(message);
    };
    fake.location = { search: SEARCH, hash: init.hash ?? '' };
    fake.matchMedia = (query: string) => ({
        matches: query.includes('dark') && init.prefersDark === true,
    });
    (globalThis as Record<string, unknown>).window = fake;
    return fake;
}

let host: FakeWindow;

afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
});

function makeBridge(): ReturnType<typeof createAppBridge> {
    return createAppBridge({
        search: SEARCH,
        parent: host.parent as unknown as Window,
        view: host as unknown as Window & typeof globalThis,
    });
}

function dispatch(data: unknown): void {
    const event = new Event('message') as Event & Record<string, unknown>;
    event.data = data;
    event.origin = PARENT_ORIGIN;
    event.source = host;
    host.dispatchEvent(event);
}

describe('initial value', () => {
    it('is readable synchronously at construction, before ready() settles', () => {
        host = installFakeWindow({ hash: '#fm_theme=dark' });
        const bridge = makeBridge();

        // The point of the whole design: no await, no handshake, no paint.
        expect(bridge.theme).toBe('dark');
        expect(bridge.context).toBeNull();
    });

    it('beats the OS preference — the merchant, not the developer, decides', () => {
        host = installFakeWindow({ hash: '#fm_theme=light', prefersDark: true });

        expect(makeBridge().theme).toBe('light');
    });

    it('is read out of a fragment that also carries app router state', () => {
        host = installFakeWindow({ hash: '#/reports/monthly?tab=2&fm_theme=dark' });

        expect(makeBridge().theme).toBe('dark');
    });

    it('lands on the context object CONTEXT resolves with', async () => {
        host = installFakeWindow({ hash: '#fm_theme=dark' });
        const bridge = makeBridge();

        dispatch({ type: MessageType.Context, payload: { origin: PARENT_ORIGIN, theme: 'dark' } });

        await expect(bridge.ready()).resolves.toMatchObject({ theme: 'dark' });
    });

    it('takes CONTEXT over a stale fragment when the two disagree', async () => {
        host = installFakeWindow({ hash: '#fm_theme=light' });
        const bridge = makeBridge();

        dispatch({ type: MessageType.Context, payload: { origin: PARENT_ORIGIN, theme: 'dark' } });

        expect(bridge.theme).toBe('dark');
        await expect(bridge.ready()).resolves.toMatchObject({ theme: 'dark' });
    });
});

describe('live change', () => {
    it('follows a THEME message without a reload, and tells subscribers', () => {
        host = installFakeWindow({ hash: '#fm_theme=light' });
        const bridge = makeBridge();
        const seen: string[] = [];
        bridge.onTheme((next) => seen.push(next));

        dispatch({ type: MessageType.Theme, payload: { theme: 'dark' } });
        expect(bridge.theme).toBe('dark');

        dispatch({ type: MessageType.Theme, payload: { theme: 'light' } });
        expect(bridge.theme).toBe('light');

        expect(seen).toEqual(['dark', 'light']);
    });

    it('refreshes the already-resolved context object in place', async () => {
        host = installFakeWindow({ hash: '#fm_theme=light' });
        const bridge = makeBridge();
        dispatch({ type: MessageType.Context, payload: { origin: PARENT_ORIGIN, theme: 'light' } });
        await bridge.ready();

        dispatch({ type: MessageType.Theme, payload: { theme: 'dark' } });

        // An app that held the object from ready() must not read a stale scheme.
        expect(bridge.context?.theme).toBe('dark');
    });

    it('stays silent when the host restates the scheme it is already on', () => {
        host = installFakeWindow({ hash: '#fm_theme=dark' });
        const bridge = makeBridge();
        const seen: string[] = [];
        bridge.onTheme((next) => seen.push(next));

        dispatch({ type: MessageType.Theme, payload: { theme: 'dark' } });

        expect(seen).toEqual([]);
    });

    it('ignores a malformed or unknown scheme rather than resetting to light', () => {
        host = installFakeWindow({ hash: '#fm_theme=dark' });
        const bridge = makeBridge();

        dispatch({ type: MessageType.Theme, payload: { theme: 'solarized' } });
        dispatch({ type: MessageType.Theme, payload: null });

        expect(bridge.theme).toBe('dark');
    });

    it('drops a THEME message from an origin that is not the parent', () => {
        host = installFakeWindow({ hash: '#fm_theme=light' });
        const bridge = makeBridge();

        const event = new Event('message') as Event & Record<string, unknown>;
        event.data = { type: MessageType.Theme, payload: { theme: 'dark' } };
        event.origin = 'https://evil.example';
        event.source = host;
        host.dispatchEvent(event);

        expect(bridge.theme).toBe('light');
    });

    it('stops calling a listener after it unsubscribes', () => {
        host = installFakeWindow({ hash: '#fm_theme=light' });
        const bridge = makeBridge();
        const seen: string[] = [];
        const off = bridge.onTheme((next) => seen.push(next));

        dispatch({ type: MessageType.Theme, payload: { theme: 'dark' } });
        off();
        dispatch({ type: MessageType.Theme, payload: { theme: 'light' } });

        expect(seen).toEqual(['dark']);
    });
});

describe('fallback', () => {
    it('follows prefers-color-scheme when no host declares anything', () => {
        host = installFakeWindow({ prefersDark: true });

        expect(makeBridge().theme).toBe('dark');
    });

    it('is light when nothing at all is known', () => {
        host = installFakeWindow({ prefersDark: false });

        expect(makeBridge().theme).toBe('light');
    });

    it('keeps the OS value when a pre-0.3 host sends CONTEXT without a theme', async () => {
        host = installFakeWindow({ prefersDark: true });
        const bridge = makeBridge();

        dispatch({ type: MessageType.Context, payload: { origin: PARENT_ORIGIN } });
        await bridge.ready();

        // Host silence must not be read as "light" — that is the pre-0.3 wire.
        expect(bridge.theme).toBe('dark');
    });

    it('survives a window with no matchMedia at all', () => {
        host = installFakeWindow();
        delete host.matchMedia;

        expect(makeBridge().theme).toBe('light');
    });
});

describe('pure helpers', () => {
    it('normalises only the two resolved schemes', () => {
        expect(normaliseColorScheme('dark')).toBe('dark');
        expect(normaliseColorScheme('light')).toBe('light');
        // "system" is a HOST-side preference; it must never reach the iframe.
        expect(normaliseColorScheme('system')).toBeNull();
        expect(normaliseColorScheme(undefined)).toBeNull();
    });

    it('reads the query string as well as the fragment', () => {
        expect(readThemeFromUrl({ search: '?fm_theme=dark', hash: '' })).toBe('dark');
        expect(readThemeFromUrl({ search: '', hash: '#fm_theme=light' })).toBe('light');
        expect(readThemeFromUrl({ search: '', hash: '' })).toBeNull();
        expect(readThemeFromUrl(null)).toBeNull();
    });

    it('prefers the fragment over the query when both are present', () => {
        // The fragment is the one the HOST rewrites client-side; the query is
        // whatever was signed into the URL, which can be older.
        expect(readThemeFromUrl({ search: '?fm_theme=light', hash: '#fm_theme=dark' })).toBe('dark');
    });

    it('resolveInitialColorScheme is light with no view at all (SSR)', () => {
        expect(resolveInitialColorScheme(null)).toBe('light');
    });
});

describe('document stamping', () => {
    /** Minimal element/document stand-ins — enough for what applyColorScheme touches. */
    function fakeDocument(): { documentElement: Record<string, unknown> } {
        const classes = new Set<string>();
        return {
            documentElement: {
                attributes: {} as Record<string, string>,
                style: {} as Record<string, string>,
                classList: {
                    toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)),
                    contains: (name: string) => classes.has(name),
                },
                setAttribute(this: { attributes: Record<string, string> }, k: string, v: string) {
                    this.attributes[k] = v;
                },
            },
        };
    }

    it('writes the token attribute, the host class and color-scheme together', () => {
        const doc = fakeDocument();

        applyColorScheme('dark', doc as unknown as Document);

        const root = doc.documentElement as Record<string, never> & {
            attributes: Record<string, string>;
            classList: { contains: (n: string) => boolean };
            style: Record<string, string>;
        };
        expect(root.attributes[THEME_ATTRIBUTE]).toBe('dark');
        // The host platform's own switch is a class; matching it keeps an app
        // styled with Tailwind's class strategy working with no adapter.
        expect(root.classList.contains(THEME_CLASS)).toBe(true);
        // Without this, form controls and scrollbars stay light in a dark app.
        expect(root.style.colorScheme).toBe('dark');
    });

    it('clears the dark class again on the way back to light', () => {
        const doc = fakeDocument();

        applyColorScheme('dark', doc as unknown as Document);
        applyColorScheme('light', doc as unknown as Document);

        const root = doc.documentElement as Record<string, never> & {
            attributes: Record<string, string>;
            classList: { contains: (n: string) => boolean };
        };
        expect(root.attributes[THEME_ATTRIBUTE]).toBe('light');
        expect(root.classList.contains(THEME_CLASS)).toBe(false);
    });

    it('does not throw without a document (SSR)', () => {
        expect(() => applyColorScheme('dark', null)).not.toThrow();
    });
});

describe('pre-paint bootstrap script', () => {
    /**
     * This string is the ONLY thing standing between a dark-mode merchant and
     * a white flash, so it is asserted as executable code, not as text: run it
     * against a stand-in global and check what it did to the document.
     */
    function runBootstrap(init: { hash: string; search?: string; prefersDark?: boolean }): {
        attribute: string | undefined;
        dark: boolean;
        colorScheme: string | undefined;
    } {
        const classes = new Set<string>();
        const attributes: Record<string, string> = {};
        const style: Record<string, string> = {};
        const root = {
            setAttribute: (k: string, v: string) => { attributes[k] = v; },
            classList: { toggle: (n: string, on: boolean) => (on ? classes.add(n) : classes.delete(n)) },
            style,
        };
        const scope = {
            location: { hash: init.hash, search: init.search ?? '' },
            document: { documentElement: root },
            window: {
                matchMedia: (q: string) => ({ matches: q.includes('dark') && init.prefersDark === true }),
            },
        };

        // eslint-disable-next-line no-new-func -- exercising generated source is the point
        new Function('location', 'document', 'window', themeBootstrapScript())(
            scope.location,
            scope.document,
            scope.window,
        );

        return {
            attribute: attributes[THEME_ATTRIBUTE],
            dark: classes.has(THEME_CLASS),
            colorScheme: style.colorScheme,
        };
    }

    it('stamps the fragment scheme with no bridge, no modules and no host', () => {
        expect(runBootstrap({ hash: '#fm_theme=dark' })).toEqual({
            attribute: 'dark',
            dark: true,
            colorScheme: 'dark',
        });
    });

    it('stamps light from the fragment even on a dark-OS machine', () => {
        // The exact shape of the reported bug, in the one place early enough
        // to prevent it being visible.
        expect(runBootstrap({ hash: '#fm_theme=light', prefersDark: true }).attribute).toBe('light');
    });

    it('falls back to the OS for a standalone, non-embedded app', () => {
        expect(runBootstrap({ hash: '', prefersDark: true }).attribute).toBe('dark');
        expect(runBootstrap({ hash: '', prefersDark: false }).attribute).toBe('light');
    });

    it('reads the query string when the host signed it there instead', () => {
        expect(runBootstrap({ hash: '', search: '?fm_theme=dark' }).attribute).toBe('dark');
    });

    it('ignores a junk value rather than stamping it', () => {
        expect(runBootstrap({ hash: '#fm_theme=neon', prefersDark: true }).attribute).toBe('dark');
    });
});
