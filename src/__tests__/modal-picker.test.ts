import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { attachModal, MODAL_LIMITS } from '../modal.js';
import { BridgeValidationError } from '../page-chrome.js';
import { createMockHost, type MockHost } from '../testing/index.js';
import { MessageType } from '../types.js';

/**
 * Modal + picker (design §4.4–4.5), driven from the optional `/modal` entry.
 *
 * The client-side caps mirror the host's on purpose: the host drops an
 * over-cap payload whole, which from the app's seat is a promise that never
 * settles. Validating here turns that into a throw at the call site.
 */

let host: MockHost;
let bridge: ReturnType<typeof attachModal>;

beforeEach(() => {
    host = createMockHost();
    bridge = attachModal(host.createBridge());
});

afterEach(() => {
    host.restore();
});

describe('modal.message', () => {
    it('resolves with the merchant\'s answer', async () => {
        const pending = bridge.modal.message({ title: 'Delete map?', body: 'Cannot be undone.' });

        expect(host.modalOpens()[0]).toMatchObject({
            mode: 'message',
            title: 'Delete map?',
            body: 'Cannot be undone.',
        });

        host.answerModal({ confirmed: true });
        await expect(pending).resolves.toEqual({ confirmed: true });
    });

    it('resolves confirmed:false on cancel', async () => {
        const pending = bridge.modal.message({ title: 'T', body: 'B' });
        host.answerModal({ confirmed: false });
        await expect(pending).resolves.toEqual({ confirmed: false });
    });

    it('forwards custom button labels', async () => {
        const pending = bridge.modal.message({
            title: 'T', body: 'B', confirmLabel: 'Delete', cancelLabel: 'Keep',
        });
        expect(host.modalOpens()[0]).toMatchObject({ confirmLabel: 'Delete', cancelLabel: 'Keep' });
        host.answerModal({ confirmed: true });
        await pending;
    });

    it.each([
        ['title', { title: 'x'.repeat(MODAL_LIMITS.titleChars + 1), body: 'B' }],
        ['body', { title: 'T', body: 'x'.repeat(MODAL_LIMITS.bodyChars + 1) }],
        ['confirmLabel', { title: 'T', body: 'B', confirmLabel: 'x'.repeat(MODAL_LIMITS.labelChars + 1) }],
        ['cancelLabel', { title: 'T', body: 'B', cancelLabel: 'x'.repeat(MODAL_LIMITS.labelChars + 1) }],
    ])('throws when %s exceeds the host cap', (_field, input) => {
        expect(() => bridge.modal.message(input as never)).toThrow(BridgeValidationError);
        expect(host.modalOpens()).toHaveLength(0);
    });

    it('accepts exactly the cap', async () => {
        const pending = bridge.modal.message({
            title: 'x'.repeat(MODAL_LIMITS.titleChars),
            body: 'x'.repeat(MODAL_LIMITS.bodyChars),
            confirmLabel: 'x'.repeat(MODAL_LIMITS.labelChars),
        });
        host.answerModal({ confirmed: true });
        await expect(pending).resolves.toEqual({ confirmed: true });
    });

    it('requires a title and a body', () => {
        expect(() => bridge.modal.message({ title: '', body: 'B' })).toThrow(BridgeValidationError);
        expect(() => bridge.modal.message({ title: 'T', body: '' })).toThrow(BridgeValidationError);
    });

    it('rejects a second modal, which the host would drop anyway', async () => {
        const first = bridge.modal.message({ title: 'T', body: 'B' });
        await expect(bridge.modal.message({ title: 'U', body: 'C' })).rejects.toThrow(/already open/);

        host.answerModal({ confirmed: false });
        await first;

        // …and the slot is free again once the first settled.
        const third = bridge.modal.message({ title: 'V', body: 'D' });
        host.answerModal({ confirmed: true });
        await expect(third).resolves.toEqual({ confirmed: true });
    });

    it('rejects when the host refuses to open', async () => {
        const pending = bridge.modal.message({ title: 'T', body: 'B' });
        host.answerModal({ confirmed: false, error: 'busy' });
        await expect(pending).rejects.toThrow(/refused by host: busy/);
    });

    it('settles as unconfirmed when the app closes the modal itself', async () => {
        const pending = bridge.modal.message({ title: 'T', body: 'B' });
        bridge.modal.close();
        await expect(pending).resolves.toEqual({ confirmed: false });
        expect(host.messagesOf(MessageType.ModalClose)).toHaveLength(1);
    });

    it('accepts an id-less MODAL_RESULT, since only one modal can exist', async () => {
        const pending = bridge.modal.message({ title: 'T', body: 'B' });
        host.post(MessageType.ModalResult, { confirmed: true });
        await expect(pending).resolves.toEqual({ confirmed: true });
    });

    it('ignores a MODAL_RESULT for a different id', async () => {
        const pending = bridge.modal.message({ title: 'T', body: 'B' });
        host.post(MessageType.ModalResult, { id: 9999, confirmed: true });
        const settled = vi.fn();
        void pending.then(settled);
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();

        host.answerModal({ confirmed: false });
        await expect(pending).resolves.toEqual({ confirmed: false });
    });
});

