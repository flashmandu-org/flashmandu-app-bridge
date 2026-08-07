import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppBridge } from '../app-bridge.js';
import { MessageType } from '../types.js';

/**
 * HOST_NAVIGATE is the one inbound message the bridge handles off the raw
 * `window` rather than through the transport: the host posts it so a framed
 * app can route internally instead of the whole admin page reloading.
 *
 * There is no jsdom in this repo (and no new dependency to add one), so the
 * suite installs a minimal `EventTarget`-backed `window` for the duration of
 * each test. That is enough: the bridge only needs `addEventListener`,
 * `removeEventListener`, and `dispatchEvent`.
 */

interface FakeWindow extends EventTarget {
    parent: FakeWindow;
    postMessage: (message: unknown, targetOrigin: string) => void;
}

function installFakeWindow(): FakeWindow {
    const fake = new EventTarget() as FakeWindow;
    fake.parent = fake;
    fake.postMessage = (): void => {};
    (globalThis as Record<string, unknown>).window = fake;
    return fake;
}

let host: FakeWindow;

beforeEach(() => {
    host = installFakeWindow();
});

afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
});

function makeBridge(): ReturnType<typeof createAppBridge> {
    return createAppBridge({ search: '?session_token=t&app_id=a', parent: host.parent as unknown as Window });
}

function postHostNavigate(payload: unknown): void {
    host.dispatchEvent(new MessageEvent('message', {
        data: { type: MessageType.HostNavigate, payload },
    }));
}

describe('onHostNavigate', () => {
    it('invokes the listener when the host asks the app to route', () => {
        const bridge = makeBridge();
        const seen: string[] = [];
        bridge.onHostNavigate((path) => seen.push(path));

        postHostNavigate({ path: '/members' });

        expect(seen).toEqual(['/members']);
    });

    it('stops calling the listener after unsubscribe', () => {
        const bridge = makeBridge();
        const listener = vi.fn();
        const off = bridge.onHostNavigate(listener);
        off();

        postHostNavigate({ path: '/settings' });

        expect(listener).not.toHaveBeenCalled();
    });

    it('stops calling the listener after the bridge is destroyed', () => {
        const bridge = makeBridge();
        const listener = vi.fn();
        bridge.onHostNavigate(listener);
        bridge.destroy();

        postHostNavigate({ path: '/settings' });

        expect(listener).not.toHaveBeenCalled();
    });

    it('rejects payloads that are not an app-relative path', () => {
        const bridge = makeBridge();
        const listener = vi.fn();
        bridge.onHostNavigate(listener);

        // Absolute URLs, protocol-relative URLs, scheme payloads, and
        // non-strings are all untrusted input arriving over postMessage.
        postHostNavigate({ path: 'https://evil.example/members' });
        postHostNavigate({ path: '//evil.example/members' });
        postHostNavigate({ path: '/\\evil.example/members' });
        postHostNavigate({ path: 'javascript:alert(1)' });
        postHostNavigate({ path: 42 });
        postHostNavigate({});
        postHostNavigate(undefined);

        expect(listener).not.toHaveBeenCalled();
    });

    it('ignores messages of any other type', () => {
        const bridge = makeBridge();
        const listener = vi.fn();
        bridge.onHostNavigate(listener);

        host.dispatchEvent(new MessageEvent('message', {
            data: { type: MessageType.Context, payload: { path: '/members' } },
        }));

        expect(listener).not.toHaveBeenCalled();
    });
});
