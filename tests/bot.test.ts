import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthorizationError, createPredictionApi, type PredictionApi } from '../src/api.ts'
import { DEFAULT_PROJECT_ID, parseConfig, type PredictionConfig } from '../src/config.ts'
import { getFirstRunAt, runBot, runCycle } from '../src/runner.ts'

const initialSlug = 'btc-updown-5m-1791787500'
const firstSlug = 'btc-updown-5m-1791787800'
const tokenIds = [
    '88119316468012514485305286210175924374986127320384901900682098192601925841125',
    '50269475391205853964351274532508665558346749663709360111274797310574546970230',
]
const market = { id: 'market-id', clobTokenIds: JSON.stringify(tokenIds) }
const page = (ids: string[], hasNextPage = false) => ({ items: ids.map(id => ({ id })), pageInfo: { hasNextPage } })

function config(overrides: Partial<PredictionConfig> = {}): PredictionConfig {
    return { ...parseConfig([
        '--base-url', 'https://example.invalid/api/', '--authorization', 'test-token',
        '--wallet-id', 'wallet-id', '--amount', '10', '--stop-price', '0.1', '--slug', initialSlug,
    ], {})!, ...overrides }
}

function mockApi(responses: Array<{ body: unknown; status?: number; raw?: string }>, options = config()) {
    const controller = new AbortController()
    const calls: Array<{ url: URL; init: RequestInit }> = []
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        calls.push({ url: new URL(String(input)), init: init! })
        const next = responses.shift()
        if (!next) throw new Error('Unexpected request')
        return new Response(next.raw ?? JSON.stringify(next.body), { status: next.status ?? 200 })
    })
    return { api: createPredictionApi(options, controller.signal, fetcher), calls, controller, fetcher }
}

const stubApi = (): PredictionApi => ({
    getMarket: vi.fn(async () => ({ id: 'market-id', clobTokenIds: tokenIds })),
    split: vi.fn(async () => {}), getClaimableMarketIds: vi.fn(async () => []), claim: vi.fn(async () => {}),
})

afterEach(() => vi.restoreAllMocks())

describe('prediction bot configuration', () => {
    it('uses the next 300-second market and keeps stopPrice as a string', () => {
        expect(config()).toMatchObject({ firstTimestamp: 1791787800, stopPrice: '0.1', amount: 10,
            authorization: 'Bearer test-token', baseUrl: 'https://example.invalid/api', projectId: DEFAULT_PROJECT_ID })
    })

    it('accepts environment parameters and lets CLI override them', () => {
        expect(parseConfig(['--amount', '20'], {
            PREDICTION_BASE_URL: 'https://example.invalid', PREDICTION_AUTHORIZATION: 'bearer env-token',
            PREDICTION_WALLET_ID: 'env-wallet', PREDICTION_AMOUNT: '10', PREDICTION_STOP_PRICE: '0.2',
            PREDICTION_SLUG: initialSlug, PREDICTION_PROJECT_ID: 'env-project',
        })).toMatchObject({ amount: 20, walletId: 'env-wallet', authorization: 'Bearer env-token', projectId: 'env-project' })
        expect(parseConfig(['--help'], {})).toBeNull()
    })

    it.each([
        ['--amount', '0'], ['--amount', '-1'], ['--amount', 'Infinity'], ['--amount', '0x10'],
        ['--stop-price', '0'], ['--stop-price', '1'], ['--stop-price', 'NaN'],
        ['--slug', 'btc-updown-5m-1791787501'], ['--slug', 'btc-updown-5m-900719925474099300'],
        ['--slug', 'btc-updown-5m'], ['--slug', 'btc-updown-5m-abc'], ['--slug', 'eth-updown-5m-'],
        ['--base-url', 'file:///tmp'], ['--base-url', 'https://user:pass@example.invalid'],
        ['--authorization', 'Bearer token\nother-token'],
    ])('rejects invalid %s values', (flag, value) => {
        const env = { PREDICTION_BASE_URL: 'https://example.invalid/api', PREDICTION_AUTHORIZATION: 'test-token',
            PREDICTION_WALLET_ID: 'wallet-id', PREDICTION_AMOUNT: '10', PREDICTION_STOP_PRICE: '0.1', PREDICTION_SLUG: initialSlug }
        expect(() => parseConfig([flag, value], env)).toThrow()
    })
})

