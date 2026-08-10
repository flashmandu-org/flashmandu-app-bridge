/**
 * `@flashmandu/app-bridge/modal` — host-rendered modal + resource picker.
 *
 * A SEPARATE entry point on purpose. Modal and picker are the two surfaces
 * most apps never touch, and their validation tables and correlation
 * bookkeeping are pure weight in the core bundle. Built on the public
 * {@link BridgeChannel} seam, so nothing here needs privileged access — an app
 * that never imports this module never ships a byte of it.
 *
 * ```ts
 * import { createAppBridge } from '@flashmandu/app-bridge';
 * import { attachModal } from '@flashmandu/app-bridge/modal';
 *
 * const bridge = attachModal(createAppBridge());
 * const { confirmed } = await bridge.modal.message({
 *   title: 'Delete map?',
 *   body: 'This cannot be undone.',
 *   confirmLabel: 'Delete',
 *   variant: 'danger',
 * });
 * const { selections } = await bridge.picker({ kind: 'item', multiple: true });
 * ```
 */

import type { AppBridge, ModalApi, PickerApi } from './app-bridge.js';
import { BridgeValidationError, isAppRelativePath } from './page-chrome.js';
import {
    MessageType,
    type ModalResultPayload,
    type ModalVariant,
    type PickerKind,
    type PickerResultPayload,
    type PickerSelection,
} from './types.js';

/** Host caps, mirrored from design §4.4. Validated here so dev failures are loud. */
export const MODAL_LIMITS = {
    titleChars: 80,
    bodyChars: 500,
    labelChars: 32,
} as const;

const PICKER_KINDS: readonly PickerKind[] = ['item', 'media'];

const MODAL_VARIANTS: readonly ModalVariant[] = ['default', 'danger'];

export interface ModalMessageInput {
    title: string;
    body: string;
    confirmLabel?: string;
    cancelLabel?: string;
    /**
     * `danger` makes the host render the confirm button destructively — red,
     * the way the admin's own delete dialogs look.
     *
     * Validated rather than passed through: an unknown value would reach a host
     * that treats everything except `'danger'` as default, so a typo would
     * silently downgrade a delete confirmation to a neutral one. Better to
     * throw at the call site.
     */
    variant?: ModalVariant;
}

export interface PickerInput {
    kind: PickerKind;
    multiple?: boolean;
    query?: string;
}

export interface PickerResult {
    cancelled: boolean;
    selections: PickerSelection[];
    /** `'scope'` when the app lacks the scope the picker kind requires. */
    error?: string;
}

/** An `AppBridge` with the modal + picker halves installed. */
export type AppBridgeWithModal = AppBridge & {
    modal: ModalApi;
    picker: PickerApi;
};

/**
 * Install `bridge.modal` and `bridge.picker` on an existing bridge.
 *
 * Mutates and returns the same instance rather than wrapping it: the bridge is
 * a singleton in every real app, and a wrapper would mean two objects where
 * `bridge === getBridge()` silently stops holding.
 */
