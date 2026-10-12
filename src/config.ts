import { parseArgs } from 'node:util'

export const INTERVAL_SECONDS = 300
export const ORDER_DELAY_SECONDS = 60
export const DEFAULT_PROJECT_ID = '816d6686-3c64-4a98-bf41-9e781b77270e'

export interface PredictionConfig {
    baseUrl: string
    authorization: string
    email?: string
    password?: string
    walletId: string
    projectId: string
    amount: number
    stopPrice: string
    slugPrefix: string
    firstTimestamp: number
    once: boolean
    dryRun: boolean
}

export const HELP = `每 5 分钟拆分下单并领取已结算市场。

用法:
  pnpm start --base-url https://your-host/api \\
    --wallet-id <walletId> --amount 10 --stop-price 0.1 \\
    --slug btc-updown-5m-1791787500

参数（同名参数优先于环境变量）:
  --base-url        接口根地址，包含 /api 等实际前缀；PREDICTION_BASE_URL
  --authorization   Bearer token 或完整 Authorization；PREDICTION_AUTHORIZATION（有账号密码时可省略）
  --email           登录账号（邮箱）；PREDICTION_EMAIL
  --password        登录密码；PREDICTION_PASSWORD（与 email 一起配置，401 时自动续登）
  --wallet-id       钱包 ID；PREDICTION_WALLET_ID
  --amount          每轮下单数量，必须 > 0；PREDICTION_AMOUNT
  --stop-price      止损价，必须在 0 和 1 之间；PREDICTION_STOP_PRICE
  --slug            起始 5 分钟市场，至少从其时间戳 +300 开始，过期区间自动跳过；PREDICTION_SLUG
  --project-id      领取项目；PREDICTION_PROJECT_ID，默认 ${DEFAULT_PROJECT_ID}
  --once            只执行一轮
  --dry-run         读取接口并打印计划，不发送拆分或领取 POST
  --help            显示帮助

等待下一个市场区间开始后 1 分钟执行（每小时 01、06、11、16、21、26…分）；Ctrl+C 停止。
推荐通过 .env 或环境变量传入 token、邮箱和密码。`

export function parseConfig(args: string[], env: NodeJS.ProcessEnv = process.env): PredictionConfig | null {
    const { values } = parseArgs({ args, options: {
        'base-url': { type: 'string' }, authorization: { type: 'string' },
        email: { type: 'string' }, password: { type: 'string' },
        'wallet-id': { type: 'string' }, amount: { type: 'string' },
        'stop-price': { type: 'string' }, slug: { type: 'string' },
        'project-id': { type: 'string' },
        once: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
    } })
    if (values.help) return null

    const required = (name: keyof typeof values, envName: string): string => {
        const value = String(values[name] ?? env[envName] ?? '').trim()
        if (!value) throw new Error(`缺少 --${name} 或环境变量 ${envName}`)
        return value
    }
    let url: URL
    try { url = new URL(required('base-url', 'PREDICTION_BASE_URL')) }
    catch { throw new Error('--base-url 必须是完整的 http/https 接口根地址') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('--base-url 只允许 http/https，不能包含账号、查询参数或 fragment')
    }
    const email = (values.email ?? env.PREDICTION_EMAIL ?? '').trim()
    // 密码不 trim，保留用户密码中的首尾空格。
    const password = values.password ?? env.PREDICTION_PASSWORD ?? ''
    if ((email || password) && (!email || !password)) throw new Error('--email 和 --password 必须一起提供')
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('--email 必须是有效邮箱')
    const authorization = (values.authorization ?? env.PREDICTION_AUTHORIZATION ?? '').trim()
    const token = authorization.replace(/^Bearer\s+/i, '')
    if (authorization && (!token || /\s/.test(token))) throw new Error('Authorization 格式错误')
    if (!token && !email) throw new Error('请提供 Authorization，或同时提供 email 和 password')
    const decimal = /^(?:\d+(?:\.\d*)?|\.\d+)$/
    const amountText = required('amount', 'PREDICTION_AMOUNT')
    const amount = Number(amountText)
    if (!decimal.test(amountText) || !Number.isFinite(amount) || amount <= 0) {
        throw new Error('--amount 必须是大于 0 的有限十进制数')
    }
    const stopPrice = required('stop-price', 'PREDICTION_STOP_PRICE')
    if (!decimal.test(stopPrice) || !(Number(stopPrice) > 0 && Number(stopPrice) < 1)) {
        throw new Error('--stop-price 必须大于 0 且小于 1')
    }
    const slug = required('slug', 'PREDICTION_SLUG')
    const match = /^(btc-updown-5m-)(\d+)$/.exec(slug)
    const timestamp = Number(match?.[2])
    if (!match || !Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp % INTERVAL_SECONDS !== 0
        || !Number.isSafeInteger((timestamp + INTERVAL_SECONDS) * 1000)
        || !Number.isFinite(new Date((timestamp + INTERVAL_SECONDS) * 1000).getTime())) {
        throw new Error('--slug 必须为 btc-updown-5m-<Unix 秒时间戳>，且时间戳对齐 300 秒')
    }
    return {
        baseUrl: url.href.replace(/\/+$/, ''), authorization: token ? `Bearer ${token}` : '',
        email: email || undefined, password: password || undefined,
        walletId: required('wallet-id', 'PREDICTION_WALLET_ID'),
        projectId: String(values['project-id'] ?? env.PREDICTION_PROJECT_ID ?? DEFAULT_PROJECT_ID).trim() || DEFAULT_PROJECT_ID,
        amount, stopPrice, slugPrefix: match[1], firstTimestamp: timestamp + INTERVAL_SECONDS,
        once: values.once ?? false, dryRun: values['dry-run'] ?? false,
    }
}
