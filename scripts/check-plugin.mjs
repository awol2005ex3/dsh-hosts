/**
 * 宿主半冒烟检查：模拟 cordis 环境加载 lib/index.js，
 * 验证四大导出、工具注册、RPC 路由注册，并用本地假的 host_server_mcp
 * （SSE 帧 + 会话头）走通 probe / exec_script 全链路。
 *
 * 运行：npm run build && node scripts/check-plugin.mjs
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

const pluginUrl = new URL('../lib/index.js', import.meta.url)

const failures = []
const check = (label, cond) => {
  console.log(`${cond ? '✔' : '✘'} ${label}`)
  if (!cond) failures.push(label)
}

/* ── 假的 host_server_mcp：SSE 帧 + Mcp-Session-Id 会话 ────────────────── */

const SESSION_ID = 'fake-session-1'

function sse(payload, id) {
  return `data: \nid: 0/${id}\nretry: 3000\n\ndata: ${JSON.stringify(payload)}\nid: 1/${id}\n\n`
}

const fakeServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', exec_enabled: true, tokens: 1 }))
    return
  }
  if (req.method !== 'POST' || req.url !== '/mcp') {
    res.writeHead(404)
    res.end()
    return
  }
  const auth = req.headers.authorization
  if (auth !== 'Bearer fake-token') {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized', message: '令牌无效' }))
    return
  }
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const msg = JSON.parse(body)
    const sid = req.headers['mcp-session-id']
    // initialize 无需会话头（同真机）：先按方法分流。
    if (msg.method === 'initialize') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'mcp-session-id': SESSION_ID,
      })
      res.end(sse({
        jsonrpc: '2.0', id: msg.id,
        result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'host-server-mcp', version: '0.0.1' } },
      }, msg.id))
      return
    }
    if (!sid) {
      // 非 initialize 且无会话：422（同真机）
      res.writeHead(422, { 'content-type': 'text/plain' })
      res.end('Unexpected message, expect initialize request')
      return
    }
    if (msg.method === 'notifications/initialized') {
      res.writeHead(202)
      res.end()
      return
    }
    if (msg.method === 'tools/call') {
      const name = msg.params?.name
      const args = msg.params?.arguments ?? {}
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (name === 'whoami') {
        res.end(sse({
          jsonrpc: '2.0', id: msg.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ token_id: 'fake', scopes: ['read', 'exec'], roots: ['/tmp'] }) }],
            isError: false,
          },
        }, msg.id))
        return
      }
      if (name === 'exec_script') {
        res.end(sse({
          jsonrpc: '2.0', id: msg.id,
          result: {
            // 真机 json_result 用 to_string_pretty，这里对齐（带缩进与空格）
            content: [{ type: 'text', text: JSON.stringify({
              interpreter: args.interpreter ?? 'python',
              exit_code: 0, timed_out: false, duration_ms: 5, timeout_secs: args.timeout_secs ?? 10,
              cwd: args.cwd ?? '/tmp', stdout: `ran: ${String(args.script).slice(0, 40)}`, stderr: '',
              stdout_bytes: 40, stderr_bytes: 0, stdout_truncated: false, stderr_truncated: false,
            }, null, 2) }],
            isError: false,
          },
        }, msg.id))
        return
      }
      res.end(sse({
        jsonrpc: '2.0', id: msg.id,
        error: { code: -32602, message: 'tool not found' },
      }, msg.id))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: String(msg.method) } }, msg.id))
  })
})

await new Promise((resolve) => fakeServer.listen(0, '127.0.0.1', resolve))
const fakePort = fakeServer.address().port
console.log(`fake host_server_mcp listening on 127.0.0.1:${fakePort}`)

/* ── 加载插件主入口 ── */
let plugin
try {
  plugin = await import(pluginUrl.href)
} catch (err) {
  console.error('✘ lib/index.js 加载失败:', err)
  fakeServer.close()
  process.exit(1)
}

check('name 导出 = dsh-host-mcp', plugin.name === 'dsh-host-mcp')
check('inject 含 connection + tools', Array.isArray(plugin.inject)
  && plugin.inject.includes('connection') && plugin.inject.includes('tools'))
