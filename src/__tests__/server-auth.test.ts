import { describe, expect, it } from 'vitest';

import { loadConfig } from '../server/config.js';
import { mintEmbedToken, resolveProfile, verifyEmbedToken, verifyEmbedTokenDetailed } from '../server/auth.js';

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