describe('automatic market slug', () => {
    const env = {
        PREDICTION_BASE_URL: 'https://example.invalid/api', PREDICTION_AUTHORIZATION: 'test-token',
        PREDICTION_WALLET_ID: 'wallet-id', PREDICTION_AMOUNT: '10', PREDICTION_STOP_PRICE: '0.1',
        PREDICTION_SLUG: 'btc-updown-5m-',
    }

    it.each([
        ['2026-10-13T16:22:00+08:00', '2026-10-13T16:25:00+08:00'],
        ['2026-10-13T16:24:59.999+08:00', '2026-10-13T16:25:00+08:00'],
        ['2026-10-13T16:25:00+08:00', '2026-10-13T16:30:00+08:00'],
        ['2026-10-13T16:59:59.999+08:00', '2026-10-13T17:00:00+08:00'],
        ['2026-10-13T23:59:59.999+08:00', '2026-10-14T00:00:00+08:00'],
    ])('calculates the next interval at %s as %s from a prefix-only environment value', (started, target) => {
        vi.spyOn(Date, 'now').mockReturnValue(Date.parse(started))
        expect(parseConfig([], env)).toMatchObject({ slugPrefix: 'btc-updown-5m-', firstTimestamp: Date.parse(target) / 1000 })
    })

    it('accepts a prefix from CLI and preserves complete-slug overrides', () => {
        vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-13T16:22:00+08:00'))
        expect(parseConfig(['--slug', 'btc-updown-5m-'], { ...env, PREDICTION_SLUG: initialSlug })?.firstTimestamp).toBe(Date.parse('2026-10-13T16:25:00+08:00') / 1000)
        expect(parseConfig(['--slug', initialSlug], env)?.firstTimestamp).toBe(1791787800)
    })

    it('buys immediately from a prefix and advances to the next market at each interval boundary', async () => {
        let now = Date.parse('2026-10-13T16:22:00+08:00')
        vi.spyOn(Date, 'now').mockImplementation(() => now)
        const options = parseConfig([], env)!
        const api = stubApi()
        const controller = new AbortController()
        const orderTimes: number[] = []
        api.split = vi.fn(async () => { orderTimes.push(now) })
        let waits = 0
        const wait = vi.fn(async (ms: number) => { now += ms; if (++waits === 2) controller.abort() })
        await expect(runBot(options, api, controller.signal, vi.fn(), { now: () => now, wait })).rejects.toThrow()
        expect(orderTimes).toEqual([Date.parse('2026-10-13T16:22:00+08:00'), Date.parse('2026-10-13T16:25:00+08:00')])
        expect(vi.mocked(api.getMarket).mock.calls.map(([slug]) => slug)).toEqual([
            `btc-updown-5m-${Date.parse('2026-10-13T16:25:00+08:00') / 1000}`,
            `btc-updown-5m-${Date.parse('2026-10-13T16:30:00+08:00') / 1000}`,
        ])
        expect(wait.mock.calls.map(([ms]) => ms)).toEqual([180_000, 300_000])
    })

    it('recalculates the target at execution if startup crosses an interval boundary', async () => {
        const parsedAt = Date.parse('2026-10-13T16:24:59.999+08:00')
        vi.spyOn(Date, 'now').mockReturnValue(parsedAt)
        const options = parseConfig(['--once'], env)!
        const api = stubApi()
        const startedAt = Date.parse('2026-10-13T16:25:00+08:00')
        const wait = vi.fn(async () => { throw new Error('Startup should not wait') })
        await runBot(options, api, new AbortController().signal, vi.fn(), { now: () => startedAt, wait })
        expect(wait).not.toHaveBeenCalled()
        expect(api.getMarket).toHaveBeenCalledExactlyOnceWith(`btc-updown-5m-${Date.parse('2026-10-13T16:30:00+08:00') / 1000}`)
        expect(api.split).toHaveBeenCalledOnce()
    })
})

