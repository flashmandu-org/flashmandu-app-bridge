import { describe, expect, it } from 'vitest';

import { loadConfig } from '../server/config.js';

describe('loadConfig', () => {
    it('loads credentials from env without touching the app secret', () => {
        const cfg = loadConfig({
            FLASHMANDU_API_TOKEN: 'tok',
            FLASHMANDU_WEBHOOK_SECRET: 'whsec',
            FLASHMANDU_APP_SECRET: 'appsec',
            FLASHMANDU_DEV_BOX_BASE_URL: 'https://dev.example/',
        } as NodeJS.ProcessEnv);

        expect(cfg.apiToken).toBe('tok');
        expect(cfg.webhookSecret).toBe('whsec');
        expect(cfg.devBoxBaseUrl).toBe('https://dev.example');
    });

    it('resolves appSecret lazily and throws only on use when missing', () => {
        const cfg = loadConfig({} as NodeJS.ProcessEnv); // must NOT throw here
        expect(() => cfg.appSecret()).toThrow(); // throws only on use
    });

    it('memoizes appSecret across calls', () => {
        const cfg = loadConfig({ FLASHMANDU_APP_SECRET: 'appsec' } as NodeJS.ProcessEnv);
        expect(cfg.appSecret()).toBe('appsec');
        expect(cfg.appSecret()).toBe('appsec');
    });

    it('defaults missing fields to empty strings rather than throwing', () => {
        const cfg = loadConfig({} as NodeJS.ProcessEnv);
        expect(cfg.apiToken).toBe('');
        expect(cfg.webhookSecret).toBe('');
        expect(cfg.devBoxBaseUrl).toBe('');
    });
});
