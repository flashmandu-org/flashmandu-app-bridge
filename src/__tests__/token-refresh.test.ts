import { afterEach, describe, expect, it } from 'vitest';

import { createMockHost, type MockHost } from '../testing/index.js';
import { TOKEN_FRESHNESS_MARGIN_MS } from '../app-bridge.js';
import { MessageType } from '../types.js';

/**
 * Token refresh (design §4.6).
 *
 * The invariant worth the most here is SINGLE-FLIGHT. A page that mounts three
 * widgets fires three reads in the same tick; without a shared in-flight
 * promise that is three TOKEN_REFRESH messages, three server mints, and — on a
 * throttled endpoint — two failures for calls that had nothing wrong with them.
 */

let host: MockHost;

/** Runs every scheduled callback immediately, so no test needs fake timers. */
const immediate = (fn: () => void): (() => void) => {
    fn();
    return () => {};
};

/** Never runs anything: proves a path did NOT depend on a timer firing. */
const never = (): (() => void) => () => {};

afterEach(() => {
    host?.restore();
});

describe('getSessionToken freshness', () => {
    it('returns the embed-URL token without touching the host when validity is unknown', async () => {
        host = createMockHost({ token: 'tok_boot' });
        const bridge = host.createBridge({ schedule: never });
        await bridge.ready();

        await expect(bridge.getSessionToken()).resolves.toBe('tok_boot');
        expect(host.tokenRefreshCount()).toBe(0);
    });

    it('returns the cached token while more than 60s of validity remains', async () => {
        const now = 1_000_000;
        host = createMockHost({ token: 'tok_boot', expiresAt: now + TOKEN_FRESHNESS_MARGIN_MS + 1_000 });
        const bridge = host.createBridge({ now: () => now, schedule: never });
        await bridge.ready();

        await expect(bridge.getSessionToken()).resolves.toBe('tok_boot');
        expect(host.tokenRefreshCount()).toBe(0);
    });

    it('refreshes once the remaining validity drops inside the 60s margin', async () => {
        const now = 1_000_000;
        host = createMockHost({ token: 'tok_boot', expiresAt: now + 30_000 });
        const bridge = host.createBridge({ now: () => now, schedule: never });
        await bridge.ready();

        await expect(bridge.getSessionToken()).resolves.toBe('tok_refreshed_1');
        expect(host.tokenRefreshCount()).toBe(1);
    });

    it('refreshes when the embed URL carried no token at all', async () => {
        host = createMockHost({ token: '' });
        const bridge = host.createBridge({ schedule: never });
        await bridge.ready();

        await expect(bridge.getSessionToken()).resolves.toBe('tok_refreshed_1');
    });

    it('adopts the new expiry, so the next call is served from cache', async () => {
        let clock = 1_000_000;
        host = createMockHost({ token: 'tok_boot', expiresAt: clock + 1_000 });
        const bridge = host.createBridge({ now: () => clock, schedule: never });
        await bridge.ready();
        host.autoToken(false);

        const first = bridge.getSessionToken();
        host.sendToken('tok_fresh', clock + 600_000);
        await expect(first).resolves.toBe('tok_fresh');

        clock += 1_000;
        await expect(bridge.getSessionToken()).resolves.toBe('tok_fresh');
        expect(host.tokenRefreshCount()).toBe(1);
    });

    it('updates the exposed context with the refreshed token', async () => {
        const now = 1_000_000;
        host = createMockHost({ token: 'tok_boot', expiresAt: now + 1_000 });
        const bridge = host.createBridge({ now: () => now, schedule: never });
        await bridge.ready();

        await bridge.getSessionToken();

        expect(bridge.context?.token).toBe('tok_refreshed_1');
    });
});

