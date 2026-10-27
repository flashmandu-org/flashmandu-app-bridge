/**
 * Host-rendered dialogs — the app's ONLY confirm/picker surface.
 *
 * Doctrine (parity spec §4.4/§4.5): a confirm dialog the app renders inside
 * its own iframe covers the app and nothing else — not the sidebar, not the
 * command bar — so a destructive action reads as a widget rather than as an
 * interruption. Everything destructive goes through `bridge.modal.message`,
 * which the HOST draws above the whole admin.
 *
 * Merged from two app-local sources per Task B4 / spec §4.1:
 *   - tours/orbit's `lib/host-dialogs.ts` (71 ln) — `hostBridge`, `clamp`,
 *     `confirmDestructive`.
 *   - interactive-map's `lib/host-dialogs.ts` (128 ln, the richer fork) —
 *     ADDS `pickMedia`/`MediaPick`, folded in here as additional exports
 *     rather than kept as a separate fork.
 *
 * `attachModal` is what installs `bridge.modal` / `bridge.picker` on the
 * shared singleton. It MUTATES the bridge and subscribes channel handlers, so
 * it must run exactly once per bridge instance — hence the memo below rather
 * than a call at each site.
 */

import type { PickerSelection } from '../types.js';
import { attachModal, type AppBridgeWithModal } from '../modal.js';
import { getBridge } from './use-app-bridge.js';

/** Host caps (kit `MODAL_LIMITS`). Over them, `modal.message` THROWS. */
const TITLE_MAX = 80;
const BODY_MAX = 500;
const LABEL_MAX = 32;

let installed: AppBridgeWithModal | null = null;

/** The shared bridge with the modal + picker halves installed, attached once. */
export function hostBridge(): AppBridgeWithModal {
    const bridge = getBridge();
    // `attachModal` returns the same object it was given, so identity is a
    // sound "already installed" test.
    if (installed !== (bridge as AppBridgeWithModal)) {
        installed = attachModal(bridge);
    }
    return installed;
}

/**
 * Clamp app-supplied text to the host cap.
 *
 * A merchant-typed name can be any length, and `modal.message` throws
 * `BridgeValidationError` past the cap — which would turn "delete this item"
 * into an unhandled rejection and no dialog at all. Truncating is the only
 * behaviour where the merchant still gets asked.
 */
function clamp(value: string, max: number): string {
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export interface ConfirmInput {
    title: string;
    body: string;
    confirmLabel?: string;
    cancelLabel?: string;
}

/**
 * Ask the host for a DESTRUCTIVE confirmation. Resolves false on cancel, on a
 * host refusal, and on a host that does not implement modals at all — a
 * delete that cannot be confirmed must not happen.
 *
 * `variant: 'danger'` is what makes the host draw its red confirm button.
 */
export async function confirmDestructive(input: ConfirmInput): Promise<boolean> {
    const bridge = hostBridge();
    try {
        const { confirmed } = await bridge.modal.message({
            title: clamp(input.title, TITLE_MAX),
            body: clamp(input.body, BODY_MAX),
            confirmLabel: clamp(input.confirmLabel ?? 'Delete', LABEL_MAX),
            cancelLabel: clamp(input.cancelLabel ?? 'Cancel', LABEL_MAX),
            variant: 'danger',
        });
        return confirmed;
    } catch {
        return false;
    }
}

/* ------------------------------------------------------------------------ *
 * Media picker — folded in from interactive-map's richer host-dialogs fork.
 * Not needed by every app (tours' P0 skipped it), so it stays an additional,
 * separately-callable export rather than something `confirmDestructive`
 * callers pay for.
 * ------------------------------------------------------------------------ */

/** What the merchant did with the media picker. */
export type MediaPick =
    | { status: 'picked'; url: string; label: string }
    | { status: 'cancelled' }
    /** The app was never granted `read:media`. Degrade, never throw. */
    | { status: 'denied' }
    /** The host refused for any other reason (unknown kind, picker already up). */
    | { status: 'unavailable'; reason: string };

/** The platform returns the deliverable URL under `meta.url` (BridgePicker). */
function urlOf(selection: PickerSelection): string {
    const meta = selection.meta as { url?: unknown } | undefined;
    if (typeof meta?.url === 'string' && meta.url !== '') {
        return meta.url;
    }
    if (typeof selection.thumbnail === 'string' && selection.thumbnail !== '') {
        return selection.thumbnail;
    }
    return '';
}

/**
 * Open the host media library and return one selection.
 *
 * Three settled outcomes, no throw: the host answers a scope denial with
 * `{ cancelled: true, error: 'scope' }` rather than an error, and an app that
 * treats that as a crash would show the merchant a broken page for a
 * permission they simply were not granted.
 */
export async function pickMedia(query?: string): Promise<MediaPick> {
    const bridge = hostBridge();
    try {
        const result = await bridge.picker(query ? { kind: 'media', query } : { kind: 'media' });
        if (result.error === 'scope') {
            return { status: 'denied' };
        }
        if (typeof result.error === 'string' && result.error !== '') {
            return { status: 'unavailable', reason: result.error };
        }
        const first = result.selections[0];
        if (result.cancelled || first === undefined) {
            return { status: 'cancelled' };
        }

        const url = urlOf(first);
        if (url === '') {
            return { status: 'unavailable', reason: 'no-url' };
        }
        return { status: 'picked', url, label: String(first.label ?? '') };
    } catch (err) {
        return { status: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Open the media picker and return `{ url, label }`, or `null` after telling
 * the merchant why there is nothing (the ONE place apps settle a
 * {@link MediaPick}; Interactive Map and Tours each hand-wrote it before):
 *
 *  - `cancelled` — silent: the merchant closed the picker on purpose;
 *  - `denied` — explained: the install was never granted `read:media`;
 *  - `unavailable`, or a picker that rejects anyway — reported.
 *
 * Never throws, so a form can `await` it inline. `toast` is the app's
 * `useToast()` (or anything with that call shape); `pick` is injectable for
 * tests and for a `pickMedia(query)` call.
 */
export async function chooseMedia(
    toast: (message: string, variant: 'error') => void,
    pick: () => Promise<MediaPick> = () => pickMedia(),
): Promise<{ url: string; label: string } | null> {
    let result: MediaPick;
    try {
        result = await pick();
    } catch {
        result = { status: 'unavailable', reason: 'threw' };
    }
    if (result.status === 'picked') {
        return { url: result.url, label: result.label };
    }
    if (result.status === 'denied') {
        toast('This app has not been granted access to your media library.', 'error');
    } else if (result.status === 'unavailable') {
        toast('The media picker is unavailable right now.', 'error');
    }
    return null;
}
