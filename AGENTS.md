# AGENTS.md — dsh-host-mcp 开发指南

连接 host_server_mcp（Rust MCP Streamable HTTP 服务）的 dsh 插件。宿主半发 MCP 请求，浏览器半配置服务器 + 运维面板，agent 经 `host-mcp` 工具访问。

## 技术栈

- TypeScript（`NodeNext`）+ `tsc` 产出 `lib/`
- 依赖：`@deepseek-ai/cordis`（4.0.4）、`@deepseek-ai/dsh-tools`（0.2.0-rc.2，`defineTool`）、`@deepseek-ai/schemastery`（3.18.4）
- 浏览器半：无框架 DOM 工厂 + `require('react')`（seed 提供）包成 `window.__ModuleLoader__.load({id, factory})`

## 目录与职责

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 宿主半入口：`name` / `inject` / `Config` / `apply`。注册 `/api/host-mcp/*` 精确路由 + `host-mcp` 工具 |
| `src/settings.ts` | **配置载体**：`HostMcpConfigSchema`（servers JSON + 5 个标量，全 `.volatile()`）、`readSettings()` 现读解包、`parseServers()` 容错解析、`serverUrl()` |
| `src/mcp-client.ts` | MCP Streamable HTTP 客户端：`initSession` / `notifyInitialized` / `callTool` / `healthCheck` / `invalidateSession`。SSE 帧解析、会话缓存、404/422 会话失效自动重建（清缓存→重初始化→重试一次，重建仍失败给可读报错）、传输失败清缓存、401 可读报错 |
| `src/rpc.ts` | `RPC_ENDPOINTS`（12 个：version/servers/probe/health/whoami/list_files/count_file_lines/read_file_lines/exec_script/server_info/diagnose/probe_uncached）、`createHandler`（端点→处理器）、`createDispatch`（工具与路由共用）、`registerRpcRoutes`（精确路由 + disposer）、`mcpToRpc`（MCP 结果→RpcResult，并把 exec_script 失败的结构化 `error_kind` 提到兄弟字段） |
| `src/tool.ts` | `createHostMcpTool`：万能 `host-mcp` 工具（action + args + server）；exec_script 失败时按 `ERROR_KIND_HINTS` 把 `errorKind` 译成一行可读提示追加在输出尾部 |
| `src/client.ts` | 浏览器半：`buildConfigPanel`（服务器编辑器）、`buildOpsPanel`（概览/文件/执行）、`configChannel`（configForms）、`apply`（槽位注册） |
| `scripts/wrap-client.mjs` | 把 `lib/client.js` 包成模块工厂（**幂等**：先剥旧包装再包，重复运行不叠层） |
| `scripts/check-plugin.mjs` | 冒烟：假 ctx + 假 MCP 服务器（SSE + 会话头）走通全链路；含会话回收回归（404 自愈 / 自愈后缓存刷新 / 重建失败可读报错）与两侧载荷契约 |
| `scripts/check-resolve.mjs` | 从 profile 的 node_modules 验证依赖解析与导出 |
| `scripts/check-cordis-get.mjs` | 真 cordis 验证 `ctx.inject` 跨 fiber 读服务（含反面对照） |
| `scripts/check-parse.mjs` | 配置解析链路（落盘 JSON 形态 → readSettings，含 role(secret) 回归） |
| `scripts/check-live.mjs` | 真机联调（env 传 token） |

## 关键设计约束

