/**
 * 真机联调：用环境变量提供的服务器信息，直接驱动编译后的宿主半代码，
 * 走通 probe / whoami / list_files / read_file_lines / exec_script / diagnose 全链路。
 *
 * 运行（token 只经环境变量传入，不写入任何文件）：
 *   HSM_HOST=bd-pr-rn1 HSM_PORT=8765 HSM_TOKEN=hsk_xxx node scripts/check-live.mjs
 */
import { readSettings } from '../lib/settings.js'
import { createDispatch } from '../lib/rpc.js'

const HOST = process.env.HSM_HOST
const PORT = Number(process.env.HSM_PORT || 8765)
const TOKEN = process.env.HSM_TOKEN

if (!HOST || !TOKEN) {
  console.error('用法：HSM_HOST=<host> [HSM_PORT=8765] HSM_TOKEN=<token> node scripts/check-live.mjs')
  process.exit(2)
}

const failures = []
const check = (label, cond) => {
  console.log(`${cond ? '✔' : '✘'} ${label}`)
  if (!cond) failures.push(label)
}

// 用插件自己的配置载体构造一份「volatile 引用」形态的配置
const config = {
  servers: {
    get: () => JSON.stringify([{ id: 'live', host: HOST, port: PORT, token: TOKEN, mcpPath: '/mcp' }]),
  },
  defaultServer: { get: () => 'live' },
  requestTimeoutMs: { get: () => 20000 },
  defaultTimeoutSecs: { get: () => 20 },
}

const dispatch = createDispatch(() => readSettings(config))
const call = async (endpoint, args = {}) => {
  const result = await dispatch(endpoint, args)
  if (!result.ok) {
    const err = new Error(result.error?.message ?? `${endpoint} 失败`)
    err.rpc = result.error
    throw err
  }
  return result.value
}

console.log(`联调目标：${HOST}:${PORT}\n`)

// 1) servers（配置解析 + 脱敏）
const servers = await call('servers')
check('servers 返回 1 台且脱敏', servers.servers?.length === 1 && servers.servers[0].hasToken === true && !JSON.stringify(servers).includes(TOKEN))

// 2) health
const health = await call('health')
check('health status=ok 且 exec_enabled', health.body?.status === 'ok' && health.body?.exec_enabled === true)

// 3) probe（health + MCP initialize + whoami 全链路）
const probe = await call('probe')
check('probe 成功', probe.ok === true && /连接正常/.test(String(probe.summary)))
console.log(`  summary: ${probe.summary}`)

// 4) whoami（作用域/根目录）
const whoami = await call('whoami')
const identity = JSON.parse(whoami.text)
check('whoami 含 read+exec 作用域', Array.isArray(identity.scopes) && identity.scopes.includes('read') && identity.scopes.includes('exec'))
console.log(`  roots: ${JSON.stringify(identity.roots)}`)

// 5) list_files（第一个根目录）
const roots = identity.roots ?? []
const listRaw = await call('list_files', { max_entries: 20 })
const list = JSON.parse(listRaw.text)
check('list_files 返回条目', list.entries?.length > 0 && Array.isArray(list.entries))
console.log(`  root: ${list.root}, entries: ${list.entries?.length}`)

// 6) read_file_lines（读一个真实文件：/tmp/nohup.out 若存在）
// 注意：read_file_lines 是唯一返回「原始文本」的工具（其余工具走 JSON 信封）。
const nohup = list.entries.find((e) => e.name === 'nohup.out' && e.kind === 'file')
if (nohup) {
  const read = await call('read_file_lines', { path: `${list.root}/nohup.out`, start_line: 1, end_line: 5, with_line_numbers: true })
  check('read_file_lines 有内容', typeof read.text === 'string' && read.text.length > 0 && /^\s*1\t/.test(read.text))
  console.log(`  first line: ${read.text?.split('\n')[0]?.slice(0, 60)}`)
} else {
  console.log('  （根目录无 nohup.out，跳过 read_file_lines）')
}

// 7) exec_script（python 跨平台探针）
const exec = await call('exec_script', { interpreter: 'python', cwd: roots[0] ?? '/tmp', script: 'import sys; print(sys.version)' })
const outcome = JSON.parse(exec.text)
check('exec_script exit_code=0 且未超时', outcome.exit_code === 0 && outcome.timed_out === false)
console.log(`  python: ${outcome.stdout?.split('\n')[0]}`)

// 8) exec_script 超时路径（sleep 3s + 1s 超时 → timed_out）
const timed = await call('exec_script', { interpreter: 'python', cwd: roots[0] ?? '/tmp', script: 'import time; time.sleep(3); print("late")', timeout_secs: 1 })
const timedOutcome = JSON.parse(timed.text)
check('exec_script 超时被 kill（timed_out=true）', timedOutcome.timed_out === true)

// 9) diagnose（health + whoami + 系统探测 三步报告）
const diagnose = await call('diagnose')
check('diagnose 三步全过', diagnose.ok === true && diagnose.steps?.length === 3 && diagnose.steps.every((s) => s.ok === true))
console.log(`  summary: ${diagnose.summary}`)

if (failures.length > 0) {
  console.error(`\n${failures.length} 项联调失败`)
  process.exit(1)
}
console.log('\n真机联调全部通过')
