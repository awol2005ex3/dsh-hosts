/**
 * dsh-host-mcp · 浏览器端 bundle 模块体。
 *
 * 构建契约同 dsh-hdfs/src/client.ts：本文件经 tsc 编译后，由
 * scripts/wrap-client.mjs 包上闭包工厂外壳（无 ESM 语法，module.exports 返回
 * { name, inject, apply }）。因此本文件不得出现 import/export 语句。
 *
 * 功能：
 * 1. **服务器配置页**（设置 → 插件 → host-mcp，`settings.plugins.tab` 插槽）：
 *    结构化编辑服务器列表（host + port + token + 备注 + 默认选择），保存走官方
 *    configForms（volatile 字段落盘 + 宿主热更新）；附 JSON 高级编辑与逐台测试。
 * 2. **运维面板**（侧边栏 footer 按钮切换的浮动面板）：文件浏览 / 脚本执行 /
 *    一键诊断（probe + diagnose），全部经 /api/host-mcp/* 精确路由走宿主半。
 *
 * ⚠ RPC 通道固定 /api：宿主端是 connection.fetch.register() 注册的精确路由
 * （0.1.5 起 rpc.handle 对插件失效），只有 /api 前缀才会被路由表命中。
 */

const PLUGIN_ID = 'dsh-host-mcp'
const SETTINGS_NS = 'host-mcp'
const RPC_CHANNEL = '/api'
const RPC_PREFIX = 'host-mcp/'

declare const module: { exports: unknown }
declare function require(id: string): unknown

const win = window as unknown as { __dshHostMcpMounted?: boolean }
const doc = document

/* ── 工具函数 ─────────────────────────────────────────────────────────── */

type ElProps = { style?: string; [key: string]: unknown }

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElProps,
  children?: (Node | string)[],
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag)
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (key === 'style') node.setAttribute('style', value as string)
      else (node as unknown as Record<string, unknown>)[key] = value
    }
  }
  if (children) {
    for (const c of children) node.append(typeof c === 'string' ? doc.createTextNode(c) : c)
  }
  return node
}

function fmtBytes(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '-'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  let i = -1
  do { v /= 1024; i += 1 } while (v >= 1024 && i < units.length - 1)
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

/** 安全地取一个服务（cordis 4 严格 inject：属性访问会抛，get 不受限制）。 */
function service(ctx: any, name: string): any {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(name)
    return ctx?.[name]
  } catch {
    return undefined
  }
}

/* ── RPC ──────────────────────────────────────────────────────────────── */

interface RpcResponse {
  ok: boolean
  value?: any
  error?: { code: string; message: string; details?: any }
}

/**
 * 调一个宿主半端点。
 *
 * ⚠ 载荷必须包一层 `{ args }`：宿主半读 `envelope.payload.args`
 * （见 src/rpc.ts），与 dsh-hdfs 的约定一致。直接发扁平对象会让所有参数
 * 静默丢失（表现为「未填主机名」这类看似无关的报错）。
 */
async function callRpc(conn: any, endpoint: string, args?: Record<string, unknown>): Promise<any> {
  // rpcId 由浏览器连接传输自动生成并回传，调用方不需要提供。
  const res = (await conn.rpc.call(
    RPC_CHANNEL,
    `${RPC_PREFIX}${endpoint}`,
    { args: args ?? {} },
  )) as RpcResponse
  if (!res || res.ok !== true) {
    throw new Error(res?.error?.message ?? 'rpc error')
  }
  return res.value
}

/**
 * MCP 透传端点的 RPC 值统一是 `{isError, text}`（text 为服务端 JSON 信封字符串，
 * 唯 read_file_lines 是原始文本）。此助手把可解析的 JSON 信封还原成对象。
 */
function toolData(value: any): any {
  if (typeof value?.text !== 'string') return value
  try {
    return JSON.parse(value.text)
  } catch {
    return { raw: value.text, isError: value.isError === true }
  }
}

/* ── 配置读写（官方 configForms） ─────────────────────────────────────── */

interface ServerRow {
  id: string
  host: string
  port: number
  token: string
  mcpPath: string
  note: string
  /** 编辑器内部标记：default 服务器 */
  isDefault: boolean
}

interface ConfigChannel {
  read(): Promise<{ rows: ServerRow[]; error?: string }>
  write(rows: ServerRow[], defaultId: string): Promise<void>
}

/**
 * 配置读写通道：ctx.configForms.get(SETTINGS_NS)（volatile 字段落盘 + 热更新）。
 *
 * ⚠ **必须在 `ctx.inject(['configForms'], …)` 的回调里构造**，不能直接
 * `ctx.get('configForms')`。cordis 4 的 `ctx.get(name)` 只读**当前 fiber 自己
 * 的 isolate scope**（`_getImpl` 用 `this.ctx[symbols.isolate][name]` 取 key），
 * 而 `provide` 写在提供者 fiber 的 scope 里——兄弟 fiber 之间 `get` 必然返回
 * undefined（已用真 cordis 实测复现，见 scripts/check-cordis-get.mjs）。
 * `ctx.inject` 创建子 fiber 并等依赖就绪后跑回调，是跨 fiber 读服务的唯一
 * 正规通道。
 *
 * @param formsCtx - inject 回调给出的 ctx（其 isolate scope 含 configForms）。
 */