describe('prediction API workflow', () => {
    it('preserves token precision, reads every claim page before submitting, and uses the correct IDs', async () => {
        const { api, calls, controller } = mockApi([
            { body: market }, { body: { success: true } },
            { body: page(['claim-a', 'claim-b'], true) }, { body: page(['claim-b', 'claim-c']) },
            { body: { success: true } },
        ])
        const log = vi.fn()
        const lookup = vi.spyOn(api, 'getMarket')
        expect(await runCycle(config(), firstSlug, api, controller.signal, log)).toBe(true)
        expect(calls.map(({ url, init }) => [init.method, url.pathname])).toEqual([
            ['GET', '/api/prediction/getMarketDetail'], ['POST', '/api/prediction/createSplitOrders'],
            ['GET', '/api/prediction/getClaimableMarkets'], ['GET', '/api/prediction/getClaimableMarkets'],
            ['POST', '/api/prediction/createWalletClaimOrders'],
        ])
        expect(calls[0].url.searchParams.get('slug')).toBe(firstSlug)
        expect(calls.every(({ init }) => new Headers(init.headers).get('Authorization') === 'Bearer test-token')).toBe(true)
        expect(JSON.parse(calls[1].init.body as string)).toEqual({ marketId: 'market-id', walletIds: ['wallet-id'], amount: 10, createStopOrder: true, stopPrice: '0.1' })
        expect(Object.fromEntries(calls[2].url.searchParams)).toEqual({ projectId: DEFAULT_PROJECT_ID, page: '1', limit: '200' })
        expect(calls[3].url.searchParams.get('page')).toBe('2')
        expect(JSON.parse(calls[4].init.body as string)).toEqual({ marketIds: ['claim-a', 'claim-b', 'claim-c'], walletId: 'wallet-id' })
        await expect(lookup.mock.results[0].value).resolves.toEqual({ id: 'market-id', clobTokenIds: tokenIds })
    })

    it('does not submit a claim when there are no claimable markets', async () => {
        const { api, calls, controller } = mockApi([{ body: market }, { body: { success: true } }, { body: page([]) }])
        expect(await runCycle(config(), firstSlug, api, controller.signal, vi.fn())).toBe(true)
        expect(calls).toHaveLength(3)
    })

    it('dry-run only sends GET requests and prints both planned payloads', async () => {
        const options = config({ dryRun: true })
        const { api, calls, controller } = mockApi([{ body: market }, { body: page(['claim-a']) }], options)
        const log = vi.fn()
        expect(await runCycle(options, firstSlug, api, controller.signal, log)).toBe(true)
        expect(calls.every(({ init }) => init.method === 'GET')).toBe(true)
        expect(log.mock.calls.flat().join(' ')).toContain('createSplitOrders')
        expect(log.mock.calls.flat().join(' ')).toContain('createWalletClaimOrders')
    })

    it('reports success=false, redacts echoed credentials, does not retry, and still checks claims', async () => {
        const { api, calls, controller } = mockApi([
            { body: market }, { body: { success: false, message: 'invalid test-token Bearer reflected-token' } }, { body: page([]) },
        ])
        const log = vi.fn()
        expect(await runCycle(config(), firstSlug, api, controller.signal, log)).toBe(false)
        expect(calls.filter(({ init }) => init.method === 'POST')).toHaveLength(1)
        const logs = log.mock.calls.flat().join(' ')
        expect(logs).toContain(`拆分订单创建失败：当前 slug=${firstSlug}，第 1 次下单`)
        expect(log).toHaveBeenCalledWith('累计统计：累计下单 0 笔，累计领取 0 个市场，累计下单失败 1 笔')
        expect(logs).not.toContain('拆分订单创建成功')
        expect(logs).not.toContain('test-token')
        expect(logs).not.toContain('reflected-token')
    })

    it.each([{ success: false }, {}])('rejects unsuccessful or ambiguous claim responses', async body => {
        const { api } = mockApi([{ body }])
        await expect(api.claim(['claim-a'])).rejects.toThrow()
    })

    it.each([{ body: {}, status: 401 }, { body: { statusCode: 403 } }, { body: { code: 401 } }])('stops all later operations on authentication failure', async response => {
        const { api, calls, controller } = mockApi([response])
        await expect(runCycle(config(), firstSlug, api, controller.signal, vi.fn())).rejects.toBeInstanceOf(AuthorizationError)
        expect(calls).toHaveLength(1)
    })

    it('does not retry a POST after an uncertain network failure', async () => {
        const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('socket closed'))
        const api = createPredictionApi(config(), new AbortController().signal, fetcher)
        await expect(api.split('market-id')).rejects.toThrow('订单结果可能未知')
        expect(fetcher).toHaveBeenCalledTimes(1)
    })

    it('rejects lossy numeric token IDs before creating an order', async () => {
        const { api, calls, controller } = mockApi([{ body: { ...market, clobTokenIds: [123, 456] } }, { body: page([]) }])
        expect(await runCycle(config(), firstSlug, api, controller.signal, vi.fn())).toBe(false)
        expect(calls.every(({ init }) => init.method === 'GET')).toBe(true)
    })

    it('does not submit partial claims when a later page is invalid', async () => {
        const { api, calls, controller } = mockApi([{ body: market }, { body: { success: true } }, { body: page(['claim-a'], true) }, { body: {} }])
        expect(await runCycle(config(), firstSlug, api, controller.signal, vi.fn())).toBe(false)
        expect(calls.some(({ url }) => url.pathname.endsWith('createWalletClaimOrders'))).toBe(false)
    })

    it('does not create an order after receiving a stop signal during market lookup', async () => {
        const controller = new AbortController()
        const api = stubApi()
        api.getMarket = vi.fn(async () => { controller.abort(); return { id: 'market-id', clobTokenIds: tokenIds } })
        await expect(runCycle(config(), firstSlug, api, controller.signal, vi.fn())).rejects.toThrow()
        expect(api.split).not.toHaveBeenCalled()
        expect(api.getClaimableMarketIds).not.toHaveBeenCalled()
    })
})

