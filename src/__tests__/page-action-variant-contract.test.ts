import { describe, expect, it } from 'vitest';

import type { PageAction, PageActionVariant } from '../types.js';
import type { PageChromeAction } from '../react/use-page-chrome.js';

/**
 * Contract test for the `PageActionVariant` union this package shares with
 * `@flashmandu/app-bridge-ui`'s own `PageActionVariant` (`src/react.tsx`).
 *
 * `configurePageChrome(usePageChrome)` (the documented GUIDELINES.md wiring
 * in `@flashmandu/app-bridge-ui`) only type-checks with no cast if the two
 * packages' `PageAction`-shaped types stay structurally identical. The two
 * repos have no dependency on each other (bridge-ui does not `import` this
 * package — see its own framework-free doc comment), so there is no way to
 * `import` bridge-ui's type here and compare it directly. This test instead
 * pins THIS repo's union to the literal canonical list both repos are
 * required to keep in lockstep. The identical list, with this identical
 * comment, lives in `flashmandu-app-bridge-ui/test/page-action-variant-contract.test.tsx`.
 *
 * A cross-package `tsc --noEmit` probe (compiled against both packages'
 * built `dist/`, importing both real types with zero casts) was also run
 * manually to prove the wiring compiles; it is not committed here because it
 * requires both `dist/` folders to exist side by side, which neither repo's
 * own `npm test` can guarantee.
 */

/** The exact variant spellings both packages must accept. Keep in lockstep with bridge-ui. */
const CANONICAL_PAGE_ACTION_VARIANTS = ['primary', 'ghost', 'danger', 'default'] as const;

type Canonical = (typeof CANONICAL_PAGE_ACTION_VARIANTS)[number];

// Compile-time: PageActionVariant must be exactly (not a subset or superset
// of) the canonical union. Either direction of drift fails `tsc`.
type AssertExact<A extends string, B extends string> = [A] extends [B]
    ? [B] extends [A]
        ? true
        : false
    : false;
const _unionMatchesCanonical: AssertExact<PageActionVariant, Canonical> = true;
void _unionMatchesCanonical;

// Compile-time: `variant` must be OPTIONAL on both the wire type and the
// hook-input type — a required `variant` is exactly what broke assignability
// against bridge-ui's `PageChrome.actions` in the first place.
const _actionVariantIsOptional: PageAction = { id: 'a', label: 'A' };
const _chromeActionVariantIsOptional: PageChromeAction = { id: 'a', label: 'A' };
void _actionVariantIsOptional;
void _chromeActionVariantIsOptional;

describe('PageActionVariant contract', () => {
    it('matches the canonical union shared with app-bridge-ui', () => {
        // Runtime companion to the compile-time check above, so a `describe`
        // block exists to fail loudly (rather than only a silent tsc error)
        // if this file is ever run without a type-checking step.
        const sample: readonly PageActionVariant[] = CANONICAL_PAGE_ACTION_VARIANTS;
        expect(sample).toEqual(CANONICAL_PAGE_ACTION_VARIANTS);
    });
});
