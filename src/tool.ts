/**
 * dsh-host-mcp 的 agent 工具。
 *
 * 设计：不暴露十几个细粒度工具（工具面越大模型选择越难），而是
 * 「一个万能 host-mcp 代理工具 + 结构化 action 参数」。执行体直接复用 RPC
 * 分发器，与浏览器半走完全相同的校验与错误路径。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { RPC_ENDPOINTS } from './rpc.js'

export type RpcDispatch = (
  endpoint: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>

/** 输出 JSON 截断上限（工具结果过大会挤爆上下文）。 */
const OUTPUT_LIMIT = 256 * 1024

/** 每个 action 的简短用法提示（进工具 description，帮助模型选参）。 */
const ACTION_HINTS: Record<string, string> = {
  probe: '连通性诊断：health + MCP 初始化 + whoami，返回结构化报告与修复提示（排查「连不上/鉴权失败」首选）',
  health: '健康检查 GET /health（服务进程是否存活、exec 是否启用）',
  whoami: '查看当前 token 身份、作用域（read/exec）、可访问根目录、限流与超时上限',
  list_files: '列举目录，args:{path, pattern, recursive, max_entries}',
  count_file_lines: '统计文件行数/字节数/修改时间，args:{path}（读大文件前先调用）',
  read_file_lines: '按行区间读文件，args:{path, start_line, end_line, with_line_numbers}',
  exec_script: '在服务器沙箱内执行脚本，args:{script, interpreter, cwd, timeout_secs}；interpreter 白名单见服务端配置',
  diagnose: '一键排查：health + whoami + 系统信息探测（uname/负载/内存/磁盘/CPU 进程）',
  servers: '列出已配置服务器（不含 token）',
}

export function createHostMcpTool(dispatch: RpcDispatch) {
  return defineTool({
    name: 'host-mcp',
    description: [
      'Access servers running the host_server_mcp service (本机文件 + 脚本执行 MCP).',
      'Configured servers are listed in the plugin settings page (设置 → 插件 → host-mcp).',
      'Pass `action` (one of: ' + RPC_ENDPOINTS.join(', ') + ') and `args` matching it.',
      'Omitting `server` uses the plugin default server; pass `server` to pick another.',
      ACTION_HINTS.probe,
      ACTION_HINTS.diagnose,
      'Examples: {action:"probe"} · {action:"exec_script",args:{script:"uname -a",cwd:"/tmp"}} ·',
      '{action:"read_file_lines",args:{path:"/tmp/nohup.out",start_line:1,end_line:50}} ·',
      '{action:"servers"} to list configured servers.',
      'exec_script 在服务器上以该 token 的权限执行，注意服务端危险命令黑名单与超时限制。',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: `RPC action, one of: ${RPC_ENDPOINTS.join(', ')}`,
      },
      args: {
        type: 'object',
        additionalProperties: true,
        description: 'Action arguments (path, pattern, script, interpreter, cwd, timeout_secs, start_line, end_line, ...).',
      },
      server: {
        type: 'string',
        description: 'Configured server id. Defaults to the plugin default server.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          ok: { type: 'boolean' },
          result: { type: 'string', description: 'JSON result (truncated to 256KB)' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.ok
            ? `host-mcp ${value.action} → ${value.result}`
            : `host-mcp ${value.action} failed → ${value.result}`,
        },
      ],
    },
    async execute(args, exec) {
      if (exec.signal?.aborted) throw new Error('Cancelled')
      const action = String(args.action ?? '')
      if (!RPC_ENDPOINTS.includes(action as (typeof RPC_ENDPOINTS)[number])) {
        throw new Error(`unknown action "${action}". Valid: ${RPC_ENDPOINTS.join(', ')}`)
      }
      const rpcArgs: Record<string, unknown> =
        typeof args.args === 'object' && args.args !== null ? { ...(args.args as Record<string, unknown>) } : {}
      if (typeof args.server === 'string' && args.server) rpcArgs.server = args.server

      try {
        const value = await dispatch(action, rpcArgs, exec.signal)
        let json = JSON.stringify(value, null, 2)
        if (json.length > OUTPUT_LIMIT) {
          json = `${json.slice(0, OUTPUT_LIMIT)}\n…[truncated ${json.length - OUTPUT_LIMIT} chars]`
        }
        return { action, ok: true, result: json }
      } catch (err) {
        // 错误也走结构化返回（ok:false），模型能读到完整错误消息并自行纠正参数。
        return {
          action,
          ok: false,
          result: err instanceof Error ? err.message : String(err),
        }
      }
    },
  })
}
