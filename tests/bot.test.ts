import { describe, expect, it, vi } from 'vitest'
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

function mockApi(responses: Array<{ body: unknown; status?: number }>, options = config()) {
    const controller = new AbortController()
    const calls: Array<{ url: URL; init: RequestInit }> = []
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        calls.push({ url: new URL(String(input)), init: init! })
        const next = responses.shift()
        if (!next) throw new Error('Unexpected request')
        return new Response(JSON.stringify(next.body), { status: next.status ?? 200 })
    })
    return { api: createPredictionApi(options, controller.signal, fetcher), calls, controller, fetcher }
}

const stubApi = (): PredictionApi => ({
    getMarket: vi.fn(async () => ({ id: 'market-id', clobTokenIds: tokenIds })),
    split: vi.fn(async () => {}), getClaimableMarketIds: vi.fn(async () => []), claim: vi.fn(async () => {}),
})

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
        ['--base-url', 'file:///tmp'], ['--base-url', 'https://user:pass@example.invalid'],
        ['--authorization', 'Bearer token\nother-token'],
    ])('rejects invalid %s values', (flag, value) => {
        const env = { PREDICTION_BASE_URL: 'https://example.invalid/api', PREDICTION_AUTHORIZATION: 'test-token',
            PREDICTION_WALLET_ID: 'wallet-id', PREDICTION_AMOUNT: '10', PREDICTION_STOP_PRICE: '0.1', PREDICTION_SLUG: initialSlug }
        expect(() => parseConfig([flag, value], env)).toThrow()
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
        expect(log.mock.calls.flat().join(' ')).toContain(tokenIds[0])
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
        expect(logs).toContain('拆分下单失败')
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
        ['16:19:00', '16:21:00', '16:20:00'],
        ['16:22:00', '16:26:00', '16:25:00'],
        ['16:24:00', '16:26:00', '16:25:00'],
        ['16:25:00', '16:26:00', '16:25:00'],
        ['16:25:59', '16:26:00', '16:25:00'],
        ['16:20:00', '16:21:00', '16:20:00'],
        ['16:21:00', '16:26:00', '16:25:00'],
        ['16:21:01', '16:26:00', '16:25:00'],
        ['16:59:30', '17:01:00', '17:00:00'],
    ])('starts at %s, waits until %s, and orders the %s market', async (started, due, marketTime) => {
        const api = stubApi()
        const controller = new AbortController()
        let now = at(started)
        const log = vi.fn()
        const wait = vi.fn(async (ms: number) => {
            expect(api.split).not.toHaveBeenCalled()
            now += ms
        })
        api.split = vi.fn(async () => { expect(now).toBe(at(due)) })
        await runBot(config({ once: true }), api, controller.signal, log, { now: () => now, wait })
        expect(wait).toHaveBeenCalledWith(at(due) - at(started), controller.signal)
        expect(api.getMarket).toHaveBeenCalledExactlyOnceWith(slugAt(marketTime))
        expect(api.split).toHaveBeenCalledExactlyOnceWith('market-id')
        expect(log.mock.calls.flat().join(' ')).toContain(due)
        expect(log.mock.calls.flat().join(' ')).toContain(`当前 slug=${slugAt(marketTime)}`)
    })

    it('keeps a future configured market as the earliest allowed market', () => {
        expect(getFirstRunAt(at('16:19:00'), at('16:30:00') / 1000)).toBe(at('16:31:00'))
    })

    it('keeps subsequent rounds aligned to the market +1 minute despite request duration', async () => {
        const api = stubApi()
        const controller = new AbortController()
        let now = at('16:19:00')
        let waits = 0
        const orderTimes: number[] = []
        api.split = vi.fn(async () => { orderTimes.push(now); now += 25_000 })
        const wait = vi.fn(async (ms: number) => { now += ms; if (++waits === 3) controller.abort() })
        await expect(runBot(config(), api, controller.signal, vi.fn(), { now: () => now, wait })).rejects.toThrow()
        expect(vi.mocked(api.getMarket).mock.calls.map(([slug]) => slug)).toEqual([slugAt('16:20:00'), slugAt('16:25:00')])
        expect(orderTimes).toEqual([at('16:21:00'), at('16:26:00')])
        expect(wait.mock.calls.map(([ms]) => ms)).toEqual([120_000, 275_000, 275_000])
    })

    it('skips missed execution times instead of submitting overlapping catch-up orders', async () => {
        const api = stubApi()
        const controller = new AbortController()
        let now = at('16:19:00')
        let waits = 0
        api.split = vi.fn(async () => { now += 650_000 })
        const wait = vi.fn(async (ms: number) => { now += ms; if (++waits === 3) controller.abort() })
        const log = vi.fn()
        await expect(runBot(config(), api, controller.signal, log, { now: () => now, wait })).rejects.toThrow()
        expect(vi.mocked(api.getMarket).mock.calls.map(([slug]) => slug)).toEqual([slugAt('16:20:00'), slugAt('16:35:00')])
        expect(log.mock.calls.flat().join(' ')).toContain('跳过 2 个')
    })

    it('once waits for the scheduled time, then exits with an error if the round fails', async () => {
        const api = stubApi()
        let now = at('16:19:00')
        api.split = vi.fn(async () => { throw new Error('split failed') })
        const wait = vi.fn(async (ms: number) => { now += ms })
        await expect(runBot(config({ once: true }), api, new AbortController().signal, vi.fn(), { now: () => now, wait })).rejects.toThrow('本轮存在失败')
        expect(api.split).toHaveBeenCalledTimes(1)
        expect(api.getClaimableMarketIds).toHaveBeenCalledOnce()
        expect(wait).toHaveBeenCalledOnce()
    })

    it('selects the current market after a late timer wake-up and skips older markets', async () => {
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
        expect(api.getMarket).toHaveBeenCalledExactlyOnceWith(slugAt('16:30:00'))
        expect(log.mock.calls.flat().join(' ')).toContain('跳过 2 个')
    })

    it('can stop while waiting without creating an order', async () => {
        const api = stubApi()
        const controller = new AbortController()
        const wait = vi.fn(async () => { controller.abort() })
        await expect(runBot(config(), api, controller.signal, vi.fn(), { now: () => at('16:19:00'), wait })).rejects.toThrow()
        expect(api.getMarket).not.toHaveBeenCalled()
        expect(api.split).not.toHaveBeenCalled()
    })

    it('does not order early if the system clock moves backward while waiting', async () => {
        const api = stubApi()
        const controller = new AbortController()
        let now = at('16:19:00')
        let waits = 0
        const wait = vi.fn(async (_ms: number) => { now = at(++waits === 1 ? '16:20:00' : '16:21:00') })
        await runBot(config({ once: true }), api, controller.signal, vi.fn(), { now: () => now, wait })
        expect(wait.mock.calls.map(([ms]) => ms)).toEqual([120_000, 60_000])
        expect(api.split).toHaveBeenCalledOnce()
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
    const statistics = () => ({ orderAttempts: 0, successfulOrders: 0, claimedMarketIds: new Set<string>() })

    it('keeps counters across scheduled rounds, excludes failed orders, and deduplicates claimed markets', async () => {
        const api = stubApi()
        const controller = new AbortController()
        const log = vi.fn()
        let now = at('16:19:00')
        let waits = 0
        api.split = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('split failed')).mockResolvedValueOnce(undefined)
        api.getClaimableMarketIds = vi.fn().mockResolvedValueOnce(['claim-a']).mockResolvedValueOnce(['claim-a', 'claim-b']).mockResolvedValueOnce(['claim-c'])
        const wait = async (ms: number) => { now += ms; if (++waits === 4) controller.abort() }
        await expect(runBot(config(), api, controller.signal, log, { now: () => now, wait })).rejects.toThrow()
        const logs = log.mock.calls.map(([message]) => message as string)
        expect(logs.filter(message => message.startsWith('正在下单：')).map(message => message.match(/第 \d+ 次下单/)?.[0])).toEqual(['第 1 次下单', '第 2 次下单', '第 3 次下单'])
        expect(logs.filter(message => message.startsWith('累计统计：'))).toEqual([
            '累计统计：累计下单 1 笔，累计领取 1 个市场',
            '累计统计：累计下单 1 笔，累计领取 2 个市场',
            '累计统计：累计下单 2 笔，累计领取 3 个市场',
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
        expect(log).toHaveBeenLastCalledWith('累计统计：累计下单 2 笔，累计领取 2 个市场')
    })

    it('does not assign an order number when market lookup fails, while still counting successful claims', async () => {
        const api = stubApi()
        const totals = statistics()
        const log = vi.fn()
        api.getMarket = vi.fn(async () => { throw new Error('market lookup failed') })
        api.getClaimableMarketIds = vi.fn(async () => ['claim-a'])
        expect(await runCycle(config(), firstSlug, api, new AbortController().signal, log, totals)).toBe(false)
        expect(totals.orderAttempts).toBe(0)
        expect(api.split).not.toHaveBeenCalled()
        expect(log).toHaveBeenLastCalledWith('累计统计：累计下单 0 笔，累计领取 1 个市场')
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
        expect(log).toHaveBeenLastCalledWith('累计统计：累计下单 1 笔，累计领取 1 个市场')
    })
})