const at = (time: string) => Date.parse(`2026-10-12T${time}+08:00`)
const slugAt = (time: string) => `btc-updown-5m-${at(time) / 1000}`

describe('prediction schedule', () => {
    it.each([
        ['16:19:00', '16:20:00'],
        ['16:22:00', '16:25:00'],
        ['16:24:00', '16:25:00'],
        ['16:24:59.999', '16:25:00'],
        ['16:25:00', '16:30:00'],
        ['16:25:59', '16:30:00'],
        ['16:20:00', '16:25:00'],
        ['16:21:00', '16:25:00'],
        ['16:21:01', '16:25:00'],
        ['16:59:30', '17:00:00'],
        ['23:59:59.999', '00:00:00'],
    ])('starts at %s and immediately buys the next %s market', async (started, marketTime) => {
        const api = stubApi()
        const controller = new AbortController()
        const now = at(started)
        const log = vi.fn()
        const wait = vi.fn(async () => { throw new Error('Startup should not wait') })
        api.split = vi.fn(async () => { expect(now).toBe(at(started)) })
        await runBot(config({ once: true }), api, controller.signal, log, { now: () => now, wait })
        const targetSlug = marketTime === '00:00:00' ? `btc-updown-5m-${Date.parse('2026-10-13T00:00:00+08:00') / 1000}` : slugAt(marketTime)
        expect(wait).not.toHaveBeenCalled()
        expect(api.getMarket).toHaveBeenCalledExactlyOnceWith(targetSlug)
        expect(api.split).toHaveBeenCalledExactlyOnceWith('market-id')
        expect(log.mock.calls.flat().join(' ')).toContain(`当前 slug=${targetSlug}`)
    })

    it('waits until the interval preceding a future configured target market', async () => {
        const api = stubApi()
        const controller = new AbortController()
        let now = at('16:19:00')
        expect(getFirstRunAt(now, at('16:30:00') / 1000)).toBe(at('16:25:00'))
        const wait = vi.fn(async (ms: number) => {
            expect(api.split).not.toHaveBeenCalled()
            now += ms
        })
        api.split = vi.fn(async () => { expect(now).toBe(at('16:25:00')) })
        await runBot(config({ once: true, firstTimestamp: at('16:30:00') / 1000 }), api, controller.signal, vi.fn(), { now: () => now, wait })
        expect(wait).toHaveBeenCalledExactlyOnceWith(360_000, controller.signal)
        expect(api.getMarket).toHaveBeenCalledExactlyOnceWith(slugAt('16:30:00'))
    })

    it('orders immediately, then aligns subsequent rounds to interval boundaries despite request duration', async () => {
        const api = stubApi()
        const controller = new AbortController()
        let now = at('16:19:00')
        let waits = 0
        const orderTimes: number[] = []
        api.split = vi.fn(async () => { orderTimes.push(now); now += 25_000 })
        const wait = vi.fn(async (ms: number) => { now += ms; if (++waits === 2) controller.abort() })
        await expect(runBot(config(), api, controller.signal, vi.fn(), { now: () => now, wait })).rejects.toThrow()
        expect(vi.mocked(api.getMarket).mock.calls.map(([slug]) => slug)).toEqual([slugAt('16:20:00'), slugAt('16:25:00')])
        expect(orderTimes).toEqual([at('16:19:00'), at('16:20:00')])
        expect(wait.mock.calls.map(([ms]) => ms)).toEqual([35_000, 275_000])
    })

    it('buys the next interval once when starting exactly at an interval boundary', async () => {
        const api = stubApi()
        const controller = new AbortController()
        let now = at('16:25:00')
        let waits = 0
        const orderTimes: number[] = []
        api.split = vi.fn(async () => { orderTimes.push(now) })
        const wait = vi.fn(async (ms: number) => { now += ms; if (++waits === 2) controller.abort() })
        await expect(runBot(config(), api, controller.signal, vi.fn(), { now: () => now, wait })).rejects.toThrow()
        expect(orderTimes).toEqual([at('16:25:00'), at('16:30:00')])
        expect(vi.mocked(api.getMarket).mock.calls.map(([slug]) => slug)).toEqual([slugAt('16:30:00'), slugAt('16:35:00')])
        expect(wait.mock.calls.map(([ms]) => ms)).toEqual([300_000, 300_000])
    })

    it('skips missed execution times instead of submitting overlapping catch-up orders', async () => {
        const api = stubApi()
        const controller = new AbortController()
        let now = at('16:19:00')
        let waits = 0
        api.split = vi.fn(async () => { now += 650_000 })
        const wait = vi.fn(async (ms: number) => { now += ms; if (++waits === 2) controller.abort() })
        const log = vi.fn()
        await expect(runBot(config(), api, controller.signal, log, { now: () => now, wait })).rejects.toThrow()
        expect(vi.mocked(api.getMarket).mock.calls.map(([slug]) => slug)).toEqual([slugAt('16:20:00'), slugAt('16:35:00')])
        expect(log.mock.calls.flat().join(' ')).toContain('跳过 2 个')
    })

    it('once executes immediately and exits with an error if the round fails', async () => {
        const api = stubApi()
        let now = at('16:19:00')
        api.split = vi.fn(async () => { throw new Error('split failed') })
        const wait = vi.fn(async (ms: number) => { now += ms })
        await expect(runBot(config({ once: true }), api, new AbortController().signal, vi.fn(), { now: () => now, wait })).rejects.toThrow('本轮存在失败')
        expect(api.split).toHaveBeenCalledTimes(1)
        expect(api.getClaimableMarketIds).toHaveBeenCalledOnce()
        expect(wait).not.toHaveBeenCalled()
    })

    it('selects the next market after a late timer wake-up and skips older markets', async () => {
        const api = stubApi()
        const controller = new AbortController()
        let now = at('16:19:00')
        let waits = 0
        const wait = vi.fn(async () => {
            now = at('16:31:10')
            if (++waits === 2) controller.abort()
        })
        const log = vi.fn()
        await expect(runBot(config(), api, controller.signal, log, { now: () => now, wait })).rejects.toThrow()
        expect(vi.mocked(api.getMarket).mock.calls.map(([slug]) => slug)).toEqual([slugAt('16:20:00'), slugAt('16:35:00')])
        expect(log.mock.calls.flat().join(' ')).toContain('跳过 2 个')
    })

    it('can stop while waiting without creating an order', async () => {
        const api = stubApi()
        const controller = new AbortController()
        const wait = vi.fn(async () => { controller.abort() })
        await expect(runBot(config({ firstTimestamp: at('16:30:00') / 1000 }), api, controller.signal, vi.fn(), { now: () => at('16:19:00'), wait })).rejects.toThrow()
        expect(api.getMarket).not.toHaveBeenCalled()
        expect(api.split).not.toHaveBeenCalled()
    })

    it('does not order early if the system clock moves backward while waiting', async () => {
        const api = stubApi()
        const controller = new AbortController()
        let now = at('16:19:00')
        let waits = 0
        const wait = vi.fn(async (_ms: number) => { now = at(++waits === 1 ? '16:19:30' : '16:20:00') })
        await runBot(config({ once: true, firstTimestamp: at('16:25:00') / 1000 }), api, controller.signal, vi.fn(), { now: () => now, wait })
        expect(wait.mock.calls.map(([ms]) => ms)).toEqual([60_000, 30_000])
        expect(api.split).toHaveBeenCalledOnce()
    })

    it('skips a split if market lookup finishes after the target market starts and still checks claims', async () => {
        const api = stubApi()
        let now = at('16:24:59')
        const log = vi.fn()
        api.getMarket = vi.fn(async () => { now = at('16:25:00'); return { id: 'market-id', clobTokenIds: tokenIds } })
        await expect(runBot(config({ once: true }), api, new AbortController().signal, log, { now: () => now, wait: vi.fn() })).rejects.toThrow('本轮存在失败')
        expect(api.getMarket).toHaveBeenCalledExactlyOnceWith(slugAt('16:25:00'))
        expect(api.split).not.toHaveBeenCalled()
        expect(api.getClaimableMarketIds).toHaveBeenCalledOnce()
        expect(log.mock.calls.flat().join(' ')).toContain('目标市场已开始')
    })

    it('prints the current slug before sending the split order', async () => {
        const api = stubApi()
        const log = vi.fn()
        api.split = vi.fn(async () => {
            expect(log).toHaveBeenLastCalledWith(expect.stringContaining(`正在下单：当前 slug=${firstSlug}`))
        })
        await runCycle(config(), firstSlug, api, new AbortController().signal, log)
        expect(log).toHaveBeenCalledWith(`拆分订单创建成功：当前 slug=${firstSlug}，第 1 次下单，累计下单 1 笔`)
    })
})