describe('modal.route', () => {
    it('opens the host max-modal at an app path', async () => {
        const pending = bridge.modal.route('/maps/9/edit');
        expect(host.modalOpens()[0]).toMatchObject({ mode: 'route', path: '/maps/9/edit' });
        host.answerModal({ confirmed: true });
        await expect(pending).resolves.toEqual({ confirmed: true });
    });

    it.each(['https://evil.example', '//evil.example', 'maps', ''])(
        'rejects a path that is not app-relative: %s',
        (path) => {
            expect(() => bridge.modal.route(path)).toThrow(BridgeValidationError);
        },
    );
});

describe('picker', () => {
    it('resolves with the merchant\'s selections', async () => {
        const pending = bridge.picker({ kind: 'item', multiple: true, query: 'tea' });

        expect(host.pickerOpens()[0]).toMatchObject({ kind: 'item', multiple: true, query: 'tea' });

        host.answerPicker({
            selections: [{ id: 4, label: 'Masala tea', thumbnail: 'https://cdn/x.jpg' }],
        });

        await expect(pending).resolves.toEqual({
            cancelled: false,
            selections: [{ id: 4, label: 'Masala tea', thumbnail: 'https://cdn/x.jpg' }],
        });
    });

    it('reports a cancellation', async () => {
        const pending = bridge.picker({ kind: 'media' });
        host.answerPicker({ cancelled: true });
        await expect(pending).resolves.toEqual({ cancelled: true, selections: [] });
    });

    it('surfaces a scope refusal without throwing', async () => {
        const pending = bridge.picker({ kind: 'item' });
        host.answerPicker({ cancelled: true, error: 'scope' });
        await expect(pending).resolves.toEqual({ cancelled: true, selections: [], error: 'scope' });
    });

    it('reads an empty selection list as a cancellation, never as a choice', async () => {
        const pending = bridge.picker({ kind: 'item' });
        host.post(MessageType.PickerResult, { selections: [] });
        await expect(pending).resolves.toEqual({ cancelled: true, selections: [] });
    });

    it.each(['category', 'customer', '', undefined])('rejects the unsupported kind %s', (kind) => {
        expect(() => bridge.picker({ kind: kind as never })).toThrow(BridgeValidationError);
    });

    it('rejects a second picker while one is open', async () => {
        const first = bridge.picker({ kind: 'item' });
        await expect(bridge.picker({ kind: 'media' })).rejects.toThrow(/already open/);
        host.answerPicker({ cancelled: true });
        await first;
    });
});

describe('tree-shaking contract', () => {
    it('leaves modal and picker undefined on a bridge that never attached them', () => {
        const plain = host.createBridge();
        expect(plain.modal).toBeUndefined();
        expect(plain.picker).toBeUndefined();
    });

    it('mutates the same instance rather than wrapping it', () => {
        const plain = host.createBridge();
        expect(attachModal(plain)).toBe(plain);
    });
});