function configChannel(formsCtx: any): ConfigChannel {
  const forms = (): any => {
    const svc = service(formsCtx, 'configForms')
    if (!svc || typeof svc.get !== 'function') {
      throw new Error('宿主配置服务不可用（configForms 未提供）')
    }
    return svc
  }

  const form = (): any => forms().get(SETTINGS_NS)

  /**
   * 等表单快照就绪。
   *
   * ⚠ 不在入口调 `ensure()` 预检：`configForms.describe()` 的镜像异步拉取
   * （启动时 idle，要等宿主 remote.settings.describe 回来才填 view.namespaces），
   * 启动瞬间探测必然失败——那正是「宿主配置镜像未包含 host-mcp」误报的来源。
   * 表单控制器自己订阅镜像：命名空间缺席时把 status 置为 `unavailable`，这才是
   * 权威判定，故这里只等 `ready` / 观察 `unavailable`。
   */
  async function waitReady(): Promise<any> {
    let scope: any
    try {
      scope = form()
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err))
    }
    const snap = scope.getSnapshot()
    if (snap?.status === 'ready') return snap
    return new Promise((resolve, reject) => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        off?.()
        const current = scope.getSnapshot()
        reject(new Error(current?.status === 'unavailable'
          ? '宿主配置镜像未包含 host-mcp（插件未安装或未启用）'
          : '读取配置超时（宿主配置镜像未就绪）'))
      }, 15000)
      const off = typeof scope.subscribe === 'function' ? scope.subscribe(check) : undefined
      function check(): void {
        if (done) return
        const s = scope.getSnapshot()
        if (s?.status === 'ready') {
          done = true
          clearTimeout(timer)
          off?.()
          resolve(s)
        } else if (s?.status === 'unavailable') {
          done = true
          clearTimeout(timer)
          off?.()
          reject(new Error('宿主配置镜像未包含 host-mcp（插件未安装或未启用）'))
        }
      }
    })
  }

  return {
    read: async () => {
      const snap = await waitReady()
      const value = snap.value ?? {}
      const rows = normalizeRows(value.servers, value.defaultServer)
      return { rows }
    },
    write: async (rows, defaultId) => {
      const snap = await waitReady()
      const json = JSON.stringify(
        rows.map((r) => ({
          id: r.id.trim() || undefined,
          host: r.host.trim(),
          port: r.port,
          token: r.token,
          mcpPath: r.mcpPath.trim() || '/mcp',
          note: r.note.trim() || undefined,
        })),
        null,
        2,
      )
      const ops = [
        { op: 'set', path: ['servers'], value: json },
        { op: 'set', path: ['defaultServer'], value: defaultId },
      ]
      await form().mutate(ops, snap.revision)
    },
  }
}

/**
 * 由 host:port 推导规范 id（与宿主半 `deriveServerId` 保持一致的镜像）。
 *
 * 浏览器半不 import 宿主模块，故此处手抄一份；改任一侧请同步另一侧
 * （scripts/check-plugin.mjs 末尾的两侧契约测试会验证）。
 */
function deriveServerId(host: string, port: number): string {
  return `${host}:${port}`.replace(/[^\w.-]+/g, '-') || 'server'
}

/** 把配置原始值归一成编辑器行（缺 id 时按 host:port 推导，保证默认标记能对上）。 */
function normalizeRows(raw: unknown, defaultServer: unknown): ServerRow[] {
  let arr: unknown[] = []
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) arr = parsed
    } catch {
      arr = []
    }
  } else if (Array.isArray(raw)) {
    arr = raw
  }
  const def = typeof defaultServer === 'string' ? defaultServer.trim() : ''
  const seen = new Set<string>()
  const rows: ServerRow[] = arr.map((item: any) => {
    const host = typeof item?.host === 'string' ? item.host : ''
    const port = typeof item?.port === 'number' ? item.port : Number.parseInt(String(item?.port ?? ''), 10) || 8765
    let id = typeof item?.id === 'string' && item.id.trim() ? item.id.trim() : ''
    if (!id && host) id = deriveServerId(host, port)
    // 去重（与宿主半 parseServers 一致：重复时加序号后缀）
    let unique = id
    for (let n = 2; seen.has(unique); n += 1) unique = `${id}-${n}`
    seen.add(unique)
    return {
      id: unique,
      host,
      port,
      token: typeof item?.token === 'string' ? item.token : '',
      mcpPath: typeof item?.mcpPath === 'string' ? item.mcpPath : '/mcp',
      note: typeof item?.note === 'string' ? item.note : '',
      isDefault: false,
    }
  })
  if (rows.length > 0) {
    // 旧数据 defaultServer 可能是 `host:port` 冒号形态，id 推导时已折叠成 `-`，
    // 故除精确匹配外再按推导 id 兜一次。
    const target = rows.find((r) => r.id === def)
      ?? rows.find((r) => r.host && deriveServerId(r.host, r.port) === def)
      ?? rows[0]
    if (target) target.isDefault = true
  }
  return rows
}

/* ── 样式 ─────────────────────────────────────────────────────────────── */

const LABEL_CSS = 'display:block;font-weight:600;margin-top:4px;'
const HINT_CSS = 'display:block;color:var(--fg-muted,#57606a);font-size:12px;margin:2px 0;'
const INPUT_CSS =
  'width:100%;box-sizing:border-box;padding:6px 8px;font-size:13px;font-family:inherit;' +
  'border:1px solid rgba(127,127,127,.4);border-radius:6px;background:var(--bg,#fff);color:inherit;'
const BTN_CSS =
  'padding:6px 14px;font-size:13px;cursor:pointer;border:1px solid rgba(127,127,127,.4);' +
  'background:var(--bg,#f6f8fa);color:inherit;border-radius:6px;'
const BTN_PRIMARY_CSS =
  'padding:6px 14px;font-size:13px;cursor:pointer;border:none;background:#1f6feb;color:#fff;border-radius:6px;'