describe('prediction running statistics', () => {
    const statistics = () => ({ orderAttempts: 0, successfulOrders: 0, failedOrderRequests: 0, claimedMarketIds: new Set<string>() })

    it.each([
        { body: { success: false, message: 'split rejected' } },
        { body: {}, status: 500 },
        { body: {} },
    ])('logs a failed split, still claims history, and succeeds on the next scheduled market: %j', async failedResponse => {
        const { api, calls, controller } = mockApi([
            { body: market }, failedResponse, { body: page(['claim-a']) }, { body: { success: true } },
            { body: market }, { body: { success: true } }, { body: page([]) },
        ])
        const log = vi.fn()
        let now = at('16:19:00')
        let waits = 0
        const wait = async (ms: number) => { now += ms; if (++waits === 2) controller.abort() }
        await expect(runBot(config(), api, controller.signal, log, { now: () => now, wait })).rejects.toThrow()
        const logs = log.mock.calls.map(([message]) => message as string)
        expect(logs.filter(message => message.startsWith('拆分订单创建失败：'))).toHaveLength(1)
        expect(log).toHaveBeenCalledWith(expect.stringContaining(`拆分订单创建失败：当前 slug=${slugAt('16:20:00')}，第 1 次下单`), 'error')
        expect(logs).toContain('累计统计：累计下单 0 笔，累计领取 0 个市场，累计下单失败 1 笔')
        expect(logs).toContain('领取订单创建成功：1 个市场')
        expect(logs).toContain('累计统计：累计下单 0 笔，累计领取 1 个市场，累计下单失败 1 笔')
        expect(logs.filter(message => message.startsWith('拆分订单创建成功：'))).toEqual([
            `拆分订单创建成功：当前 slug=${slugAt('16:25:00')}，第 2 次下单，累计下单 1 笔`,
        ])
        expect(calls.filter(({ url }) => url.pathname.endsWith('getMarketDetail')).map(({ url }) => url.searchParams.get('slug'))).toEqual([slugAt('16:20:00'), slugAt('16:25:00')])
        expect(calls.filter(({ url }) => url.pathname.endsWith('createSplitOrders'))).toHaveLength(2)
    })

    it('counts an interrupted split request once without retrying or claiming it succeeded', async () => {
        const { api, fetcher, controller } = mockApi([{ body: market }, { body: page([]) }])
        const originalFetch = fetcher.getMockImplementation()!
        let splits = 0
        fetcher.mockImplementation(async (input, init) => {
            if (new URL(String(input)).pathname.endsWith('createSplitOrders')) {
                splits++
                throw new Error('fetch failed', { cause: new Error('ECONNRESET socket closed test-token') })
            }
            return originalFetch(input, init)
        })
        const totals = statistics()
        const log = vi.fn()
        expect(await runCycle(config(), firstSlug, api, controller.signal, log, totals)).toBe(false)
        expect(totals).toMatchObject({ orderAttempts: 1, successfulOrders: 0, failedOrderRequests: 1 })
        expect(splits).toBe(1)
        expect(log.mock.calls.flat().join(' ')).toContain('订单结果可能未知')
        expect(log.mock.calls.flat().join(' ')).toContain('ECONNRESET socket closed')
        expect(log.mock.calls.flat().join(' ')).not.toContain('test-token')
        expect(log).toHaveBeenCalledWith('累计统计：累计下单 0 笔，累计领取 0 个市场，累计下单失败 1 笔')
        expect(log.mock.calls.some(([message]) => String(message).startsWith('拆分订单创建成功：'))).toBe(false)
    })

    it('logs and counts a fatal split authorization error before stopping', async () => {
        const { api, calls, controller } = mockApi([{ body: market }, { body: {}, status: 403 }])
        const totals = statistics()
        const log = vi.fn()
        await expect(runCycle(config(), firstSlug, api, controller.signal, log, totals)).rejects.toBeInstanceOf(AuthorizationError)
        expect(totals.failedOrderRequests).toBe(1)
        expect(log.mock.calls.flat().join(' ')).toContain(`拆分订单创建失败：当前 slug=${firstSlug}，第 1 次下单`)
        expect(log).toHaveBeenLastCalledWith('累计统计：累计下单 0 笔，累计领取 0 个市场，累计下单失败 1 笔')
        expect(calls).toHaveLength(2)
    })

    it('does not count a user stop signal as a failed order', async () => {
        const api = stubApi()
        const controller = new AbortController()
        const totals = statistics()
        const log = vi.fn()
        api.split = vi.fn(async () => { controller.abort(); throw new Error('stopped') })
        await expect(runCycle(config(), firstSlug, api, controller.signal, log, totals)).rejects.toThrow('stopped')
        expect(totals.failedOrderRequests).toBe(0)
        expect(log.mock.calls.some(([message]) => String(message).startsWith('拆分订单创建失败：'))).toBe(false)
        expect(api.getClaimableMarketIds).not.toHaveBeenCalled()
    })

    it('keeps counters across scheduled rounds, excludes failed orders, and deduplicates claimed markets', async () => {
        const api = stubApi()
        const controller = new AbortController()
        const log = vi.fn()
        let now = at('16:19:00')
        let waits = 0
        api.split = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('split failed')).mockResolvedValueOnce(undefined)
        api.getClaimableMarketIds = vi.fn().mockResolvedValueOnce(['claim-a']).mockResolvedValueOnce(['claim-a', 'claim-b']).mockResolvedValueOnce(['claim-c'])
        const wait = async (ms: number) => { now += ms; if (++waits === 3) controller.abort() }
        await expect(runBot(config(), api, controller.signal, log, { now: () => now, wait })).rejects.toThrow()
        const logs = log.mock.calls.map(([message]) => message as string)
        expect(logs.filter(message => message.startsWith('正在下单：')).map(message => message.match(/第 \d+ 次下单/)?.[0])).toEqual(['第 1 次下单', '第 2 次下单', '第 3 次下单'])
        expect(logs.filter(message => message.startsWith('累计统计：'))).toEqual([
            '累计统计：累计下单 1 笔，累计领取 1 个市场，累计下单失败 0 笔',
            '累计统计：累计下单 1 笔，累计领取 1 个市场，累计下单失败 1 笔',
            '累计统计：累计下单 1 笔，累计领取 2 个市场，累计下单失败 1 笔',
            '累计统计：累计下单 2 笔，累计领取 3 个市场，累计下单失败 1 笔',
        ])
        for (const [index, message] of logs.entries()) {
            if (message.startsWith('领取订单创建成功：')) expect(logs[index + 1]).toMatch(/^累计统计：/)
        }
        expect(logs).toContain(`拆分订单创建成功：当前 slug=${slugAt('16:30:00')}，第 3 次下单，累计下单 2 笔`)
    })

    it('does not count a failed claim and retains successful orders for later rounds', async () => {
        const api = stubApi()
        const totals = statistics()
        const log = vi.fn()
        api.getClaimableMarketIds = vi.fn(async () => ['claim-a', 'claim-b'])
        api.claim = vi.fn().mockRejectedValueOnce(new Error('claim failed')).mockResolvedValueOnce(undefined)
        expect(await runCycle(config(), firstSlug, api, new AbortController().signal, log, totals)).toBe(false)
        expect(totals.successfulOrders).toBe(1)
        expect(totals.claimedMarketIds.size).toBe(0)
        expect(log.mock.calls.some(([message]) => String(message).startsWith('累计统计：'))).toBe(false)
        expect(await runCycle(config(), 'btc-updown-5m-1791788100', api, new AbortController().signal, log, totals)).toBe(true)
        expect(log).toHaveBeenLastCalledWith('累计统计：累计下单 2 笔，累计领取 2 个市场，累计下单失败 0 笔')
    })

    it('does not assign an order number when market lookup fails, while still counting successful claims', async () => {
        const api = stubApi()
        const totals = statistics()
        const log = vi.fn()
        api.getMarket = vi.fn(async () => { throw new Error('market lookup failed') })
        api.getClaimableMarketIds = vi.fn(async () => ['claim-a'])
        expect(await runCycle(config(), firstSlug, api, new AbortController().signal, log, totals)).toBe(false)
        expect(totals.orderAttempts).toBe(0)
        expect(totals.failedOrderRequests).toBe(0)
        expect(api.split).not.toHaveBeenCalled()
        expect(log).toHaveBeenLastCalledWith('累计统计：累计下单 0 笔，累计领取 1 个市场，累计下单失败 0 笔')
    })

    it('leaves counters unchanged in dry-run mode', async () => {
        const api = stubApi()
        const totals = statistics()
        api.getClaimableMarketIds = vi.fn(async () => ['claim-a'])
        expect(await runCycle(config({ dryRun: true }), firstSlug, api, new AbortController().signal, vi.fn(), totals)).toBe(true)
        expect(totals).toEqual(statistics())
        expect(api.split).not.toHaveBeenCalled()
        expect(api.claim).not.toHaveBeenCalled()
    })

    it('counts a successful split once when a 401 response triggers login and request replay', async () => {
        const options = config({ email: 'account@example.invalid', password: 'test-password' })
        const { api, calls, controller } = mockApi([
            { body: market }, { body: {}, status: 401 }, { body: { accessToken: 'new-token' } },
            { body: { success: true } }, { body: page(['claim-a']) }, { body: { success: true } },
        ], options)
        const totals = statistics()
        const log = vi.fn()
        expect(await runCycle(options, firstSlug, api, controller.signal, log, totals)).toBe(true)
        expect(calls.filter(({ url }) => url.pathname.endsWith('createSplitOrders'))).toHaveLength(2)
        expect(totals.orderAttempts).toBe(1)
        expect(totals.successfulOrders).toBe(1)
        expect(totals.failedOrderRequests).toBe(0)
        expect(log).toHaveBeenLastCalledWith('累计统计：累计下单 1 笔，累计领取 1 个市场，累计下单失败 0 笔')
    })
})

