/**
 * dsh-host-mcp 的配置载体（dsh ≥ 0.1.7 契约）。
 *
 * 插件配置 = 导出的 `Config` schema + profile 条目 config。本插件的 bundle patch
 * 用 `id: host-mcp`，所以配置命名空间就是 `host-mcp`。
 *
 * ⚠ volatile 字段会被 loader 解析成 cosmokit 的 `Volatile<T>` **稳定引用**
 * （设置页改写时原地更新引用里的值、不重挂插件），因此：
 *   - 业务代码一律经 {@link readSettings} 解包成普通值，每次请求现读现用；
 *   - 禁止在 apply 时缓存配置快照。
 */
import z from '@deepseek-ai/schemastery'

/** 只依赖 `get()` 的结构类型（兼容新旧 dsh 与测试替身）。 */
export interface VolatileRef<T> {
  get(): T
}

/** 字段可能是 volatile 引用（dsh ≥ 0.1.7）或普通值（旧版 dsh / 测试替身）。 */
export type MaybeVolatile<T> = T | VolatileRef<T>

/** 一台装了 host_server_mcp 的服务器（普通值配置）。 */
export interface HostServer {
  /** 显示名 / 选择 id（面板下拉与工具参数都用它） */
  id: string
  /** 主机名或 IP，如 `bd-pr-rn1` / `10.0.0.8` / `127.0.0.1` */
  host: string
  /** 端口，如 `8765` */
  port: number
  /** 访问令牌（host_server_mcp 的 token，形如 `hsk_...`） */
  token: string
  /** MCP 端点路径，默认 `/mcp` */
  mcpPath: string
  /** 备注（可选） */
  note?: string
}

/** 宿主半与工具使用的**普通值**配置快照。 */
export interface HostMcpSettings {
  servers: HostServer[]
  defaultServer: string
  /** 单次 MCP 请求超时（毫秒），默认 60000 */
  requestTimeoutMs: number
  /** exec_script 默认超时（秒），默认 10（服务端还会再钳一次） */
  defaultTimeoutSecs: number
  /** 读文件预览的默认字节上限，默认 128 KiB */
  readLimitBytes: number
  /** 单次 MCP 结果回传上限（超出截断），默认 256 KiB */
  maxResultChars: number
}

/** `Config` schema 的解析结果：每个字段都可能是 volatile 引用。 */
export interface HostMcpConfig {
  servers?: MaybeVolatile<string>
  defaultServer?: MaybeVolatile<string>
  requestTimeoutMs?: MaybeVolatile<number>
  defaultTimeoutSecs?: MaybeVolatile<number>
  readLimitBytes?: MaybeVolatile<number>
  maxResultChars?: MaybeVolatile<number>
}

/** 与 Schema 默认值保持一致的常量兜底。 */
const DEFAULTS = {
  servers: '[]',
  defaultServer: '',
  requestTimeoutMs: 60_000,
  defaultTimeoutSecs: 10,
  readLimitBytes: 128 * 1024,
  maxResultChars: 256 * 1024,
}

/**
 * host_server_mcp 插件的 **Config schema**（dsh ≥ 0.1.7 的配置载体）。
 *
 * 服务器列表存成 JSON 字符串（`[{id,host,port,token,mcpPath,note}]`）——
 * schemastery 表单对「对象数组」的编辑体验差，JSON 文本域 + 面板里的结构化
 * 编辑器（每台服务器一行：host/port/token）更实用。只有标记 `.volatile()` 的
 * 字段会进入「设置 → 插件」表单并被允许热改。
 *
 * ⚠ **绝不能给 servers 标 `role('secret')`**：settings 的远程读取统一走
 * `redactSecrets: true`（harness settings-controller 的契约注释原文：
 * "a role('secret') field cannot ride a response"），secret 字段会被整个
 * 移除——配置页读到空列表，而宿主侧配置其实完好（2026-10-14 实测踩坑）。
 * token 的保护由两点承担：只落本机 profile 文件 + 工具/RPC 回包一律脱敏
 * （servers 端点只回 hasToken）。
 */
