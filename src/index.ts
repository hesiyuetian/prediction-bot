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
        const log = (message: string, level: 'info' | 'error' = 'info') => {
            const output = `[${new Date().toISOString()}] ${level === 'error' ? '[ERROR] ' : ''}${sanitize(message)}`
            if (level === 'error') console.error(output)
            else console.log(output)
        }
        log('调度规则：启动后立即买下一个 5 分钟市场，之后每个区间开始时买下一区间；旧的起始市场自动跳过已错过的区间')
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
