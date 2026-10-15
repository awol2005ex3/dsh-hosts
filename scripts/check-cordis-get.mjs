/**
 * 真 cordis 复现：从兄弟 fiber 用 ctx.get() 读服务，验证 service() 助手与
 * configChannel 的现取逻辑在真实运行时可用。
 *
 * 运行：node scripts/check-cordis-get.mjs
 */
import { createRequire } from 'node:module'

const require = createRequire('D:/workspace_node/dsh-hosts/package.json')
const { Context } = require('@deepseek-ai/cordis')

const failures = []
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '✔' : '✘'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!cond) failures.push(label)
}

// 与 client.ts 完全相同的 service() 助手
function service(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(name)
    return ctx?.[name]
  } catch {
    return undefined
  }
}

const root = new Context()

// fiber A：先启动，扮演「早于提供者」的插件 fiber
const seenByA = []
root.plugin(function pluginA(ctx) {
  seenByA.push(service(ctx, 'configForms'))
})

// fiber B：提供 configForms（扮演 ui-settings）
root.plugin(function pluginB(ctx) {
  ctx.provide('configForms', {
    get: (ns) => ({ namespace: ns, getSnapshot: () => ({ status: 'ready', value: {} }) }),
  })
})

// fiber C：后启动，扮演本插件的 fiber
const seenByC = []
root.plugin(function pluginC(ctx) {
  seenByC.push(service(ctx, 'configForms'))
})

await root.fiber.await()

console.log(`  fiber A（先启动）看到: ${seenByA[0] === undefined ? 'undefined' : 'service'}`)
console.log(`  fiber C（后启动）看到: ${seenByC[0] === undefined ? 'undefined' : 'service'}`)
// 反面对照（cordis 4 isolate 语义，预期如此，不是 bug）：
// 兄弟 fiber 内 ctx.get('configForms') 读不到——这正是用户遇到的现象。
check('反面对照：兄弟 fiber 内 ctx.get 读不到（证实必须走 inject）', seenByC[0] === undefined)

// 关键验证：现取在启动后任意时刻都有效（configChannel 的依赖）
let late
root.plugin(function pluginD(ctx) {
  late = service(ctx, 'configForms')
})
await root.fiber.await()
check('后注册的 fiber 也能现取到', late !== undefined)

// ── 正确解法验证：ctx.inject 跨 isolate 读服务 ─────────────────────────────
// ctx.get 只在本 isolate scope 有效（兄弟 fiber 读不到）；inject 创建**子
// fiber** 并等依赖就绪后跑回调，是 cordis 4 跨 fiber 读服务的正规通道。
// 顺序：先 inject（子 fiber 挂起等待），再 provide（唤醒）。
const injected = []
let injectCallCount = 0
const injectFiber = root.inject(['configForms'], (ctx2) => {
  injectCallCount += 1
  injected.push(service(ctx2, 'configForms'))
})
root.plugin(function provider2(ctx) {
  ctx.provide('configForms', {
    get: (ns) => ({ namespace: ns, getSnapshot: () => ({ status: 'ready', value: {} }) }),
  })
})
await root.fiber.await()
check('ctx.inject 回调被执行', injectCallCount > 0, `回调 ${injectCallCount} 次`)
check('ctx.inject 里能读到 configForms', injected[0] !== undefined,
  injected[0] === undefined ? 'undefined' : 'service')
check('ctx.inject 读到的服务有 get()', typeof injected[0]?.get === 'function')
check('ctx.inject 读到的 get(ns) 可用', injected[0]?.get('host-mcp')?.namespace === 'host-mcp')
void injectFiber

// 直接在任何时刻从 root 读（对照：root scope 与兄弟 fiber scope 不同）
check('反面对照：root 上现取 configForms', service(root, 'configForms') !== undefined)

if (failures.length > 0) {
  console.error(`\n${failures.length} 项检查失败`)
  process.exit(1)
}
console.log('\ncordis 服务访问验证通过：ctx.inject 是跨 fiber 读服务的唯一正规通道')
