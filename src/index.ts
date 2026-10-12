import { createPredictionApi, redact } from './api.ts'
import { HELP, parseConfig } from './config.ts'
import { runBot } from './runner.ts'

const controller = new AbortController()
const stop = () => {
    console.log('\n收到停止信号，终止定时任务。已发送的订单请以服务端状态为准。')
    controller.abort()
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

let sanitize = (message: string) => redact(message, process.env.PREDICTION_AUTHORIZATION ?? '', process.env.PREDICTION_EMAIL ?? '', process.env.PREDICTION_PASSWORD ?? '')
try {
    const config = parseConfig(process.argv.slice(2))
    if (!config) {
        console.log(HELP)
    } else {
        sanitize = (message: string) => redact(message, config.authorization, config.email ?? '', config.password ?? '')
        const log = (message: string) => console.log(`[${new Date().toISOString()}] ${sanitize(message)}`)
        log('调度规则：市场区间开始后 1 分钟下单，每 5 分钟执行；旧的起始市场自动跳过已错过的区间')
        await runBot(config, createPredictionApi(config, controller.signal, undefined, log), controller.signal, log)
    }
} catch (error) {
    if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[prediction:bot] ${sanitize(message)}`)
        process.exitCode = 1
    }
} finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
}
