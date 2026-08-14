/**
 * SET_PAGE validation + structural diffing.
 *
 * Framework-free on purpose: the React `usePageChrome` hook, the core
 * `bridge.setPage()`, and the mock host all need the identical rules, and a
 * PHP/Python runtime should be able to port them from one place.
 *
 * WHY VALIDATE CLIENT-SIDE AT ALL — the host already enforces every cap here.
 * Because the host's enforcement is a silent DROP of the whole payload (it
 * cannot trust a partial chrome), which from the app author's seat looks like
 * "my breadcrumbs just don't show up" with nothing in any console. Throwing
 * here converts that into a stack trace pointing at the offending call.
 */

import type { PageAction, PageActionVariant, PageCrumb, SetPagePayload } from './types.js';

/** Host caps, mirrored from the host's enforced SET_PAGE validation. */
export const PAGE_CHROME_LIMITS = {
    crumbs: 5,
    actions: 4,
    labelChars: 48,
    /** Measured AFTER trim, exactly as the host measures it. */
    titleChars: 120,
    actionIdChars: 32,
    pathChars: 200,
} as const;

const ACTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** The variant spellings accepted on input — canonical set plus the deprecated alias. */
const ACCEPTED_ACTION_VARIANTS = ['primary', 'ghost', 'danger', 'default'] as const;

/** The variant spellings the host actually distinguishes on the wire. */
const CANONICAL_ACTION_VARIANTS = ['primary', 'ghost', 'danger'] as const;
type CanonicalActionVariant = (typeof CANONICAL_ACTION_VARIANTS)[number];

/**
 * Resolve an author-supplied (possibly absent, possibly the deprecated
 * `'default'` alias) variant down to the three the host renders distinctly.
 * Missing and `'default'` both mean "no explicit weight" — the neutral style.
 */
function normaliseVariant(variant: PageActionVariant | undefined): CanonicalActionVariant {
    if (variant === undefined || variant === 'default') return 'ghost';
    return variant;
}

/**
 * The host's `APP_PATH_PATTERN` for a crumb path.
 *
 * Stricter than {@link isAppRelativePath}: no query string, no dot segments,
 * no percent-encoding. A crumb is a navigation target the host renders as an
 * anchor and routes through HOST_NAVIGATE, so it is held to the narrowest
 * shape that can express one.
 */
export const APP_PATH_PATTERN = /^\/[A-Za-z0-9_\-/]*$/;

/**
 * Icons the host will render. Anything else renders NO icon — the host treats
 * an unknown name as an omission, not as a reason to drop the payload, so this
 * SDK must not throw on one either. {@link normalisePageChrome} warns instead.
 */
export const PAGE_ACTION_ICONS: readonly string[] = [
    'check',
    'plus',
    'trash',
    'arrow-path',
    'pencil-square',
    'arrow-down-tray',
];

/** True for a path the host will accept as a crumb target. */
export function isHostNavigablePath(path: string): boolean {
    return (
        typeof path === 'string' &&
        path.length <= PAGE_CHROME_LIMITS.pathChars &&
        APP_PATH_PATTERN.test(path)
    );
}

const warnedIcons = new Set<string>();

function warnUnknownIcon(icon: string): void {
    if (warnedIcons.has(icon)) return;
    warnedIcons.add(icon);
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn(
            `[app-bridge] Unknown action icon "${icon}". The host renders no icon for it. ` +
            `Allowed: ${PAGE_ACTION_ICONS.join(', ')}.`,
        );
    }
}

/**
 * Thrown when a payload would be dropped by the host.
 *
 * A distinct class so an app that genuinely wants to survive bad chrome can
 * catch precisely this and nothing else.
 */
export class BridgeValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BridgeValidationError';
    }
}

function assert(condition: boolean, message: string): asserts condition {
    if (!condition) {
        throw new BridgeValidationError(message);
    }
}

/**
 * True only for a path the app can safely route to itself. `//host` and `/\host`
 * both start with a slash yet are read as protocol-relative URLs by browsers and
 * by router `push()` calls, so they are rejected alongside absolute URLs.
 */
export function isAppRelativePath(path: string): boolean {
    return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\');
}

/**
 * Validate and normalise a page-chrome payload.
 *
 * Normalisation is deliberately narrow — dropping `undefined` optionals so two
 * structurally identical payloads compare equal in {@link pageChromeEquals}.
 * It never trims, truncates, or otherwise "fixes" over-cap input: silently
 * shortening a label is how a bug ships. The one exception is `variant`: a
 * missing variant or the deprecated `'default'` alias is filled in as
 * `'ghost'`, because that substitution is a documented default, not a silent
 * repair of invalid input.
 */
