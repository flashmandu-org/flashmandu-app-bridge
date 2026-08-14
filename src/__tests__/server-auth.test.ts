import { describe, expect, it } from 'vitest';

import { loadConfig } from '../server/config.js';
import {
    AuthError,
    mintEmbedToken,
    requireSession,
    resolveProfile,
    resolveSession,
    verifyEmbedToken,
    verifyEmbedTokenDetailed,
} from '../server/auth.js';

const SECRET = 'appsecret';

describe('verifyEmbedToken', () => {
    it('accepts a token minted for the same secret and returns its profileId', () => {
        const token = mintEmbedToken({ profile_id: '42' }, SECRET);
        expect(verifyEmbedToken(token, SECRET)).toEqual({ profileId: '42' });
    });

    it('rejects a token signed with a different secret', () => {
        const token = mintEmbedToken({ profile_id: '42' }, SECRET);
        expect(verifyEmbedToken(token, 'wrong')).toBeNull();
    });

    it('rejects an expired token', () => {
        const token = mintEmbedToken({ profile_id: '42' }, SECRET, 0);
        expect(verifyEmbedToken(token, SECRET)).toBeNull();
    });

    it('rejects a token with no usable profile_id', () => {
        const token = mintEmbedToken({ foo: 'bar' }, SECRET);
        expect(verifyEmbedToken(token, SECRET)).toBeNull();
    });
});

describe('verifyEmbedTokenDetailed', () => {
    it('surfaces the reason for a malformed token', () => {
        expect(verifyEmbedTokenDetailed('not-a-token', SECRET)).toMatchObject({ ok: false, reason: 'malformed' });
    });

    it('surfaces the reason for an empty token', () => {
        expect(verifyEmbedTokenDetailed('', SECRET)).toMatchObject({ ok: false, reason: 'empty token' });
    });
});

describe('resolveProfile', () => {
    it('resolves via a valid Authorization bearer token', async () => {
        const cfg = loadConfig({ FLASHMANDU_APP_SECRET: SECRET } as NodeJS.ProcessEnv);
        const token = mintEmbedToken({ profile_id: '7' }, SECRET);
        const req = new Request('https://app.example/api/items', {
            headers: { Authorization: `Bearer ${token}` },
        });
        await expect(resolveProfile(req, cfg)).resolves.toBe('7');
    });

    it('resolves via ?session_token= when no header is present', async () => {
        const cfg = loadConfig({ FLASHMANDU_APP_SECRET: SECRET } as NodeJS.ProcessEnv);
        const token = mintEmbedToken({ profile_id: '9' }, SECRET);
        const req = new Request(`https://app.example/api/items?session_token=${encodeURIComponent(token)}`);
        await expect(resolveProfile(req, cfg)).resolves.toBe('9');
    });

    it('falls back to bare ?profileId= when no token verifies', async () => {
        const cfg = loadConfig({} as NodeJS.ProcessEnv); // appSecret() throws — never called eagerly
        const req = new Request('https://app.example/api/items?profileId=3');
        await expect(resolveProfile(req, cfg)).resolves.toBe('3');
    });

    it('returns null when nothing resolves', async () => {
        const cfg = loadConfig({} as NodeJS.ProcessEnv);
        const req = new Request('https://app.example/api/items');
        await expect(resolveProfile(req, cfg)).resolves.toBeNull();
    });
});

describe('resolveSession', () => {
    it('resolves via a valid Authorization bearer token, returning the full payload', () => {
        const cfg = loadConfig({ FLASHMANDU_APP_SECRET: SECRET } as NodeJS.ProcessEnv);
        const token = mintEmbedToken({ profile_id: '7', role: 'owner' }, SECRET);
        const req = new Request('https://app.example/api/items', {
            headers: { Authorization: `Bearer ${token}` },
        });
        const session = resolveSession(req, cfg);
        expect(session).not.toBeNull();
        expect(session?.profileId).toBe(7);
        expect(session?.payload.role).toBe('owner');
    });

    it('resolves via ?session_token= when no header is present', () => {
        const cfg = loadConfig({ FLASHMANDU_APP_SECRET: SECRET } as NodeJS.ProcessEnv);
        const token = mintEmbedToken({ profile_id: '9' }, SECRET);
        const req = new Request(`https://app.example/api/items?session_token=${encodeURIComponent(token)}`);
        expect(resolveSession(req, cfg)?.profileId).toBe(9);
    });

    it('prefers the query token over the header when both are present', () => {
        const cfg = loadConfig({ FLASHMANDU_APP_SECRET: SECRET } as NodeJS.ProcessEnv);
        const headerToken = mintEmbedToken({ profile_id: '1' }, SECRET);
        const queryToken = mintEmbedToken({ profile_id: '2' }, SECRET);
        const req = new Request(
            `https://app.example/api/items?session_token=${encodeURIComponent(queryToken)}`,
            { headers: { Authorization: `Bearer ${headerToken}` } },
        );
        expect(resolveSession(req, cfg)?.profileId).toBe(2);
    });

    it('falls back to bare ?profileId= when no token verifies, synthesizing a minimal payload', () => {
        const cfg = loadConfig({} as NodeJS.ProcessEnv); // appSecret() throws — never called eagerly
        const req = new Request('https://app.example/api/items?profileId=3');
        const session = resolveSession(req, cfg);
        expect(session).toEqual({ profileId: 3, payload: { profile_id: '3' } });
    });

    it('returns null when nothing resolves', () => {
        const cfg = loadConfig({} as NodeJS.ProcessEnv);
        const req = new Request('https://app.example/api/items');
        expect(resolveSession(req, cfg)).toBeNull();
    });

    it('returns null for an unprovisioned secret even with a bearer token present (never throws)', () => {
        const cfg = loadConfig({} as NodeJS.ProcessEnv);
        const token = mintEmbedToken({ profile_id: '7' }, SECRET);
        const req = new Request('https://app.example/api/items', {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(() => resolveSession(req, cfg)).not.toThrow();
        expect(resolveSession(req, cfg)).toBeNull();
    });

    it('ignores an invalid/expired token and falls through to ?profileId=', () => {
        const cfg = loadConfig({ FLASHMANDU_APP_SECRET: SECRET } as NodeJS.ProcessEnv);
        const expired = mintEmbedToken({ profile_id: '7' }, SECRET, 0);
        const req = new Request(
            `https://app.example/api/items?session_token=${encodeURIComponent(expired)}&profileId=5`,
        );
        expect(resolveSession(req, cfg)?.profileId).toBe(5);
    });
});

describe('requireSession', () => {
    it('returns the session when resolvable', () => {
        const cfg = loadConfig({} as NodeJS.ProcessEnv);
        const req = new Request('https://app.example/api/items?profileId=4');
        expect(requireSession(req, cfg).profileId).toBe(4);
    });

    it('throws AuthError with status 401 when unresolvable', () => {
        const cfg = loadConfig({} as NodeJS.ProcessEnv);
        const req = new Request('https://app.example/api/items');
        expect(() => requireSession(req, cfg)).toThrow(AuthError);
        try {
            requireSession(req, cfg);
            throw new Error('expected requireSession to throw');
        } catch (error) {
            expect(error).toBeInstanceOf(AuthError);
            expect((error as AuthError).status).toBe(401);
            expect((error as AuthError).name).toBe('AuthError');
        }
    });
});
