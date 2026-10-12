import type { PredictionConfig } from './config.ts'
import { createAuthenticatedRequest } from './auth.ts'
export { AuthorizationError, redact } from './auth.ts'

/** 使用原始接口响应；不依赖浏览器的 localStorage 或刷新 token 拦截器。 */
export function createPredictionApi(config: PredictionConfig, signal: AbortSignal, fetcher: typeof fetch = fetch,
    log: (message: string) => void = () => {}) {
    const request = createAuthenticatedRequest(config, signal, fetcher, log)

    return {
        async getMarket(slug: string) {
            const data = await request('getMarketDetail', undefined, { slug })
            if (typeof data.id !== 'string' || !data.id.trim()) throw new Error('getMarketDetail 缺少 id')
            if (typeof data.slug === 'string' && data.slug !== slug) throw new Error('getMarketDetail 返回的 slug 与请求不一致')
            let tokenIds: unknown
            try { tokenIds = typeof data.clobTokenIds === 'string' ? JSON.parse(data.clobTokenIds) : data.clobTokenIds }
            catch { throw new Error('getMarketDetail 的 clobTokenIds 不是有效 JSON') }
            if (!Array.isArray(tokenIds) || tokenIds.length !== 2 || !tokenIds.every(id => typeof id === 'string' && /^\d+$/.test(id)) || tokenIds[0] === tokenIds[1]) {
                throw new Error('getMarketDetail 必须返回两个不同的字符串 clobTokenIds')
            }
            return { id: data.id as string, clobTokenIds: tokenIds as string[] }
        },
        async split(marketId: string) {
            await request('createSplitOrders', { marketId, walletIds: [config.walletId], amount: config.amount, createStopOrder: true, stopPrice: config.stopPrice })
        },
        async getClaimableMarketIds() {
            const marketIds = new Set<string>()
            // 先读完所有页，再发送领取，避免领取导致分页内容移动而漏项。
            for (let page = 1; ; page++) {
                const data = await request('getClaimableMarkets', undefined, { projectId: config.projectId, page, limit: 200 })
                if (!Array.isArray(data.items) || typeof data.pageInfo?.hasNextPage !== 'boolean') {
                    throw new Error('getClaimableMarkets 响应缺少 items 或 pageInfo.hasNextPage')
                }
                for (const item of data.items) {
                    if (typeof item?.id !== 'string' || !item.id.trim()) throw new Error('getClaimableMarkets 返回的市场缺少 id')
                    marketIds.add(item.id)
                }
                if (!data.pageInfo.hasNextPage) break
                if (data.items.length === 0 || page >= 1000) throw new Error('getClaimableMarkets 分页异常，停止本轮领取')
            }
            return [...marketIds]
        },
        async claim(marketIds: string[]) {
            await request('createWalletClaimOrders', { marketIds, walletId: config.walletId })
        },
    }
}

export type PredictionApi = ReturnType<typeof createPredictionApi>
