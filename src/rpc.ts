/**
 * dsh-host-mcp 宿主半 RPC：把浏览器半的请求桥接到 MCP 客户端。
 *
 * 通道契约（harness 0.1.5+，0.1.7 验证不变）：
 * - 0.1.5 起 `connection.rpc.handle` 对插件失效，插件 RPC 的唯一正解是
 *   `connection.fetch.register()` 注册 `/api/host-mcp/<endpoint>` 精确路由；
 * - 浏览器 transport POST `{ type:'client-request', rpcId, method, payload }`，
 *   本端回 `HTTP 200` + `{ type:'server-response', rpcId, result }`；
 * - result 必须是 `{ ok:true, value }` 或 `{ ok:false, error:{ code, message, details } }`。
 */
import type { HostMcpSettings, HostServer } from './settings.js'
import { parseServers, readSettings, type HostMcpConfig } from './settings.js'
import { callTool, healthCheck, initSession, invalidateAllSessions, invalidateSession } from './mcp-client.js'
import type { McpCallResult } from './mcp-client.js'

/** 宿主 connection.fetch 的最小形状（见 harness connection/src/rpc.ts）。 */
export interface HostConnectionFetch {
  register(route: {
    path: string
    methods: readonly ('GET' | 'HEAD' | 'POST')[]
    requestBody: 'buffered' | 'streaming'
    fetch: (request: Request) => Promise<Response>
  }): () => Promise<void>
}

/** 载体中立的 RPC 结果（浏览器 transport 严格要求 code/details）。 */
export interface RpcResult {
  ok: boolean
  value?: unknown
  error?: { code: string; message: string; details: object }
}

/** 精确 Fetch 路由的 base（必须在 /api 下）。 */
export const RPC_BASE = '/api/host-mcp'
/** 端点前缀（rpc.call 的 method 字段）。 */
export const RPC_PREFIX = 'host-mcp/'
/** 暴露为精确路由的端点清单。 */
export const RPC_ENDPOINTS = [
  'version',
  'servers',
  'probe',
  'probe_all',
  'health',
  'whoami',
  'list_files',
  'count_file_lines',
  'read_file_lines',
  'exec_script',
  'server_info',
  'diagnose',
  'probe_uncached',
] as const

export type RpcEndpoint = (typeof RPC_ENDPOINTS)[number]

interface ClientRequestEnvelope {
  type?: unknown
  rpcId?: unknown
  method?: unknown
  payload?: unknown
}

/** 把任意异常折叠成合法的 RpcResult 错误分支。 */
function failure(err: unknown): RpcResult {
  const message = err instanceof Error ? err.message : String(err)
  return { ok: false, error: { code: 'bad-request', message, details: {} } }
}

function ok(value: unknown): RpcResult {
  return { ok: true, value }
}

/** 宽松字符串读取（args 校验从简：MCP 服务端会做最终校验）。 */
function str(args: Record<string, unknown>, key: string, fallback = ''): string {
  const v = args[key]
  return typeof v === 'string' ? v : fallback
}

function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function bool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = args[key]
  return typeof v === 'boolean' ? v : fallback
}

/** 从 args 或默认配置里挑出目标服务器。 */
function pickServer(
  settings: HostMcpSettings & { serverError?: string },
  args: Record<string, unknown>,
  requireToken: boolean,
): { server?: HostServer; error?: string } {
  const id = str(args, 'server') || settings.defaultServer
  const server = settings.servers.find((s) => s.id === id)
  if (!server) {
    const known = settings.servers.map((s) => s.id).join(', ') || '(无)'
    return { error: `服务器 "${id}" 未配置。已配置：${known}` }
  }
  if (requireToken && !server.token) {
    return { error: `服务器 "${server.id}" 未配置 token，无法访问 MCP 端点` }
  }
  return { server }
}

