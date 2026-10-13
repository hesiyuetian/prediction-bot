import type { PredictionConfig } from './config.ts'

export class RequestError extends Error {
    constructor(message: string, readonly details?: string) {
        super(message)
        this.name = new.target.name
    }
}

export class AuthorizationError extends RequestError {
    constructor(message: string, readonly status: number = 401, details?: string) { super(message, details) }
}

/** 已配置账号密码时，续登失败只影响本轮，定时器继续运行。 */
export class RecoverableAuthenticationError extends RequestError {}

export function formatError(error: unknown, depth = 0): string {
    if (error instanceof Error) {
        const parts = [error.stack ?? `${error.name}: ${error.message}`]
        if (error instanceof RequestError && error.details) parts.push(error.details)
        if (error.cause !== undefined && depth < 3) parts.push(`原始错误：\n${formatError(error.cause, depth + 1)}`)
        return parts.join('\n')
    }
    try { return JSON.stringify(error, null, 2) ?? String(error) }
    catch { return String(error) }
}

export function redact(message: string, ...secrets: string[]): string {
    let result = message.replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
    result = result.replace(/("(?:authorization|access_?token|refresh_?token|token|password|email)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
    const variants = secrets.map(value => value.replace(/^Bearer\s+/i, '')).filter(Boolean)
        .flatMap(value => [value, JSON.stringify(value).slice(1, -1)])
    for (const secret of [...new Set(variants)].sort((a, b) => b.length - a.length)) {
        result = result.replaceAll(secret, '[REDACTED]')
    }
    return result
}

export function createAuthenticatedRequest(config: PredictionConfig, signal: AbortSignal, fetcher: typeof fetch,
    log: (message: string) => void = () => {}) {
    const secrets = new Set([config.authorization, config.email ?? '', config.password ?? ''])
    const sanitize = (message: string) => redact(message, ...secrets)
    const responseLog = (raw: string): string => {
        let formatted = raw || '（空响应）'
        try { formatted = JSON.stringify(JSON.parse(raw), null, 2) }
        catch { /* 非 JSON 错误页也保留其文本。 */ }
        const safe = sanitize(formatted)
        return safe.length > 10_000 ? `${safe.slice(0, 10_000)}\n（响应超过 10000 字符，已截断）` : safe
    }
    let loginPromise: Promise<void> | undefined
    let needsLogin = !config.authorization
    let retryAfter = 0

    const send = async (path: string, body?: Record<string, unknown>, query?: Record<string, string | number>, login = false) => {
        signal.throwIfAborted()
        const url = new URL(`${config.baseUrl}/${path}`)
        for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value))
        const context = `接口：${body ? 'POST' : 'GET'} ${url.pathname}`
        let response: Response
        try {
            response = await fetcher(url, {
                method: body ? 'POST' : 'GET', redirect: 'error',
                headers: { Accept: 'application/json', ...(login ? { 'X-Platform': 'mobile' } : { Authorization: config.authorization }),
                    ...(body ? { 'Content-Type': 'application/json' } : {}) },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
            })
        } catch (error) {
            throw new RequestError(`${path} 请求中断、超时或网络失败${body && !login ? '；订单结果可能未知，未自动重试' : ''}`, `${context}\n原始错误：\n${sanitize(formatError(error))}`)
        }
        let raw: string
        try { raw = await response.text() }
        catch (error) {
            const details = `${context}\nHTTP 状态：${response.status}\n读取响应失败：\n${sanitize(formatError(error))}`
            if (response.status === 401 || response.status === 403) throw new AuthorizationError(`${path} 鉴权失败 (${response.status})`, response.status, details)
            throw new RequestError(`${path} 无法读取响应${body && !login ? '；订单结果可能未知，未自动重试' : ''}`, details)
        }
        const details = `${context}\nHTTP 状态：${response.status}\n接口响应：\n${responseLog(raw)}`
        if (response.status === 401 || response.status === 403) throw new AuthorizationError(`${path} 鉴权失败 (${response.status})`, response.status, details)
        if (!response.ok) throw new RequestError(`${path} HTTP ${response.status}${body && !login ? '；未自动重试' : ''}`, details)
        let data: Record<string, any>
        try { data = JSON.parse(raw) as Record<string, any> }
        catch { throw new RequestError(`${path} 未返回有效 JSON${body && !login ? '；订单结果可能未知，未自动重试' : ''}`, details) }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new RequestError(`${path} 响应格式错误`, details)
        const codes = [Number(data.statusCode), Number(data.code)]
        const authCode = codes.find(code => code === 401 || code === 403)
        if (authCode) throw new AuthorizationError(`${path} 鉴权失败 (${authCode})`, authCode, details)
        if (data.success === false || (data.statusCode !== undefined && Number(data.statusCode) !== 200)) {
            const message = typeof data.message === 'string' ? data.message : JSON.stringify(data.message ?? 'success=false')
            throw new RequestError(`${path} 失败：${sanitize(message).slice(0, 500)}`, details)
        }
        if (body && !login && data.success !== true) throw new RequestError(`${path} 未返回 success=true；订单结果可能未知，未自动重试`, details)
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
                    throw new RequestError('登录需要验证码或二次验证，账号密码无法独立完成登录', `接口：POST auth/login\n接口响应：\n${responseLog(JSON.stringify(data))}`)
                }
                const token = typeof data.accessToken === 'string' ? data.accessToken.trim().replace(/^Bearer\s+/i, '') : ''
                if (!token || /\s/.test(token)) throw new RequestError('登录接口未返回有效 accessToken', `接口：POST auth/login\n接口响应：\n${responseLog(JSON.stringify(data))}`)
                secrets.add(token)
                config.authorization = `Bearer ${token}`
                needsLogin = false
                retryAfter = 0
                log('登录成功，已更新 token')
            } catch (error) {
                if (signal.aborted) throw error
                retryAfter = Date.now() + 30_000
                throw new RecoverableAuthenticationError(`自动登录失败：${sanitize(error instanceof Error ? error.message : String(error))}；定时任务继续，后续轮次重新尝试`, sanitize(formatError(error)))
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
            try { await relogin(tokenUsed) }
            catch (loginError) {
                if (signal.aborted) throw loginError
                if (loginError instanceof RequestError) {
                    const details = `${sanitize(formatError(error))}\n续登错误：\n${sanitize(formatError(loginError))}`
                    if (loginError instanceof AuthorizationError) throw new AuthorizationError(loginError.message, loginError.status, details)
                    throw new RecoverableAuthenticationError(loginError.message, details)
                }
                throw loginError
            }
            // 只重试明确被 401 拒绝的请求一次；不会重试超时或结果未知的订单。
            try { data = await send(`prediction/${path}`, body, query) }
            catch (retryError) {
                if (retryError instanceof AuthorizationError && retryError.status === 401) {
                    needsLogin = true
                    retryAfter = Date.now() + 30_000
                    throw new RecoverableAuthenticationError(`${path} 重新登录后仍返回 401，本轮失败，定时任务继续`, sanitize(formatError(retryError)))
                }
                throw retryError
            }
        }
        return data
    }
}
