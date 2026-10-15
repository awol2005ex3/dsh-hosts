# dsh-host-mcp

DeepSeek Harness (dsh) 插件：连接装了 [host_server_mcp](https://gitee.com/awol2010ex/host_server_mcp) 的服务器，在 Web 设置页配置（IP/主机名 + 端口 + token），之后 **agent 对话里即可访问这些服务器排查问题**——查看信息、执行脚本、读文件、一键诊断。

## 能力

| 通道 | 能力 |
|------|------|
| **设置 → 插件 → 服务器** | 增删改服务器（host/port/token/mcpPath/备注）、设默认、保存前逐台测试连通性 |
| **agent 工具 `host-mcp`** | `probe`（连通诊断）、`diagnose`（一键排查）、`whoami`、`list_files`、`count_file_lines`、`read_file_lines`、`exec_script`、`health`、`servers` |
| **侧边栏「服务器」按钮** | 浮动运维面板：概览 / 文件浏览 / 脚本执行三个页签 |

## 安装

```bash
# 1. 构建（产出 lib/）
npm install
npm run build

# 2. 装进 web profile
cd "$DSH_HOME/profiles/web"     # Windows: C:\Users\<you>\.dsh\profiles\web
npx @deepseek-ai/dsh plugin --profile web add D:/workspace_node/dsh-hosts

# 3. 重启 dsh
```

装好后 profile 的 `cordis.patch.yml` 会多出一行（插件自带的 bundle patch 也会 insert 同一 id，二者幂等）：

```yaml
- id: host-mcp
  name: dsh-host-mcp
```

## 配置服务器

打开 **设置 → 插件 → 服务器**（在「内置插件」页的页签里）：

1. 点 `+ 添加服务器`，填 **主机/IP**、**端口**、**Token**（host_server_mcp 的 token，形如 `hsk_...`）；
2. 单选钮设为默认服务器；
3. 点 `保存配置` —— 写入 profile 配置（volatile 字段，宿主热更新，无需重启）；
4. 想先验证再保存，点行内 `测试连接`：依次探 `/health` 与 MCP `initialize`，token 是否有效一目了然。

> 也可以用 `高级：JSON 编辑` 直接编辑 `servers` 数组。
> token 会明文写入本机 profile 配置文件，请只填可信的内网服务器。

### 配置字段

| 字段 | 默认 | 说明 |
|------|------|------|
| `servers` | `[]` | JSON 数组 `[{id,host,port,token,mcpPath,note}]` |
| `defaultServer` | 第一个 | 省略 `server` 参数时使用的服务器 |
| `requestTimeoutMs` | `60000` | 单次 MCP 请求 HTTP 超时 |
| `defaultTimeoutSecs` | `10` | `exec_script` 默认超时（服务端会再钳一次） |
| `readLimitBytes` | `131072` | 读文件预览默认字节上限 |
| `maxResultChars` | `262144` | 工具结果回传上限（超出截断） |

## agent 工具

```
host-mcp(action, args?, server?)
```

`action` 取值与用法：

| action | args | 用途 |
|--------|------|------|
| `probe` | — | **连通诊断**：health + MCP initialize + whoami，失败时给修复提示 |
| `diagnose` | — | **一键排查**：health + whoami + 系统探测（uname/负载/内存/磁盘/CPU 进程） |
| `whoami` | — | token 身份、作用域（read/exec）、可访问根目录、限流与超时上限 |
| `list_files` | `{path, pattern, recursive, max_entries}` | 列目录（glob + 递归） |
| `count_file_lines` | `{path}` | 行数/字节数/是否二进制（读大文件前先调用） |
| `read_file_lines` | `{path, start_line, end_line, with_line_numbers}` | 按行区间读文件 |
| `exec_script` | `{script, interpreter, cwd, timeout_secs}` | 在服务器沙箱内执行脚本 |
| `health` | — | `GET /health` |
| `servers` | — | 已配置服务器清单（**不含 token**） |

对话示例：

> 帮我看看 bd-pr-rn1 上 host_server_mcp 服务是否正常，磁盘还剩多少。

agent 会调 `host-mcp(action:"diagnose", server:"bd-pr-rn1")`，一次拿到服务状态 + 系统信息。

## 架构

```
浏览器半（lib/client.js）
  ├─ 设置页配置编辑器 ──► ctx.configForms.get('host-mcp')  ◄─ 官方配置通道（落盘 + 热更新）
  └─ 侧边栏/浮动运维面板 ──► connection.rpc.call('/api', 'host-mcp/<endpoint>')
                                     │
宿主半（lib/index.js）                  ▼
  ├─ connection.fetch.register('/api/host-mcp/<endpoint>')   ← 精确路由（0.1.5+ 唯一正解）
  ├─ RPC 分发器（rpc.ts）：现读配置 → pickServer → MCP 客户端
  ├─ MCP Streamable HTTP 客户端（mcp-client.ts）：
  │    initialize（拿 Mcp-Session-Id）→ notifications/initialized → tools/call
  │    SSE 帧解析、会话缓存、422 自动重初始化、401 可读报错
  └─ agent 工具（tool.ts）：万能 host-mcp 工具，复用同一条分发路径
```

安全边界：

- token **只**存在于插件配置里；`servers` RPC 端点与工具结果一律脱敏，不回传明文；
- `exec_script` 的最终安全边界在 host_server_mcp 服务端（解释器白名单、危险命令黑名单、强制超时、进程树 kill），本插件不改写、不绕过；
- 浏览器半只能经 `/api` 精确路由访问宿主半，无第二条通路。

## 开发

```bash
npm install
npm run build          # tsc + wrap-client
npm run check          # 冒烟（假 ctx + 假 MCP 服务器）+ 依赖解析
npm run check:resolve  # 只跑依赖解析（从 profile 的 node_modules 出发）
npm run check:live     # 真机联调（需要 HSM_HOST/HSM_PORT/HSM_TOKEN）
```

真机联调（token 只经环境变量，不落盘）：

```bash
HSM_HOST=bd-pr-rn1 HSM_PORT=8765 HSM_TOKEN=hsk_xxx npm run check:live
```

## 已知限制

- `read_file_lines` 是 host_server_mcp 里唯一返回**原始文本**（非 JSON 信封）的工具，面板已特判；
- `diagnose` 的系统探测用 `interpreter: python`（跨平台最稳），需要服务器白名单里有 python；
- 管理 API（`/admin/tokens` 签发/吊销）未接入面板，请用 host_server_mcp 自带的管理接口。

## 许可

Apache-2.0
