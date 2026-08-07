import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppBridge } from '../app-bridge.js';
import { subscribeHostNavigation } from '../react/use-app-bridge.js';
import { MessageType } from '../types.js';

/**
 * `<UrlSync />` used to be the OUTBOUND half only — it deep-linked on mount and
 * posted PATH_CHANGE, but never called `onHostNavigate`. Every React/Next app
 * therefore had to hand-wire the inbound half, and an app that forgot got no
 * signal: the host only suppresses clicks for an app that announced the
 * capability, so a forgetful app silently kept full-page navigation forever.
 *
 * These tests pin the seam the adapter mounts: subscribing must (a) announce
 * `hostNavigate: true`, which is what unlocks host-side suppression, and (b)
 * deliver a subsequent HOST_NAVIGATE to the router.
 *
 * WHY NOT `render(<UrlSync />)`: this repo has no `@testing-library/react`, no
 * `react-test-renderer`, and no DOM environment — vitest runs in `node` and
 * jsdom is not a dependency. Adding one was explicitly out of scope, so the
 * component's effect body is exercised through the exported helper it calls,
 * against a REAL bridge, plus a structural guard below that the adapter still
 * calls it. See the report for what that does and does not prove.
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

let host: FakeWindow;

beforeEach(() => {
    const fake = new EventTarget() as FakeWindow;
    fake.parent = fake;
    fake.sent = [];
    fake.postMessage = (message: unknown, targetOrigin: string): void => {
        fake.sent.push({ data: message as SentMessage['data'], targetOrigin });
    };
    (globalThis as Record<string, unknown>).window = fake;
    host = fake;
});

afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
});

function makeBridge(): ReturnType<typeof createAppBridge> {
    return createAppBridge({ search: SEARCH, parent: host.parent as unknown as Window });
}

function postNavigate(path: string, id = 1): void {
    const event = new Event('message') as Event & Record<string, unknown>;
    event.data = { type: MessageType.HostNavigate, payload: { id, path } };
    event.origin = PARENT_ORIGIN;
    event.source = host;
    host.dispatchEvent(event);
}

function announcedHostNavigate(): boolean[] {
    return host.sent
        .filter((m) => m.data.type === MessageType.SetCapabilities)
        .map((m) => (m.data.payload as { capabilities: { hostNavigate: boolean } }).capabilities.hostNavigate);
}

/** Stand-in for `useRouter()`, matching how the adapter uses it. */
function mockRouter(): { push: ReturnType<typeof vi.fn> } {
    return { push: vi.fn() };
}

