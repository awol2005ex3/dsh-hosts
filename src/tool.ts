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
  server_info: '探测服务端运行环境：OS/架构、可用解释器及版本（含 Python 主版本）、解释器白名单与默认解释器，需 exec 作用域；执行 exec_script 前调用可选',
  diagnose: '一键排查：health + whoami + 系统信息探测（uname/负载/内存/磁盘/CPU 进程）',
  servers: '列出已配置服务器（不含 token）',
}

/** exec_script 失败时服务端结构化 error_kind → 可读提示（对应 host_server_mcp 的 classify_error）。 */
const ERROR_KIND_HINTS: Record<string, string> = {
  interpreter_not_allowed: '解释器不在白名单内（检查服务端 allowed_interpreters）',
  interpreter_unsupported: '服务端不支持该解释器（内置支持 powershell/pwsh/cmd/bash/sh/python/python3/node）',
  interpreter_not_found: '系统未安装该解释器或不在 PATH 中',
  blocked: '脚本命中危险命令/交互式命令黑名单，被拒绝执行',
  path_denied: '路径被拒绝：不在该 token 允许的沙箱根目录内',
  path_not_found: '路径不存在或不可访问',
  cwd_not_found: '工作目录不存在',
  missing_cwd: '未指定 cwd 且服务端未配置 exec.default_cwd',
  exec_disabled: '服务端已禁用脚本执行',
  invalid_request: '脚本内容为空或过长',
  exec_failed: '执行失败（见 message 详情）',
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
        // exec_script 失败时把 error_kind 译成一行可读提示，方便模型纠正参数。
        const decoded =
          value && typeof value === 'object' && (value as Record<string, unknown>).errorKind
            ? ` [${ERROR_KIND_HINTS[(value as Record<string, unknown>).errorKind as string] ?? (value as Record<string, unknown>).errorKind}]`
            : ''
        return { action, ok: true, result: json + decoded }
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
