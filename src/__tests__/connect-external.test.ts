import { afterEach, describe, expect, it } from 'vitest';

import { createMockHost, type MockHost } from '../testing/index.js';

/**
 * `connectExternal` (capability spec §9).
 *
 * The security shape is the point: the popup goes to a THIRD party, but only
 * the app's OWN callback page may report completion. A consent screen that
 * decides to postMessage something must not be able to fake a connection, and
 * the platform must never see the third party's tokens — which is why nothing
 * in this flow touches the host at all.
 */

let host: MockHost;

/** A manual scheduler: nothing fires until the test says so. */
function manualScheduler() {
    const tasks: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
    const schedule = (fn: () => void, ms: number): (() => void) => {
        const task = { fn, ms, cancelled: false };
        tasks.push(task);
        return () => { task.cancelled = true; };
    };
    /** Fire every live task queued at `ms`, oldest first. */
    const fire = (ms: number): void => {
        for (const task of [...tasks]) {
            if (task.cancelled || task.ms !== ms) continue;
            task.cancelled = true;
            task.fn();
        }
    };
    return { schedule, fire };
}

afterEach(() => {
    host?.restore();
});

describe('connectExternal', () => {
    it('resolves when the app\'s callback page reports success', async () => {
        host = createMockHost();
        const bridge = host.createBridge();

        const pending = bridge.connectExternal('https://facebook.example/dialog/oauth');
        expect(host.popups).toHaveLength(1);
        expect(host.popups[0]?.url).toBe('https://facebook.example/dialog/oauth');

        host.completeExternal({ connected: true });

        await expect(pending).resolves.toEqual({ connected: true });
        expect(host.popups[0]?.closed).toBe(true);
    });

    it('resolves connected:false when the callback reports a refusal', async () => {
        host = createMockHost();
        const bridge = host.createBridge();
        const pending = bridge.connectExternal('https://x.example/oauth');
        host.completeExternal({ connected: false });
        await expect(pending).resolves.toEqual({ connected: false });
    });

    it('passes through whatever detail the callback attached', async () => {
        host = createMockHost();
        const bridge = host.createBridge();
        const pending = bridge.connectExternal('https://x.example/oauth');
        host.completeExternal({ connected: true, detail: { pages: 3 } });
        await expect(pending).resolves.toEqual({ connected: true, detail: { pages: 3 } });
    });

    it('never involves the platform host', async () => {
        host = createMockHost();
        const bridge = host.createBridge();
        host.reset();

        const pending = bridge.connectExternal('https://x.example/oauth');
        host.completeExternal({ connected: true });
        await pending;

        expect(host.sent).toEqual([]);
    });

    it('ignores a completion posted from anywhere but the app\'s own origin', async () => {
        host = createMockHost();
        const bridge = host.createBridge();
        const pending = bridge.connectExternal('https://x.example/oauth', { timeoutMs: 5_000 });

        // The third party's own consent page, shouting "connected".
        host.completeExternal({ connected: true }, 'https://facebook.example');

        await expect(Promise.race([
            pending,
            new Promise((resolve) => { setTimeout(() => resolve('still-pending'), 10); }),
        ])).resolves.toBe('still-pending');

        // Now the app's own callback page answers and it settles for real.
        host.completeExternal({ connected: true });
        await expect(pending).resolves.toEqual({ connected: true });
    });

    it('ignores a message that is not a completion at all', async () => {
        host = createMockHost();
        const bridge = host.createBridge();
        const pending = bridge.connectExternal('https://x.example/oauth');

        host.completeExternal({ connected: 'yes' as unknown as boolean });
        await expect(Promise.race([
            pending,
            new Promise((resolve) => { setTimeout(() => resolve('still-pending'), 10); }),
        ])).resolves.toBe('still-pending');

        host.completeExternal({ connected: true });
        await expect(pending).resolves.toEqual({ connected: true });
    });

    it('rejects when the merchant closes the popup', async () => {
        host = createMockHost();
        const { schedule, fire } = manualScheduler();
        const bridge = host.createBridge({ schedule });

        const pending = bridge.connectExternal('https://x.example/oauth');
        host.closePopup();
        fire(400);

        await expect(pending).rejects.toThrow(/closed before/);
    });

    it('keeps polling while the popup is open', async () => {
        host = createMockHost();
        const { schedule, fire } = manualScheduler();
        const bridge = host.createBridge({ schedule });

        const pending = bridge.connectExternal('https://x.example/oauth');
        fire(400);
        fire(400);
        host.completeExternal({ connected: true });

        await expect(pending).resolves.toEqual({ connected: true });
    });

    it('rejects on timeout', async () => {
        host = createMockHost();
        const { schedule, fire } = manualScheduler();
        const bridge = host.createBridge({ schedule });

        const pending = bridge.connectExternal('https://x.example/oauth', { timeoutMs: 1_000 });
        fire(1_000);

        await expect(pending).rejects.toThrow(/Timed out/);
        expect(host.popups[0]?.closed).toBe(true);
    });

    it('rejects immediately when the popup is blocked', async () => {
        host = createMockHost();
        const bridge = host.createBridge({ openWindow: () => null });

        await expect(bridge.connectExternal('https://x.example/oauth')).rejects.toThrow(/Popup blocked/);
    });

    it('honours an explicit allowedOrigins list', async () => {
        host = createMockHost();
        const bridge = host.createBridge();
        const pending = bridge.connectExternal('https://x.example/oauth', {
            allowedOrigins: ['https://callback.myapp.test'],
        });

        host.completeExternal({ connected: true }, 'https://callback.myapp.test');
        await expect(pending).resolves.toEqual({ connected: true });
    });
});
