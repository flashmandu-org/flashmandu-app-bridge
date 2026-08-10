/**
 * SET_SEARCH_PROVIDER validation.
 *
 * Framework-free on purpose, for the same reason `page-chrome.ts` is: the core
 * `bridge.setSearchProvider()`, the mock host, the platform's own relay and a
 * PHP runtime all need the identical rules, and three drifting copies of a
 * dedupe gate is how duplicate results get shipped.
 *
 * WHY VALIDATE CLIENT-SIDE — the host enforces every cap here too, and its
 * enforcement is a silent drop. From the app author's seat that reads as "my
 * search results just never appear", with nothing in any console. Throwing
 * converts it into a stack trace at the offending call.
 *
 * THE PART THAT IS NOT A CAP: {@link PLATFORM_OWNED_SEARCH_TYPES}. Rejecting a
 * platform-owned domain is the deduplication rule itself, not a size limit. An
 * app that mirrors the platform's items or orders through the GraphQL API must
 * not be able to publish them back into ⌘K as a second copy — so it is denied
 * a domain to publish them under, at the moment it tries to register one.
 */

import { BridgeValidationError } from './page-chrome.js';
import type {
    SearchCommand,
    SearchDomain,
    SearchProviderPayload,
} from './types.js';

/** Host caps, mirrored from the host's enforced SET_SEARCH_PROVIDER validation. */
export const SEARCH_PROVIDER_LIMITS = {
    domains: 4,
    commands: 20,
    typeChars: 32,
    domainLabelChars: 32,
    commandIdChars: 32,
    labelChars: 48,
    subtitleChars: 64,
    pathChars: 200,
    iconChars: 48,
    keywords: 8,
    keywordChars: 24,
    endpointChars: 300,
} as const;

/**
 * Record types the PLATFORM is authoritative for.
 *
 * Derived from `App\Services\Search\GlobalSearchService::GROUPS` on the host,
 * plus the singular/alias spellings an app would reach for. An app may not
 * register a domain of any of these types: the host already searches them, and
 * an app's copy of them — however it was obtained — is by definition a
 * duplicate of a row the merchant is already being shown.
 *
 * An app that wants to say something ABOUT one of these records attaches to it
 * with `platformRef` instead, which the host renders under the platform's own
 * row rather than beside it.
 *
 * Compared case-insensitively, after trimming, in both singular and plural
 * form — `Items`, `item` and `ITEM` are the same claim.
 */
export const PLATFORM_OWNED_SEARCH_TYPES: readonly string[] = [
    'account',
    'app',
    'brand',
    'category',
    'coupon',
    'customer',
    'expense',
    'item',
    'location',
    'order',
    'outlet',
    'party',
    'product',
    'purchase',
    'purchase-order',
    'supplier',
    'table',
    'tag',
    'transaction',
];

const DOMAIN_TYPE_PATTERN = /^[a-z][a-z0-9_-]*$/;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const COMMAND_PATH_PATTERN = /^\/[A-Za-z0-9_\-/]*$/;
const ICON_PATTERN = /^[a-z0-9-]+$/;

/**
 * True when `type` names something the platform already searches.
 *
 * The plural strip is deliberately crude (one trailing `s`) rather than a
 * pluralisation library: the list is a denylist, and a near-miss like
 * `categorie` failing to match costs nothing — the type is still segregated
 * into the app's own group and badged with the app's name, so it can never be
 * mistaken for a platform row.
 */
export function isPlatformOwnedSearchType(type: string): boolean {
    const normalised = String(type).trim().toLowerCase();
    if (normalised === '') {
        return false;
    }
    const singular = normalised.endsWith('s') ? normalised.slice(0, -1) : normalised;

    return (
        PLATFORM_OWNED_SEARCH_TYPES.includes(normalised) ||
        PLATFORM_OWNED_SEARCH_TYPES.includes(singular)
    );
}

function requireText(value: unknown, field: string, max: number): string {
    if (typeof value !== 'string') {
        throw new BridgeValidationError(`${field} must be a string.`);
    }
    const trimmed = value.trim();
    if (trimmed === '') {
        throw new BridgeValidationError(`${field} must not be empty.`);
    }
    if (trimmed.length > max) {
        throw new BridgeValidationError(`${field} exceeds max ${max} chars.`);
    }

    return trimmed;
}

function optionalText(value: unknown, field: string, max: number): string {
    if (value === undefined || value === null || value === '') {
        return '';
    }
    if (typeof value !== 'string') {
        throw new BridgeValidationError(`${field} must be a string.`);
    }
    const trimmed = value.trim();
    if (trimmed.length > max) {
        throw new BridgeValidationError(`${field} exceeds max ${max} chars.`);
    }

    return trimmed;
}

function normaliseDomain(raw: unknown, index: number): SearchDomain {
    if (typeof raw !== 'object' || raw === null) {
        throw new BridgeValidationError(`domains[${index}] must be an object.`);
    }
    const candidate = raw as Record<string, unknown>;

    const type = requireText(candidate.type, `domains[${index}].type`, SEARCH_PROVIDER_LIMITS.typeChars)
        .toLowerCase();

    if (!DOMAIN_TYPE_PATTERN.test(type)) {
        throw new BridgeValidationError(
            `domains[${index}].type must match ${String(DOMAIN_TYPE_PATTERN)}.`,
        );
    }

    if (isPlatformOwnedSearchType(type)) {
        throw new BridgeValidationError(
            `domains[${index}].type "${type}" is owned by the platform, which already ` +
            'searches it. Publishing your copy of it would show the merchant the same ' +
            'record twice. Attach to the platform record with `platformRef` instead, or ' +
            'pick a type that names YOUR record.',
        );
    }

    return {
        type,
        label: requireText(candidate.label, `domains[${index}].label`, SEARCH_PROVIDER_LIMITS.domainLabelChars),
    };
}

