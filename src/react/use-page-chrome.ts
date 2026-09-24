/**
 * `usePageChrome` — the React face of SET_PAGE.
 *
 * An app's chrome is derived state: it falls out of the route and the form's
 * dirty flag, so it is naturally recomputed on every render. Posting it on
 * every render would mean a postMessage per keystroke on a dirty form. The
 * hook therefore diffs against the last payload it actually sent and stays
 * silent when nothing structurally changed — the host does the same dedupe on
 * its side, but the cheapest message is the one never posted.
 *
 * Action callbacks live here rather than in the protocol: the wire only ever
 * carries an `id`, and the hook keeps the id → handler map so an app writes
 * `onSelect` next to the button it belongs to instead of a switch statement in
 * a separate effect.
 *
 * CLICKABLE BREADCRUMBS NEED `onHostNavigate`
 * -------------------------------------------
 * A crumb click is NOT a new message. The host renders the crumb as an anchor
 * and routes the click through the existing HOST_NAVIGATE + ack path, exactly
 * as it does a sidebar link — and it only suppresses the browser navigation
 * when the app has announced `SET_CAPABILITIES { hostNavigate: true }`. An app
 * that gives its crumbs a `path` but never subscribes to host navigation gets
 * a full page reload on every crumb click. Mount `<UrlSync />` (which
 * subscribes for you) or call `bridge.onHostNavigate(...)` yourself.
 */
'use client';

import { useEffect, useRef } from 'react';
import type { PageAction, PageCrumb, SetPagePayload } from '../types.js';
import { normalisePageChrome, pageChromeEquals } from '../page-chrome.js';
import { getBridge } from './use-app-bridge.js';

/** A command-bar action plus the handler that runs when it is clicked. */
export interface PageChromeAction extends PageAction {
    /** Invoked when the host posts ACTION with this action's `id`. */
    onSelect?: () => void;
}

export interface PageChromeInput {
    /** Document-title suffix. */
    title?: string;
    /** Breadcrumbs, max 5. The last one is the current page. */
    crumbs?: PageCrumb[];
    /** Command-bar buttons, max 4. */
    actions?: PageChromeAction[];
    /** Whether the page has unsaved changes. */
    dirty?: boolean;
}

const EMPTY_CRUMBS: PageCrumb[] = [];
const EMPTY_ACTIONS: PageChromeAction[] = [];

/**
 * Publish page chrome to the host command bar, and route action clicks back.
 *
 * Safe to call with freshly-built object and array literals every render —
 * that is the expected usage, and the diff is structural, not by reference.
 */
export function usePageChrome(input: PageChromeInput): void {
    const lastSent = useRef<SetPagePayload | null>(null);
    const handlers = useRef<Map<string, () => void>>(new Map());

    const crumbs = input.crumbs ?? EMPTY_CRUMBS;
    const actions = input.actions ?? EMPTY_ACTIONS;
    const dirty = input.dirty === true;
    const title = input.title;

    // Refresh the id → handler map on every render, BEFORE any effect can fire.
    // A ref rather than state: the map is never rendered, and rebuilding it must
    // not itself schedule a render.
    const nextHandlers = new Map<string, () => void>();
    for (const action of actions) {
        if (typeof action.onSelect === 'function') {
            nextHandlers.set(action.id, action.onSelect);
        }
    }
    handlers.current = nextHandlers;

    // Subscribed once on mount, never per-render: `onAction` is what announces
    // the `action` capability to the host, and re-subscribing on every render
    // would post a SET_CAPABILITIES pair each time.
    useEffect(() => {
        const bridge = getBridge();
        return bridge.onAction((id: string): void => {
            handlers.current.get(id)?.();
        });
    }, []);

    useEffect(() => {
        if (typeof window === 'undefined' || window.self === window.top) return;

        const payload: SetPagePayload = {
            crumbs,
            // Strip `onSelect` — it is a local concern and would not survive
            // the structured clone postMessage performs anyway.
            actions: actions.map(stripHandler),
            dirty,
        };
        if (title !== undefined) payload.title = title;

        lastSent.current = publishPageChrome(payload, lastSent.current, getBridge());
    });
}

