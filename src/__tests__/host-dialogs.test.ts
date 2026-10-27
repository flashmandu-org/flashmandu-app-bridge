import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockHost, type MockHost } from '../testing/index.js';

/**
 * `confirmDestructive`/`pickMedia` build on `attachModal` + `getBridge()`
 * (already covered end-to-end by `modal-picker.test.ts`). Here we only need
 * to prove the host-dialogs wrapper wires those correctly — clamping,
 * `variant: 'danger'`, and the settled (never-throwing) outcome shapes — so
 * `getBridge()` is swapped for a mock-host-backed bridge via `vi.mock`.
 */

let host: MockHost;

vi.mock('../react/use-app-bridge.js', async () => {
    const actual = await vi.importActual<typeof import('../react/use-app-bridge.js')>(
        '../react/use-app-bridge.js',
    );
    return {
        ...actual,
        getBridge: () => host.createBridge(),
    };
});

const { confirmDestructive, pickMedia } = await import('../react/host-dialogs.js');

beforeEach(() => {
    host = createMockHost();
});

afterEach(() => {
    host.restore();
});

describe('confirmDestructive', () => {
    it('resolves true on confirm, with a danger-variant modal', async () => {
        const pending = confirmDestructive({ title: 'Delete map?', body: 'Cannot be undone.' });
        expect(host.modalOpens()[0]).toMatchObject({ variant: 'danger' });
        host.answerModal({ confirmed: true });
        await expect(pending).resolves.toBe(true);
    });

    it('resolves false on cancel', async () => {
        const pending = confirmDestructive({ title: 'T', body: 'B' });
        host.answerModal({ confirmed: false });
        await expect(pending).resolves.toBe(false);
    });

    it('clamps an over-cap title instead of throwing', async () => {
        const pending = confirmDestructive({ title: 'x'.repeat(200), body: 'B' });
        expect(host.modalOpens()[0]?.title.length).toBeLessThanOrEqual(80);
        host.answerModal({ confirmed: true });
        await pending;
    });
});

describe('pickMedia', () => {
    it('resolves picked with the deliverable url', async () => {
        const pending = pickMedia('logo');
        host.answerPicker({
            cancelled: false,
            selections: [{ id: 1, label: 'Logo', meta: { url: 'https://cdn.example/logo.png' } }],
        });
        await expect(pending).resolves.toEqual({
            status: 'picked',
            id: 1,
            url: 'https://cdn.example/logo.png',
            label: 'Logo',
        });
    });

    it('carries the media id as a number, so an app server can resolve it through the host', async () => {
        const pending = pickMedia();
        host.answerPicker({ cancelled: false, selections: [{ id: '42', label: 'x', meta: { url: 'https://cdn.example/x.jpg' } }] });
        await expect(pending).resolves.toMatchObject({ status: 'picked', id: 42 });
    });

    it('resolves cancelled', async () => {
        const pending = pickMedia();
        host.answerPicker({ cancelled: true, selections: [] });
        await expect(pending).resolves.toEqual({ status: 'cancelled' });
    });

    it('resolves denied on a scope error', async () => {
        const pending = pickMedia();
        host.answerPicker({ cancelled: false, selections: [], error: 'scope' });
        await expect(pending).resolves.toEqual({ status: 'denied' });
    });
});