export const HostMcpConfigSchema = z.object({
  servers: z.string().default(DEFAULTS.servers).volatile().description(
    'host_server_mcp 服务器列表（JSON 数组）：[{"id":"bd-pr-rn1","host":"bd-pr-rn1","port":8765,"token":"hsk_xxx","mcpPath":"/mcp","note":"备注"}]。' +
    'token 是访问该服务器 MCP 端点的口令；id 留空时由 host:port 推导（冒号折叠为横线）。' +
    'token 会明文写入本机 profile 配置，请只填可信的内网服务器。',
  ),
  defaultServer: z.string().default(DEFAULTS.defaultServer).volatile().description(
    '默认服务器 id（面板与工具省略 server 参数时使用）。留空取列表第一个',
  ),
  requestTimeoutMs: z.number().default(DEFAULTS.requestTimeoutMs).volatile().description(
    '单次 MCP 请求的 HTTP 超时（毫秒），默认 60000',
  ),
  defaultTimeoutSecs: z.number().default(DEFAULTS.defaultTimeoutSecs).volatile().description(
    'exec_script 默认超时（秒），默认 10；服务端会按自己的上限再钳一次',
  ),
  readLimitBytes: z.number().default(DEFAULTS.readLimitBytes).volatile().description(
    'read_file_lines 单次读取的默认字节上限，默认 131072',
  ),
  maxResultChars: z.number().default(DEFAULTS.maxResultChars).volatile().description(
    '工具结果回传上限（字符数，超出截断），默认 262144',
  ),
})

/** 解包 volatile 引用（dsh ≥ 0.1.7）或普通值（旧版 dsh / 测试替身）。 */
export function unwrap<T>(value: MaybeVolatile<T> | undefined | null): T | undefined {
  if (value === undefined || value === null) return undefined
  const ref = value as VolatileRef<T>
  if (typeof ref.get === 'function') {
    try {
      return ref.get()
    } catch {
      // 引用被替换/尚未提交时不致命：退回默认值。
      return undefined
    }
  }
  return value as T
}

/** 端口合法性（host_server_mcp 是 TCP 服务）。 */
function normalizePort(raw: unknown): number {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0 || raw > 65535) return 8765
    return Math.floor(raw)
  }
  const text = String(raw ?? '').trim()
  if (!text) return 8765
  const n = Number.parseInt(text, 10)
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return 8765
  return n
}

/**
 * 由 host:port 推导规范 id（唯一形态：非 `[\w.-]` 字符折叠为 `-`）。
 *
 * 浏览器半写 defaultServer 时必须用这个函数（client.ts 里有一份镜像）——
 * 两侧各造各的 id 会让默认服务器对不上（2026-10-14 实测：面板写
 * `host:port` 冒号形态，解析器推导横线形态，agent 报「服务器未配置」）。
 */
export function deriveServerId(host: string, port: number): string {
  return `${host}:${port}`.replace(/[^\w.-]+/g, '-') || 'server'
}

/** 由 host:port 推导一个稳定 id（带去重登记）。 */
function deriveId(host: string, port: number, taken: Set<string>): string {
  const base = deriveServerId(host, port)
  let unique = base
  for (let n = 2; taken.has(unique); n += 1) unique = `${base}-${n}`
  taken.add(unique)
  return unique
}

/**
 * 解析服务器 JSON 列表；坏条目跳过并返回错误消息（不抛，让面板能显示）。
 *
 * 容错策略：缺 id 用 `host:port` 推导并去重；缺 port 回落 8765；缺 mcpPath
 * 回落 `/mcp`；缺 token 的条目照样返回（面板要能显示「未填 token」）。
 */
