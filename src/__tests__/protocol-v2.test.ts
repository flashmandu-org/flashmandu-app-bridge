import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMockHost, type MockHost } from '../testing/index.js';
import { MessageType } from '../types.js';

/**
 * Protocol v2 round-trips, driven through the mock host so the origin/source
 * gate, the correlation bookkeeping and the wire shapes are all exercised for
 * real rather than stubbed.
 */

let host: MockHost;

function mount(options: Parameters<typeof createMockHost>[0] = {}) {
    host = createMockHost(options);
    return host.createBridge();
}

afterEach(() => {
    host?.restore();
});

describe('SET_PAGE', () => {
    it('posts the whole chrome in one message', () => {
        const bridge = mount();
        bridge.setPage({
            title: 'Kathmandu',
            crumbs: [{ label: 'Maps', path: '/maps' }, { label: 'Kathmandu' }],
            actions: [{ id: 'save', label: 'Save', variant: 'primary' }],
            dirty: true,
        });

        expect(host.pages()).toHaveLength(1);
        expect(host.lastPage()).toEqual({
            title: 'Kathmandu',
            crumbs: [{ label: 'Maps', path: '/maps' }, { label: 'Kathmandu' }],
            actions: [{ id: 'save', label: 'Save', variant: 'primary' }],
            dirty: true,
        });
    });

    it('is the only chrome message — SET_TITLE no longer exists', () => {
        const bridge = mount();
        bridge.setPage({ crumbs: [], actions: [], dirty: false });

        expect(host.sent.map((m) => m.type)).not.toContain('FLASHMANDU_BRIDGE:SET_TITLE');
        expect(bridge as unknown as Record<string, unknown>).not.toHaveProperty('setTitle');
    });

    it('refuses to post a payload the host would drop', () => {
        const bridge = mount();
        expect(() =>
            bridge.setPage({
                crumbs: [],
                actions: Array.from({ length: 5 }, (_, i) => ({
                    id: `a${i}`, label: 'x', variant: 'ghost' as const,
                })),
                dirty: false,
            }),
        ).toThrow(/at most 4 actions/);
        expect(host.pages()).toHaveLength(0);
    });
});

describe('ACTION', () => {
    it('delivers a bar click to the app', () => {
        const bridge = mount();
        const seen: string[] = [];
        bridge.onAction((id) => seen.push(id));

        host.clickAction('save');

        expect(seen).toEqual(['save']);
    });

    it('announces the action capability on first subscribe and withdraws it on last', () => {
        const bridge = mount();
        host.reset();

        const off = bridge.onAction(() => {});
        expect(host.announcements().at(-1)).toEqual({ hostNavigate: false, action: true });

        off();
        expect(host.announcements().at(-1)).toEqual({ hostNavigate: false, action: false });
    });

    it('does not announce a second time for a second subscriber', () => {
        const bridge = mount();
        host.reset();
        bridge.onAction(() => {});
        bridge.onAction(() => {});
        expect(host.announcements()).toHaveLength(1);
    });

    it('drops an id the app could never have declared', () => {
        const bridge = mount();
        const listener = vi.fn();
        bridge.onAction(listener);

        host.post(MessageType.Action, { id: '' });
        host.post(MessageType.Action, { id: 'x'.repeat(33) });
        host.post(MessageType.Action, { id: 42 });
        host.post(MessageType.Action, {});

        expect(listener).not.toHaveBeenCalled();
    });

    it('is rejected from a foreign origin, like every other inbound message', () => {
        const bridge = mount();
        const listener = vi.fn();
        bridge.onAction(listener);

        const event = new Event('message') as Event & Record<string, unknown>;
        event.data = { type: MessageType.Action, payload: { id: 'save' } };
        event.origin = 'https://evil.example';
        event.source = (globalThis as unknown as { window: EventTarget }).window;
        (globalThis as unknown as { window: EventTarget }).window.dispatchEvent(event);

        expect(listener).not.toHaveBeenCalled();
    });

    it('survives a listener that throws', () => {
        const bridge = mount();
        const after = vi.fn();
        bridge.onAction(() => { throw new Error('boom'); });
        bridge.onAction(after);

        expect(() => host.clickAction('save')).not.toThrow();
        expect(after).toHaveBeenCalledWith('save');
    });
});