/** 从 error 路径的结构化 JSON 文本里取出 error_kind（成功路径的 text 是普通结果 JSON，无此字段）。 */
function extractErrorKind(result: McpCallResult): string | undefined {
  if (result.isError !== true || typeof result.text !== 'string') return undefined
  try {
    const parsed = JSON.parse(result.text) as { error_kind?: unknown }
    return typeof parsed.error_kind === 'string' ? parsed.error_kind : undefined
  } catch {
    return undefined
  }
}

/** 把 MCP 调用结果折叠成 RpcResult。 */
function mcpToRpc(result: McpCallResult): RpcResult {
  if (!result.ok) {
    return {
      ok: false,
      error: {
        code: 'bad-request',
        message: result.error ?? 'MCP 调用失败',
        details: {
          ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
          ...(result.rpcError !== undefined ? { rpcError: result.rpcError } : {}),
        },
      },
    }
  }
  // 服务端 exec_script 在 isError=true 时会把 text 写成结构化 JSON
  // {is_error, error_kind, message}（error_kind 由 classify_error 归类），
  // 这里把 error_kind 提到兄弟字段，方便 agent 工具与浏览器面板直接解读。
  return ok({
    isError: result.isError === true,
    text: result.text ?? '',
    ...(extractErrorKind(result) !== undefined ? { errorKind: extractErrorKind(result) } : {}),
  })
}

/** 对某台服务器做连通性诊断（health + initialize + whoami），返回结构化报告。 */
async function probeServer(
  server: HostServer,
  settings: HostMcpSettings,
  signal?: AbortSignal,
): Promise<RpcResult> {
  const timeoutMs = settings.requestTimeoutMs
  const report: Record<string, unknown> = {
    server: { id: server.id, host: server.host, port: server.port, mcpPath: server.mcpPath, hasToken: Boolean(server.token) },
    health: null,
    mcp: null,
    whoami: null,
  }

  // 1) 健康检查（不依赖 MCP 会话）
  const health = await healthCheck(server, { timeoutMs, signal })
  if (health.error || health.status !== 200) {
    report.health = { ok: false, status: health.status, error: health.error ?? 'HTTP 非 200' }
    return ok({
      ok: false,
      summary: `无法访问 ${server.host}:${server.port}（健康检查失败）`,
      ...report,
      hints: [
        '检查该服务器的 host_server_mcp 进程是否在运行',
        '检查端口是否被防火墙/网络策略拦截',
        '检查 IP/主机名是否可达（ping / telnet host port）',
      ],
    })
  }
  report.health = { ok: true, status: health.status, body: health.body }

  // 2) MCP 初始化
  if (!server.token) {
    report.mcp = { ok: false, error: '未配置 token' }
    return ok({
      ok: false,
      summary: `${server.id} 未配置 token，MCP 端点不可用`,
      ...report,
      hints: ['在配置页为这台服务器填写 host_server_mcp 的 token'],
    })
  }
  const init = await initSession(server, { timeoutMs, signal })
  if (init.error) {
    report.mcp = { ok: false, error: init.error }
    const authHint = /401|鉴权|令牌/.test(init.error) ? ['token 无效或已过期，请检查配置页中的 token'] : []
    return ok({
      ok: false,
      summary: `MCP 初始化失败：${init.error}`,
      ...report,
      hints: authHint.length ? authHint : ['检查 token 是否有效（host_server_mcp 管理页可重新签发）'],
    })
  }
  report.mcp = { ok: true, serverInfo: init.serverInfo ?? null }

  // 3) whoami（验证 read/exec 作用域）
  const whoami = await callTool(server, 'whoami', {}, { timeoutMs, signal })
  if (!whoami.ok) {
    report.whoami = { ok: false, error: whoami.error }
    return ok({
      ok: false,
      summary: `whoami 调用失败：${whoami.error}`,
      ...report,
      hints: ['token 有效但可能缺少 read 作用域，请在 host_server_mcp 管理页检查'],
    })
  }
  report.whoami = { ok: true, isError: whoami.isError === true, text: whoami.text }
  return ok({
    ok: true,
    summary: `${server.id} 连接正常（health ✓ / MCP ✓ / whoami ✓）`,
    ...report,
  })
}