export function parseServers(raw: string | undefined): { servers: HostServer[]; error?: string } {
  const text = (raw ?? '').trim()
  if (!text) return { servers: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { servers: [], error: `servers JSON 解析失败: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!Array.isArray(parsed)) return { servers: [], error: 'servers 必须是 JSON 数组' }

  const servers: HostServer[] = []
  const taken = new Set<string>()
  for (const item of parsed) {
    const row = item as Partial<HostServer>
    const host = typeof row?.host === 'string' ? row.host.trim() : ''
    if (!host) continue
    const port = normalizePort(row?.port)
    let id = typeof row?.id === 'string' && row.id.trim() ? row.id.trim() : ''
    if (!id) id = deriveId(host, port, taken)
    else if (taken.has(id)) id = deriveId(host, port, taken)
    else taken.add(id)

    let mcpPath = typeof row?.mcpPath === 'string' ? row.mcpPath.trim() : ''
    if (!mcpPath) mcpPath = '/mcp'
    else if (!mcpPath.startsWith('/')) mcpPath = `/${mcpPath}`

    const token = typeof row?.token === 'string' ? row.token.trim() : ''
    const note = typeof row?.note === 'string' && row.note.trim() ? row.note.trim() : undefined
    servers.push({ id, host, port, token, mcpPath, ...(note ? { note } : {}) })
  }
  return { servers }
}

/** 取一份**普通值**配置快照（每次请求处理前都调用，不缓存）。 */
export function readSettings(config?: HostMcpConfig | null): HostMcpSettings & { serverError?: string } {
  const source: HostMcpConfig = config ?? {}
  const { servers, error } = parseServers(unwrap(source.servers))
  const defaultServer = unwrap(source.defaultServer)?.trim() ?? ''
  const timeout = unwrap(source.requestTimeoutMs)
  const execTimeout = unwrap(source.defaultTimeoutSecs)
  const readLimit = unwrap(source.readLimitBytes)
  const maxChars = unwrap(source.maxResultChars)

  return {
    servers,
    serverError: error,
    defaultServer: resolveDefaultId(defaultServer, servers),
    requestTimeoutMs: clamp(timeout, 1000, 600_000, DEFAULTS.requestTimeoutMs),
    defaultTimeoutSecs: clamp(execTimeout, 1, 3600, DEFAULTS.defaultTimeoutSecs),
    readLimitBytes: clamp(readLimit, 0, 64 * 1024 * 1024, DEFAULTS.readLimitBytes),
    maxResultChars: clamp(maxChars, 1024, 8 * 1024 * 1024, DEFAULTS.maxResultChars),
  }
}

/**
 * 把配置里的 defaultServer 解析成实际存在的服务器 id。
 *
 * 旧版本面板保存时写的是 `host:port` 冒号形态，而解析器推导的 id 是
 * 横线形态——精确匹配失败会让「默认服务器」落空，工具报「服务器未配置」。
 * 故按 三档 容错：精确 id → `deriveServerId(host, port)` 重算 → 第一台。
 */
function resolveDefaultId(raw: string, servers: HostServer[]): string {
  if (!raw) return servers[0]?.id ?? ''
  if (servers.some((s) => s.id === raw)) return raw
  // 旧数据形态：defaultServer 写成 `host:port`（冒号），id 推导时冒号已折叠成 `-`
  const m = /^([^:]+):(\d+)$/.exec(raw)
  if (m) {
    const derived = deriveServerId(m[1]!.trim(), Number.parseInt(m[2]!, 10))
    if (servers.some((s) => s.id === derived)) return derived
  }
  return servers[0]?.id ?? raw
}

/** 数值钳制；非有限值回落默认。 */
function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/** 服务器的 MCP 端点 URL。 */
export function serverUrl(server: HostServer): string {
  return `http://${server.host}:${server.port}${server.mcpPath}`
}

/** 健康检查 URL（host_server_mcp 自带 /health）。 */
export function healthUrl(server: HostServer): string {
  return `http://${server.host}:${server.port}/health`
}