describe('single-flight', () => {
    it('collapses concurrent callers into ONE in-flight refresh', async () => {
        const now = 1_000_000;
        host = createMockHost({ token: 'tok_boot', expiresAt: now + 1_000 });
        const bridge = host.createBridge({ now: () => now, schedule: never });
        await bridge.ready();
        host.autoToken(false);

        const a = bridge.getSessionToken();
        const b = bridge.getSessionToken();
        const c = bridge.getSessionToken();

        // The shared promise is stored before any await point, so three callers
        // in the same tick observe the same object — not merely the same value.
        expect(a).toBe(b);
        expect(b).toBe(c);
        expect(host.tokenRefreshCount()).toBe(1);

        host.sendToken('tok_shared');
        await expect(Promise.all([a, b, c])).resolves.toEqual([
            'tok_shared', 'tok_shared', 'tok_shared',
        ]);
    });

    it('shares the in-flight refresh with a caller that arrives after an await', async () => {
        const now = 1_000_000;
        host = createMockHost({ token: 'tok_boot', expiresAt: now + 1_000 });
        const bridge = host.createBridge({ now: () => now, schedule: never });
        await bridge.ready();
        host.autoToken(false);

        const first = bridge.getSessionToken();
        await Promise.resolve();
        const second = bridge.getSessionToken();

        expect(host.tokenRefreshCount()).toBe(1);
        host.sendToken('tok_shared');
        await expect(Promise.all([first, second])).resolves.toEqual(['tok_shared', 'tok_shared']);
    });

    it('starts a NEW flight after the previous one settled', async () => {
        let clock = 1_000_000;
        host = createMockHost({ token: 'tok_boot', expiresAt: clock + 1_000 });
        const bridge = host.createBridge({ now: () => clock, schedule: never });
        await bridge.ready();

        host.autoToken(false);

        // Each answer names a short-lived expiry, so the NEXT call must open a
        // new flight rather than reuse the settled one.
        const first = bridge.getSessionToken();
        expect(host.tokenRefreshCount()).toBe(1);
        host.sendToken('tok_two', clock + 1_000);
        await expect(first).resolves.toBe('tok_two');

        clock += 500;
        const third = bridge.getSessionToken();
        expect(host.tokenRefreshCount()).toBe(2);
        host.sendToken('tok_three');
        await expect(third).resolves.toBe('tok_three');
    });

    it('lets every concurrent caller see the same rejection, then recovers', async () => {
        const now = 1_000_000;
        host = createMockHost({ token: 'tok_boot', expiresAt: now + 1_000 });
        const bridge = host.createBridge({ now: () => now, schedule: never });
        await bridge.ready();
        host.autoToken(false);

        const a = bridge.getSessionToken();
        const b = bridge.getSessionToken();
        host.failToken('throttled');

        await expect(a).rejects.toThrow(/throttled/);
        await expect(b).rejects.toThrow(/throttled/);

        // The failed flight must not poison the slot.
        const retry = bridge.getSessionToken();
        expect(host.tokenRefreshCount()).toBe(2);
        host.sendToken('tok_ok');
        await expect(retry).resolves.toBe('tok_ok');
    });
});

describe('ISO-8601 expiry (the shape the host actually sends)', () => {
    it('reads an ISO-8601 expiry from the TOKEN reply', async () => {
        let clock = Date.parse('2026-08-10T12:00:00Z');
        host = createMockHost({ token: 'tok_boot', expiresAt: clock + 1_000 });
        const bridge = host.createBridge({ now: () => clock, schedule: never });
        await bridge.ready();
        host.autoToken(false);

        const first = bridge.getSessionToken();
        host.sendToken('tok_iso', '2026-08-10T12:10:00Z');
        await expect(first).resolves.toBe('tok_iso');

        // Ten minutes of validity: the next call must come from cache. Reading
        // the ISO string as a number would leave validity unknown, and a later
        // regression there would show up here as a second refresh.
        clock += 60_000;
        await expect(bridge.getSessionToken()).resolves.toBe('tok_iso');
        expect(host.tokenRefreshCount()).toBe(1);

        // …and once it is inside the 60s margin, it refreshes again.
        clock += 8 * 60_000 + 30_000;
        host.autoToken(true);
        await expect(bridge.getSessionToken()).resolves.toBe('tok_refreshed_1');
        expect(host.tokenRefreshCount()).toBe(2);
    });

    it('reads an ISO-8601 expiry from CONTEXT', async () => {
        const clock = Date.parse('2026-08-10T12:00:00Z');
        host = createMockHost({ token: 'tok_boot', expiresAt: '2026-08-10T12:00:30Z' });
        const bridge = host.createBridge({ now: () => clock, schedule: never });
        await bridge.ready();

        // 30s left — inside the margin, so this must refresh rather than
        // treating the unparsed string as "validity unknown".
        await expect(bridge.getSessionToken()).resolves.toBe('tok_refreshed_1');
    });

    it('treats an unparseable expiry as unknown, never as a refresh loop', async () => {
        const now = 1_000_000;
        host = createMockHost({ token: 'tok_boot', expiresAt: 'whenever' });
        const bridge = host.createBridge({ now: () => now, schedule: never });
        await bridge.ready();

        await expect(bridge.getSessionToken()).resolves.toBe('tok_boot');
        expect(host.tokenRefreshCount()).toBe(0);
    });
});