/** The one bridge method {@link publishPageChrome} needs. */
export interface PageChromeSink {
    setPage: (page: SetPagePayload) => void;
}

const reportedChromeErrors = new Set<string>();

/**
 * Report a SET_PAGE payload the host would drop — LOUDLY, once per reason.
 *
 * The host's enforcement is a silent whole-payload drop, and a throw inside a
 * React effect either unmounts the whole app (no error boundary) or is
 * swallowed by one — both read as "the Save button vanished" with nothing
 * pointing at the cause. So the reason goes to `console.error` in every
 * environment (a merchant's devtools included), deduped so a per-render
 * failure does not flood it. There is no bridge telemetry channel yet; when
 * one lands this is the single place to wire it.
 */
export function reportPageChromeError(error: unknown, payload: SetPagePayload): void {
    const reason = error instanceof Error ? error.message : String(error);
    if (reportedChromeErrors.has(reason)) return;
    reportedChromeErrors.add(reason);
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
        console.error(
            `[app-bridge] SET_PAGE was NOT sent — the host would drop this page chrome ` +
            `(title, breadcrumbs and command-bar actions). Reason: ${reason}`,
            payload,
        );
    }
}

/** Test helper — forget which reasons were already reported. */
export function resetPageChromeErrors(): void {
    reportedChromeErrors.clear();
}

/**
 * Validate, diff and post one chrome payload; returns the payload that now
 * counts as "last sent". The effect body of {@link usePageChrome}, pulled out
 * so it is testable without a DOM.
 *
 * - Structurally equal to `lastSent` → nothing is posted. `pageChromeEquals`
 *   compares `dirty` and every action's `disabled`/`loading`, so a form going
 *   dirty (or a Save going busy) always re-posts.
 * - Invalid → nothing is posted, the reason is reported via
 *   {@link reportPageChromeError}, and `lastSent` is kept so the next valid
 *   payload is still diffed against what the host actually shows.
 */
export function publishPageChrome(
    payload: SetPagePayload,
    lastSent: SetPagePayload | null,
    sink: PageChromeSink,
): SetPagePayload | null {
    let normalised: SetPagePayload;
    try {
        normalised = normalisePageChrome(payload);
    } catch (error) {
        reportPageChromeError(error, payload);
        return lastSent;
    }
    if (pageChromeEquals(lastSent, normalised)) return lastSent;
    sink.setPage(normalised);
    return normalised;
}

function stripHandler(action: PageChromeAction): PageAction {
    const out: PageAction = { id: action.id, label: action.label, variant: action.variant };
    if (action.icon !== undefined) out.icon = action.icon;
    if (action.disabled !== undefined) out.disabled = action.disabled;
    if (action.loading !== undefined) out.loading = action.loading;
    return out;
}

/**
 * Drive the host's progress bar for the lifetime of a boolean.
 *
 * Separate from `usePageChrome` because loading is per-FETCH, not per-route:
 * a page publishes its chrome once and then flickers the bar many times.
 */
export function useBridgeLoading(active: boolean): void {
    const last = useRef<boolean | null>(null);

    useEffect(() => {
        if (typeof window === 'undefined' || window.self === window.top) return;
        if (last.current === active) return;
        last.current = active;
        getBridge().loading(active);
    }, [active]);

    // A component that unmounts mid-fetch must not leave the bar spinning
    // forever — the host's 15s stuck-app guard would clear it, but 15 seconds
    // of a phantom progress bar is a bug report.
    useEffect(() => {
        return () => {
            if (last.current === true) {
                last.current = false;
                getBridge().loading(false);
            }
        };
    }, []);
}

/** Subscribe to one command-bar action by id, outside `usePageChrome`. */
export function useBridgeAction(id: string, handler: () => void): void {
    const latest = useRef(handler);
    latest.current = handler;

    useEffect(() => {
        const bridge = getBridge();
        return bridge.onAction((actionId: string): void => {
            if (actionId === id) latest.current();
        });
    }, [id]);
}
