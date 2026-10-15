/**
 * 验证落盘配置串能被配置载体解析成服务器行。
 * 复现 config-editor 写出的 `servers` YAML 形态（多行 pretty JSON）。
 *
 * 运行：node scripts/check-parse.mjs
 */
import { readFileSync } from 'node:fs'
import { parseServers, readSettings, deriveServerId, HostMcpConfigSchema } from '../lib/settings.js'
import z from '@deepseek-ai/schemastery'

const failures = []
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '✔' : '✘'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!cond) failures.push(label)
}

// 1. config-editor 实际写出的形态（YAML |- 块 → 展开为多行 pretty JSON）
const multiLine = `[
  {
    "host": "10.110.195.25",
    "port": 8765,
    "token": "hsk_test",
    "mcpPath": "/mcp"
  }
]`
const single = '[{"id":"a","host":"h","port":1,"token":"t","mcpPath":"/mcp"}]'

for (const [label, raw] of [['多行 pretty JSON', multiLine], ['单行紧凑 JSON', single]]) {
  const { servers, error } = parseServers(raw)
  check(`${label} 解析成功`, error === undefined && servers.length === 1, error ?? `${servers.length} 行`)
  check(`${label} 字段完整`, servers[0]?.host === (label === '多行 pretty JSON' ? '10.110.195.25' : 'h')
    && servers[0]?.port === (label === '多行 pretty JSON' ? 8765 : 1)
    && servers[0]?.token !== undefined
    && servers[0]?.mcpPath === '/mcp',
  JSON.stringify(servers[0] ?? {}))
}

// 2. 完整配置链路：volatile 引用 → readSettings（旧数据 defaultServer 是冒号形态）
const config = {
  servers: {
    get: () => multiLine,
  },
  defaultServer: { get: () => '10.110.195.25:8765' },
}
const settings = readSettings(config)
check('readSettings 解出 1 台服务器', settings.servers.length === 1, JSON.stringify(settings.servers))
check('readSettings 无解析错误', settings.serverError === undefined, settings.serverError)
check('readSettings 旧冒号形态 defaultServer 解析成实际 id',
  settings.defaultServer === settings.servers[0]?.id,
  `default=${settings.defaultServer} id=${settings.servers[0]?.id}`)

// 2b. 新写法（直接写规范 id）同样工作；且 id 形态就是 deriveServerId
check('deriveServerId 冒号折叠横线', deriveServerId('10.110.195.25', 8765) === '10.110.195.25-8765',
  deriveServerId('10.110.195.25', 8765))
const config2 = {
  servers: { get: () => multiLine },
  defaultServer: { get: () => '10.110.195.25-8765' },
}
check('readSettings 规范 id defaultServer 直接匹配', readSettings(config2).defaultServer === '10.110.195.25-8765')

// 2c. 关键回归：servers 字段绝不能标 role('secret')——settings 远程读取对 secret
//     字段整体脱敏，配置页会读到空列表（2026-10-14 实测）。
{
  const schema = HostMcpConfigSchema
  // schemastery 的对象 schema 字段挂在 `.dict` 上（不是 `.properties`），
  // role 存于节点 meta。之前用 properties 取是空节点，这条检测曾是永远绿的摆设。
  const role = schema?.dict?.servers?.meta?.role
  check('servers 字段未标 role(secret)（否则远程读取被脱敏）', role !== 'secret', `role=${role}`)
  // 自检：确认本检测能抓到 regression（用一个故意标 secret 的对照 schema）
  const control = z.object({ servers: z.string().volatile().role('secret') })
  check('检测自检：对照 schema 的 role=secret 能被识别', control?.dict?.servers?.meta?.role === 'secret',
    `control role=${control?.dict?.servers?.meta?.role}`)
}

// 3. 坏输入不应抛异常（面板要能显示错误而不是白屏）
for (const bad of ['not json', '{}', '[]', '']) {
  const r = parseServers(bad)
  check(`坏输入 ${JSON.stringify(bad)} 安全降级`, Array.isArray(r.servers), `error=${r.error ?? '(无)'}`)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 项检查失败`)
  process.exit(1)
}
console.log('\n配置解析链路验证通过')