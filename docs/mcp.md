# 内置 MCP 服务

呆呆面板内置了一个 [MCP（Model Context Protocol）](https://modelcontextprotocol.io/) 服务，Claude Desktop、Cursor、Cherry Studio、AstrBot 等支持 MCP 的 AI 客户端连上之后，就能直接用自然语言查任务、看日志、巡检失败任务；管理员放开写入权限后，还可以让 AI 运行任务、改环境变量、写脚本。

提供两种连接方式：

| 方式 | 地址 / 命令 | 适合 |
|---|---|---|
| HTTP（Streamable HTTP） | `POST http://<面板地址>/api/v1/mcp` | 大多数客户端；手机（Magisk 模块版）只能用这个 |
| stdio | 容器内的 `ddp mcp` 命令 | 只支持「拉起本地进程」的客户端，例如 Claude Desktop |

两种方式的工具完全一样：所有工具都经面板的开放 API 执行，**能访问哪些模块由应用的权限范围决定**，每一次工具调用都会记进「Open API」页面的调用日志，并计入应用的调用频率限制。

---

## 1. 开启

MCP 默认关闭。在面板 **系统设置 → MCP 服务** 里：

- **启用 MCP 服务**：打开后才能连接，否则 HTTP 接口一律返回 403，`ddp mcp` 直接报错退出。
- **允许写入与执行工具**：默认关闭，此时 AI 只能用查询类工具（看不到、也调不到写入类工具）。打开后才会提供运行任务、修改环境变量、保存与运行脚本等工具。

两个开关改完立即生效，不需要重启面板。已经连着的 `ddp mcp` 进程在每次调用工具前都会重新检查开关：关掉之后再调用会直接拿到错误。

## 2. 创建应用并勾选权限

在 **Open API** 页面新建一个应用，记下 `app_key` 与 `app_secret`（密钥只显示一次），再按需要勾选权限范围：

| 权限范围 | 对应的工具 |
|---|---|
| `tasks` | list_tasks、get_task、get_task_log、run_task、stop_task、set_task_enabled、batch_task_action |
| `logs` | list_logs、get_log |
| `envs` | list_envs、create_env、update_env、delete_env |
| `scripts` | list_scripts、read_script、save_script、run_script |
| `subscriptions` | list_subscriptions、pull_subscription |
| `system` | get_system_info、get_dashboard |

没有勾选的模块，对应工具调用时会返回「应用无权访问此资源」。建议只勾选真正需要的范围。

> ⚠️ `scripts` 权限等于可以在面板上执行任意代码（保存脚本再运行），请只授予完全信任的 AI 客户端。

## 3. HTTP 方式

地址与浏览器访问面板的地址相同，后面加 `/api/v1/mcp`，例如 `http://192.168.1.10:5700/api/v1/mcp`。

鉴权二选一：

- `Authorization: Basic <base64(app_key:app_secret)>`：直接用应用凭据，最省事；
- `Authorization: Bearer <令牌>`：用 `POST /api/v1/open-api/token` 换来的应用令牌（24 小时有效），或者面板的登录令牌。

生成 Basic 凭据：

```bash
# Linux / macOS
echo -n 'app_key:app_secret' | base64
```

```powershell
# Windows PowerShell
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('app_key:app_secret'))
```

支持远程 MCP 地址的客户端（例如 Cursor），配置示例：

```json
{
  "mcpServers": {
    "daidai-panel": {
      "url": "http://192.168.1.10:5700/api/v1/mcp",
      "headers": {
        "Authorization": "Basic <上面生成的 base64>"
      }
    }
  }
}
```

只支持 stdio 的客户端，可以借助 [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) 转一层（需要本机有 Node.js）：

```json
{
  "mcpServers": {
    "daidai-panel": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "http://192.168.1.10:5700/api/v1/mcp",
        "--header", "Authorization:Basic <上面生成的 base64>"
      ]
    }
  }
}
```

用 curl 自测连通性（应当返回工具清单）：

```bash
curl -s http://192.168.1.10:5700/api/v1/mcp \
  -u 'app_key:app_secret' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

说明：

- 服务是无状态的：每个 POST 独立处理、直接返回 JSON，不开 SSE 长连接，`GET` / `DELETE` 返回 405。
- 浏览器来源（带 `Origin` 头）的请求，要求来源与面板同源、在局域网 IP 下，或在 `config.yaml` 的 `cors.origins` 里，否则返回 403。
- 公网访问时请务必套 HTTPS：Basic 凭据与令牌在明文 HTTP 上会被同一网络里的人看到。

## 4. stdio 方式（`ddp mcp`）

`ddp mcp` 在面板所在的机器 / 容器里运行，经本机 HTTP 调用正在运行的面板（面板必须在运行），自己不改数据库。

```text
ddp mcp --app-key <app_key> --app-secret <app_secret> [--url http://127.0.0.1:5701]
```

| 参数 | 环境变量 | 说明 |
|---|---|---|
| `--url` | `DDP_MCP_URL` | 面板后端地址，默认 `http://127.0.0.1:<面板后端端口>` |
| `--app-key` | `DDP_MCP_APP_KEY` | 应用的 app_key |
| `--app-secret` | `DDP_MCP_APP_SECRET` | 应用的 app_secret |

stdout 只输出 MCP 协议消息，就绪提示与错误都写到 stderr。

**Docker 部署**（客户端在宿主机上）：

```json
{
  "mcpServers": {
    "daidai-panel": {
      "command": "docker",
      "args": [
        "exec", "-i", "daidai-panel",
        "ddp", "mcp", "--app-key", "<app_key>", "--app-secret", "<app_secret>"
      ]
    }
  }
}
```

`daidai-panel` 换成你的容器名；`-i` 不能少，否则 stdin 接不上。

**二进制部署**：`command` 直接写 ddp 的完整路径，`args` 为 `["mcp", "--app-key", "…", "--app-secret", "…"]`。

**Magisk 模块版**：面板跑在手机的容器里，电脑上的客户端进不去这个容器，请改用上面的 HTTP 方式。

## 5. 工具清单

查询类（开启 MCP 即可用）：

| 工具 | 说明 |
|---|---|
| `list_tasks` | 分页查询任务，可按关键词、运行状态、分组、标签筛选；`enabled` 是启用开关，`status_text` 是运行状态 |
| `get_task` | 按 ID 查看任务完整配置 |
| `get_task_log` | 任务最近一次执行的日志（过长只保留末尾） |
| `list_logs` | 执行记录，可按任务、结果筛选，适合巡检失败任务 |
| `get_log` | 按执行记录 ID 查看日志正文（过长只保留末尾） |
| `list_envs` | 查询环境变量，名称像凭据的变量值会被遮蔽 |
| `list_scripts` | 脚本文件列表或目录树 |
| `read_script` | 读取脚本内容（过长只返回开头） |
| `list_subscriptions` | 查询订阅 |
| `get_system_info` | 资源占用、版本、部署形态 |
| `get_dashboard` | 概览页统计 |

写入与执行类（还需要开启「允许写入与执行工具」）：

| 工具 | 说明 |
|---|---|
| `run_task` / `stop_task` | 运行 / 停止任务 |
| `set_task_enabled` | 启用或禁用任务 |
| `batch_task_action` | 批量 enable / disable / run / stop / pin / unpin / delete（delete 不删脚本文件） |
| `create_env` / `update_env` / `delete_env` | 新建、修改、删除环境变量 |
| `save_script` | 新建或覆盖脚本（保留历史版本，可在网页端回滚） |
| `run_script` | 调试运行脚本并等待最多约 50 秒；仍在运行时返回 `run_id`，用同一个 `run_id` 再调用可继续取输出，加 `stop: true` 可停止 |
| `pull_subscription` | 立即拉取订阅（后台进行） |

单次工具输出上限约 64KB，超出部分会截断并注明；列表类工具可以减小 `page_size` 或加关键词缩小范围。

## 6. 安全提示

- 默认关闭，开启后也默认只读；写入与执行需要管理员再单独打开。
- 权限完全沿用开放 API：应用只能碰勾选了的模块，禁用应用立即失效；登录令牌则按账号角色限制。
- 环境变量的遮蔽规则与网页端一致（名称含 TOKEN、SECRET、PASSWORD、COOKIE 等，或某一段是 KEY、PWD、PASS、AUTH、CK 等），只作用于 MCP 的输出，目的是不把凭据送进 AI 的上下文；`list_envs` 的关键词搜索也不会按这些变量的值匹配，免得被拿来逐字试出凭据。拥有 `envs` 权限的应用直接调开放 API 仍能读到明文。
- 每次工具调用都会记进「Open API」页面的调用日志，并计入应用的调用频率限制；`run_script` 等待期间的轮询也算在内。
- `scripts` 权限等于任意代码执行，`envs` 权限能改写所有凭据，请按需授予。