describe('failure diagnostics', () => {
    it.each([
        { body: { success: false, error: { message: 'insufficient balance', available: 1 }, accessToken: 'hidden-response-token' }, status: 200, expected: 'insufficient balance' },
        { body: { message: 'wallet rejected', code: 'WALLET_ERROR', password: 'hidden-response-password' }, status: 400, expected: 'wallet rejected' },
        { body: null, raw: '<html>upstream unavailable</html>', status: 502, expected: 'upstream unavailable' },
        { body: null, raw: 'broken JSON response', status: 200, expected: 'broken JSON response' },
        { body: { message: 'missing success flag', details: 'split was not accepted' }, status: 200, expected: 'split was not accepted' },
    ])('prints the failure prompt and server response for %j', async response => {
        const { api, calls, controller } = mockApi([{ body: market }, response, { body: page([]) }])
        const log = vi.fn()
        expect(await runCycle(config(), firstSlug, api, controller.signal, log)).toBe(false)
        expect(log).toHaveBeenCalledWith(expect.stringContaining(`拆分订单创建失败：当前 slug=${firstSlug}，第 1 次下单`), 'error')
        expect(log).toHaveBeenCalledWith(expect.stringContaining('报错日志：\nRequestError:'), 'error')
        const messages = log.mock.calls.map(([message]) => String(message)).join('\n')
        expect(messages).toContain('接口：POST /api/prediction/createSplitOrders')
        expect(messages).toContain(`HTTP 状态：${response.status}`)
        expect(messages).toContain(response.expected)
        expect(messages).not.toContain('hidden-response-token')
        expect(messages).not.toContain('hidden-response-password')
        expect(calls.filter(({ url }) => url.pathname.endsWith('createSplitOrders'))).toHaveLength(1)
        expect(log).toHaveBeenCalledWith('累计统计：累计下单 0 笔，累计领取 0 个市场，累计下单失败 1 笔')
    })

    it('marks an oversized error response as truncated while keeping the failure reason', async () => {
        const { api, controller } = mockApi([
            { body: market }, { body: { success: false, message: 'server failure', details: 'x'.repeat(11_000) } }, { body: page([]) },
        ])
        const log = vi.fn()
        expect(await runCycle(config(), firstSlug, api, controller.signal, log)).toBe(false)
        const messages = log.mock.calls.map(([message]) => String(message)).join('\n')
        expect(messages).toContain('server failure')
        expect(messages).toContain('响应超过 10000 字符，已截断')
        expect(messages.length).toBeLessThan(14_000)
    })
})
