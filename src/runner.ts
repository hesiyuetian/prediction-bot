import { setTimeout as sleep } from 'node:timers/promises';
import { AuthorizationError, redact, type PredictionApi } from './api.ts';
import { INTERVAL_SECONDS, ORDER_DELAY_SECONDS, type PredictionConfig } from './config.ts';

type Log = (message: string) => void;

type RunStatistics = {
    orderAttempts: number;
    successfulOrders: number;
    claimedMarketIds: Set<string>;
};

const createRunStatistics = (): RunStatistics => ({
    orderAttempts: 0,
    successfulOrders: 0,
    claimedMarketIds: new Set(),
});

export async function runCycle(config: PredictionConfig, slug: string, api: PredictionApi, signal: AbortSignal, log: Log, statistics: RunStatistics = createRunStatistics()): Promise<boolean> {
    let succeeded = true;
    const onError = (phase: string, error: unknown) => {
        if (signal.aborted || error instanceof AuthorizationError) throw error;
        succeeded = false;
        log(`${phase}失败：当前 slug=${slug}；${redact(error instanceof Error ? error.message : String(error), config.authorization, config.email ?? '', config.password ?? '')}`);
    };
    log(`开始处理 ${slug}${config.dryRun ? '（dry-run）' : ''}`);
    try {
        const market = await api.getMarket(slug);
        signal.throwIfAborted();
        // log(`marketId=${market.id} clobTokenIds=${JSON.stringify(market.clobTokenIds)}`);
        if (config.dryRun) {
            log(`计划 POST createSplitOrders ${JSON.stringify({ marketId: market.id, walletIds: [config.walletId], amount: config.amount, createStopOrder: true, stopPrice: config.stopPrice })}`);
        } else {
            const orderNumber = ++statistics.orderAttempts;
            log(`正在下单：当前 slug=${slug}，第 ${orderNumber} 次下单，marketId=${market.id}，amount=${config.amount}，stopPrice=${config.stopPrice}`);
            await api.split(market.id);
            statistics.successfulOrders++;
            log(`拆分订单创建成功：当前 slug=${slug}，第 ${orderNumber} 次下单，累计下单 ${statistics.successfulOrders} 笔`);
        }
    } catch (error) {
        onError('拆分下单', error);
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
            log(`累计统计：累计下单 ${statistics.successfulOrders} 笔，累计领取 ${statistics.claimedMarketIds.size} 个市场`);
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

/** 每个 5 分钟区间开始后 60 秒；起始 slug +300 是最早可处理的市场。 */
export function getFirstRunAt(nowMs: number, firstTimestamp: number): number {
    const intervalMs = INTERVAL_SECONDS * 1000;
    const offsetMs = ORDER_DELAY_SECONDS * 1000;
    const nextSlot = (Math.floor((nowMs - offsetMs) / intervalMs) + 1) * intervalMs + offsetMs;
    return Math.max(firstTimestamp * 1000 + offsetMs, nextSlot);
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
    const offsetMs = ORDER_DELAY_SECONDS * 1000;
    const statistics = createRunStatistics();
    let runAt = getFirstRunAt(clock.now(), config.firstTimestamp);
    while (!signal.aborted) {
        const delay = runAt - clock.now();
        if (delay > 0) {
            const nextSlug = `${config.slugPrefix}${(runAt - offsetMs) / 1000}`;
            log(`下次下单（北京时间）：${scheduledTime.format(runAt)}；slug=${nextSlug}；等待 ${Math.ceil(delay / 1000)} 秒`);
            await clock.wait(delay, signal);
        }
        signal.throwIfAborted();
        // 系统时钟回拨或提前唤醒时继续等待，不能提前下单。
        if (clock.now() < runAt) continue;
        const missed = Math.floor((clock.now() - runAt) / intervalMs);
        if (missed > 0) {
            log(`定时任务唤醒延迟，跳过 ${missed} 个已错过的执行时点`);
            runAt += missed * intervalMs;
        }
        const slug = `${config.slugPrefix}${(runAt - offsetMs) / 1000}`;
        const succeeded = await runCycle(config, slug, api, signal, log, statistics);
        if (config.once) {
            if (!succeeded) throw new Error('本轮存在失败，详见日志');
            return;
        }
        // 始终对齐市场区间 +60 秒，不因请求耗时而漂移；各轮串行，不补单。
        const next = Math.max(runAt + intervalMs, getFirstRunAt(clock.now(), config.firstTimestamp));
        if (next > runAt + intervalMs) log(`本轮耗时过长，跳过 ${(next - runAt) / intervalMs - 1} 个已错过的执行时点`);
        runAt = next;
    }
}