/** 端点 → 处理器。settings 每次现读。 */
function createHandler(settingsRef: () => HostMcpSettings & { serverError?: string }) {
  return async (endpoint: RpcEndpoint, args: Record<string, unknown>, signal?: AbortSignal): Promise<RpcResult> => {
    const settings = settingsRef()
    switch (endpoint) {
      case 'version':
        return ok({ version: '0.1.0', name: 'dsh-host-mcp' })

      case 'servers':
        // 脱敏：绝不回传 token 明文；浏览器编辑走官方 configForms。
        return ok({
          servers: settings.servers.map((s) => ({
            id: s.id,
            host: s.host,
            port: s.port,
            mcpPath: s.mcpPath,
            hasToken: Boolean(s.token),
            note: s.note,
          })),
          defaultServer: settings.defaultServer,
          error: settings.serverError,
        })

      case 'probe': {
        const picked = pickServer(settings, args, false)
        if (picked.error || !picked.server) return failure(new Error(picked.error ?? '无服务器'))
        return probeServer(picked.server, settings, signal)
      }

      case 'probe_all': {
        if (!Array.isArray(settings.servers) || settings.servers.length === 0) {
          return ok({
            ok: true,
            summary: '未配置任何服务器',
            results: [],
          })
        }
        const results: Array<Record<string, unknown>> = []
        await Promise.allSettled(
          settings.servers.map(async (server) => {
            try {
              const res = await probeServer(server, settings, signal)
              if (res.ok && res.value && typeof res.value === 'object') {
                results.push({ serverId: server.id, ...(res.value as Record<string, unknown>) })
              } else if (res.ok) {
                results.push({ serverId: server.id, ok: true, value: res.value })
              } else {
                results.push({ serverId: server.id, ok: false, error: res.error })
              }
            } catch (err) {
              results.push({ serverId: server.id, ok: false, error: err instanceof Error ? err.message : String(err) })
            }
          }),
        )
        const failed = results.filter((r) => r.ok === false).length
        const total = results.length
        return ok({
          ok: failed === 0,
          summary: failed === 0 ? `全部 ${total} 台服务器可用` : `${failed}/${total} 台服务器异常`,
          results,
        })
      }

      /**
       * 探测**尚未保存**的服务器定义（配置页「测试连接」用）。
       *
       * 为什么不走浏览器直连：dsh 页面与目标服务器跨源，而 host_server_mcp
       * 不返回 CORS 头，浏览器 `fetch` 会以 `Failed to fetch` 拒绝——那与服务
       * 器是否可达无关。宿主进程发 HTTP 无同源限制，故预检一律经此端点。
       *
       * 出于同样的 token 卫生考虑，回包里只给结论与阶段，不回显 token。
       */
      case 'probe_uncached': {
        const { servers } = parseServers(JSON.stringify([{
          host: str(args, 'host'),
          port: args.port,
          token: str(args, 'token'),
          mcpPath: str(args, 'mcpPath', '/mcp'),
        }]))
        const candidate = servers[0]
        if (!candidate) return failure(new Error('未填主机名，无法测试'))
        // 覆盖超时：未保存的行不继承面板的 60s 默认值，避免长时间挂起。
        return probeServer(candidate, { ...settings, requestTimeoutMs: 15000 }, signal)
      }

      case 'health': {
        const picked = pickServer(settings, args, false)
        if (picked.error || !picked.server) return failure(new Error(picked.error ?? '无服务器'))
        const result = await healthCheck(picked.server, { timeoutMs: settings.requestTimeoutMs, signal })
        if (result.error || result.status !== 200) {
          return failure(new Error(result.error ?? `健康检查失败：HTTP ${result.status}`))
        }
        return ok({ status: result.status, body: result.body })
      }

      case 'whoami':
      case 'list_files':
      case 'count_file_lines':
      case 'read_file_lines':
      case 'exec_script':
      case 'server_info': {
        const picked = pickServer(settings, args, true)
        if (picked.error || !picked.server) return failure(new Error(picked.error ?? '无服务器'))
        const toolArgs = { ...args }
        delete toolArgs.server
        // exec_script 默认超时由插件配置给，服务端会再钳一次。
        if (endpoint === 'exec_script') {
          if (typeof toolArgs.timeout_secs !== 'number') toolArgs.timeout_secs = settings.defaultTimeoutSecs
        }
        const result = await callTool(picked.server, endpoint, toolArgs, {
          timeoutMs: settings.requestTimeoutMs,
          signal,
        })
        return mcpToRpc(result)
      }

      case 'diagnose': {
        const picked = pickServer(settings, args, true)
        if (picked.error || !picked.server) return failure(new Error(picked.error ?? '无服务器'))
        const server = picked.server
        const timeoutMs = settings.requestTimeoutMs
        const steps: Array<{ step: string; ok: boolean; detail: unknown }> = []
        const out: Record<string, unknown> = { server: server.id, steps }

        // 1) 健康
        const health = await healthCheck(server, { timeoutMs, signal })
        steps.push({
          step: 'health',
          ok: health.status === 200,
          detail: health.status === 200 ? health.body : (health.error ?? `HTTP ${health.status}`),
        })

        // 2) whoami
        const whoami = await callTool(server, 'whoami', {}, { timeoutMs, signal })
        steps.push({
          step: 'whoami',
          ok: whoami.ok && whoami.isError !== true,
          detail: whoami.ok ? whoami.text : whoami.error,
        })

        // 3) 系统信息探测（python；cwd 用 whoami 返回的第一个沙箱根，跨平台稳妥）
        let cwd = '/tmp'
        if (whoami.ok && typeof whoami.text === 'string') {
          try {
            const identity = JSON.parse(whoami.text) as { roots?: unknown }
            if (Array.isArray(identity.roots) && typeof identity.roots[0] === 'string') {
              cwd = identity.roots[0]
            }
          } catch {
            // whoami 文本非 JSON 时维持默认 cwd
          }
        }
        // py2/py3 兼容（服务端可能是老系统自带 python2.7），按平台分支取系统信息。
        const sysScript = [
          'import os, sys',
          'def sh(c):',
          '    try:',
          '        p = os.popen(c)',
          '        out = p.read().strip()',
          '        return out if out else "(empty)"',
          '    except Exception as e:',
          '        return "err: %s" % e',
          'parts = []',
          'win = os.name == "nt"',
          'parts.append("== platform ==")',
          'parts.append(sys.platform)',
          'if not win:',
          '    parts.append(sh("uname -a"))',
          '    parts.append("== load / uptime ==")',
          '    parts.append(sh("cat /proc/loadavg"))',
          '    parts.append(sh("uptime"))',
          '    parts.append("== mem ==")',
          '    parts.append(sh("head -8 /proc/meminfo"))',
          '    parts.append("== disk ==")',
          '    parts.append(sh("df -h"))',
          '    parts.append("== top cpu procs ==")',
          '    parts.append(sh("ps -eo pid,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -8"))',
          'else:',
          '    parts.append("== cpu / memory ==")',
          '    parts.append(sh("wmic cpu get LoadPercentage /value"))',
          '    parts.append(sh("wmic OS get FreePhysicalMemory,TotalVisibleMemorySize /value"))',
          '    parts.append("== disk ==")',
          '    parts.append(sh("wmic logicaldisk get caption,freespace,size /value"))',
          'print("\\n".join(parts))',
        ].join('\n')
        const execRes = await callTool(server, 'exec_script', {
          interpreter: 'python',
          cwd,
          script: sysScript,
          timeout_secs: 30,
        }, { timeoutMs, signal })
        steps.push({
          step: 'exec_system_probe',
          ok: execRes.ok && execRes.isError !== true,
          detail: execRes.ok ? execRes.text : execRes.error,
        })

        const failed = steps.some((s) => !s.ok)
        return ok({
          ok: !failed,
          summary: failed ? `${server.id} 诊断发现异常，见 steps` : `${server.id} 诊断通过`,
          ...out,
        })
      }

      default:
        return failure(new Error(`未知端点 ${endpoint}`))
    }
  }
}

