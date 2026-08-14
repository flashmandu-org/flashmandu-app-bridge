/**
 * `useProfileId` and friends — the small hook surface pages reach for most.
 *
 * Ported from the app template's `lib/use-profile.ts` (11 ln), which was
 * itself just a re-export shim pointing back at this package:
 *
 *   export { useProfileId, useAppBridge, useToast, useBridgeLoading } from
 *     '@flashmandu/app-bridge/react';
 *
 * DIVERGENCE: that shim only made sense app-side, as a stable local import
 * path in front of the SDK. Inside the SDK itself a re-export of the SDK's
 * own package name would be circular, so this file instead re-exports
 * directly from the sibling modules that already define these hooks
 * (`use-app-bridge.ts`, `use-page-chrome.ts`) — the SAME symbols, reachable
 * both from here and directly from `@flashmandu/app-bridge/react`'s root.
 * Kept as its own module (rather than folded away) so `src/react/use-profile.ts`
 * remains the documented, greppable home of "the profile hook", matching the
 * app template's file layout 1:1 for anyone porting mental model from tours.
 */
export { useProfileId, useAppBridge, useToast } from './use-app-bridge.js';
export { useBridgeLoading } from './use-page-chrome.js';