check('Config schema 存在（schemastery schema 为对象/函数形态）', typeof plugin.Config === 'object' || typeof plugin.Config === 'function')
check('apply 是函数', typeof plugin.apply === 'function')

/* ── 模拟宿主环境 ── */
const registeredRoutes = []
const registeredTools = []
const disposers = []

const fakeConnection = {
  fetch: {
    register(route) {
      registeredRoutes.push(route)
      const remove = async () => {
        const i = registeredRoutes.indexOf(route)
        if (i >= 0) registeredRoutes.splice(i, 1)
      }
      disposers.push(remove)
      return remove
    },
  },
}

const fakeTools = {
  register(tool) {
    registeredTools.push(tool)
    return () => {
      const i = registeredTools.indexOf(tool)
      if (i >= 0) registeredTools.splice(i, 1)
    }
  },
}

const fakeCtx = {
  logger: () => ({
    info: () => {},
    warn: (msg, ...args) => console.log('  [warn]', msg, ...args),
    error: (msg, ...args) => console.log('  [error]', msg, ...args),
  }),
  get: (name) => (name === 'connection' ? fakeConnection : name === 'tools' ? fakeTools : undefined),
  effect: (fn) => {
    const dispose = fn()
    disposers.push(() => dispose?.())
    return dispose
  },
}

// 带一台假服务器的测试配置（volatile 引用形式，get() 现读）
const config = {
  servers: {
    get: () => JSON.stringify([
      { id: 'fake', host: '127.0.0.1', port: fakePort, token: 'fake-token', mcpPath: '/mcp' },
      // 指向同一个假服务器但没配 token：health 可通过，MCP 端点应提示填 token
      { id: 'no-token', host: '127.0.0.1', port: fakePort, token: '', mcpPath: '/mcp' },
    ]),
  },
  defaultServer: { get: () => 'fake' },
  requestTimeoutMs: { get: () => 5000 },
}

/* ── apply ── */
try {
  plugin.apply(fakeCtx, config)
} catch (err) {
  console.error('✘ apply 抛错:', err)
  fakeServer.close()
  process.exit(1)
}

check('注册了 12 条 /api/host-mcp/* 路由', registeredRoutes.length === 12)
check('路由全部在 /api/host-mcp 下', registeredRoutes.every((r) => r.path.startsWith('/api/host-mcp/')))
check('路由全部 POST + buffered', registeredRoutes.every((r) => r.methods.length === 1 && r.methods[0] === 'POST' && r.requestBody === 'buffered'))
check('注册了 1 个 host-mcp 工具', registeredTools.length === 1 && registeredTools[0].name === 'host-mcp')

/* ── 通过 Fetch 路由调用 RPC（绕过 HTTP，直接调 fetch handler） ── */
const route = (path) => registeredRoutes.find((r) => r.path === path)
const callRoute = async (endpoint, args) => {
  const r = route(`/api/host-mcp/${endpoint}`)
  if (!r) throw new Error(`route ${endpoint} not found`)
  const request = new Request(`http://localhost/api/host-mcp/${endpoint}`, {
    method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'test-1', method: `host-mcp/${endpoint}`, payload: { args } }),
  })
  const response = await r.fetch(request)
  if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  const body = await response.json()
  if (body.type !== 'server-response' || body.rpcId !== 'test-1') throw new Error(`bad envelope: ${JSON.stringify(body)}`)
  return body.result
}

// version / servers（无需真实服务器）
const version = await callRoute('version', {})
check('version 返回插件版本', version.ok && version.value?.version === '0.1.0')

const list = await callRoute('servers', {})
check('servers 返回 2 台服务器', list.ok && list.value?.servers?.length === 2)
check('servers 默认服务器 = fake', list.value?.defaultServer === 'fake')
check('servers 脱敏（无 token 明文）', !JSON.stringify(list.value).includes('fake-token'))

// health（对假服务器）
const health = await callRoute('health', { server: 'fake' })
check('health 返回 200 body', health.ok && health.value?.status === 200 && health.value?.body?.status === 'ok')

// probe（对假服务器）
const probe = await callRoute('probe', { server: 'fake' })
check('probe 成功（health + MCP + whoami）', probe.ok && probe.value?.ok === true && probe.value?.summary?.includes('连接正常'))

