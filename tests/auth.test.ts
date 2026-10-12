import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPredictionApi, AuthorizationError } from '../src/api.ts'
import { RecoverableAuthenticationError } from '../src/auth.ts'
import { parseConfig, type PredictionConfig } from '../src/config.ts'
import { runBot, runCycle } from '../src/runner.ts'

const firstSlug = 'btc-updown-5m-1791787800'
const market = { id: 'market-id', clobTokenIds: '["12345678901234567890","98765432109876543210"]' }
const emptyClaims = { items: [], pageInfo: { hasNextPage: false } }
const env = {
    PREDICTION_BASE_URL: 'https://example.invalid/api', PREDICTION_AUTHORIZATION: 'old-token',
    PREDICTION_EMAIL: 'user@example.com', PREDICTION_PASSWORD: ' secret-password ',
    PREDICTION_WALLET_ID: 'wallet-id', PREDICTION_AMOUNT: '10', PREDICTION_STOP_PRICE: '0.1',
    PREDICTION_SLUG: 'btc-updown-5m-1791787500',
}
const config = (overrides: Partial<PredictionConfig> = {}) => ({ ...parseConfig([], env)!, ...overrides })

function mockApi(responses: Array<{ body: unknown; status?: number }>, options = config()) {
    const controller = new AbortController()
    const calls: Array<{ url: URL; init: RequestInit }> = []
    const log = vi.fn()
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        calls.push({ url: new URL(String(input)), init: init! })
        const next = responses.shift()
        if (!next) throw new Error('Unexpected request')
        return new Response(JSON.stringify(next.body), { status: next.status ?? 200 })
    })
    const api = createPredictionApi(options, controller.signal, fetcher, log)
    return { api, options, calls, controller, log, fetcher }
}

afterEach(() => vi.restoreAllMocks())

describe('login configuration', () => {
    it('permits login without an initial token and preserves password whitespace', () => {
        expect(parseConfig([], { ...env, PREDICTION_AUTHORIZATION: '' })).toMatchObject({
            authorization: '', email: 'user@example.com', password: ' secret-password ',
        })
    })

    it('lets CLI credentials override environment credentials', () => {
        expect(parseConfig(['--email', 'other@example.com', '--password', 'another-password'], env)).toMatchObject({
            email: 'other@example.com', password: 'another-password',
        })
    })

    it.each([
        { PREDICTION_EMAIL: '', PREDICTION_PASSWORD: 'pwd' },
        { PREDICTION_EMAIL: 'user@example.com', PREDICTION_PASSWORD: '' },
        { PREDICTION_EMAIL: 'invalid-email', PREDICTION_PASSWORD: 'pwd' },
        { PREDICTION_AUTHORIZATION: '', PREDICTION_EMAIL: '', PREDICTION_PASSWORD: '' },
    ])('rejects incomplete or invalid authentication configuration', overrides => {
        expect(() => parseConfig([], { ...env, ...overrides })).toThrow()
    })
})