1. **配置必须现读现用**。`Config` 字段被 loader 解析成 `Volatile<T>` 稳定引用（改动不重挂插件），一律经 `readSettings(config)` 解包成普通值；禁止在 `apply` 时缓存快照。
2. **`servers` 绝不能标 `role('secret')`**（见下面第 1 条坑）。
3. **RPC 只能走 `connection.fetch.register()`**。0.1.5 起 `rpc.handle` 对插件失效；路由必须在 `/api` 下，信封是 `{type:'client-request', rpcId, method:'host-mcp/<ep>', payload}` → `{type:'server-response', rpcId, result}`，result 必须 `{ok,value}` 或 `{ok:false,error:{code,message,details}}`（details 不可省）。
4. **两侧载荷必须都是 `{ args }`**。宿主半读 `envelope.payload.args`，浏览器半的 `callRpc` 必须发 `{ args: {...} }`——发扁平对象会让参数静默丢失，表现为「未填主机名」这类看似无关的报错。`scripts/check-plugin.mjs` 末尾的「两侧载荷契约」一节会加载浏览器半真实产物来验证这条（改任一侧都会红）。
5. **`registerRpcRoutes` 内部提取 `connection.fetch`**。宿主 connection 是 `HostConnectionHandle`（注册器在 `.fetch.register`），测试替身可能直接给 `register`——两种形态都要兼容。
6. **token 永不进 RPC 回包**。`servers` 端点只回 `hasToken`；浏览器编辑走官方 `configForms`，不需要经 RPC 回传 token。
7. **`read_file_lines` 是唯一返回原始文本的工具**（其余走 `json_result` JSON 信封）。面板的 `toolData()` 助手按此分流。
8. **exec_script 失败走结构化错误**：服务端 `isError=true` 时 `text` 是 `{is_error, error_kind, message}` JSON（`error_kind` 由 `classify_error` 归类，含 interpreter_not_allowed/unsupported/not_found、blocked、path_denied/not_found、cwd_not_found、missing_cwd、exec_disabled、invalid_request、exec_failed）。宿主半 `mcpToRpc` 把 `error_kind` 提到回包兄弟字段 `errorKind`，工具与浏览器面板据此给出可读提示；`server_info`（需 exec 作用域）返回 `{os, default_interpreter, allowed_interpreters, available_interpreters[]}`，执行前可先探测环境选解释器。
9. **MCP 会话**：`initialize` 无需会话头（它会签发 `Mcp-Session-Id`）；非 initialize 方法无会话头 → 422，回传**已被服务端回收**的会话 id → 404（rmcp 的 LocalSessionManager 默认空闲 5 分钟销毁会话，服务重启同理）。404/422 统一视为 `SESSION_INVALID_STATUS`：清缓存 → 重新 initialize → 重试一次（`forceNewSession`）。**任何一次失败都必须让缓存里的会话 id 失效**（传输异常、notifyInitialized 后的 404/422 也要清），否则死 id 会被反复复用，后续每次调用稳定 404 直到进程重启；重试后仍失效则返回能自解释的错误（不把裸 404 文本抛给调用方）。
10. **浏览器半读 `configForms` 必须走 `ctx.inject(['configForms'], cb)`**（见下面第 3 条坑）。
11. **浏览器不能直连 host_server_mcp 做预检**。dsh 页面与目标服务器跨源，而 host_server_mcp 不返回 CORS 头，浏览器 `fetch` 一律以 `Failed to fetch` 拒绝——与服务端是否可达无关（用户手动开标签页能通，因为那不是脚本发起的跨源请求）。配置页「测试连接」走宿主半的 `probe_uncached` 端点，宿主进程发 HTTP 无同源限制。
12. **defaultServer 写规范 id（`deriveServerId` 横线形态），且宿主半按三档容错解析**（精确 id → 冒号形态重算 → 第一台）。两侧 `deriveServerId` 是手抄镜像，改一侧同步另一侧。

## 踩过的坑（2026-10-14 ~ 10-15）