const TABLE_CSS = 'width:100%;border-collapse:collapse;font-size:12.5px;'
const CELL_CSS = 'padding:4px 8px;border-bottom:1px solid rgba(127,127,127,.2);text-align:left;white-space:nowrap;'
const PRE_CSS =
  'max-height:320px;overflow:auto;padding:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;' +
  'font-size:12px;white-space:pre-wrap;word-break:break-all;border:1px solid rgba(127,127,127,.3);' +
  'border-radius:6px;background:var(--bg,#f6f8fa);margin:0;'
const STATUS_OK = 'color:#1a7f37;'
const STATUS_ERR = 'color:#cf222e;'

/* ── 配置面板（设置页：服务器列表编辑器） ─────────────────────────────── */

function buildConfigPanel(channel: ConfigChannel, conn: any): HTMLElement {
  const root = el('div', {
    style: 'color:var(--fg,#1f2328);font-size:13px;line-height:1.5;display:flex;flex-direction:column;gap:8px;',
    'data-dsh-host-mcp-config': 'true',
  })

  const status = el('div', { style: 'font-size:12.5px;', textContent: '' })
  const setStatus = (text: string, isError = false): void => {
    status.textContent = text
    status.setAttribute('style', `font-size:12.5px;${isError ? STATUS_ERR : STATUS_OK}`)
  }

  root.append(
    el('p', {
      style: HINT_CSS,
      textContent:
        '配置装有 host_server_mcp 的服务器（IP/主机名 + 端口 + token），保存后 agent 对话即可通过 host-mcp 工具访问它们排查问题。' +
        'token 会写入本机 profile 配置文件，请只填可信的内网服务器。',
    }),
  )

  /* 服务器行容器 */
  const list = el('div', { style: 'display:flex;flex-direction:column;gap:10px;' })
  root.append(list)

  function buildRow(row: ServerRow, index: number, total: number): HTMLElement {
    const box = el('div', {
      style: 'border:1px solid rgba(127,127,127,.3);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:6px;',
    })

    const head = el('div', { style: 'display:flex;align-items:center;gap:8px;' })
    const radio = el('input', { type: 'radio', name: 'dsh-host-mcp-default', title: '设为默认服务器' }) as HTMLInputElement
    radio.checked = row.isDefault
    radio.addEventListener('change', () => {
      if (radio.checked) {
        rows.forEach((r) => { r.isDefault = false })
        row.isDefault = true
        for (const other of list.querySelectorAll('input[type=radio]') as NodeListOf<HTMLInputElement>) {
          other.checked = other === radio
        }
      }
    })
    const label = el('span', { style: 'font-weight:600;', textContent: row.id || `服务器 ${index + 1}` })
    const spacer = el('span', { style: 'flex:1;' })
    const testBtn = el('button', { type: 'button', textContent: '测试连接', style: BTN_CSS + 'padding:3px 10px;font-size:12px;' }) as HTMLButtonElement
    const rmBtn = el('button', { type: 'button', textContent: '删除', style: BTN_CSS + 'padding:3px 10px;font-size:12px;color:#cf222e;' }) as HTMLButtonElement
    head.append(radio, label, spacer, testBtn, rmBtn)

    const grid = el('div', { style: 'display:grid;grid-template-columns:2fr 80px 3fr;gap:6px;align-items:end;' })
    const hostInput = el('input', { type: 'text', style: INPUT_CSS, placeholder: '主机名或 IP', spellcheck: 'false', value: row.host }) as HTMLInputElement
    const portInput = el('input', { type: 'number', style: INPUT_CSS, placeholder: '8765', value: String(row.port) }) as HTMLInputElement
    const tokenInput = el('input', { type: 'password', style: INPUT_CSS, placeholder: 'hsk_…（host_server_mcp token）', spellcheck: 'false', value: row.token }) as HTMLInputElement
    grid.append(
      el('div', {}, [el('label', { style: LABEL_CSS, textContent: '主机 / IP' }), hostInput]),
      el('div', {}, [el('label', { style: LABEL_CSS, textContent: '端口' }), portInput]),
      el('div', {}, [el('label', { style: LABEL_CSS, textContent: 'Token' }), tokenInput]),
    )

    const grid2 = el('div', { style: 'display:grid;grid-template-columns:1fr 2fr;gap:6px;align-items:end;' })
    const pathInput = el('input', { type: 'text', style: INPUT_CSS, placeholder: '/mcp', spellcheck: 'false', value: row.mcpPath }) as HTMLInputElement
    const noteInput = el('input', { type: 'text', style: INPUT_CSS, placeholder: '备注（可选）', value: row.note }) as HTMLInputElement
    grid2.append(
      el('div', {}, [el('label', { style: LABEL_CSS, textContent: 'MCP 路径' }), pathInput]),
      el('div', {}, [el('label', { style: LABEL_CSS, textContent: '备注' }), noteInput]),
    )

    hostInput.addEventListener('change', () => { row.host = hostInput.value })
    portInput.addEventListener('change', () => { row.port = Number.parseInt(portInput.value, 10) || 8765 })
    tokenInput.addEventListener('change', () => { row.token = tokenInput.value })
    pathInput.addEventListener('change', () => { row.mcpPath = pathInput.value })
    noteInput.addEventListener('change', () => { row.note = noteInput.value })
    // 输入时也同步（用户改完直接点保存的场景）
    for (const input of [hostInput, portInput, tokenInput, pathInput, noteInput]) {
      input.addEventListener('input', () => {
        row.host = hostInput.value
        row.port = Number.parseInt(portInput.value, 10) || 8765
        row.token = tokenInput.value
        row.mcpPath = pathInput.value
        row.note = noteInput.value
      })
    }

    testBtn.addEventListener('click', () => {
      void runTest(conn, row, setStatus)
    })
    rmBtn.addEventListener('click', () => {
      const i = rows.indexOf(row)
      if (i >= 0) rows.splice(i, 1)
      if (row.isDefault && rows.length > 0) rows[0]!.isDefault = true
      render()
      setStatus(`已删除 ${label.textContent}`)
    })
    void total

    box.append(head, grid, grid2)
    return box
  }

  const rows: ServerRow[] = []

  function render(): void {
    list.textContent = ''
    rows.forEach((row, i) => list.append(buildRow(row, i, rows.length)))
  }

  /* 底部操作区 */
  const addBtn = el('button', { type: 'button', textContent: '+ 添加服务器', style: BTN_CSS }) as HTMLButtonElement
  addBtn.addEventListener('click', () => {
    rows.push({ id: '', host: '', port: 8765, token: '', mcpPath: '/mcp', note: '', isDefault: rows.length === 0 })
    render()
  })
  const saveBtn = el('button', { type: 'button', textContent: '保存配置', style: BTN_PRIMARY_CSS }) as HTMLButtonElement
  saveBtn.addEventListener('click', () => {
    const invalid = rows.filter((r) => !r.host.trim())
    if (invalid.length > 0) {
      setStatus(`有 ${invalid.length} 台服务器未填主机名，请补全或删除`, true)
      return
    }
    const defRow = rows.find((r) => r.isDefault) ?? rows[0]
    setStatus('保存中…')
    void channel
      // defaultServer 必须写规范 id（deriveServerId 形态）——宿主半的
      // resolveDefaultId 虽能兜底旧的 `host:port` 冒号形态，但一次写对
      // 免得日后兜底逻辑变化踩空。
      .write(rows, defRow ? (defRow.id.trim() || deriveServerId(defRow.host.trim(), defRow.port)) : '')
      .then(() => setStatus('✔ 已保存，宿主热更新生效；agent 对话即可用 host-mcp 工具访问'))
      .catch((err) => setStatus(`✘ 保存失败：${err instanceof Error ? err.message : String(err)}`, true))
  })
  const reloadBtn = el('button', { type: 'button', textContent: '放弃修改', style: BTN_CSS }) as HTMLButtonElement
  reloadBtn.addEventListener('click', () => { void load() })

  /* JSON 高级编辑 */
  const jsonBox = el('textarea', { rows: '6', spellcheck: 'false', style: INPUT_CSS + 'font-family:ui-monospace,monospace;display:none;' }) as HTMLTextAreaElement
  const jsonToggle = el('button', { type: 'button', textContent: '高级：JSON 编辑', style: BTN_CSS + 'font-size:12px;' }) as HTMLButtonElement
  const jsonApply = el('button', { type: 'button', textContent: '从 JSON 应用', style: BTN_CSS + 'font-size:12px;display:none;' }) as HTMLButtonElement
  jsonToggle.addEventListener('click', () => {
    const shown = jsonBox.style.display !== 'none'
    if (shown) {
      jsonBox.style.display = 'none'
      jsonApply.style.display = 'none'
    } else {
      jsonBox.value = JSON.stringify(
        rows.map((r) => ({
          id: r.id || undefined, host: r.host, port: r.port, token: r.token, mcpPath: r.mcpPath, note: r.note || undefined,
        })),
        null,
        2,
      )
      jsonBox.style.display = ''
      jsonApply.style.display = ''
    }
  })
  jsonApply.addEventListener('click', () => {
    try {
      const parsed = JSON.parse(jsonBox.value)
      if (!Array.isArray(parsed)) throw new Error('必须是 JSON 数组')
      const fresh = normalizeRows(parsed, rows.find((r) => r.isDefault)?.id)
      rows.length = 0
      rows.push(...fresh)
      render()
      setStatus('✔ 已从 JSON 应用到编辑器（记得点保存配置落盘）')
    } catch (err) {
      setStatus(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`, true)
    }
  })

  root.append(
    el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' }, [addBtn, saveBtn, reloadBtn, jsonToggle]),
    jsonBox,
    jsonApply,
    status,
  )

  /** 载入当前配置到编辑器（镜像未就绪时自动重试，避免启动瞬间误报）。 */
  let loadAttempt = 0
  async function load(): Promise<void> {
    setStatus('读取配置…')
    try {
      const { rows: loaded, error } = await channel.read()
      loadAttempt = 0
      rows.length = 0
      rows.push(...loaded)
      render()
      setStatus(error ? `⚠ 配置解析警告：${error}` : `✔ 已加载 ${rows.length} 台服务器`, Boolean(error))
    } catch (err) {
      // 启动瞬间宿主配置镜像可能还没拉回来，等 2s 再试一次（最多 3 次）。
      loadAttempt += 1
      if (loadAttempt < 3) {
        setStatus(`配置镜像未就绪，${2}s 后重试（第 ${loadAttempt}/3 次）…`)
        setTimeout(() => { void load() }, 2000)
        return
      }
      setStatus(`✘ 读取配置失败：${err instanceof Error ? err.message : String(err)}`, true)
    }
  }

  void load()
  return root
}

/**
 * 测试一台服务器（保存前的预检：不依赖已落盘配置）。
 *
 * ⚠ **必须经宿主半 RPC，不能浏览器直连**：dsh 页面（127.0.0.1:3080）与目标
 * 服务器跨源，而 host_server_mcp 不返回 CORS 头，浏览器 `fetch` 会一律以
 * `Failed to fetch` 拒绝——与服务端是否可达无关（手动开标签页能通，因为那不是
 * 脚本发起的跨源请求）。宿主进程发 HTTP 无同源限制，故预检走
 * `probe_uncached` 端点。
 */
async function runTest(conn: any, row: ServerRow, setStatus: (t: string, e?: boolean) => void): Promise<void> {
  if (!row.host.trim()) {
    setStatus('未填主机名', true)
    return
  }
  setStatus(`测试 ${row.host.trim()}:${row.port || 8765} …`)
  try {
    const report = (await callRpc(conn, 'probe_uncached', {
      host: row.host.trim(),
      port: row.port || 8765,
      token: row.token,
      mcpPath: row.mcpPath.trim() || '/mcp',
    })) as {
      ok?: boolean
      summary?: string
      health?: { ok?: boolean; status?: number; error?: string; body?: { status?: string; exec_enabled?: boolean } }
      mcp?: { ok?: boolean; error?: string; serverInfo?: { name?: string; version?: string } | null }
      whoami?: { ok?: boolean; error?: string; text?: string }
      hints?: string[]
    }

    if (report?.ok === true) {
      const identity = safeJson(report.whoami?.text)
      const roots = Array.isArray(identity?.roots) ? identity.roots.join(', ') : ''
      setStatus(`✔ ${report.summary ?? '连接正常'}${roots ? `（根目录 ${roots}）` : ''}`)
      return
    }
    // 失败：把阶段原因与修复提示拼成一行，便于直接照着改。
    const parts: string[] = []
    if (report?.health && report.health.ok !== true) {
      parts.push(`健康检查失败${report.health.error ? `：${report.health.error}` : `（HTTP ${report.health.status}）`}`)
    }
    if (report?.mcp && report.mcp.ok !== true && report.mcp.error) {
      parts.push(`MCP 初始化失败：${report.mcp.error}`)
    }
    if (report?.whoami && report.whoami.ok !== true && report.whoami.error) {
      parts.push(`whoami 失败：${report.whoami.error}`)
    }
    const hints = Array.isArray(report?.hints) && report.hints.length ? `　提示：${report.hints.join('；')}` : ''
    setStatus(`✘ ${report?.summary ?? '连接失败'}${parts.length ? `（${parts.join('；')}）` : ''}${hints}`, true)
  } catch (err) {
    setStatus(`✘ 测试失败：${err instanceof Error ? err.message : String(err)}`, true)
  }
}

/** 宽松解析一段 JSON 文本（非 JSON 返回 undefined）。 */
function safeJson(text: unknown): any {
  if (typeof text !== 'string') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/* ── 运维面板（文件 / 执行 / 诊断） ───────────────────────────────────── */

function buildOpsPanel(conn: any): HTMLElement {
  const root = el('div', {
    id: 'dsh-host-mcp-panel',
    style: 'color:var(--fg,#1f2328);font-size:13px;line-height:1.5;display:flex;flex-direction:column;gap:8px;' +
      'position:fixed;right:16px;bottom:16px;z-index:2147483646;width:880px;max-height:80vh;' +
      'overflow:auto;padding:14px;background:var(--bg,#fff);border:1px solid rgba(127,127,127,.35);' +
      'border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.25);display:none;',
    'data-dsh-host-mcp-panel': 'true',
  })

  const status = el('div', { style: 'font-size:12.5px;', textContent: '' })
  const setStatus = (text: string, isError = false): void => {
    status.textContent = text
    status.setAttribute('style', `font-size:12.5px;${isError ? STATUS_ERR : STATUS_OK}`)
  }

  /* 顶栏：标题 + 服务器下拉 + 关闭 */
  const serverSelect = el('select', { style: INPUT_CSS + 'width:auto;' }) as HTMLSelectElement
  const closeBtn = el('button', { type: 'button', textContent: '✕', style: BTN_CSS + 'padding:2px 8px;' }) as HTMLButtonElement
  closeBtn.addEventListener('click', () => { root.style.display = 'none' })
  const topBar = el('div', { style: 'display:flex;align-items:center;gap:8px;' }, [
    el('strong', { textContent: '服务器运维' }),
    serverSelect,
    el('span', { style: 'flex:1;' }),
    closeBtn,
  ])
  root.append(topBar)

  /* 服务器清单（RPC servers 端点，脱敏） */
  let servers: Array<{ id: string; host: string; port: number; hasToken: boolean }> = []

  async function loadServers(): Promise<void> {
    try {
      const value = (await callRpc(conn, 'servers', {})) as {
        servers: Array<{ id: string; host: string; port: number; hasToken: boolean }>
        defaultServer?: string
      }
      servers = value.servers ?? []
      serverSelect.textContent = ''
      for (const s of servers) {
        serverSelect.append(el('option', { value: s.id, textContent: `${s.id}（${s.host}:${s.port}）${s.hasToken ? '' : ' [无 token]'}` }))
      }
      if (!serverSelect.value && value.defaultServer) serverSelect.value = value.defaultServer
    } catch (err) {
      setStatus(`加载服务器列表失败：${err instanceof Error ? err.message : String(err)}`, true)
    }
  }

  const activeServer = (): string => serverSelect.value || ''

  /* Tab 切换 */
  const tabButtons: HTMLButtonElement[] = []
  const tabPanes: HTMLElement[] = []
  const tabBar = el('div', { style: 'display:flex;gap:4px;border-bottom:1px solid rgba(127,127,127,.3);' })
  const paneWrap = el('div', { style: 'display:flex;flex-direction:column;gap:8px;' })

  function addTab(name: string, build: (pane: HTMLElement) => void): void {
    const pane = el('div', { style: 'display:none;flex-direction:column;gap:8px;' })
    const btn = el('button', {
      type: 'button',
      textContent: name,
      style: BTN_CSS + 'border:none;border-bottom:2px solid transparent;border-radius:6px 6px 0 0;padding:6px 14px;',
    }) as HTMLButtonElement
    btn.addEventListener('click', () => {
      for (const b of tabButtons) {
        b.style.borderBottomColor = b === btn ? '#1f6feb' : 'transparent'
      }
      tabPanes.forEach((p) => { p.style.display = p === pane ? 'flex' : 'none' })
    })
    tabButtons.push(btn)
    tabPanes.push(pane)
    tabBar.append(btn)
    build(pane)
    paneWrap.append(pane)
  }

  /* Tab 1：概览（probe + health + whoami） */
  addTab('概览', (pane) => {
    const probeBtn = el('button', { type: 'button', textContent: '连接诊断（probe）', style: BTN_PRIMARY_CSS }) as HTMLButtonElement
    const diagBtn = el('button', { type: 'button', textContent: '一键排查（diagnose）', style: BTN_CSS }) as HTMLButtonElement
    const out = el('pre', { style: PRE_CSS })
    pane.append(
      el('div', { style: 'display:flex;gap:8px;' }, [probeBtn, diagBtn]),
      out,
    )
    probeBtn.addEventListener('click', async () => {
      setStatus(`诊断 ${activeServer()} …`)
      try {
        const value = (await callRpc(conn, 'probe', { server: activeServer() })) as Record<string, any>
        out.textContent = JSON.stringify(value, null, 2)
        setStatus(value.ok === false ? `✘ ${value.summary ?? '连接异常'}` : `✔ ${value.summary ?? '连接正常'}`, value.ok === false)
      } catch (err) {
        setStatus(`✘ ${err instanceof Error ? err.message : String(err)}`, true)
      }
    })
    diagBtn.addEventListener('click', async () => {
      setStatus(`排查 ${activeServer()} …（最多 30s）`)
      try {
        const value = (await callRpc(conn, 'diagnose', { server: activeServer() })) as Record<string, any>
        out.textContent = JSON.stringify(value, null, 2)
        setStatus(value.ok === false ? '✘ 排查发现异常（见输出）' : '✔ 排查通过', value.ok === false)
      } catch (err) {
        setStatus(`✘ ${err instanceof Error ? err.message : String(err)}`, true)
      }
    })
  })

  /* Tab 2：文件 */
  addTab('文件', (pane) => {
    const pathInput = el('input', { type: 'text', style: INPUT_CSS + 'flex:1;', value: '/tmp', spellcheck: 'false' }) as HTMLInputElement
    const goBtn = el('button', { type: 'button', textContent: '列目录', style: BTN_PRIMARY_CSS }) as HTMLButtonElement
    const upBtn = el('button', { type: 'button', textContent: '⬆ 上级', style: BTN_CSS }) as HTMLButtonElement
    const preview = el('pre', { style: PRE_CSS + 'display:none;' })
    const previewTitle = el('div', { style: 'font-weight:600;display:none;' })
    const table = el('table', { style: TABLE_CSS })
    const tableWrap = el('div', { style: 'overflow:auto;max-height:360px;' }, [table])
    pane.append(
      el('div', { style: 'display:flex;gap:6px;' }, [pathInput, goBtn, upBtn]),
      tableWrap,
      previewTitle,
      preview,
    )

    async function listDir(): Promise<void> {
      const path = pathInput.value.trim()
      setStatus(`加载 ${path} …`)
      try {
        const raw = (await callRpc(conn, 'list_files', { server: activeServer(), path, recursive: false, max_entries: 300 })) as {
          isError?: boolean
          text?: string
        }
        const value = toolData(raw) as {
          root: string
          entries?: Array<{ name: string; path: string; kind: string; size: number | null; modified: string | null }>
          truncated?: boolean
          scanned?: number
        }
        table.textContent = ''
        const headCells = [
          el('th', { textContent: '名称' }), el('th', { textContent: '类型' }),
          el('th', { textContent: '大小' }), el('th', { textContent: '修改时间' }),
          el('th', { textContent: '操作' }),
        ]
        for (const th of headCells) th.setAttribute('style', CELL_CSS)
        table.append(el('thead', {}, [el('tr', {}, headCells)]))
        const tbody = el('tbody')
        const entries = value.entries ?? []
        for (const e of entries) {
          const openBtn = el('button', {
            type: 'button',
            textContent: e.kind === 'dir' ? '进入' : '预览',
            style: BTN_CSS + 'padding:2px 8px;font-size:12px;',
          }) as HTMLButtonElement
          const abs = value.root.replace(/\/$/, '') + '/' + e.path
          openBtn.addEventListener('click', () => {
            if (e.kind === 'dir') {
              pathInput.value = abs
              void listDir()
            } else {
              void previewFile(abs)
            }
          })
          const tr = el('tr', {}, [
            el('td', { textContent: e.name }),
            el('td', { textContent: e.kind }),
            el('td', { textContent: fmtBytes(e.size) }),
            el('td', { textContent: e.modified ?? '-' }),
            el('td', {}, [openBtn]),
          ])
          for (const td of tr.children) (td as HTMLElement).setAttribute('style', CELL_CSS)
          tbody.append(tr)
        }
        table.append(tbody)
        setStatus(`✔ ${value.root ?? path}（${entries.length} 项${value.truncated ? '，已截断' : ''}，扫描 ${value.scanned ?? '?'}）`)
      } catch (err) {
        setStatus(`✘ ${err instanceof Error ? err.message : String(err)}`, true)
      }
    }

    async function previewFile(path: string): Promise<void> {
      previewTitle.textContent = path
      previewTitle.style.display = ''
      preview.style.display = ''
      preview.textContent = '加载中…'
      try {
        // 先 count 再读（服务端建议的姿势），最多预览前 200 行。
        // RPC 层统一包成 {isError, text}；count 的 text 是 JSON 信封，read 的 text 是原始内容。
        const countRaw = (await callRpc(conn, 'count_file_lines', { server: activeServer(), path })) as {
          isError?: boolean
          text?: string
        }
        let totalLines = 200
        let binary = false
        if (countRaw.text) {
          try {
            const count = JSON.parse(countRaw.text) as { lines?: number; binary?: boolean }
            binary = count.binary === true
            if (typeof count.lines === 'number') totalLines = count.lines
          } catch {
            // count 文本非 JSON：维持默认
          }
        }
        if (binary) {
          preview.textContent = `二进制文件（约 ${totalLines} 行），不支持预览`
          return
        }
        const end = Math.min(totalLines || 200, 200)
        const read = (await callRpc(conn, 'read_file_lines', {
          server: activeServer(), path, start_line: 1, end_line: end, with_line_numbers: true,
        })) as { text?: string }
        preview.textContent = read.text ?? '(空)'
        if (totalLines > end) preview.textContent += `\n…[仅预览前 ${end} 行，文件共 ${totalLines} 行]`
      } catch (err) {
        preview.textContent = `✘ ${err instanceof Error ? err.message : String(err)}`
      }
    }

    goBtn.addEventListener('click', () => { void listDir() })
    pathInput.addEventListener('keydown', (ev) => { if ((ev as KeyboardEvent).key === 'Enter') void listDir() })
    upBtn.addEventListener('click', () => {
      const parts = pathInput.value.replace(/\/+$/, '').split('/')
      parts.pop()
      pathInput.value = parts.join('/') || '/'
      void listDir()
    })
    void listDir()
  })

  /* Tab 3：执行 */
  addTab('执行', (pane) => {
    const interpSelect = el('select', { style: INPUT_CSS + 'width:auto;' }) as HTMLSelectElement
    for (const name of ['python', 'powershell', 'cmd', 'node']) {
      interpSelect.append(el('option', { value: name, textContent: name }))
    }
    const cwdInput = el('input', { type: 'text', style: INPUT_CSS + 'flex:1;', value: '/tmp', spellcheck: 'false' }) as HTMLInputElement
    const timeoutInput = el('input', { type: 'number', style: INPUT_CSS + 'width:80px;', value: '30' }) as HTMLInputElement
    const scriptArea = el('textarea', {
      rows: '7',
      spellcheck: 'false',
      style: INPUT_CSS + 'font-family:ui-monospace,monospace;',
      // 纯 Python 跨平台探针（不依赖 shell 命令，Windows/Linux 都能跑）
      value: 'import os, platform\nprint(platform.platform())\nprint("cwd:", os.getcwd())',
    }) as HTMLTextAreaElement
    const runBtn = el('button', { type: 'button', textContent: '▶ 执行', style: BTN_PRIMARY_CSS }) as HTMLButtonElement
    const out = el('pre', { style: PRE_CSS })
    pane.append(
      el('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;' }, [
        el('label', { style: 'font-size:12px;', textContent: '解释器' }), interpSelect,
        el('label', { style: 'font-size:12px;', textContent: 'cwd' }), cwdInput,
        el('label', { style: 'font-size:12px;', textContent: '超时(s)' }), timeoutInput,
        runBtn,
      ]),
      el('label', { style: HINT_CSS, textContent: '脚本（服务端有解释器白名单与危险命令黑名单；超时会 kill 进程树）。cwd 必须位于该 token 的沙箱根内。' }),
      scriptArea,
      out,
    )
    runBtn.addEventListener('click', async () => {
      const cwd = cwdInput.value.trim() || '/tmp'
      const timeout = Number.parseInt(timeoutInput.value, 10) || 30
      setStatus(`执行中（${interpSelect.value} @ ${cwd}，超时 ${timeout}s）…`)
      runBtn.disabled = true
      try {
        const raw = (await callRpc(conn, 'exec_script', {
          server: activeServer(),
          script: scriptArea.value,
          interpreter: interpSelect.value,
          cwd,
          timeout_secs: timeout,
        })) as { isError?: boolean; text?: string }
        const value = toolData(raw)
        out.textContent = typeof raw.text === 'string' ? raw.text : JSON.stringify(raw, null, 2)
        if (raw.isError) setStatus('✘ 执行被服务端拒绝或失败（见输出）', true)
        else if (value?.timed_out) setStatus(`⚠ 超时被 kill（生效超时 ${value?.timeout_secs}s）`, true)
        else if (value?.exit_code !== 0) setStatus(`⚠ 退出码 ${value?.exit_code}（stderr 见输出）`, true)
        else setStatus(`✔ 执行成功，耗时 ${value?.duration_ms}ms`)
      } catch (err) {
        out.textContent = `✘ ${err instanceof Error ? err.message : String(err)}`
        setStatus('✘ 执行失败', true)
      } finally {
        runBtn.disabled = false
      }
    })
  })

  root.append(tabBar, paneWrap, status)
  // 默认选中第一个 tab
  void loadServers().then(() => tabButtons[0]?.click())
  serverSelect.addEventListener('change', () => { void loadServers() })
  return root
}

/* ── 挂载策略 ────────────────────────────────────────────────────────────
   1. 设置页插槽（`settings.plugins.tab`，id=host-mcp）：服务器配置页。
   2. 侧边栏 footer 按钮（`sidebar.footer.action`，根作用域 list 插槽，纯按钮）：
      切换运维浮动面板。
   3. 两个插槽都失败时：左下浮动启动器兜底。
   ────────────────────────────────────────────────────────────────────── */

const SETTINGS_TAB_SLOT = 'settings.plugins.tab'
const SIDEBAR_SLOT = 'sidebar.footer.action'

function createSlotComponent(React: any, node: () => HTMLElement, attrs: Record<string, unknown> = {}): any {
  return function HostMcpSlot() {
    const ref = React.useRef(null)
    React.useEffect(function () {
      const host = ref.current as HTMLElement | null
      if (!host || host.childElementCount > 0) return
      host.append(node())
    }, [])
    return React.createElement('div', Object.assign({ ref, 'data-dsh-host-mcp-slot': 'true' }, attrs))
  }
}

function createSidebarButton(React: any, panel: HTMLElement): any {
  const Icon = function Icon(props: Record<string, unknown>) {
    return React.createElement(
      'svg',
      Object.assign({ width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true }, props),
      React.createElement('rect', { x: 3, y: 4, width: 18, height: 7, rx: 1.5 }),
      React.createElement('rect', { x: 3, y: 13, width: 18, height: 7, rx: 1.5 }),
      React.createElement('path', { d: 'M7 7.5h.01M7 16.5h.01' }),
    )
  }
  return function HostMcpSidebarButton({ wide }: { wide?: boolean }): any {
    const [open, setOpen] = React.useState(panel.style.display !== 'none')
    React.useEffect(function () {
      panel.style.display = open ? 'flex' : 'none'
    }, [open])
    return React.createElement(
      'button',
      {
        type: 'button',
        title: '服务器运维（host-mcp）',
        'data-dsh-host-mcp-sidebar-toggle': 'true',
        'aria-expanded': open ? 'true' : 'false',
        onClick: () => setOpen((v: boolean) => !v),
        style: {
          display: 'flex', alignItems: 'center', gap: wide === false ? '0' : '8px',
          justifyContent: wide === false ? 'center' : 'flex-start',
          width: '100%', boxSizing: 'border-box', margin: '2px 0', padding: '8px 10px',
          fontSize: '13px', cursor: 'pointer',
          border: '1px solid rgba(127,127,127,.25)',
          background: open ? 'rgba(127,127,127,.15)' : 'transparent',
          color: 'inherit', borderRadius: '8px',
        },
      },
      React.createElement(Icon, null),
      wide === false ? null : '服务器',
    )
  }
}

/**
 * 声明 fiber 依赖。
 *
 * `connection` / `slots` 是本 fiber 直接等的服务；`configForms` **不在此列**——
 * 它由 `ctx.inject` 另起子 fiber 获取（见 apply）。cordis 的 fiber 对 inject
 * 里缺失的服务会永久 pending（`_refresh()` 把 epoch 置 INACTIVE），浏览器启动
 * 审计会点名失败 entry，故不把可选服务塞进来。
 */
const CLIENT_INJECT = ['connection', 'slots']

function apply(ctx: any): void {
  if (win.__dshHostMcpMounted === true) return
  const conn = service(ctx, 'connection')
  if (!conn || !conn.rpc || typeof conn.rpc.call !== 'function') return
  win.__dshHostMcpMounted = true

  let entryCount = 0
  const slots = service(ctx, 'slots')
  let React: any
  try { React = require('react') } catch { React = undefined }
  const hasReact = Boolean(React && typeof React.createElement === 'function')

  /* 运维浮动面板（纯 DOM，预挂 body） */
  const opsPanel = buildOpsPanel(conn)
  doc.body.append(opsPanel)

  /* 侧边栏 footer 按钮 + 兜底启动器：不依赖 configForms，立即注册 */
  if (slots && typeof slots.inject === 'function' && hasReact) {
    try {
      ctx.effect(() => slots.inject(SIDEBAR_SLOT, () => {
        const Button = createSidebarButton(React, opsPanel)
        return slots.register({ name: SIDEBAR_SLOT, id: PLUGIN_ID, order: 55, label: '服务器' }, Button)
      }), 'host-mcp: sidebar button')
      entryCount += 1
    } catch (err) {
      console.warn('[dsh-host-mcp] sidebar registration failed:', err)
    }
  }

  /* 兜底：侧边栏没挂上时用浮动启动器控制运维面板 */
  if (entryCount === 0) {
    const launcher = el('button', {
      textContent: '🖥 服务器',
      id: 'dsh-host-mcp-launcher',
      style: 'position:fixed;left:16px;bottom:16px;z-index:2147483647;padding:9px 14px;' +
        'font-size:13px;background:#1f6feb;color:#fff;border:none;border-radius:8px;' +
        'box-shadow:0 2px 8px rgba(0,0,0,.3);margin:0;cursor:pointer;',
    }) as HTMLButtonElement
    launcher.addEventListener('click', () => {
      opsPanel.style.display = opsPanel.style.display === 'none' ? 'flex' : 'none'
    })
    doc.body.append(launcher)
  }

  /* 设置 → 插件：host-mcp 配置页。
     必须等 configForms 就绪——ctx.get 跨 fiber 读不到它（兄弟 isolate scope），
     ctx.inject 创建子 fiber 等依赖，回调里才拿得到。 */
  if (!slots || typeof slots.inject !== 'function' || !hasReact) return
  try {
    ctx.inject(['configForms'], (formsCtx: any) => {
      const channel = configChannel(formsCtx)
      let configPanel: HTMLElement | undefined
      return slots.inject(SETTINGS_TAB_SLOT, () => {
        // configPanel 只建一次（重复 append 会把 DOM 搬走）；面板内部 load()
        // 自带「镜像未就绪重试」，命名空间真缺席时就地显示可读错误。
        if (!configPanel) configPanel = buildConfigPanel(channel, conn)
        const Comp = createSlotComponent(React, () => configPanel as HTMLElement)
        return slots.register({ name: SETTINGS_TAB_SLOT, id: SETTINGS_NS, order: 30, label: '服务器' }, Comp)
      })
    })
  } catch (err) {
    console.warn('[dsh-host-mcp] settings tab registration failed:', err)
  }
}

module.exports = { name: PLUGIN_ID, inject: CLIENT_INJECT, apply }