// probe（无 token 的服务器 → 明确报错）
const probeNoToken = await callRoute('probe', { server: 'no-token' })
check('probe 无 token → 提示填 token', probeNoToken.ok === true && probeNoToken.value?.ok === false && String(probeNoToken.value?.summary).includes('token'))

// probe_uncached（配置页「测试连接」：接受未保存的行定义，不查已存配置）
const probeUncached = await callRoute('probe_uncached', {
  host: '127.0.0.1', port: fakePort, token: 'fake-token', mcpPath: '/mcp',
})
check('probe_uncached 探测未保存的行成功',
  probeUncached.ok && probeUncached.value?.ok === true && probeUncached.value?.summary?.includes('连接正常'))
check('probe_uncached 回包不含 token 明文', !JSON.stringify(probeUncached.value).includes('fake-token'))
const probeUncachedBad = await callRoute('probe_uncached', { host: '', port: 8765, token: 'x' })
check('probe_uncached 缺主机名 → 明确报错', !probeUncachedBad.ok && /未填主机名/.test(probeUncachedBad.error?.message ?? ''))

// exec_script（对假服务器，验证会话建立 + 结果解析 + 默认超时注入）
const exec = await callRoute('exec_script', { server: 'fake', script: 'print(1)', interpreter: 'python' })
check('exec_script 成功且解析 stdout', exec.ok && exec.value?.isError === false && exec.value?.text?.includes('ran: print(1)'))
check('exec_script 注入默认超时', exec.value?.text?.includes('"timeout_secs": 10'))

// 未知服务器 → 业务错误
const missing = await callRoute('whoami', { server: 'nope' })
check('未知服务器 → ok:false + 可读错误', !missing.ok && /未配置/.test(missing.error?.message ?? ''))

// 信封畸形：method 不匹配 → gateway/bad-request
const r = route('/api/host-mcp/version')
const badResp = await r.fetch(new Request('http://localhost/api/host-mcp/version', {
  method: 'POST',
  body: JSON.stringify({ type: 'client-request', rpcId: 'x', method: 'host-mcp/other', payload: {} }),
}))
const badBody = await badResp.json()
check('method 不匹配 → gateway/bad-request', badResp.status === 200 && badBody.result?.error?.code === 'gateway/bad-request')

// 非 JSON body → 400
const notJson = await r.fetch(new Request('http://localhost/api/host-mcp/version', { method: 'POST', body: 'not-json' }))
check('非 JSON body → HTTP 400', notJson.status === 400)