describe('automatic login after 401', () => {
    it('logs in, retries the same GET, then uses the new token on later requests', async () => {
        const { api, options, calls, log } = mockApi([
            { body: {}, status: 401 }, { body: { accessToken: 'new-token' } }, { body: market }, { body: emptyClaims },
        ])
        await expect(api.getMarket(firstSlug)).resolves.toMatchObject({ id: 'market-id' })
        await api.getClaimableMarketIds()
        expect(calls.map(({ url }) => url.pathname)).toEqual([
            '/api/prediction/getMarketDetail', '/api/auth/login', '/api/prediction/getMarketDetail', '/api/prediction/getClaimableMarkets',
        ])
        expect(calls[2].url.href).toBe(calls[0].url.href)
        expect(new Headers(calls[0].init.headers).get('Authorization')).toBe('Bearer old-token')
        expect(new Headers(calls[2].init.headers).get('Authorization')).toBe('Bearer new-token')
        expect(new Headers(calls[3].init.headers).get('Authorization')).toBe('Bearer new-token')
        expect(new Headers(calls[1].init.headers).get('Authorization')).toBeNull()
        expect(new Headers(calls[1].init.headers).get('X-Platform')).toBe('mobile')
        expect(JSON.parse(calls[1].init.body as string)).toEqual({ email: env.PREDICTION_EMAIL, password: env.PREDICTION_PASSWORD, code: '', faCode: '' })
        expect(options.authorization).toBe('Bearer new-token')
        expect(log.mock.calls.flat().join(' ')).toContain('登录成功')
        expect(log.mock.calls.flat().join(' ')).not.toContain('new-token')
    })

    it.each([{ statusCode: 401 }, { code: 401 }, { statusCode: 200, code: 401 }])('recovers from an HTTP 200 response containing 401', async body => {
        const { api, calls } = mockApi([{ body }, { body: { accessToken: 'new-token' } }, { body: market }])
        await expect(api.getMarket(firstSlug)).resolves.toMatchObject({ id: 'market-id' })
        expect(calls).toHaveLength(3)
    })

    it.each(['split', 'claim'] as const)('replays the rejected %s POST once with identical payload', async method => {
        const { api, calls } = mockApi([{ body: {}, status: 401 }, { body: { accessToken: 'new-token' } }, { body: { success: true } }])
        if (method === 'split') await api.split('market-id')
        else await api.claim(['market-a', 'market-b'])
        expect(calls).toHaveLength(3)
        expect(calls[2].init.body).toBe(calls[0].init.body)
        expect(calls[2].url.href).toBe(calls[0].url.href)
        expect(calls[2].init.method).toBe('POST')
        expect(new Headers(calls[2].init.headers).get('Authorization')).toBe('Bearer new-token')
    })

    it('refreshes on a later claim page without restarting pagination or reordering claims', async () => {
        const { api, calls } = mockApi([
            { body: { items: [{ id: 'market-a' }], pageInfo: { hasNextPage: true } } },
            { body: {}, status: 401 }, { body: { accessToken: 'new-token' } },
            { body: { items: [{ id: 'market-b' }], pageInfo: { hasNextPage: false } } },
        ])
        await expect(api.getClaimableMarketIds()).resolves.toEqual(['market-a', 'market-b'])
        expect(calls[1].url.searchParams.get('page')).toBe('2')
        expect(calls[3].url.href).toBe(calls[1].url.href)
    })

    it('coalesces concurrent 401 responses into one login', async () => {
        const { api, calls } = mockApi([
            { body: {}, status: 401 }, { body: {}, status: 401 }, { body: { accessToken: 'new-token' } },
            { body: market }, { body: market },
        ])
        await Promise.all([api.getMarket(firstSlug), api.getMarket('btc-updown-5m-1791788100')])
        expect(calls.filter(({ url }) => url.pathname.endsWith('/auth/login'))).toHaveLength(1)
        expect(calls).toHaveLength(5)
    })

    it('logs in before the first business request when no initial token is supplied', async () => {
        const { api, calls } = mockApi([{ body: { accessToken: 'new-token' } }, { body: market }], config({ authorization: '' }))
        await api.getMarket(firstSlug)
        expect(calls.map(({ url }) => url.pathname)).toEqual(['/api/auth/login', '/api/prediction/getMarketDetail'])
    })

    it('limits retries if the replacement token is still rejected and cools down later calls', async () => {
        const { api, calls } = mockApi([{ body: {}, status: 401 }, { body: { accessToken: 'new-token' } }, { body: {}, status: 401 }])
        await expect(api.getMarket(firstSlug)).rejects.toBeInstanceOf(RecoverableAuthenticationError)
        await expect(api.getClaimableMarketIds()).rejects.toBeInstanceOf(RecoverableAuthenticationError)
        expect(calls).toHaveLength(3)
    })

    it('keeps the scheduled bot alive after login failure and recovers on the next round', async () => {
        let now = Date.parse('2026-10-12T16:19:00+08:00')
        vi.spyOn(Date, 'now').mockImplementation(() => now)
        const { api, options, calls, controller, log } = mockApi([
            { body: {}, status: 401 }, { body: {}, status: 401 },
            { body: { accessToken: 'new-token' } }, { body: market }, { body: { success: true } }, { body: emptyClaims },
        ])
        let waits = 0
        const wait = async (ms: number) => { now += ms; if (++waits === 3) controller.abort() }
        await expect(runBot(options, api, controller.signal, log, { now: () => now, wait })).rejects.toThrow()
        const lookups = calls.filter(({ url }) => url.pathname.endsWith('getMarketDetail'))
        expect(lookups.map(({ url }) => url.searchParams.get('slug'))).toEqual([
            `btc-updown-5m-${Date.parse('2026-10-12T16:20:00+08:00') / 1000}`,
            `btc-updown-5m-${Date.parse('2026-10-12T16:25:00+08:00') / 1000}`,
        ])
        expect(calls.filter(({ url }) => url.pathname.endsWith('/auth/login'))).toHaveLength(2)
        expect(calls.filter(({ url }) => url.pathname.endsWith('createSplitOrders'))).toHaveLength(1)
        expect(log.mock.calls.flat().join(' ')).toContain('定时任务继续')
    })

    it.each([{ user: {} }, { accessToken: '' }, { requiresVerifyList: ['faCode'] }])('treats incomplete login responses as recoverable failures', async body => {
        const { api, calls } = mockApi([{ body: {}, status: 401 }, { body }])
        await expect(api.getMarket(firstSlug)).rejects.toBeInstanceOf(RecoverableAuthenticationError)
        expect(calls).toHaveLength(2)
    })

    it('redacts passwords, emails, and both old and new tokens from reflected errors', async () => {
        const { api, options, controller, log } = mockApi([
            { body: {}, status: 401 }, { body: { accessToken: 'new-token' } }, { body: market },
            { body: { success: false, message: `old-token new-token ${env.PREDICTION_EMAIL} ${env.PREDICTION_PASSWORD}` } },
            { body: emptyClaims },
        ])
        expect(await runCycle(options, firstSlug, api, controller.signal, log)).toBe(false)
        const messages = log.mock.calls.flat().join(' ')
        for (const secret of ['old-token', 'new-token', env.PREDICTION_EMAIL, env.PREDICTION_PASSWORD]) expect(messages).not.toContain(secret)
    })

    it('does not retry unknown order failures or log in for non-401 errors', async () => {
        const { api, calls } = mockApi([{ body: {}, status: 500 }])
        await expect(api.split('market-id')).rejects.toThrow('HTTP 500')
        expect(calls).toHaveLength(1)
    })

    it('continues to treat 403 as a fatal permissions error', async () => {
        const { api, options, controller, calls } = mockApi([{ body: {}, status: 403 }])
        await expect(runCycle(options, firstSlug, api, controller.signal, vi.fn())).rejects.toBeInstanceOf(AuthorizationError)
        expect(calls).toHaveLength(1)
    })

    it('does not replay the business request when a stop signal arrives during login', async () => {
        const { api, fetcher, controller, calls } = mockApi([{ body: {}, status: 401 }])
        fetcher.mockImplementationOnce(async (input, init) => {
            calls.push({ url: new URL(String(input)), init: init! })
            return new Response('{}', { status: 401 })
        }).mockImplementationOnce(async (input, init) => {
            calls.push({ url: new URL(String(input)), init: init! })
            controller.abort()
            return new Response('{"accessToken":"new-token"}')
        })
        await expect(api.getMarket(firstSlug)).rejects.toThrow()
        expect(calls).toHaveLength(2)
    })
})