describe('envelope channel on TOKEN_REFRESH', () => {
    it('carries the channel — the host drops a mismatched one, and a drop here is a silent hang', async () => {
        const now = 1_000_000;
        host = createMockHost({
            token: 'tok_boot',
            expiresAt: now + 1_000,
            channel: 'chan-abc',
        });
        const bridge = host.createBridge({ now: () => now, schedule: never });
        await bridge.ready();

        await bridge.getSessionToken();

        const refresh = host.sent.find((m) => m.type === MessageType.TokenRefresh);
        expect(refresh).toBeDefined();
        expect(refresh?.channel).toBe('chan-abc');
    });
});

describe('refresh failure modes', () => {
    it('times out when the host never answers', async () => {
        const now = 1_000_000;
        host = createMockHost({ token: 'tok_boot', expiresAt: now + 1_000 });
        host.autoToken(false);
        const bridge = host.createBridge({ now: () => now, schedule: immediate });
        await bridge.ready();

        await expect(bridge.getSessionToken()).rejects.toThrow(/timed out/);
    });

    it('rejects a TOKEN reply carrying no token', async () => {
        const now = 1_000_000;
        host = createMockHost({ token: 'tok_boot', expiresAt: now + 1_000 });
        host.autoToken(false);
        const bridge = host.createBridge({ now: () => now, schedule: never });
        await bridge.ready();

        const p = bridge.getSessionToken();
        host.post(MessageType.Token, { token: '' });
        await expect(p).rejects.toThrow(/no token/);
    });

    it('accepts an id-less reply, since only one refresh can be outstanding', async () => {
        const now = 1_000_000;
        host = createMockHost({ token: 'tok_boot', expiresAt: now + 1_000 });
        host.autoToken(false);
        const bridge = host.createBridge({ now: () => now, schedule: never });
        await bridge.ready();

        const p = bridge.getSessionToken();
        host.post(MessageType.Token, { token: 'tok_no_id' });
        await expect(p).resolves.toBe('tok_no_id');
    });

    it('ignores a TOKEN whose id matches nothing', async () => {
        const now = 1_000_000;
        host = createMockHost({ token: 'tok_boot', expiresAt: now + 1_000 });
        host.autoToken(false);
        const bridge = host.createBridge({ now: () => now, schedule: never });
        await bridge.ready();

        const p = bridge.getSessionToken();
        host.post(MessageType.Token, { id: 9999, token: 'tok_wrong' });
        host.post(MessageType.Token, { id: 9998, token: 'tok_also_wrong' });
        host.sendToken('tok_right');

        await expect(p).resolves.toBe('tok_right');
    });

    it.each([
        'refresh_failed_401',
        'refresh_failed_403',
        'refresh_failed_404',
        'refresh_failed_419',
        'refresh_failed_429',
        'refresh_malformed',
        'network_error',
        'unknown_app',
    ])('rejects terminally on %s without spinning', async (code) => {
        const now = 1_000_000;
        host = createMockHost({ token: 'tok_boot', expiresAt: now + 1_000 });
        host.autoToken(false);
        const bridge = host.createBridge({ now: () => now, schedule: never });
        await bridge.ready();

        const pending = bridge.getSessionToken();
        host.failToken(code);

        await expect(pending).rejects.toThrow(new RegExp(code));
        // Every one of these is terminal: exactly one attempt went out.
        expect(host.tokenRefreshCount()).toBe(1);
    });

    it('rejects the in-flight refresh when the bridge is destroyed', async () => {
        const now = 1_000_000;
        host = createMockHost({ token: 'tok_boot', expiresAt: now + 1_000 });
        host.autoToken(false);
        const bridge = host.createBridge({ now: () => now, schedule: never });
        await bridge.ready();

        const p = bridge.getSessionToken();
        bridge.destroy();
        await expect(p).rejects.toThrow(/destroyed/);
    });
});
