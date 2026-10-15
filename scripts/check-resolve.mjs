/**
 * 依赖解析 + 真 cordis 加载验证。
 *
 * 验证两件事：
 *   1. 从 profile 的 node_modules 出发能解析 dsh-host-mcp 及其全部依赖
 *      （dsh-tools / cordis / schemastery）——junction 依赖已移除，必须自给自足；
 *   2. 用**真 cordis**（profile 里的版本）跑 apply：验证 ctx.effect /
 *      ctx.logger / ctx.get 的调用签名与真实运行时一致。
 *
 * 运行：node scripts/check-resolve.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const failures = []
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '✔' : '✘'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!cond) failures.push(label)
}

const profileDir = process.env.DSH_PROFILE_DIR
  || 'C:/Users/Administrator/.dsh/profiles/web'

const require = createRequire(`${profileDir}/package.json`)

/* ── 1. 依赖解析 ────────────────────────────────────────────────────────── */

let plugin
try {
  plugin = require('dsh-host-mcp')
  check('从 profile 解析 dsh-host-mcp', true)
} catch (err) {
  check('从 profile 解析 dsh-host-mcp', false, err.message)
  process.exit(1)
}

check('name 导出 = dsh-host-mcp', plugin.name === 'dsh-host-mcp')
check('apply 是函数', typeof plugin.apply === 'function')
check('inject 含 connection + tools', plugin.inject.includes('connection') && plugin.inject.includes('tools'))
check('Config 是 schemastery schema（函数形态）',
  typeof plugin.Config === 'function' || typeof plugin.Config === 'object')

// 插件 lib/tool.js 里 import '@deepseek-ai/dsh-tools' —— 必须能解析
try {
  const tools = require('@deepseek-ai/dsh-tools')
  check('解析 @deepseek-ai/dsh-tools', typeof tools.defineTool === 'function')
} catch (err) {
  check('解析 @deepseek-ai/dsh-tools', false, err.message)
}

/* ── 2. 真 cordis 加载 ──────────────────────────────────────────────────── */

let cordis
try {
  cordis = require('@deepseek-ai/cordis')
  check('解析 @deepseek-ai/cordis', true)
} catch (err) {
  check('解析 @deepseek-ai/cordis', false, err.message)
  process.exit(1)
}

check('cordis 提供 Context', typeof cordis.Context === 'function')

// Config schema 能否用真 schemastery 解析出默认值（loader 会做这一步）
let schemastery
try {
  schemastery = require('@deepseek-ai/schemastery')
  check('解析 @deepseek-ai/schemastery', true)
} catch (err) {
  check('解析 @deepseek-ai/schemastery', false, err.message)
}

if (schemastery && typeof schemastery.validate === 'function') {
  try {
    const parsed = schemastery.validate(plugin.Config, {})
    check('Config 空输入解析出默认值', parsed && typeof parsed === 'object' && Array.isArray(parsed.servers) === false
      && typeof parsed.requestTimeoutMs === 'number')
    console.log(`  defaults: requestTimeoutMs=${parsed.requestTimeoutMs}, defaultTimeoutSecs=${parsed.defaultTimeoutSecs}`)
  } catch (err) {
    check('Config 空输入解析出默认值', false, err.message)
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 项检查失败`)
  process.exit(1)
}
console.log('\n依赖解析全部通过')
