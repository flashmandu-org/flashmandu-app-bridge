import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppBridge } from '../app-bridge.js';
import { MessageType } from '../types.js';

/**
 * HOST_NAVIGATE is the one inbound message the bridge handles off the raw
 * `window` rather than through the transport: the host posts it so a framed
 * app can route internally instead of the whole admin page reloading. It is
 * held to the transport's gate all the same — parent origin, parent source,
 * fail-closed when the origin is unknown — because an unguarded listener here
 * would be the weakest door in the wall.
 *
 * There is no jsdom in this repo (and no new dependency to add one), so the
 * suite installs a minimal `EventTarget`-backed `window` for the duration of
 * each test. That is enough: the bridge only needs `addEventListener`,
 * `removeEventListener`, and `dispatchEvent`.
 *
 * Events are hand-built rather than constructed with `new MessageEvent(...)`:
 * Node's MessageEvent rejects an `init.source` that is not a MessagePort, and
 * the source check is exactly what these tests need to exercise.
 */

const PARENT_ORIGIN = 'https://merchant.flashmandu.example';
const SEARCH = `?session_token=t&app_id=a&parent_origin=${encodeURIComponent(PARENT_ORIGIN)}`;

interface SentMessage {
    data: { type?: string; payload?: unknown };
    targetOrigin: string;
}

interface FakeWindow extends EventTarget {
    parent: FakeWindow;
    postMessage: (message: unknown, targetOrigin: string) => void;
    sent: SentMessage[];
}

function installFakeWindow(): FakeWindow {
    const fake = new EventTarget() as FakeWindow;
    fake.parent = fake;
    fake.sent = [];
    fake.postMessage = (message: unknown, targetOrigin: string): void => {
        fake.sent.push({ data: message as SentMessage['data'], targetOrigin });
    };
    (globalThis as Record<string, unknown>).window = fake;
    return fake;
}

/** Every HOST_NAVIGATE_ACK the bridge has posted to the parent so far. */
function acks(): SentMessage[] {
    return host.sent.filter((m) => m.data.type === MessageType.HostNavigateAck);
}

let host: FakeWindow;

beforeEach(() => {
    host = installFakeWindow();
});

afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
});

function makeBridge(search: string = SEARCH): ReturnType<typeof createAppBridge> {
    return createAppBridge({ search, parent: host.parent as unknown as Window });
}

/** Dispatch a synthetic `message` event with a settable `source`. */
function dispatchMessage(init: { data: unknown; origin?: string; source?: unknown }): void {
    const event = new Event('message') as Event & Record<string, unknown>;
    event.data = init.data;
    event.origin = init.origin ?? PARENT_ORIGIN;
    event.source = 'source' in init ? init.source : host;
    host.dispatchEvent(event);
}

function postHostNavigate(payload: unknown): void {
    dispatchMessage({ data: { type: MessageType.HostNavigate, payload } });
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

    it('ignores a HOST_NAVIGATE from any origin other than the parent', () => {
        const bridge = makeBridge();
        const listener = vi.fn();
        bridge.onHostNavigate(listener);

        dispatchMessage({
            data: { type: MessageType.HostNavigate, payload: { path: '/members' } },
            origin: 'https://evil.example',
        });

        expect(listener).not.toHaveBeenCalled();
    });

    it('ignores a HOST_NAVIGATE from a window that is not the parent', () => {
        const bridge = makeBridge();
        const listener = vi.fn();
        bridge.onHostNavigate(listener);

        dispatchMessage({
            data: { type: MessageType.HostNavigate, payload: { path: '/members' } },
            source: new EventTarget(),
        });

        expect(listener).not.toHaveBeenCalled();
    });

    it('accepts nothing at all when no parent origin could be resolved', () => {
        // Fail-closed, same as the transport: with no `parent_origin` param and
        // no referrer there is no origin to compare against, so every inbound
        // HOST_NAVIGATE is dropped rather than trusted.
        const bridge = makeBridge('?session_token=t&app_id=a');
        const listener = vi.fn();
        bridge.onHostNavigate(listener);

        postHostNavigate({ path: '/members' });

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

        dispatchMessage({
            data: { type: MessageType.Context, payload: { path: '/members' } },
        });

        expect(listener).not.toHaveBeenCalled();
    });
});

/**
 * The ack is the host's only evidence that a navigate landed. The host
 * suppresses the merchant's click, rewrites the address bar with pushState and
 * moves the active highlight BEFORE posting, so a dropped message leaves the
 * chrome lying about what the iframe is showing — and the pushState means
 * re-clicking the same link is a no-op. Silence therefore has to mean "did not
 * route", which makes the two negative cases below as load-bearing as the
 * positive one.
 */
describe('HOST_NAVIGATE_ACK', () => {
    it('acks a navigate that reached a registered listener', () => {
        const bridge = makeBridge();
        bridge.onHostNavigate(() => {});

        postHostNavigate({ path: '/members' });

        expect(acks()).toEqual([{
            data: { type: MessageType.HostNavigateAck, payload: { path: '/members' } },
            targetOrigin: PARENT_ORIGIN,
        }]);
    });

    it('does not ack when the origin gate rejects the message', () => {
        const bridge = makeBridge();
        bridge.onHostNavigate(() => {});

        dispatchMessage({
            data: { type: MessageType.HostNavigate, payload: { path: '/members' } },
            origin: 'https://evil.example',
        });

        expect(acks()).toEqual([]);
    });

    it('does not ack when no listener is registered', () => {
        // An app that imported the SDK but never subscribed is exactly the case
        // the host needs to detect, so a well-formed navigate still gets silence.
        makeBridge();

        postHostNavigate({ path: '/members' });

        expect(acks()).toEqual([]);
    });

    it('does not ack a payload the path guard rejects', () => {
        const bridge = makeBridge();
        bridge.onHostNavigate(() => {});

        postHostNavigate({ path: '//evil.example/members' });

        expect(acks()).toEqual([]);
    });

    it('acks once per accepted navigate, whatever the listener count', () => {
        const bridge = makeBridge();
        bridge.onHostNavigate(() => {});
        bridge.onHostNavigate(() => {});

        postHostNavigate({ path: '/members' });

        expect(acks()).toHaveLength(1);
    });

    it('still acks when a listener throws', () => {
        // The listener received the path; that it then failed is the app's
        // problem, not a transport failure the host should try to recover from.
        const bridge = makeBridge();
        bridge.onHostNavigate(() => {
            throw new Error('router blew up');
        });

        postHostNavigate({ path: '/members' });

        expect(acks()).toHaveLength(1);
    });
});