/**
 * 注册全部精确 Fetch 路由。
 *
 * @param connection - 宿主 connection 服务（取其 `.fetch` 注册器）；测试替身
 *   也可以直接给带 `register` 的对象。
 * @param settingsRef - volatile 配置的现读快照器。
 * @param log - 告警日志（注册失败不阻断插件加载）。
 * @returns disposer 函数（HMR/卸载时调用）。
 */
export function registerRpcRoutes(
  connection: unknown,
  settingsRef: () => HostMcpSettings & { serverError?: string },
  log: (msg: string) => void,
): () => void {
  const registry =
    (connection as { fetch?: HostConnectionFetch } | undefined)?.fetch
    ?? (connection as HostConnectionFetch | undefined)
  if (!registry || typeof registry.register !== 'function') {
    log('connection.fetch registry unavailable; Web client RPC disabled')
    return () => {}
  }
  const handler = createHandler(settingsRef)

  const answer = (endpoint: RpcEndpoint) => async (request: Request): Promise<Response> => {
    let envelope: ClientRequestEnvelope
    try {
      envelope = (await request.json()) as ClientRequestEnvelope
    } catch {
      return new Response('body is not JSON', { status: 400 })
    }
    const rpcId = typeof envelope.rpcId === 'string' ? envelope.rpcId : 'invalid'
    if (envelope.type !== 'client-request' || envelope.method !== `${RPC_PREFIX}${endpoint}`) {
      return Response.json(
        {
          type: 'server-response',
          rpcId,
          result: {
            ok: false,
            error: {
              code: 'gateway/bad-request',
              message: `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(`${RPC_PREFIX}${endpoint}`)}`,
              details: {},
            },
          },
        },
        { status: 200 },
      )
    }
    try {
      const payload = (envelope.payload ?? {}) as Record<string, unknown>
      const args = (payload.args ?? {}) as Record<string, unknown>
      const result = await handler(endpoint, args, request.signal)
      return Response.json({ type: 'server-response', rpcId, result }, { status: 200 })
    } catch (err) {
      return Response.json(
        {
          type: 'server-response',
          rpcId,
          result: failure(err),
        },
        { status: 200 },
      )
    }
  }

  const disposers: Array<() => unknown> = []
  for (const endpoint of RPC_ENDPOINTS) {
    try {
      const remove = registry.register({
        path: `${RPC_BASE}/${endpoint}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: answer(endpoint),
      })
      disposers.push(remove)
    } catch (err) {
      log(`failed to register route ${RPC_BASE}/${endpoint}: ${String(err)}`)
    }
  }

  return () => {
    for (const dispose of disposers) {
      try {
        void dispose()
      } catch {
        // 单个路由解除失败不阻断其余清理
      }
    }
    invalidateAllSessions()
  }
}

/**
 * 构造统一的端点分发器：agent 工具与 Fetch 路由共用同一条校验路径。
 *
 * @param settingsRef - volatile 配置的现读快照器（禁止缓存结果）。
 * @returns `(endpoint, args, signal) => Promise<RpcResult>`。
 */
export function createDispatch(
  settingsRef: () => HostMcpSettings & { serverError?: string },
): (endpoint: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<RpcResult> {
  const handler = createHandler(settingsRef)
  return async (endpoint, args, signal) => {
    if (!RPC_ENDPOINTS.includes(endpoint as RpcEndpoint)) {
      return failure(new Error(`未知端点 "${endpoint}"。可用：${RPC_ENDPOINTS.join(', ')}`))
    }
    return handler(endpoint as RpcEndpoint, args, signal)
  }
}

export { invalidateSession }
