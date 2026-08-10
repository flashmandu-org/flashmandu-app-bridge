import { afterEach, describe, expect, it } from 'vitest';

import { BridgeValidationError } from '../page-chrome.js';
import {
    isPlatformOwnedSearchType,
    normaliseSearchProvider,
    SEARCH_PROVIDER_LIMITS,
} from '../search-provider.js';
import { createMockHost, type MockHost } from '../testing/index.js';
import { MessageType, type SearchProviderPayload } from '../types.js';

/**
 * The dedupe rule lives in `normaliseSearchProvider`, so these are not "cap"
 * tests with one policy test bolted on — the platform-owned-type rejection IS
 * the feature. If it regresses, an app that mirrors items over GraphQL starts
 * publishing every one of them back into ⌘K beside the platform's own copy.
 */

const domain = (type: string) => ({ type, label: 'Things' });
const command = (n: number) => ({ id: `c${n}`, label: `C${n}`, path: `/c/${n}` });

let host: MockHost;

afterEach(() => {
    host?.restore();
});

describe('platform-owned domains are refused', () => {
    it.each(['item', 'items', 'Order', 'ORDERS', 'customer', 'category', 'outlet', 'party', 'app'])(
        'rejects %s',
        (type) => {
            expect(() => normaliseSearchProvider({ domains: [domain(type)] })).toThrow(
                BridgeValidationError,
            );
            expect(() => normaliseSearchProvider({ domains: [domain(type)] })).toThrow(
                /owned by the platform/,
            );
        },
    );

    it('accepts a type the platform does not search', () => {
        const out = normaliseSearchProvider({ domains: [domain('route')] });

        expect(out.domains).toEqual([{ type: 'route', label: 'Things' }]);
    });

    it('classifies singular and plural spellings alike', () => {
        expect(isPlatformOwnedSearchType('purchase-order')).toBe(true);
        expect(isPlatformOwnedSearchType('  Transactions  ')).toBe(true);
        expect(isPlatformOwnedSearchType('route')).toBe(false);
        expect(isPlatformOwnedSearchType('')).toBe(false);
    });

    it('rejects the same domain declared twice', () => {
        expect(() =>
            normaliseSearchProvider({ domains: [domain('route'), domain('ROUTE')] }),
        ).toThrow(/twice/);
    });
});

describe('caps', () => {
    it('accepts the maximum domains and commands', () => {
        const out = normaliseSearchProvider({
            domains: ['route', 'trip', 'zone', 'pin'].map(domain),
            commands: Array.from({ length: SEARCH_PROVIDER_LIMITS.commands }, (_, i) => command(i)),
        });

        expect(out.domains).toHaveLength(4);
        expect(out.commands).toHaveLength(20);
    });

    it('rejects a fifth domain', () => {
        expect(() =>
            normaliseSearchProvider({ domains: ['a', 'b', 'c', 'd', 'e'].map(domain) }),
        ).toThrow(/domains exceeds max 4/);
    });

    it('rejects a twenty-first command', () => {
        expect(() =>
            normaliseSearchProvider({
                commands: Array.from({ length: 21 }, (_, i) => command(i)),
            }),
        ).toThrow(/commands exceeds max 20/);
    });

    it('rejects an over-long label and an over-long subtitle', () => {
        expect(() =>
            normaliseSearchProvider({ commands: [{ ...command(1), label: 'x'.repeat(49) }] }),
        ).toThrow(/max 48 chars/);
        expect(() =>
            normaliseSearchProvider({ commands: [{ ...command(1), subtitle: 'x'.repeat(65) }] }),
        ).toThrow(/max 64 chars/);
    });

    it('rejects more than eight keywords', () => {
        expect(() =>
            normaliseSearchProvider({
                commands: [{ ...command(1), keywords: Array.from({ length: 9 }, () => 'k') }],
            }),
        ).toThrow(/keywords exceeds max 8/);
    });

    it('lowercases keywords so host matching is case-blind', () => {
        const out = normaliseSearchProvider({
            commands: [{ ...command(1), keywords: ['Map', 'DRAW'] }],
        });

        expect(out.commands[0]?.keywords).toEqual(['map', 'draw']);
    });
});