export function normalisePageChrome(input: SetPagePayload): SetPagePayload {
    // `dirty` is REQUIRED and must be a real boolean. The host drops the whole
    // payload for a missing or truthy-but-not-boolean value, because `dirty`
    // decides whether the command bar shows ⌘K or the app's Save/Discard —
    // guessing it wrong is worse than showing no chrome at all.
    assert(
        typeof input.dirty === 'boolean',
        'SET_PAGE: `dirty` is required and must be a real boolean.',
    );
    assert(Array.isArray(input.crumbs), 'SET_PAGE: `crumbs` must be an array.');
    assert(Array.isArray(input.actions), 'SET_PAGE: `actions` must be an array.');
    assert(
        input.crumbs.length <= PAGE_CHROME_LIMITS.crumbs,
        `SET_PAGE: at most ${PAGE_CHROME_LIMITS.crumbs} crumbs (got ${input.crumbs.length}).`,
    );
    assert(
        input.actions.length <= PAGE_CHROME_LIMITS.actions,
        `SET_PAGE: at most ${PAGE_CHROME_LIMITS.actions} actions (got ${input.actions.length}).`,
    );

    let title: string | undefined;
    if (input.title !== undefined) {
        assert(typeof input.title === 'string', 'SET_PAGE: `title` must be a string.');
        // The host measures the TRIMMED length, so trim here too — otherwise a
        // title padded to 121 chars passes locally and is dropped remotely.
        title = input.title.trim();
        assert(
            title.length <= PAGE_CHROME_LIMITS.titleChars,
            `SET_PAGE: \`title\` max ${PAGE_CHROME_LIMITS.titleChars} chars after trim.`,
        );
    }

    const crumbs: PageCrumb[] = input.crumbs.map((crumb, index) => {
        assert(
            typeof crumb?.label === 'string' && crumb.label !== '',
            `SET_PAGE: crumbs[${index}].label must be a non-empty string.`,
        );
        assert(
            crumb.label.length <= PAGE_CHROME_LIMITS.labelChars,
            `SET_PAGE: crumbs[${index}].label max ${PAGE_CHROME_LIMITS.labelChars} chars.`,
        );
        if (crumb.path === undefined) {
            return { label: crumb.label };
        }
        assert(
            typeof crumb.path === 'string' && isHostNavigablePath(crumb.path),
            `SET_PAGE: crumbs[${index}].path must match ${String(APP_PATH_PATTERN)} ` +
            `and be at most ${PAGE_CHROME_LIMITS.pathChars} chars (got ${String(crumb.path)}).`,
        );
        return { label: crumb.label, path: crumb.path };
    });

    const seenIds = new Set<string>();
    const actions: PageAction[] = input.actions.map((action, index) => {
        assert(
            typeof action?.id === 'string' && ACTION_ID_PATTERN.test(action.id),
            `SET_PAGE: actions[${index}].id must match [A-Za-z0-9_-]{1,${PAGE_CHROME_LIMITS.actionIdChars}}.`,
        );
        assert(
            !seenIds.has(action.id),
            `SET_PAGE: duplicate action id "${action.id}" — ACTION could not be routed unambiguously.`,
        );
        seenIds.add(action.id);
        assert(
            typeof action.label === 'string' && action.label !== '',
            `SET_PAGE: actions[${index}].label must be a non-empty string.`,
        );
        assert(
            action.label.length <= PAGE_CHROME_LIMITS.labelChars,
            `SET_PAGE: actions[${index}].label max ${PAGE_CHROME_LIMITS.labelChars} chars.`,
        );
        assert(
            action.variant === undefined ||
                (ACCEPTED_ACTION_VARIANTS as readonly string[]).includes(action.variant),
            `SET_PAGE: actions[${index}].variant must be one of ${ACCEPTED_ACTION_VARIANTS.join(', ')} when present.`,
        );

        // The host drops the WHOLE payload for a non-boolean flag, so a stray
        // `disabled={saving && 'yes'}` must fail here rather than take the
        // breadcrumbs down with it in production.
        assert(
            action.disabled === undefined || typeof action.disabled === 'boolean',
            `SET_PAGE: actions[${index}].disabled must be a boolean when present.`,
        );
        assert(
            action.loading === undefined || typeof action.loading === 'boolean',
            `SET_PAGE: actions[${index}].loading must be a boolean when present.`,
        );

        const out: PageAction = { id: action.id, label: action.label, variant: normaliseVariant(action.variant) };
        if (action.icon !== undefined) {
            // Deliberately NOT an assertion: the host renders an unknown icon
            // as no icon rather than rejecting, and this SDK must not be
            // stricter than the thing it is protecting the app from.
            if (!PAGE_ACTION_ICONS.includes(action.icon)) warnUnknownIcon(action.icon);
            out.icon = action.icon;
        }
        if (action.disabled !== undefined) out.disabled = action.disabled;
        if (action.loading !== undefined) out.loading = action.loading;
        return out;
    });

    const payload: SetPagePayload = { crumbs, actions, dirty: input.dirty };
    if (title !== undefined) payload.title = title;
    return payload;
}

/**
 * Structural equality for two normalised chrome payloads.
 *
 * Hand-rolled rather than `JSON.stringify` comparison because key ORDER would
 * then be load-bearing: `{label, path}` and `{path, label}` describe the same
 * breadcrumb and must not cause a redundant post on every render.
 */
export function pageChromeEquals(a: SetPagePayload | null, b: SetPagePayload | null): boolean {
    if (a === null || b === null) return a === b;
    if (a.title !== b.title) return false;
    if (a.dirty !== b.dirty) return false;
    if (a.crumbs.length !== b.crumbs.length) return false;
    if (a.actions.length !== b.actions.length) return false;

    for (let i = 0; i < a.crumbs.length; i += 1) {
        const x = a.crumbs[i]!;
        const y = b.crumbs[i]!;
        if (x.label !== y.label || x.path !== y.path) return false;
    }

    for (let i = 0; i < a.actions.length; i += 1) {
        const x = a.actions[i]!;
        const y = b.actions[i]!;
        if (
            x.id !== y.id ||
            x.label !== y.label ||
            x.variant !== y.variant ||
            x.icon !== y.icon ||
            x.disabled !== y.disabled ||
            x.loading !== y.loading
        ) {
            return false;
        }
    }

    return true;
}
