// @dsh-version 0.1.7
/**
 * dsh-host-mcp · 宿主半（Node / Cordis 插件）。
 *
 * 职责：
 * 1. 解析插件配置（servers 列表：host + port + token，volatile 字段可热改）；
 * 2. 经 `connection.fetch.register()` 注册 `/api/host-mcp/<endpoint>` 精确路由
 *    （0.1.5 起 rpc.handle 对插件失效，这是插件 RPC 的唯一正解）；
 * 3. 注册 `host-mcp` agent 工具（复用 RPC 分发器，浏览器半与工具走同一条校验路径）。
 *
 * 浏览器半（lib/client.js）通过 `connection.rpc.call('/api', 'host-mcp/<endpoint>', …)`
 * 调用这里注册的路由；MCP HTTP 请求由宿主进程直接发出（Node fetch）。
 */
import type { Context } from '@deepseek-ai/cordis'

import { HostMcpConfigSchema, readSettings, type HostMcpConfig } from './settings.js'
import { createDispatch, registerRpcRoutes } from './rpc.js'
import { createHostMcpTool } from './tool.js'

/** Plugin id — must be unique within the composed plugin tree. */
export const name = 'dsh-host-mcp'

/** Declare the host services this plugin needs; the loader waits for them. */
export const inject = ['connection', 'tools'] as const

/**
 * 插件配置 schema（dsh ≥ 0.1.7 的配置载体）。
 * volatile 字段改动不重挂插件：loader 原地更新引用并广播 loader/volatile-update；
 * 本插件所有 RPC 请求都现读配置（readSettings），无需监听也能生效。
 */
export const Config = HostMcpConfigSchema

export function apply(ctx: Context, config: HostMcpConfig): void {
  const logger = ctx.logger('host-mcp')

  // volatile 配置现读快照器：每次请求现取，引用不变、值在变。
  const settings = () => readSettings(config)

  // ── 统一分发器（浏览器半 + agent 工具共用同一条校验路径） ────────────────
  const dispatch = createDispatch(settings)

  // ── 注册 Fetch 精确路由（ctx.effect 保证 HMR/卸载可逆） ───────────────────
  // 真实 cordis 的 connection 服务是 HostConnectionHandle，注册器在
  // `connection.fetch.register`；registerRpcRoutes 内部会提取 `.fetch`。
  const connection = ctx.get('connection')
  ctx.effect(() => {
    const dispose = registerRpcRoutes(
      connection,
      settings,
      (m) => logger.warn('dsh-host-mcp: %s', m),
    )
    const count = settings().servers.length
    logger.info('dsh-host-mcp: /api/host-mcp/* routes registered (%d server(s) configured)', count)
    return dispose
  }, 'host-mcp: rpc routes')

  // ── 注册 agent 工具 ──────────────────────────────────────────────────────
  ctx.effect(() => {
    // tools 服务由 loader 提供；ctx.get 兼容测试替身，属性访问只适用于真实 cordis。
    const tools = (ctx as unknown as { get?: (n: string) => unknown }).get?.('tools')
      ?? (ctx as unknown as { tools?: { register: unknown } }).tools
    const registry = tools as { register: (t: unknown) => unknown } | undefined
    if (!registry || typeof registry.register !== 'function') {
      // 无工具注册表时退化为空 effect（仍返回合法 disposer）。
      logger.warn('dsh-host-mcp: tools registry unavailable; agent tool not registered')
      return () => {}
    }
    const tool = createHostMcpTool(async (endpoint, args, signal) => {
      const result = await dispatch(endpoint, args, signal)
      if (result.ok) return result.value
      throw new Error(result.error?.message ?? 'host-mcp rpc failed')
    })
    logger.info('dsh-host-mcp: host-mcp agent tool registered')
    // register 回 disposer（cordis collect 风格）；收窄类型以满足 ctx.effect 的 Effect 签名。
    const dispose = registry.register(tool) as () => void
    return () => { dispose() }
  }, 'host-mcp: agent tool')
}