- **`wrap-client.mjs` 重复运行会双层包装 → 浏览器报 duplicate factory registration、插件激活失败**（用户报「web boot: 1 entry did not activate / duplicate factory registration for "dsh-host-mcp"」的根因）。`wrap` 直接对 `lib/client.js` 追加外层，不重新 `tsc` 就重复运行会叠两层，浏览器执行 bundle 时 `__ModuleLoader__.load` 被调用两次，整个插件被拒绝激活。**修复**：`wrap-client.mjs` 改为幂等（先剥旧包装再包），`check-plugin.mjs` 加断言「产物恰好包装一层（load() 调用 = 1）」。
- **`role('secret')` 会让配置页读到空列表——settings 远程读取整体脱敏**（用户报「保存后刷新还是空列表」的根因，宿主侧 dump 明明完好）。settings-controller 的契约注释原文："Every remote read uses `redactSecrets: true`, so a role('secret') field **cannot ride a response**"。我曾给 `servers` 整块标 secret，浏览器经 `configForms` 读回时该字段被整个移除 → 面板拿到 `undefined` → 空列表。**修复**：去掉 secret 标记。token 的保护改由「只落本机 profile 文件 + 工具/RPC 回包一律脱敏」承担（页面里本就要显示 token 给用户编辑，这是常规设置页行为）。检测：`check-parse.mjs` 用 `schema.dict.servers.meta.role` 断言（**注意 schemastery 的对象字段在 `.dict` 上而非 `.properties`**，我第一版检测取错路径成了永远绿的摆设，现已加对照 schema 自检）。
- **defaultServer 冒号/横线形态不一致**：面板旧代码写 `host:port`，而 `parseServers` 推导的 id 是横线形态（`:` 被折叠成 `-`），导致「默认服务器」落空、agent 报「服务器未配置」。已统一为 `deriveServerId` 规范形态 + `resolveDefaultId` 三档容错（能直接读旧数据，无需重存）。
- **配置页「测试连接」报 `Failed to fetch` ≠ 服务器不通**。原因如上第 10 条：浏览器跨源被 CORS 拦。改走宿主半 RPC 后能正确区分「网络不通 / HTTP 非 200 / token 无效 / 作用域缺失」并给出对应提示。
- **会话回收回 404，缓存复用死 id → 后续调用稳定 404 直到进程重启**（2026-10-15 真机报「访问久了 Not Found: Session not found」的根因）。rmcp 的 LocalSessionManager 默认空闲 5 分钟销毁会话，服务重启同理；服务端对带已回收会话 id 的 POST 一律回 404。旧客户端只把 422 当会话失效，404 后死 id 留在缓存里被反复复用。**修复**：404/422 统一进 `SESSION_INVALID_STATUS`，任何一次失败都清缓存并强制重新 initialize 重试一次（传输异常、notifyInitialized 后的 404/422 同样清）；重试后仍失效返回可读错误。回归：`check-plugin.mjs` 的「会话回收回归」一节（自愈 / 自愈后缓存刷新 / 重建失败可读报错 / 清理后可恢复）。

- **`ctx.get()` 跨 fiber 读不到服务——cordis 4 isolate 语义**（用户报「配置服务不可用（宿主未提供 configForms.host-mcp）」的根因）。`ctx.get(name)` 内部是 `this.ctx[symbols.isolate][name]` 取 key，而 `provide` 时 key 写在**提供者 fiber** 的 isolate map 里；兄弟 fiber 的 map 里没有这个 key，于是 `_getImpl` 返回 undefined。已用真 cordis 实测复现（`scripts/check-cordis-get.mjs` 的反面对照）。**唯一正规通道是 `ctx.inject([name], cb)`**——它创建子 fiber、等依赖就绪后跑回调。。
- **`configForms.describe()` 镜像异步拉取**：启动瞬间 `view.namespaces` 是空的，拿它做读写前置门控会误报「宿主配置镜像未包含 host-mcp」。权威判定是表单控制器自己的 status（缺席 → `unavailable`）。读配置只等 `ready`，失败重试至多 3 次。
- **`ctx.inject` 的依赖方要先于提供者注册**：提供者已存在时 inject 回调不会补跑（cordis 既有语义）。所以配置页注册放在 apply 里尽早做，而不是等用户点开设置页。
- **`/plugins/<id>/client.js` 必须带 `?rev=<hash>`** 才返回 200；rev 由 client.js 的 mtime/ctime/size 算出，探测时别忘。
- **profile 的 node_modules 用 pnpm hoisted，未必包含 `@deepseek-ai/dsh-tools`**。插件必须自带依赖（`npm install`），不能靠指向别的插件 node_modules 的 junction。
- **YAML patch 按 id 整体替换 config，不深合并**。插件自带的 `cordis.patch.yml` 与 profile patch 同时 insert 同一 id 是幂等的（dump 显示 `disabled: false`）。
- `dsh --profile web --dump-config` 是验证插件条目是否进组合树的最快手段；

## 常见改动点

- **新增 MCP 端点**：`RPC_ENDPOINTS` 加一项 → `createHandler` 加 case（注意 `pickServer` 的 `requireToken`）→ `ACTION_HINTS`（tool.ts）补说明。
- **新增配置字段**：`settings.ts` 的 schema + `HostMcpConfig` 接口 + `readSettings` 解包，然后业务侧现读。
- **改浏览器面板**：`client.ts` 的 `buildConfigPanel` / `buildOpsPanel`。槽位策略：`settings.plugins.tab`（配置）+ `sidebar.footer.action`（运维面板开关），两者都失败才落浮动启动器兜底。

## 验证

```bash
npm run check          # 冒烟 + 依赖解析 + cordis 服务访问 + 配置解析（离线可跑）
npm run check:live     # 真机（HSM_HOST/HSM_PORT/HSM_TOKEN）
dsh --profile web --dump-config | tail -20   # 确认 host-mcp 条目在树里
```
