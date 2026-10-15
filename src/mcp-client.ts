/**
 * host_server_mcp 的 MCP Streamable HTTP 客户端（宿主半专用，Node 环境）。
 *
 * 协议要点（对 bd-pr-rn1 实测确认）：
 *   - `POST http://host:port/mcp`，头 `Content-Type: application/json`、
 *     `Accept: application/json, text/event-stream`、`Authorization: Bearer <token>`；
 *   - 响应体是 SSE 帧（`data: <json>` 行），可能夹带 `id: 0` / `retry: 3000` 心跳；
 *   - `initialize` 成功后在响应头 `Mcp-Session-Id` 拿到会话 id，后续请求必须回传
 *     该头；否则工具调用返回 HTTP 422「Unexpected message, expect initialize request」；
 *   - 无 id 的 JSON-RPC notification 返回 HTTP 202 空体（`notifications/initialized`）；
 *   - 工具结果在 `result.content[].text`（字符串，多半是 JSON），`result.isError`
 *     标记业务失败；未知工具是 JSON-RPC error -32602；
 *   - token 错误返回 HTTP 401 `{"error":"unauthorized","message":"令牌无效"}`。
 */
import type { HostServer } from './settings.js'
import { serverUrl } from './settings.js'

/** MCP 工具调用 / 探测的统一结果。 */
export interface McpCallResult {
  /** 传输层是否成功（HTTP 200 且拿到 JSON-RPC 响应） */
  ok: boolean
  /** 工具业务失败标记（MCP result.isError） */
  isError?: boolean
  /** content 里的文本拼接（json_result 工具的 JSON 就在里面） */
  text?: string
  /** 原始 result（content 保留） */
  result?: unknown
  /** JSON-RPC error（协议层） */
  rpcError?: { code: number; message: string }
  /** HTTP 状态（非 200 时） */
  httpStatus?: number
  /** 传输/客户端错误消息 */
  error?: string
}

/** 一次初始化返回。 */
export interface InitResult {
  sessionId?: string
  serverInfo?: { name?: string; version?: string }
  httpStatus?: number
  error?: string
}

/** 服务器 -> 会话 id 的缓存（初始化成功后复用；失效即丢弃重来）。 */
const sessionCache = new Map<string, string>()

/** 解析 SSE 文本里的 JSON-RPC 消息。返回第一个匹配指定 id 的消息。 */
function pickMessage(text: string, id: number): { result?: unknown; error?: { code: number; message: string } } | null {
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const raw = line.slice(6).trim()
    if (!raw) continue
    let msg: { id?: unknown; result?: unknown; error?: { code: number; message: string } }
    try {
      msg = JSON.parse(raw) as typeof msg
    } catch {
      continue
    }
    if (msg.id !== id) continue
    return { result: msg.result, error: msg.error }
  }
  return null
}

/** 单个请求：发一个 JSON-RPC 消息并取回响应。 */
async function post(
  server: HostServer,
  body: unknown,
  opts: { timeoutMs: number; sessionId?: string; signal?: AbortSignal },
): Promise<{ httpStatus: number; text: string; sessionId?: string }> {
  const url = serverUrl(server)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (server.token) headers.authorization = `Bearer ${server.token}`
  if (opts.sessionId) headers['mcp-session-id'] = opts.sessionId

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  const onOuterAbort = (): void => controller.abort()
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    return {
      httpStatus: res.status,
      text,
      sessionId: res.headers.get('mcp-session-id') ?? undefined,
    }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onOuterAbort)
  }
}

/** 初始化一个会话；返回会话 id。 */
export async function initSession(
  server: HostServer,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<InitResult> {
  let resp
  try {
    resp = await post(
      server,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'dsh-host-mcp', version: '0.1.0' },
        },
      },
      opts,
    )
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  if (resp.httpStatus !== 200) {
    return {
      httpStatus: resp.httpStatus,
      error: resp.text.trim() || `HTTP ${resp.httpStatus}`,
    }
  }
  const msg = pickMessage(resp.text, 1)
  if (!msg) {
    return { httpStatus: resp.httpStatus, error: `初始化响应异常：${resp.text.slice(0, 200)}` }
  }
  if (msg.error) {
    return { httpStatus: resp.httpStatus, error: `initialize 失败：${msg.error.message}` }
  }
  const sessionId = resp.sessionId
  const result = msg.result as { serverInfo?: { name?: string; version?: string } } | undefined
  if (sessionId) sessionCache.set(server.id, sessionId)
  return {
    sessionId,
    serverInfo: result?.serverInfo,
    httpStatus: resp.httpStatus,
  }
}