export function attachModal(bridge: AppBridge): AppBridgeWithModal {
    const channel = bridge.channel;

    /**
     * One modal and one picker at a time, enforced on BOTH sides. The host
     * drops a second MODAL_OPEN while one is up (§4.4), so without this check
     * the second call's promise would hang forever with no clue why.
     */
    let modalPending: Settle<{ confirmed: boolean }> | null = null;
    let modalId: number | null = null;
    let pickerPending: Settle<PickerResult> | null = null;
    let pickerId: number | null = null;

    channel.subscribe(MessageType.ModalResult, (payload: unknown) => {
        const p = payload as Partial<ModalResultPayload> | undefined;
        if (modalPending === null) return;
        // An id-less reply settles the single in-flight modal; the host is
        // allowed to omit it because only one modal can exist.
        if (typeof p?.id === 'number' && modalId !== null && p.id !== modalId) return;

        const settle = modalPending;
        modalPending = null;
        modalId = null;

        if (typeof p?.error === 'string' && p.error !== '') {
            settle.reject(new Error(`Modal refused by host: ${p.error}`));
            return;
        }
        settle.resolve({ confirmed: p?.confirmed === true });
    });

    channel.subscribe(MessageType.PickerResult, (payload: unknown) => {
        const p = payload as Partial<PickerResultPayload> | undefined;
        if (pickerPending === null) return;
        if (typeof p?.id === 'number' && pickerId !== null && p.id !== pickerId) return;

        const settle = pickerPending;
        pickerPending = null;
        pickerId = null;

        const selections = Array.isArray(p?.selections) ? p.selections : [];
        const result: PickerResult = {
            // A result with no explicit `cancelled` and no selections is a
            // cancellation: that is the only reading that cannot invent a
            // selection the merchant did not make.
            cancelled: p?.cancelled === true || selections.length === 0,
            selections,
        };
        if (typeof p?.error === 'string' && p.error !== '') result.error = p.error;
        settle.resolve(result);
    });

    const modal: ModalApi = {
        message(input: ModalMessageInput): Promise<{ confirmed: boolean }> {
            assertString(input?.title, 'modal.message: `title` is required.');
            assertMax(input.title, MODAL_LIMITS.titleChars, 'modal.message: `title`');
            assertString(input?.body, 'modal.message: `body` is required.');
            assertMax(input.body, MODAL_LIMITS.bodyChars, 'modal.message: `body`');
            if (input.confirmLabel !== undefined) {
                assertMax(input.confirmLabel, MODAL_LIMITS.labelChars, 'modal.message: `confirmLabel`');
            }
            if (input.cancelLabel !== undefined) {
                assertMax(input.cancelLabel, MODAL_LIMITS.labelChars, 'modal.message: `cancelLabel`');
            }
            if (input.variant !== undefined && !MODAL_VARIANTS.includes(input.variant)) {
                throw new BridgeValidationError(
                    `modal.message: \`variant\` must be one of ${MODAL_VARIANTS.join(', ')} ` +
                    `(got ${String(input.variant)}).`,
                );
            }

            return openModal((id) => {
                const payload: Record<string, unknown> = {
                    id,
                    mode: 'message',
                    title: input.title,
                    body: input.body,
                };
                if (input.confirmLabel !== undefined) payload.confirmLabel = input.confirmLabel;
                if (input.cancelLabel !== undefined) payload.cancelLabel = input.cancelLabel;
                if (input.variant !== undefined) payload.variant = input.variant;
                return payload;
            });
        },

        route(path: string): Promise<{ confirmed: boolean }> {
            if (typeof path !== 'string' || !isAppRelativePath(path)) {
                throw new BridgeValidationError(
                    `modal.route: \`path\` must be an app-relative path (got ${String(path)}).`,
                );
            }
            return openModal((id) => ({ id, mode: 'route', path }));
        },

        close(): void {
            const settle = modalPending;
            const id = modalId;
            modalPending = null;
            modalId = null;
            channel.post(MessageType.ModalClose, id === null ? {} : { id });
            // Closing from the app side is not a confirmation. Resolving rather
            // than rejecting keeps `const { confirmed } = await ...` working for
            // a caller that races its own close against the merchant's click.
            settle?.resolve({ confirmed: false });
        },
    };

    function openModal(build: (id: number) => Record<string, unknown>): Promise<{ confirmed: boolean }> {
        if (modalPending !== null) {
            return Promise.reject(
                new Error('A modal is already open. The host renders one at a time and drops the second.'),
            );
        }
        warnIfUnsupported(bridge, 'modal');
        const id = channel.nextId();
        modalId = id;
        return new Promise<{ confirmed: boolean }>((resolve, reject) => {
            modalPending = { resolve, reject };
            channel.post(MessageType.ModalOpen, build(id));
        });
    }

    const picker: PickerApi = (input: PickerInput): Promise<PickerResult> => {
        if (!PICKER_KINDS.includes(input?.kind)) {
            throw new BridgeValidationError(
                `picker: \`kind\` must be one of ${PICKER_KINDS.join(', ')} (got ${String(input?.kind)}).`,
            );
        }
        if (input.query !== undefined) {
            assertMax(input.query, 200, 'picker: `query`');
        }
        if (pickerPending !== null) {
            return Promise.reject(new Error('A picker is already open.'));
        }
        warnIfUnsupported(bridge, 'picker');

        const id = channel.nextId();
        pickerId = id;
        return new Promise<PickerResult>((resolve, reject) => {
            pickerPending = { resolve, reject };
            const payload: Record<string, unknown> = { id, kind: input.kind };
            if (input.multiple !== undefined) payload.multiple = input.multiple === true;
            if (input.query !== undefined) payload.query = input.query;
            channel.post(MessageType.PickerOpen, payload);
        });
    };

    const withModal = bridge as AppBridgeWithModal;
    withModal.modal = modal;
    withModal.picker = picker;
    return withModal;
}

interface Settle<T> {
    resolve: (value: T) => void;
    reject: (error: Error) => void;
}

function assertString(value: unknown, message: string): asserts value is string {
    if (typeof value !== 'string' || value === '') {
        throw new BridgeValidationError(message);
    }
}

function assertMax(value: string, max: number, label: string): void {
    if (typeof value !== 'string' || value.length > max) {
        throw new BridgeValidationError(`${label} max ${max} chars (got ${String(value).length}).`);
    }
}

const warned = new Set<string>();

/**
 * One console warning per surface when the host never announced it.
 *
 * Not a rejection: the promise still goes out, because a host that supports the
 * surface but forgot the capability flag should still work. But a promise that
 * hangs forever with no output is the worst possible dev experience, and this
 * is the only place we can name the cause.
 */
function warnIfUnsupported(bridge: AppBridge, surface: 'modal' | 'picker'): void {
    if (bridge.hostCapabilities[surface] === true) return;
    if (warned.has(surface)) return;
    warned.add(surface);
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn(
            `[app-bridge] The host did not announce \`capabilities.${surface}\` on CONTEXT. ` +
            `The ${surface} request was sent anyway; if it never settles, the host does not implement it.`,
        );
    }
}