describe('command paths and icons', () => {
    it.each(['routes/new', 'https://evil.example/x', '/routes?x=1', '/routes/../../etc'])(
        'rejects the path %s',
        (path) => {
            expect(() => normaliseSearchProvider({ commands: [{ ...command(1), path }] })).toThrow(
                BridgeValidationError,
            );
        },
    );

    it('rejects a command id outside [A-Za-z0-9_-]{1,32}', () => {
        expect(() => normaliseSearchProvider({ commands: [{ ...command(1), id: 'new route' }] }))
            .toThrow(BridgeValidationError);
        expect(() => normaliseSearchProvider({ commands: [{ ...command(1), id: 'a'.repeat(33) }] }))
            .toThrow(BridgeValidationError);
    });

    it('rejects an icon that is not a flux-shaped name', () => {
        expect(() => normaliseSearchProvider({ commands: [{ ...command(1), icon: 'Map Pin' }] }))
            .toThrow(BridgeValidationError);
    });

    it('fills optional fields so the wire payload is one shape', () => {
        const out = normaliseSearchProvider({ commands: [command(1)] });

        expect(out.commands[0]).toEqual({
            id: 'c1',
            label: 'C1',
            subtitle: '',
            path: '/c/1',
            icon: '',
            keywords: [],
        });
    });
});

describe('endpoint', () => {
    it('accepts an absolute https endpoint alongside a domain', () => {
        const out = normaliseSearchProvider({
            domains: [domain('route')],
            endpoint: 'https://maps.example.com/api/search',
        });

        expect(out.endpoint).toBe('https://maps.example.com/api/search');
    });

    it.each(['http://maps.example.com/s', '/api/search', 'https://u:p@maps.example.com/s'])(
        'rejects %s',
        (endpoint) => {
            expect(() =>
                normaliseSearchProvider({ domains: [domain('route')], endpoint }),
            ).toThrow(BridgeValidationError);
        },
    );

    it('rejects an endpoint with no domain to answer for', () => {
        expect(() => normaliseSearchProvider({ endpoint: 'https://maps.example.com/s' })).toThrow(
            /requires at least one domain/,
        );
    });

    it('normalises an omitted endpoint to null', () => {
        expect(normaliseSearchProvider({ commands: [command(1)] }).endpoint).toBeNull();
    });
});

describe('bridge.setSearchProvider', () => {
    const provider: SearchProviderPayload = {
        domains: [{ type: 'route', label: 'Routes' }],
        endpoint: 'https://maps.example.com/api/search',
        commands: [{ id: 'new-route', label: 'Draw a new route', path: '/routes/new' }],
    };

    it('posts the registration and announces the capability', () => {
        host = createMockHost();
        const bridge = host.createBridge();

        bridge.setSearchProvider(provider);

        const sent = host.sent.filter((m) => m.type === MessageType.SetSearchProvider);
        expect(sent).toHaveLength(1);
        expect(sent[0]?.payload).toMatchObject({
            domains: [{ type: 'route', label: 'Routes' }],
            endpoint: 'https://maps.example.com/api/search',
        });
        expect(host.announcements().at(-1)).toMatchObject({ search: true });
    });

    it('announces once, however many times the app re-registers', () => {
        host = createMockHost();
        const bridge = host.createBridge();

        bridge.setSearchProvider(provider);
        bridge.setSearchProvider(provider);

        expect(host.sent.filter((m) => m.type === MessageType.SetSearchProvider)).toHaveLength(2);
        expect(host.announcements().filter((c) => c.search === true)).toHaveLength(1);
    });

    it('is a silent no-op on a host that never announced capabilities.search', () => {
        host = createMockHost({ capabilities: { search: false } });
        const bridge = host.createBridge();

        expect(() => bridge.setSearchProvider(provider)).not.toThrow();
        expect(host.sent.filter((m) => m.type === MessageType.SetSearchProvider)).toHaveLength(0);
    });

    it('still throws on a malformed registration against an old host', () => {
        host = createMockHost({ capabilities: { search: false } });
        const bridge = host.createBridge();

        expect(() => bridge.setSearchProvider({ domains: [domain('item')] })).toThrow(
            BridgeValidationError,
        );
    });
});