function normaliseKeywords(raw: unknown, index: number): string[] {
    if (raw === undefined || raw === null) {
        return [];
    }
    if (!Array.isArray(raw)) {
        throw new BridgeValidationError(`commands[${index}].keywords must be an array.`);
    }
    if (raw.length > SEARCH_PROVIDER_LIMITS.keywords) {
        throw new BridgeValidationError(
            `commands[${index}].keywords exceeds max ${SEARCH_PROVIDER_LIMITS.keywords}.`,
        );
    }

    return raw.map((keyword, k) =>
        requireText(keyword, `commands[${index}].keywords[${k}]`, SEARCH_PROVIDER_LIMITS.keywordChars)
            .toLowerCase(),
    );
}

function normaliseCommand(raw: unknown, index: number): Required<SearchCommand> {
    if (typeof raw !== 'object' || raw === null) {
        throw new BridgeValidationError(`commands[${index}] must be an object.`);
    }
    const candidate = raw as Record<string, unknown>;

    const id = requireText(candidate.id, `commands[${index}].id`, SEARCH_PROVIDER_LIMITS.commandIdChars);
    if (!COMMAND_ID_PATTERN.test(id)) {
        throw new BridgeValidationError(
            `commands[${index}].id must match ${String(COMMAND_ID_PATTERN)}.`,
        );
    }

    const path = requireText(candidate.path, `commands[${index}].path`, SEARCH_PROVIDER_LIMITS.pathChars);
    if (!COMMAND_PATH_PATTERN.test(path)) {
        throw new BridgeValidationError(
            `commands[${index}].path must be app-relative and match ${String(COMMAND_PATH_PATTERN)}.`,
        );
    }

    const icon = optionalText(candidate.icon, `commands[${index}].icon`, SEARCH_PROVIDER_LIMITS.iconChars);
    if (icon !== '' && !ICON_PATTERN.test(icon)) {
        throw new BridgeValidationError(
            `commands[${index}].icon must match ${String(ICON_PATTERN)}.`,
        );
    }

    return {
        id,
        label: requireText(candidate.label, `commands[${index}].label`, SEARCH_PROVIDER_LIMITS.labelChars),
        subtitle: optionalText(candidate.subtitle, `commands[${index}].subtitle`, SEARCH_PROVIDER_LIMITS.subtitleChars),
        path,
        icon,
        keywords: normaliseKeywords(candidate.keywords, index),
    };
}

/**
 * The live-query endpoint.
 *
 * https only, and absolute: the host POSTs this from its OWN server, so a
 * relative path has no meaning and an http:// URL would put the merchant's
 * typed search term on the wire in clear text. Credentials in the URL are
 * rejected outright rather than stripped — an app that put them there believes
 * they are being sent.
 */
function normaliseEndpoint(raw: unknown): string | null {
    if (raw === undefined || raw === null || raw === '') {
        return null;
    }
    if (typeof raw !== 'string') {
        throw new BridgeValidationError('endpoint must be a string or null.');
    }
    const trimmed = raw.trim();
    if (trimmed.length > SEARCH_PROVIDER_LIMITS.endpointChars) {
        throw new BridgeValidationError(
            `endpoint exceeds max ${SEARCH_PROVIDER_LIMITS.endpointChars} chars.`,
        );
    }

    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        throw new BridgeValidationError('endpoint must be an absolute URL.');
    }
    if (url.protocol !== 'https:') {
        throw new BridgeValidationError('endpoint must use https.');
    }
    if (url.username !== '' || url.password !== '') {
        throw new BridgeValidationError('endpoint must not embed credentials.');
    }

    return url.toString();
}

/**
 * Validate and re-shape a search-provider registration.
 *
 * Returns the exact payload to put on the wire: every field present, every
 * string trimmed and clamped, so the host's own re-derivation is a no-op on a
 * well-formed message rather than a second, differently-rounded opinion.
 */
export function normaliseSearchProvider(raw: SearchProviderPayload): Required<SearchProviderPayload> {
    if (typeof raw !== 'object' || raw === null) {
        throw new BridgeValidationError('The search provider must be an object.');
    }

    const rawDomains = raw.domains ?? [];
    if (!Array.isArray(rawDomains)) {
        throw new BridgeValidationError('domains must be an array.');
    }
    if (rawDomains.length > SEARCH_PROVIDER_LIMITS.domains) {
        throw new BridgeValidationError(`domains exceeds max ${SEARCH_PROVIDER_LIMITS.domains}.`);
    }

    const rawCommands = raw.commands ?? [];
    if (!Array.isArray(rawCommands)) {
        throw new BridgeValidationError('commands must be an array.');
    }
    if (rawCommands.length > SEARCH_PROVIDER_LIMITS.commands) {
        throw new BridgeValidationError(`commands exceeds max ${SEARCH_PROVIDER_LIMITS.commands}.`);
    }

    const domains = rawDomains.map(normaliseDomain);
    const endpoint = normaliseEndpoint(raw.endpoint);

    // An endpoint with nothing to answer for is a live query the host would
    // issue on every ⌘K and then discard every row of, because no domain
    // claims them. Caught here rather than silently ignored on the host.
    if (endpoint !== null && domains.length === 0) {
        throw new BridgeValidationError(
            'endpoint requires at least one domain: the host only accepts live results ' +
            'whose type matches a registered domain.',
        );
    }

    const seen = new Set<string>();
    for (const domain of domains) {
        if (seen.has(domain.type)) {
            throw new BridgeValidationError(`domains contains "${domain.type}" twice.`);
        }
        seen.add(domain.type);
    }

    return {
        domains,
        commands: rawCommands.map(normaliseCommand),
        endpoint,
    };
}