describe('LOADING', () => {
    it('posts the active flag', () => {
        const bridge = mount();
        bridge.loading(true);
        bridge.loading(false);
        expect(host.loadingStates()).toEqual([true, false]);
    });

    it('coerces anything non-boolean to false rather than forwarding it', () => {
        const bridge = mount();
        bridge.loading('yes' as never);
        expect(host.loadingStates()).toEqual([false]);
    });
});

describe('TOAST with action', () => {
    it('keeps the plain variant call working', () => {
        const bridge = mount();
        bridge.toast('Saved', 'success');
        expect(host.toasts()).toEqual([{ message: 'Saved', variant: 'success' }]);
    });

    it('carries an action button', () => {
        const bridge = mount();
        bridge.toast('Map published', {
            variant: 'success',
            action: { label: 'View', path: '/maps/9' },
        });
        expect(host.toasts()[0]).toEqual({
            message: 'Map published',
            variant: 'success',
            action: { label: 'View', path: '/maps/9' },
        });
    });

    it.each(['https://evil.example', '//evil.example', 'maps', '/maps?x=1'])(
        'drops an action whose path the host would reject (%s), keeping the message',
        (path) => {
            const bridge = mount();
            bridge.toast('Done', { action: { label: 'Go', path } });

            const toast = host.toasts()[0];
            expect(toast?.action).toBeUndefined();
            expect(toast?.message).toBe('Done');
        },
    );
});

describe('envelope channel', () => {
    it('omits `channel` entirely while the host has declared none', () => {
        const bridge = mount();
        bridge.setPage({ crumbs: [], actions: [], dirty: false });

        const message = host.sent.find((m) => m.type === MessageType.SetPage);
        expect(message).toBeDefined();
        expect(Object.keys(message as object)).not.toContain('channel');
    });

    it('echoes the channel the host declared on CONTEXT', async () => {
        const bridge = mount({ channel: 'chrome-1' });
        await bridge.ready();
        host.reset();

        bridge.setPage({ crumbs: [], actions: [], dirty: false });
        bridge.loading(true);
        bridge.toast('hi');

        expect(host.sent).not.toHaveLength(0);
        for (const message of host.sent) {
            expect(message.channel).toBe('chrome-1');
        }
    });
});

describe('CONTEXT capabilities', () => {
    it('exposes what the host announced', async () => {
        const bridge = mount({ capabilities: { directApi: true, modal: false } });
        await bridge.ready();

        expect(bridge.hostCapabilities.directApi).toBe(true);
        expect(bridge.hostCapabilities.modal).toBe(false);
        expect(bridge.context?.hostCapabilities.picker).toBe(true);
    });

    it('defaults to an empty object before CONTEXT arrives', () => {
        const bridge = mount({ autoContext: false });
        expect(bridge.hostCapabilities).toEqual({});
        expect(bridge.context).toBeNull();
    });
});

describe('the channel seam', () => {
    it('delivers any gated inbound message to a subscriber', () => {
        const bridge = mount();
        const seen: unknown[] = [];
        bridge.channel.subscribe('FLASHMANDU_BRIDGE:SOMETHING_NEW', (p) => seen.push(p));

        host.post('FLASHMANDU_BRIDGE:SOMETHING_NEW', { hello: 1 });

        expect(seen).toEqual([{ hello: 1 }]);
    });

    it('stops delivering after unsubscribe', () => {
        const bridge = mount();
        const listener = vi.fn();
        const off = bridge.channel.subscribe('X', listener);
        off();
        host.post('X', {});
        expect(listener).not.toHaveBeenCalled();
    });

    it('posts to the parent, scoped to the resolved origin', () => {
        const bridge = mount();
        bridge.channel.post('X', { a: 1 });
        const last = host.sent.at(-1);
        expect(last?.type).toBe('X');
        expect(last?.targetOrigin).toBe(host.origin);
    });
});