describe('UrlSync host navigation', () => {
    it('announces the capability simply by subscribing', () => {
        // This is what unlocks host-side click suppression. Mounting the
        // adapter has to be sufficient — no per-app wiring, no first click
        // wasted on a full page load.
        const bridge = makeBridge();
        const router = mockRouter();

        subscribeHostNavigation(bridge, { push: router.push, currentUrl: () => '/' });

        expect(announcedHostNavigate()).toEqual([true]);
    });

    it('routes when the host asks, with no per-app wiring', () => {
        const bridge = makeBridge();
        const router = mockRouter();
        subscribeHostNavigation(bridge, { push: router.push, currentUrl: () => '/' });

        postNavigate('/members');

        expect(router.push).toHaveBeenCalledWith('/members');
    });

    it('acks the navigate it routed, so the host knows the shell held', () => {
        const bridge = makeBridge();
        const router = mockRouter();
        subscribeHostNavigation(bridge, { push: router.push, currentUrl: () => '/' });

        postNavigate('/members', 4);

        const acks = host.sent.filter((m) => m.data.type === MessageType.HostNavigateAck);
        expect(acks).toHaveLength(1);
        expect(acks[0]?.data.payload).toEqual({ id: 4, path: '/members' });
    });

    it('does not re-route to the page the app is already on', () => {
        // Not a loop-breaker — the host answers PATH_CHANGE by rewriting its
        // own address bar, never by posting HOST_NAVIGATE — but a pointless
        // push() is a scroll reset or a refetch in some routers.
        const bridge = makeBridge();
        const router = mockRouter();
        subscribeHostNavigation(bridge, { push: router.push, currentUrl: () => '/members?tab=open' });

        postNavigate('/members?tab=open');

        expect(router.push).not.toHaveBeenCalled();
    });

    it('still routes when only the query differs from the current URL', () => {
        const bridge = makeBridge();
        const router = mockRouter();
        subscribeHostNavigation(bridge, { push: router.push, currentUrl: () => '/members?tab=open' });

        postNavigate('/members?tab=closed');

        expect(router.push).toHaveBeenCalledWith('/members?tab=closed');
    });

    it('reads the current URL at delivery time, not at subscribe time', () => {
        // The adapter's subscription is mount-only and holds a ref, so a
        // getter that has moved on since mount must be honoured.
        const bridge = makeBridge();
        const router = mockRouter();
        let current = '/';
        subscribeHostNavigation(bridge, { push: router.push, currentUrl: () => current });

        current = '/members';
        postNavigate('/members');

        expect(router.push).not.toHaveBeenCalled();
    });

    it('emits only an ack in response to a navigate — never a PATH_CHANGE', () => {
        // The loop that would matter: HOST_NAVIGATE → app routes → app posts
        // PATH_CHANGE → host posts HOST_NAVIGATE → … It cannot form, and this
        // pins the SDK's half of that. Handling a navigate produces exactly one
        // outbound message, the ack. The PATH_CHANGE that follows is posted by
        // UrlSync's own pathname effect, and the host answers it by rewriting
        // its address bar — it never replies with HOST_NAVIGATE.
        const bridge = makeBridge();
        const router = mockRouter();
        subscribeHostNavigation(bridge, { push: router.push, currentUrl: () => '/' });
        const before = host.sent.length;

        postNavigate('/members');

        const emitted = host.sent.slice(before).map((m) => m.data.type);
        expect(emitted).toEqual([MessageType.HostNavigateAck]);
    });

    it('unsubscribes cleanly, announcing that the app can no longer route', () => {
        // The adapter returns this from its effect: a remount must not stack
        // listeners, and teardown must tell the host to stop suppressing.
        const bridge = makeBridge();
        const router = mockRouter();
        const off = subscribeHostNavigation(bridge, { push: router.push, currentUrl: () => '/' });

        off();
        postNavigate('/members');

        expect(announcedHostNavigate()).toEqual([true, false]);
        expect(router.push).not.toHaveBeenCalled();
    });

    it('does not stack listeners across a remount', () => {
        const bridge = makeBridge();
        const router = mockRouter();

        const off = subscribeHostNavigation(bridge, { push: router.push, currentUrl: () => '/' });
        off();
        subscribeHostNavigation(bridge, { push: router.push, currentUrl: () => '/' });

        postNavigate('/members');

        expect(router.push).toHaveBeenCalledTimes(1);
    });
});

/**
 * Structural guard.
 *
 * The bug this task fixes was found by `grep -rn onHostNavigate src/next/`
 * returning nothing, because the adapter simply never subscribed. Without a
 * renderer in this repo there is no way to assert "mounting subscribes" by
 * behaviour, so the grep itself is encoded here: it is the check that would
 * have caught the original omission, and it fails loudly if someone deletes the
 * wiring again. Replace it with a real mount test the day a DOM environment
 * lands.
 */
describe('UrlSync adapter wiring', () => {
    it('still calls subscribeHostNavigation from the Next adapter', async () => {
        const { readFile } = await import('node:fs/promises');
        const source = await readFile(
            new URL('../next/url-sync.tsx', import.meta.url),
            'utf8',
        );

        expect(source).toContain('subscribeHostNavigation');
        expect(source).toMatch(/return subscribeHostNavigation\(/);
    });
});
