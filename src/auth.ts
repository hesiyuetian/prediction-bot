import type { PredictionConfig } from './config.ts'

export class AuthorizationError extends Error {
    constructor(message: string, readonly status: number = 401) { super(message) }
}

/** 已配置账号密码时，续登失败只影响本轮，定时器继续运行。 */
export class RecoverableAuthenticationError extends Error {}

export function redact(message: string, ...secrets: string[]): string {
    let result = message.replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
    for (const secret of secrets.map(value => value.replace(/^Bearer\s+/i, '')).filter(Boolean).sort((a, b) => b.length - a.length)) {
        result = result.replaceAll(secret, '[REDACTED]')
    }
    return result
}

export function createAuthenticatedRequest(config: PredictionConfig, signal: AbortSignal, fetcher: typeof fetch,
    log: (message: string) => void = () => {}) {
    const secrets = new Set([config.authorization, config.email ?? '', config.password ?? ''])
    const sanitize = (message: string) => redact(message, ...secrets)
    let loginPromise: Promise<void> | undefined
    let needsLogin = !config.authorization
    let retryAfter = 0

    const send = async (path: string, body?: Record<string, unknown>, query?: Record<string, string | number>, login = false) => {
        signal.throwIfAborted()
        const url = new URL(`${config.baseUrl}/${path}`)
        for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value))
        let response: Response
        try {
            response = await fetcher(url, {
                method: body ? 'POST' : 'GET', redirect: 'error',
                headers: { Accept: 'application/json', ...(login ? { 'X-Platform': 'mobile' } : { Authorization: config.authorization }),
                    ...(body ? { 'Content-Type': 'application/json' } : {}) },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
            })
        } catch {
            throw new Error(`${path} 请求中断、超时或网络失败${body && !login ? '；订单结果可能未知，未自动重试' : ''}`)
        }
        if (response.status === 401 || response.status === 403) throw new AuthorizationError(`${path} 鉴权失败 (${response.status})`, response.status)
        if (!response.ok) throw new Error(`${path} HTTP ${response.status}${body && !login ? '；未自动重试' : ''}`)
        let data: Record<string, any>
        try { data = await response.json() as Record<string, any> }
        catch { throw new Error(`${path} 未返回有效 JSON${body && !login ? '；订单结果可能未知，未自动重试' : ''}`) }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${path} 响应格式错误`)
        const codes = [Number(data.statusCode), Number(data.code)]
        const authCode = codes.find(code => code === 401 || code === 403)
        if (authCode) throw new AuthorizationError(`${path} 鉴权失败 (${authCode})`, authCode)
        if (data.success === false || (data.statusCode !== undefined && Number(data.statusCode) !== 200)) {
            const message = typeof data.message === 'string' ? data.message : JSON.stringify(data.message ?? 'success=false')
            throw new Error(`${path} 失败：${sanitize(message).slice(0, 500)}`)
        }
        return data
    }

    const relogin = async (failedToken?: string): Promise<void> => {
        if (!config.email || !config.password) throw new AuthorizationError('接口返回 401，但未配置 PREDICTION_EMAIL 和 PREDICTION_PASSWORD')
        // 另一个请求已续登完成时直接复用新 token；并发 401 共用同一次登录。
        if (failedToken !== undefined && config.authorization !== failedToken && !needsLogin) return
        if (loginPromise) return loginPromise
        needsLogin = true
        if (Date.now() < retryAfter) throw new RecoverableAuthenticationError('自动登录失败后冷却 30 秒，等待后续轮次重试')
        loginPromise = (async () => {
            try {
                log(config.authorization ? '收到 401，正在重新登录' : '未提供 token，正在使用账号密码登录')
                const data = await send('auth/login', { email: config.email, password: config.password, code: '', faCode: '' }, undefined, true)
                signal.throwIfAborted()
                if (data.requiresVerifyList && (!Array.isArray(data.requiresVerifyList) || data.requiresVerifyList.length > 0)) {
                    throw new Error('登录需要验证码或二次验证，账号密码无法独立完成登录')
                }
                const token = typeof data.accessToken === 'string' ? data.accessToken.trim().replace(/^Bearer\s+/i, '') : ''
                if (!token || /\s/.test(token)) throw new Error('登录接口未返回有效 accessToken')
                secrets.add(token)
                config.authorization = `Bearer ${token}`
                needsLogin = false
                retryAfter = 0
                log('登录成功，已更新 token')
            } catch (error) {
                if (signal.aborted) throw error
                retryAfter = Date.now() + 30_000
                throw new RecoverableAuthenticationError(`自动登录失败：${sanitize(error instanceof Error ? error.message : String(error))}；定时任务继续，后续轮次重新尝试`)
            }
        })()
        try { await loginPromise }
        finally { loginPromise = undefined }
    }

    return async (path: string, body?: Record<string, unknown>, query?: Record<string, string | number>) => {
        if (needsLogin) await relogin()
        const tokenUsed = config.authorization
        let data: Record<string, any>
        try { data = await send(`prediction/${path}`, body, query) }
        catch (error) {
            if (!(error instanceof AuthorizationError) || error.status !== 401) throw error
            await relogin(tokenUsed)
            // 只重试明确被 401 拒绝的请求一次；不会重试超时或结果未知的订单。
            try { data = await send(`prediction/${path}`, body, query) }
            catch (retryError) {
                if (retryError instanceof AuthorizationError && retryError.status === 401) {
                    needsLogin = true
                    retryAfter = Date.now() + 30_000
                    throw new RecoverableAuthenticationError(`${path} 重新登录后仍返回 401，本轮失败，定时任务继续`)
                }
                throw retryError
            }
        }
        if (body && data.success !== true) throw new Error(`${path} 未返回 success=true；订单结果可能未知，未自动重试`)
        return data
    }
}
