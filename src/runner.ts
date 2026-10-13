import { setTimeout as sleep } from 'node:timers/promises';
import { AuthorizationError, formatError, redact, type PredictionApi } from './api.ts';
import { INTERVAL_SECONDS, type PredictionConfig } from './config.ts';

type Log = (message: string, level?: 'info' | 'error') => void;

type RunStatistics = {
    orderAttempts: number;
    successfulOrders: number;
    failedOrderRequests: number;
    claimedMarketIds: Set<string>;
};

const createRunStatistics = (): RunStatistics => ({
    orderAttempts: 0,
    successfulOrders: 0,
    failedOrderRequests: 0,
    claimedMarketIds: new Set(),
});

export async function runCycle(config: PredictionConfig, slug: string, api: PredictionApi, signal: AbortSignal, log: Log, statistics: RunStatistics = createRunStatistics(), orderDeadline?: { timestamp: number; now: () => number }): Promise<boolean> {
    let succeeded = true;
    const logStatistics = () => log(`累计统计：累计下单 ${statistics.successfulOrders} 笔，累计领取 ${statistics.claimedMarketIds.size} 个市场，累计下单失败 ${statistics.failedOrderRequests} 笔`);
    const onError = (phase: string, error: unknown, orderNumber?: number) => {
        if (signal.aborted) throw error;
        succeeded = false;
        if (orderNumber !== undefined) statistics.failedOrderRequests++;
        log(`${phase}失败：当前 slug=${slug}${orderNumber === undefined ? '' : `，第 ${orderNumber} 次下单`}；${redact(error instanceof Error ? error.message : String(error), config.authorization, config.email ?? '', config.password ?? '')}`, 'error');
        log(`报错日志：\n${redact(formatError(error), config.authorization, config.email ?? '', config.password ?? '')}`, 'error');
        if (orderNumber !== undefined) logStatistics();
        if (error instanceof AuthorizationError) throw error;
    };
    let orderNumber: number | undefined;
    log(`开始处理 ${slug}${config.dryRun ? '（dry-run）' : ''}`);
    try {
        const market = await api.getMarket(slug);
        signal.throwIfAborted();
        if (orderDeadline && orderDeadline.now() >= orderDeadline.timestamp) {
            throw new Error('目标市场已开始，跳过该市场下单，等待后续轮次');
        }
        // log(`marketId=${market.id} clobTokenIds=${JSON.stringify(market.clobTokenIds)}`);
        if (config.dryRun) {
            log(`计划 POST createSplitOrders ${JSON.stringify({ marketId: market.id, walletIds: [config.walletId], amount: config.amount, createStopOrder: true, stopPrice: config.stopPrice })}`);
        } else {
            orderNumber = ++statistics.orderAttempts;
            log(`正在下单：当前 slug=${slug}，第 ${orderNumber} 次下单，marketId=${market.id}，amount=${config.amount}，stopPrice=${config.stopPrice}`);
            await api.split(market.id);
            statistics.successfulOrders++;
            log(`拆分订单创建成功：当前 slug=${slug}，第 ${orderNumber} 次下单，累计下单 ${statistics.successfulOrders} 笔`);
        }
    } catch (error) {
        onError(orderNumber === undefined ? '拆分下单' : '拆分订单创建', error, orderNumber);
    }

    // 下单失败也检查历史市场的领取；未配置续登凭证、403 或退出信号则停止。
    try {
        signal.throwIfAborted();
        const marketIds = await api.getClaimableMarketIds();
        signal.throwIfAborted();
        if (marketIds.length === 0) {
            log('暂无可领取市场');
        } else if (config.dryRun) {
            log(`计划 POST createWalletClaimOrders ${JSON.stringify({ marketIds, walletId: config.walletId })}`);
        } else {
            await api.claim(marketIds);
            for (const marketId of marketIds) statistics.claimedMarketIds.add(marketId);
            log(`领取订单创建成功：${marketIds.length} 个市场`);
            logStatistics();
        }
    } catch (error) {
        onError('领取', error);
    }
    return succeeded;
}

const systemClock = {
    now: () => Date.now(),
    wait: (ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }),
};

/** 启动后立即买下一区间；未来的最早市场要等到它的前一个区间开始。 */
export function getFirstRunAt(nowMs: number, firstTimestamp: number): number {
    const intervalMs = INTERVAL_SECONDS * 1000;
    return Math.max(nowMs, firstTimestamp * 1000 - intervalMs);
}

const scheduledTime = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
});

export async function runBot(config: PredictionConfig, api: PredictionApi, signal: AbortSignal, log: Log, clock: { now: () => number; wait: (ms: number, signal: AbortSignal) => Promise<void> } = systemClock): Promise<void> {
    const intervalMs = INTERVAL_SECONDS * 1000;
    const statistics = createRunStatistics();
    let runAt = getFirstRunAt(clock.now(), config.firstTimestamp);
    while (!signal.aborted) {
        const delay = runAt - clock.now();
        if (delay > 0) {
            const nextSlug = `${config.slugPrefix}${(Math.floor(runAt / intervalMs) + 1) * INTERVAL_SECONDS}`;
            log(`下次下单（北京时间）：${scheduledTime.format(runAt)}；slug=${nextSlug}；等待 ${Math.ceil(delay / 1000)} 秒`);
            await clock.wait(delay, signal);
        }
        signal.throwIfAborted();
        // 系统时钟回拨或提前唤醒时继续等待，不能提前下单。
        if (clock.now() < runAt) continue;
        const intervalStart = Math.floor(clock.now() / intervalMs) * intervalMs;
        const missed = (intervalStart - Math.floor(runAt / intervalMs) * intervalMs) / intervalMs;
        if (missed > 0) {
            log(`定时任务唤醒延迟，跳过 ${missed} 个已错过的执行时点`);
        }
        const marketStartsAt = intervalStart + intervalMs;
        const slug = `${config.slugPrefix}${marketStartsAt / 1000}`;
        const succeeded = await runCycle(config, slug, api, signal, log, statistics, { timestamp: marketStartsAt, now: () => clock.now() });
        if (config.once) {
            if (!succeeded) throw new Error('本轮存在失败，详见日志');
            return;
        }
        // 后续对齐每个区间起点；当前区间买下一区间，各轮串行，不补单。
        const next = Math.max(intervalStart + intervalMs, (Math.floor(clock.now() / intervalMs) + 1) * intervalMs);
        if (next > intervalStart + intervalMs) log(`本轮耗时过长，跳过 ${(next - intervalStart) / intervalMs - 1} 个已错过的执行时点`);
        runAt = next;
    }
}