// ── 两侧载荷契约：浏览器半实际发的 payload 必须能被宿主半解出参数 ──────────
// 背景：曾出现浏览器半发扁平 payload、宿主半读 payload.args 的错配，
// 表现为「未填主机名」这类看似无关的报错，而宿主半自身的冒烟测试全绿
// （它用的正是正确形态，等于没测到浏览器侧）。这里直接加载编译后的浏览器半，
// 喂一个记录载荷的假 connection，断言它包了 { args }；再把该载荷原样送给
// 真实宿主半路由，验证参数真的到达处理器。
{
  const wrapped = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // 产物必须只包装一层：多层包装会让浏览器装载时报 duplicate factory
  // registration、整个插件激活失败（wrap-client.mjs 已做成幂等，此断言兜底）。
  const loadCalls = (wrapped.match(/__ModuleLoader__\.load\(/g) ?? []).length
  check('浏览器半产物恰好包装一层（load() 调用 = 1）', loadCalls === 1, `实际 ${loadCalls} 处`)
  const start = wrapped.indexOf('factory: (require) => {')
  const bodyStart = start + 'factory: (require) => {'.length
  const bodyEnd = wrapped.lastIndexOf('return module.exports; } });')
  check('浏览器半产物是包好的模块工厂', start > 0 && bodyEnd > bodyStart)

  const makeNode = () => ({
    style: {},
    children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    dataset: {},
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    id: '',
    childElementCount: 0,
    setAttribute() {},
    getAttribute: () => null,
    append(...nodes) { this.children.push(...nodes); this.childElementCount = this.children.length },
    appendChild(node) { this.children.push(node); this.childElementCount = this.children.length; return node },
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    click() {},
    focus() {},
    cloneNode() { return makeNode() },
  })
  const sandbox = {
    exports: {},
    require: (id) => { if (id === 'react') return {}; throw new Error(`unexpected require ${id}`) },
    console,
    window: {},
    document: {
      createElement: () => makeNode(),
      createTextNode: (t) => ({ textContent: t }),
      body: makeNode(),
    },
    setTimeout,
    clearTimeout,
    fetch: () => Promise.reject(new Error('测试沙箱内不发起真实请求')),
  }
  // 工厂体内部声明 `var module = { exports: {} }`，末尾 `module.exports = {...}`。
  // 该 var 落在 vm 的全局对象上，故从 sandbox.module 取导出。
  vm.runInNewContext(wrapped.slice(bodyStart, bodyEnd), sandbox, { filename: 'client-factory.js' })
  const clientExports = sandbox.module?.exports
  check('浏览器半导出 apply', typeof clientExports?.apply === 'function')

  // 用假 connection 触发一次浏览器半的 RPC 路径：apply 会建运维面板并调用
  // servers 端点，这里只需抓它发出的载荷形态。
  let captured = null
  const fakeConn = {
    rpc: {
      call: async (channel, method, payload) => {
        captured = { channel, method, payload }
        return { ok: true, value: { servers: [], defaultServer: '' } }
      },
    },
  }
  clientExports.apply({
    get: (name) => {
      if (name === 'connection') return fakeConn
      if (name === 'slots') return { inject: () => () => {}, register: () => () => {}, specDynamic: () => false }
      return undefined
    },
    effect: (fn) => fn(),
    logger: () => ({ info() {}, warn() {}, error() {} }),
  })
  // 运维面板的首次 servers 拉取是异步的，等一拍
  await new Promise((r) => setTimeout(r, 50))
  check('浏览器半确实发出了 RPC', captured !== null, captured?.method)
  check('浏览器半走 /api 通道 + host-mcp/ 前缀', captured?.channel === '/api' && String(captured?.method).startsWith('host-mcp/'))
  check('浏览器半载荷包在 { args } 里（与宿主半 payload.args 约定一致）',
    captured?.payload !== null && typeof captured?.payload === 'object'
    && Object.hasOwn(captured.payload, 'args') && !Object.hasOwn(captured.payload, 'servers'))

  // 把浏览器半真实发出的载荷原样交给宿主半路由，验证参数贯通
  if (captured?.payload) {
    const r = route(`/api/host-mcp/${String(captured.method).slice('host-mcp/'.length)}`)
    const response = await r.fetch(new Request('http://localhost/api/host-mcp/servers', {
      method: 'POST',
      body: JSON.stringify({ type: 'client-request', rpcId: 'contract-1', method: captured.method, payload: captured.payload }),
    }))
    const body = await response.json()
    check('浏览器半载荷被宿主半正确解出（rpcId 回传一致）', body.rpcId === 'contract-1' && body.result?.ok === true)
  }
}

/* ── 工具 execute 烟测（直接调注册好的工具定义） ── */
const tool = registeredTools[0]
const execCtx = { signal: undefined }
const toolOk = await tool.execute({ action: 'servers', args: {} }, execCtx)
check('工具 servers 调用成功', toolOk.ok === true && toolOk.result.includes('fake'))

const toolProbe = await tool.execute({ action: 'probe', server: 'fake', args: {} }, execCtx)
check('工具 probe 成功', toolProbe.ok === true && toolProbe.result.includes('连接正常'))

const toolBad = await tool.execute({ action: 'whoami', server: 'nope', args: {} }, execCtx)
check('工具未知服务器 → ok:false + 错误消息', toolBad.ok === false && /未配置/.test(toolBad.result))

const toolBadAction = await tool.execute({ action: 'nope', args: {} }, execCtx).catch((err) => ({ thrown: err }))
check('工具未知 action → 抛错（模型能读到可用清单）', Boolean(toolBadAction.thrown) && /unknown action/.test(String(toolBadAction.thrown)))

/* ── disposer 幂等 ── */
for (const d of [...disposers]) await d()
check('disposer 解除后路由清空', registeredRoutes.length === 0)
check('disposer 解除后工具清空', registeredTools.length === 0)

fakeServer.close()

/* ── 结论 ── */
if (failures.length > 0) {
  console.error(`\n${failures.length} 项检查失败`)
  process.exit(1)
}
console.log('\n全部检查通过')
