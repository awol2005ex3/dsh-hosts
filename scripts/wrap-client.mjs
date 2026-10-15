/**
 * 把 tsc 产出的 lib/client.js 包成浏览器模块工厂。
 *
 * 契约（同 dsh-hdfs/scripts/wrap-client.mjs）：client-modules 经
 * /plugins/<id>/client.js 取到本文件后，用 `window.__ModuleLoader__.load`
 * 执行；工厂返回 `module.exports`（{ name, inject, apply }）。
 *
 * ⚠ 本脚本**幂等**：若 lib/client.js 已带包装（tsc 没重跑时重复执行本脚本
 * 的场景），先剥掉旧包装再重新包。否则文件里会出现两个
 * `__ModuleLoader__.load(...)` 调用，浏览器装载时报
 * 「duplicate factory registration for "dsh-host-mcp"」、整个插件激活失败
 * （2026-10-14 实测踩坑）。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const id = 'dsh-host-mcp'
const path = new URL('../lib/client.js', import.meta.url)

const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`
// 装载期诊断：浏览器只会显示「N entry did not activate / dsh-host-mcp: failed」，
// 真实原因只在控制台。这里包一层 try/catch，把错误与栈带标签送到 console.error。
const intro = [
  'var module = { exports: {} }; var exports = module.exports;',
  'try {',
].join('\n')
const footer = [
  '} catch (error) {',
  "  console.error('[dsh-host-mcp] client half load failed:', (error && error.stack) || error);",
  '  throw error;',
  '}',
  'return module.exports; } });',
].join('\n')

let body = readFileSync(path, 'utf8')

// 幂等：剥掉旧包装（只剥一层——外层剥掉后露出的若是再次包装的产物，
// 结构同样匹配 intro/footer，循环剥净）。
let unwrapped = false
for (;;) {
  const start = body.indexOf(`${banner}\n${intro}\n`)
  if (start < 0) break
  const end = body.lastIndexOf(footer)
  if (end < 0) break
  body = body.slice(start + banner.length + 1 + intro.length + 1, end)
  unwrapped = true
}
if (unwrapped) console.log(`wrap-client: 检测到旧包装已剥离，重新包装一次`)

body = body.replace(/\nexport \{\};?\s*$/, '\n')

writeFileSync(path, `${banner}\n${intro}\n${body}${footer}\n`)
console.log(`wrap-client: ${path.pathname} wrapped as ${id}`)