/** 发送 `notifications/initialized`（无 id；失败可忽略）。 */
export async function notifyInitialized(
  server: HostServer,
  opts: { timeoutMs: number; sessionId: string; signal?: AbortSignal },
): Promise<void> {
  try {
    await post(server, { jsonrpc: '2.0', method: 'notifications/initialized' }, opts)
  } catch {
    // 通知失败不致命：部分服务端不严格校验 initialized 通知。
  }
}

/**
 * 调用一个 MCP 工具。
 *
 * 会话策略：优先用缓存会话；`initialize` 后补发 initialized 通知。若请求因会话
 * 失效返回 422（或传输异常），丢弃缓存会话重试一次（重新 initialize）。
 */
export async function callTool(
  server: HostServer,
  name: string,
  args: Record<string, unknown>,
  opts: { timeoutMs: number; signal?: AbortSignal; forceNewSession?: boolean },
): Promise<McpCallResult> {
  let sessionId = opts.forceNewSession ? undefined : sessionCache.get(server.id)
  if (!sessionId) {
    const init = await initSession(server, opts)
    if (init.error) {
      return { ok: false, error: `无法连接 MCP 端点：${init.error}` }
    }
    sessionId = init.sessionId
    if (sessionId) await notifyInitialized(server, { ...opts, sessionId })
  }

  let resp
  try {
    resp = await post(
      server,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name, arguments: args },
      },
      { ...opts, sessionId },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // 传输失败（超时/网络断）时清掉会话，让下一次调用重新初始化。
    sessionCache.delete(server.id)
    return { ok: false, error: `请求失败：${message}` }
  }

  // 会话失效：清缓存后强制重新初始化重试一次。
  if (resp.httpStatus === 422 && !opts.forceNewSession) {
    sessionCache.delete(server.id)
    return callTool(server, name, args, { ...opts, forceNewSession: true })
  }

  if (resp.httpStatus !== 200) {
    // 401（token 错/缺失）优先给可读消息。
    if (resp.httpStatus === 401) {
      const msg = ((): string => {
        try {
          const j = JSON.parse(resp.text) as { message?: string }
          return j.message ?? resp.text
        } catch {
          return resp.text || 'HTTP 401'
        }
      })()
      return { ok: false, httpStatus: 401, error: `鉴权失败：${msg}` }
    }
    return { ok: false, httpStatus: resp.httpStatus, error: resp.text.trim() || `HTTP ${resp.httpStatus}` }
  }

  const msg = pickMessage(resp.text, 2)
  if (!msg) {
    return { ok: false, httpStatus: resp.httpStatus, error: `响应异常：${resp.text.slice(0, 200)}` }
  }
  if (msg.error) {
    return { ok: false, rpcError: msg.error, error: `MCP 错误（${msg.error.code}）：${msg.error.message}` }
  }

  const result = msg.result as {
    content?: Array<{ type: string; text?: string }>
    isError?: boolean
  } | undefined
  const text = (result?.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
  return { ok: true, isError: result?.isError === true, text, result: msg.result }
}

/** 健康检查（GET /health，不走 MCP 会话）。 */
export async function healthCheck(
  server: HostServer,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ status: number; body?: unknown; error?: string }> {
  const url = `http://${server.host}:${server.port}/health`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  const onOuterAbort = (): void => controller.abort()
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal })
    const text = await res.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    return { status: res.status, body }
  } catch (err) {
    return { status: 0, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onOuterAbort)
  }
}

/** 强制丢弃某个服务器的会话缓存（服务器配置变更后调用）。 */
export function invalidateSession(serverId: string): void {
  sessionCache.delete(serverId)
}

/** 全部清空（HMR / 卸载时调用）。 */
export function invalidateAllSessions(): void {
  sessionCache.clear()
}
