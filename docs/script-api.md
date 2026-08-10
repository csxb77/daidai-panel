# 脚本内调用面板能力

面板在执行定时任务时，会往脚本进程里注入一批 `DAIDAI_*` 环境变量，其中包含**面板自己的接口地址和一枚临时凭据**。
脚本因此可以在运行过程中回头调用面板：发通知、读写环境变量、查任务和日志、触发订阅拉取……全都不需要你去后台申请 Open API 应用，也不用把账号密码写进脚本。

这篇文档写给**写定时任务脚本的人**，不需要懂面板内部实现。

> 一句话版本：`$DAIDAI_API_BASE` 是接口根地址，`$DAIDAI_TOKEN` 是配套的令牌，两个拼起来直接发 HTTP 请求就行。
> 唯一必须记住的红线：**要触发别的任务，请走 HTTP 接口，不要在脚本里跑 `ddp task run`**（原因见[第 4 节](#4-两条路径ddp-还是-http)）。

---

## 目录

- [1. 注入了哪些环境变量](#1-注入了哪些环境变量)
- [2. 最小示例：Python / Node / Shell](#2-最小示例python--node--shell)
- [3. 常用接口速查](#3-常用接口速查)
- [4. 两条路径：`ddp` 还是 HTTP](#4-两条路径ddp-还是-http)
- [5. 更新环境变量的正确姿势](#5-更新环境变量的正确姿势)
- [6. 安全说明](#6-安全说明)
- [7. `ddp` 在哪些安装方式里有](#7-ddp-在哪些安装方式里有)

---

## 1. 注入了哪些环境变量

任务开始执行时，下面这些变量会被写进脚本进程的环境。Python、Node、TypeScript、Shell、Go 任务都能拿到，**取用方式就是普通的读环境变量**（`os.environ` / `process.env` / `$VAR`）。

| 变量 | 含义 |
|------|------|
| `DAIDAI_API_BASE` | 面板 API 根地址，形如 `http://127.0.0.1:5701/api/v1`。端口跟着 `config.yaml` 的 `server.port` 走，**不要在脚本里写死** |
| `DAIDAI_TOKEN` | 调用上面这些接口用的 Bearer 令牌。权限与有效期见[第 6 节](#6-安全说明) |
| `DAIDAI_NOTIFY_URL` | 发通知接口的完整地址，等价于 `$DAIDAI_API_BASE/notifications/send`。为兼容既有脚本保留 |
| `DAIDAI_NOTIFY_TOKEN` | 与 `DAIDAI_TOKEN` **完全同值**，同样为兼容既有脚本保留。新脚本用哪个都行 |
| `DAIDAI_NOTIFY_TIMEOUT` | 内置通知 helper 的请求超时，固定 `15000`（毫秒） |
| `DAIDAI_NOTIFY_CHANNEL_ID` | 当前任务在「通知渠道」里选定的默认渠道 ID。**任务没有选渠道时这个变量不存在**，内置 helper 会退回「发给全部启用渠道」 |
| `DAIDAI_SCRIPTS_DIR` | 脚本根目录的绝对路径（面板里「脚本管理」看到的那个根） |
| `DAIDAI_NOTIFY_PY` | 内置 Python 通知 helper `notify.py` 的绝对路径 |
| `DAIDAI_SEND_NOTIFY_JS` | 内置 Node 通知 helper `sendNotify.js` 的绝对路径 |
| `DAIDAI_PYTHON_VERSION` | 当前任务实际使用的 Python 小版本，如 `3.12`。任务表单里选的版本若在本机不可用，这里是回退后的**真实**版本 |
| `DAIDAI_SILENT_EXIT_DETECT` | **由你按需设置**（不是面板注入的）。填 `0` / `off` / `false` 可为该任务单独关掉「半路静默结束」检测，见下方小节 |

三点补充：

1. **这些名字是保留名。** 注入发生在面板环境变量之后，如果你在「环境变量」页面建了一条同名的 `DAIDAI_NOTIFY_URL`，任务运行时会被上面的值覆盖掉。
2. **脚本调试运行、`ddp python` / `ddp shell` 也有。** 这两条路径同样会注入这批变量（但没有 `DAIDAI_NOTIFY_CHANNEL_ID`，因为它们不挂在任何任务上），令牌也同样在运行 / 会话结束后立即作废，详见[第 6 节](#6-安全说明)。
3. **子进程会继承。** 脚本里 `subprocess` / `child_process` 起的子命令自动继承这些变量，所以在 Python 里调 `ddp`、在 Node 里调 `curl` 都不用手动传。

### Node 任务：半路静默结束的检测与豁免

Node 有一个别的语言没有的失败模式：某个 `Promise` 永远不 resolve 也不 reject，`await` 它的调用永久卡住，事件循环随后排空，**node 以退出码 0 干净退出**。从面板外面看和「跑完了」一模一样，任务会被记成成功、不发失败通知。

典型触发写法是「请求在响应中途断开」——只在请求对象上挂了 `error` 监听，而 Node 在响应已经开始之后是把错误发给响应对象的：

```js
// ❌ 响应中途断流时，这个 Promise 永远不会 settle
new Promise((resolve, reject) => {
  const req = http.request(opts, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    // 缺了 res 上的 'aborted' / 'error'
  });
  req.on('error', reject);
  req.end();
});
```

面板默认会检测这种情况（系统设置 → 任务 → **检测脚本半路静默结束**）。命中时日志里出现 `[任务疑似半路结束]`，退出码被置为 `75`，任务判失败并正常发通知。

**这个检测有无法消除的误报**：「被抛弃的 Promise」和「被卡住的 Promise」在结构上完全一样，探针分不出来，只有脚本自己知道工作做没做完。所以下面这类写法会被误判——它们的共同点是留下了一个**背后没有定时器/socket 等句柄**的未完成 Promise：

```js
// 被抛弃的一方没有句柄时会误报（有 setTimeout 的版本不会，进程会老实等它）
await Promise.race([new Promise(() => {}), timeout(20)]);
report().catch(() => {});      // fire-and-forget 挂防御性 catch
```

**三条豁免通道，按精确度从高到低**：

| 方式 | 作用范围 | 怎么用 |
|------|----------|--------|
| `globalThis.daidaiDone?.()` | 单个脚本 | 主流程末尾加一行，声明「我跑完了」，之后一律判 CLEAN |
| `DAIDAI_SILENT_EXIT_DETECT=0` | 单个任务 | 在该任务的环境变量里加这条，只关它一个 |
| 系统设置里关掉 | 全部任务 | 影响面最大，非必要不用 |

推荐第一种：写 `?.()` 而不是 `()`，这样脚本在面板之外（本地、青龙）跑时不会因为没有这个函数而报错。

> 只有 `.js` / `.mjs` / `.ts` 任务有这套检测。Python 和 Shell **没有这个失败模式**——Python 里 `await` 一个永不完成的 future，asyncio 事件循环不会退出，进程会一直挂着，最终落到面板的任务超时路径。

### 发通知优先用内置 helper

通知这件事已经有现成的封装，不必自己拼 HTTP：

```python
# Python
from notify import send
send("任务标题", "正文第一行\n正文第二行")
```

```js
// Node
const { sendNotify } = require('sendNotify');
await sendNotify('任务标题', '正文第一行\n正文第二行');
```

两个 helper 由面板自动放进脚本根目录并加进 `PYTHONPATH` / `NODE_PATH`，`import` / `require` 直接能找到，签名与青龙保持兼容。它们内部读的就是 `DAIDAI_NOTIFY_URL` 和 `DAIDAI_NOTIFY_TOKEN`。

---

## 2. 最小示例：Python / Node / Shell

三段都是完整可跑的脚本，直接复制进「脚本管理」建个文件就能测。示例操作的变量名叫 `DEMO_TOKEN`，换成你自己的即可。

### Python（标准库 `urllib.request`，无需装依赖）

> 用的是标准库，Alpine 和 Debian 镜像都自带，复制过去就能跑。
> 习惯 `requests` 的话也可以，但它不是内置的，得先去「依赖管理 → Python」装一下。

```python
#!/usr/bin/env python3
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

API_BASE = os.environ["DAIDAI_API_BASE"]
TOKEN = os.environ["DAIDAI_TOKEN"]


def api(method, path, payload=None):
    """最小 HTTP 客户端。payload 为 None 时不带请求体。"""
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(API_BASE + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    if data is not None:
        req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as err:
        # 面板的错误响应统一是 {"error": "原因"}
        detail = err.read().decode("utf-8", "replace")
        raise RuntimeError("%s %s 失败: %s %s" % (method, path, err.code, detail))

    return json.loads(body) if body else None


def list_env(name):
    """按名字查环境变量记录。多账号场景下会返回多条。"""
    query = urllib.parse.urlencode({"keyword": name, "all": "1"})
    result = api("GET", "/envs?" + query) or {}
    # keyword 是模糊匹配（名称/备注/值/分组都会命中），所以这里再按名字精确过滤一次
    return [item for item in (result.get("data") or []) if item["name"] == name]


def upsert_env(name, value, remarks=None):
    """按名字写回。同名存在多条时接口会直接报错，不会静默改错一条。"""
    payload = {"name": name, "value": value}
    if remarks is not None:
        payload["remarks"] = remarks
    return api("PUT", "/envs/by-name", payload)


def notify(title, content):
    api("POST", "/notifications/send", {"title": title, "content": content})


def main():
    records = list_env("DEMO_TOKEN")
    print("DEMO_TOKEN 当前有 %d 条记录" % len(records))

    if len(records) > 1:
        # 多账号变量不能整段写回，详见第 5 节
        print("DEMO_TOKEN 是多账号变量，请改用 PUT /envs/<id> 单条更新")
        return 1

    # 假设脚本在这里刷新出了新的凭据
    upsert_env("DEMO_TOKEN", "new-token-value", remarks="脚本自动更新")
    notify("示例任务", "DEMO_TOKEN 已更新")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

### Node（fetch，Node 18+ 自带，无需装依赖）

```js
const API_BASE = process.env.DAIDAI_API_BASE;
const HEADERS = {
  Authorization: `Bearer ${process.env.DAIDAI_TOKEN}`,
  'Content-Type': 'application/json',
};

async function api(method, path, body) {
  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers: HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    // 面板的错误响应统一是 {"error": "原因"}
    throw new Error(`${method} ${path} 失败: ${resp.status} ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function listEnv(name) {
  const result = await api('GET', `/envs?all=1&keyword=${encodeURIComponent(name)}`);
  // keyword 是模糊匹配，这里再按名字精确过滤一次
  return (result.data || []).filter((item) => item.name === name);
}

async function upsertEnv(name, value, remarks) {
  const payload = { name, value };
  if (remarks !== undefined) payload.remarks = remarks;
  return api('PUT', '/envs/by-name', payload);
}

async function main() {
  const records = await listEnv('DEMO_TOKEN');
  console.log(`DEMO_TOKEN 当前有 ${records.length} 条记录`);

  if (records.length > 1) {
    // 多账号变量不能整段写回，详见第 5 节
    console.log('DEMO_TOKEN 是多账号变量，请改用 PUT /envs/<id> 单条更新');
    return;
  }

  await upsertEnv('DEMO_TOKEN', 'new-token-value', '脚本自动更新');
  await api('POST', '/notifications/send', {
    title: '示例任务',
    content: 'DEMO_TOKEN 已更新',
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
```

### Shell（curl）

```bash
#!/usr/bin/env bash
set -euo pipefail

AUTH="Authorization: Bearer ${DAIDAI_TOKEN}"
JSON='Content-Type: application/json'

# 1. 读：查名字里含 DEMO_TOKEN 的环境变量（keyword 是模糊匹配）
echo "--- 当前记录 ---"
curl -sS -H "$AUTH" "${DAIDAI_API_BASE}/envs?all=1&keyword=DEMO_TOKEN"
echo

# 2. 写：按名字 upsert。同名多条时接口返回 400，set -e 配合下面的判断会让脚本停下来
echo "--- 写回 ---"
http_code=$(curl -sS -o /tmp/ddp_upsert.json -w '%{http_code}' \
  -X PUT -H "$AUTH" -H "$JSON" \
  -d '{"name":"DEMO_TOKEN","value":"new-token-value","remarks":"脚本自动更新"}' \
  "${DAIDAI_API_BASE}/envs/by-name")
cat /tmp/ddp_upsert.json
echo
if [ "$http_code" -ge 400 ]; then
  echo "写入失败，HTTP $http_code" >&2
  exit 1
fi

# 3. 发通知
echo "--- 通知 ---"
curl -sS -X POST -H "$AUTH" -H "$JSON" \
  -d '{"title":"示例任务","content":"DEMO_TOKEN 已更新"}' \
  "${DAIDAI_API_BASE}/notifications/send"
echo
```

---

## 3. 常用接口速查

**统一约定**

- 根地址：`$DAIDAI_API_BASE`（即 `http://127.0.0.1:<后端端口>/api/v1`）
- 鉴权：请求头 `Authorization: Bearer $DAIDAI_TOKEN`
- 请求体：JSON，需要带 `Content-Type: application/json`
- 出错：HTTP 4xx / 5xx，响应体是 `{"error": "原因"}`
- 列表类接口返回 `{"data": [...], "total": N, "page": 1, "page_size": 20}`

**环境变量**

| 接口 | 说明 |
|------|------|
| `GET /envs?keyword=<关键字>&all=1` | 查询。`keyword` 对名称 / 备注 / 值 / 分组做模糊匹配，拿到结果后请自己按 `name` 精确过滤。`all=1` 表示不分页（上限 5000 条） |
| `PUT /envs/by-name` | **按名字 upsert**，body `{"name": "...", "value": "...", "remarks": "...", "enabled": true}`。`remarks` / `enabled` 可省略，省略即不改。不存在则创建，存在一条则更新，**存在多条直接报错** |
| `PUT /envs/<id>` | 按 id 更新单条，body 可只带 `{"value": "..."}` |
| `POST /envs` | **纯新增**，同名不去重（青龙兼容行为）。脚本想「更新」请勿用这个，会越跑越多条 |
| `DELETE /envs/<id>` | 删除单条 |

变量名必须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`，否则报「变量名格式无效」。

**任务**

| 接口 | 说明 |
|------|------|
| `GET /tasks` | 任务列表 |
| `PUT /tasks/<id>/run` | **触发执行**。走面板自己的调度器，尊重最大并发数与「不允许多实例」。任务已在运行时返回 400 |
| `PUT /tasks/<id>/stop` | 终止运行中的任务 |
| `PUT /tasks/<id>/enable`、`PUT /tasks/<id>/disable` | 启用 / 禁用 |
| `GET /tasks/<id>/latest-log` | 最近一次执行日志 |

**日志 / 脚本 / 订阅 / 通知**

| 接口 | 说明 |
|------|------|
| `GET /logs`、`GET /logs/<id>` | 执行日志列表与详情 |
| `GET /scripts/content?path=<相对路径>` | 读脚本文件 |
| `PUT /scripts/content` | 写脚本文件，body `{"path": "...", "content": "..."}` |
| `PUT /subscriptions/<id>/pull` | 立即拉取一次订阅 |
| `POST /notifications/send` | 发通知，body `{"title": "...", "content": "...", "channel_id": 1}`。`channel_id` / `channel_ids` 都可省略，省略即发给全部启用渠道 |

> 注：面板同时保留了不带版本号的 `/api/...` 路径（等价于 `/api/v1/...`），脚本里用 `$DAIDAI_API_BASE` 即可，不必关心。

---

## 4. 两条路径：`ddp` 还是 HTTP

面板自带的 `ddp` 命令行也能做很多事，可以在脚本里用 `subprocess` 调。两者的根本差别是：

|  | `ddp` CLI | HTTP API |
|--|-----------|----------|
| 怎么工作 | 自己打开数据库直接读写 | 请求正在运行的面板进程 |
| 要不要令牌 | 不要 | 要 `$DAIDAI_TOKEN` |
| 要不要面板在跑 | 不要 | 要 |
| 输出 | 给人看的文本，不好解析 | JSON |
| **触发任务** | ⚠️ **会绕开并发闸门** | ✅ 走面板调度器 |

### ⚠️ 不要用 `ddp task run` 触发任务

`ddp task run` 会在 `ddp` 这个**独立进程**里现搭一套执行器和调度器，然后自己把任务跑起来。

而面板的两道闸门 —— 「定时任务最大并发数」和任务的「不允许多实例」—— 都是**面板进程内部的状态，跨进程不共享**。也就是说：

- `ddp task run` 跑起来的任务**不占用**面板的并发名额，等于凭空多开一条执行线。并发数设成 1 也拦不住
- 「不允许多实例」也只能靠数据库里的任务状态做一次前置检查，挡不住并发触发的竞态

所以脚本里要触发另一个任务，**请走 HTTP**（`api()` 是上面第 2 节那个小封装）：

```python
api("PUT", "/tasks/12/run")
```

`ddp task run` 保留给**人在终端里手动跑**用（`docker exec -it daidai-panel ddp task run 12`），那种场景下你自己知道正在开第二条线。

### 按场景怎么选

| 我要做的事 | 推荐 |
|------------|------|
| 发通知 | 内置 `notify.py` / `sendNotify.js` |
| 读环境变量 | 直接读进程环境变量（面板已经注入好了），不用调接口 |
| 按名字写回环境变量 | HTTP `PUT /envs/by-name`，或脚本里 `ddp env set` |
| **触发另一个任务** | **HTTP `PUT /tasks/<id>/run`** |
| 查任务 / 日志 | 两者皆可，要解析结果就用 HTTP |
| 拉订阅 | 两者皆可 |

在脚本里调 `ddp` 长这样：

```python
import subprocess
subprocess.run(["ddp", "env", "set", "DEMO_TOKEN", "new-token-value"], check=True)
```

---

## 5. 更新环境变量的正确姿势

「跑完把新 Cookie 写回去」是脚本最常见的需求，也是最容易把数据搞坏的地方。先理解面板是怎么把环境变量交到你手上的。

### 面板注入时做了什么

1. 按**变量名分组**。同名的多条记录（也就是多账号）会被合并成**一个**环境变量
2. 组内顺序：置顶的在前 → 分组内的排序位置 → 创建时间 → id
3. **只有一条**记录时：值原样注入，不做任何处理
4. **两条及以上**时：用 `&` 连接；只要任意一条的值里本身含 `&`，整体分隔符就升级为 `&&`。同时每条值会被转义 —— 先把 `\` 换成 `\\`，再给分隔符字符前加 `\`

所以你在脚本里读到的 `$JD_COOKIE`，在多账号情况下是一个**合并且转义过**的串，不等于任何一条记录的原始值。

### 陷阱一：多账号变量不能整段写回

```python
# ❌ 千万别这么写
cookie = os.environ["JD_COOKIE"]           # 可能是 "账号1\&x&&账号2" 这种合并串
upsert_env("JD_COOKIE", cookie + ";new")   # 整段塞回单条 → 多账号结构被压成一条，转义符还留在值里
```

`PUT /envs/by-name` 在检测到同名多条时会**直接返回错误**，就是为了拦住这种写法 —— 让脚本当场失败，好过把用户的多账号配置静默毁掉。

正确做法分两种情况：

```python
records = list_env("JD_COOKIE")

if len(records) <= 1:
    # 单账号：按名字 upsert 就行
    upsert_env("JD_COOKIE", new_value)
else:
    # 多账号：先找到你要改的那一条（按备注 / 按值里的账号标识匹配），再按 id 单独更新
    target = next(r for r in records if "pt_pin=myaccount" in r["value"])
    api("PUT", "/envs/%d" % target["id"], {"value": new_value})
```

多账号任务通常本来就是一个账号跑一次（命令里的 `conc` / `desi` 模式），这时你手上的是**单个账号的值**，配合它对应的记录 id 更新即可。

### 陷阱二：值写成 `["a","b"]` 会被当成多账号

面板在按账号拆分变量时（任务命令用了 `conc` / `desi` 多账号模式），会**先尝试把整串当 JSON 字符串数组解析**：只要它长得像 `["a","b"]` 并且能解析成功，就直接按数组元素拆成多个账号，`&` 分隔规则完全不参与。这是为兼容青龙保留的行为。

后果是：如果你的脚本把一段恰好是 JSON 数组字面量的内容写进某个变量，它在多账号模式下会被拆开。

```python
# ⚠️ 这条值会在 conc / desi 模式下被拆成两个"账号"
upsert_env("MY_LIST", '["a","b"]')

# ✅ 想存 JSON 又不想被拆，就别让它以 [ 开头 —— 包一层对象即可
upsert_env("MY_LIST", '{"items":["a","b"]}')
```

写入接口是**逐字节原样存**的，不会替你改写，也不会替你"修正"。要不要规避取决于你自己。

### `ddp env set` 的两个副作用

`ddp env set` 与 `PUT /envs/by-name` 语义一致（0 条创建 / 1 条更新 / 多条报错），但命令行版更新已有记录时会**把没传的字段一并重置**：

- 不传 `--group` → 分组被清空
- 不传 `--remarks` → 备注被清空
- 不传 `--disabled` → 强制设为启用

想保留原有的分组和备注，就把它们一起带上，或者改用 HTTP 的 `by-name`（省略的字段不会动）。

---

## 6. 安全说明

**这枚令牌能干什么**

`$DAIDAI_TOKEN` 是 operator 角色，能读写：

- ✅ 环境变量（增删改查、导入导出）
- ✅ 任务（增删改查、运行、停止、批量操作、导入导出）
- ✅ 脚本文件（读、写、上传、删除）
- ✅ 订阅（增删改、立即拉取）
- ✅ 执行日志（查看、删除）
- ✅ 发送通知

被挡在外面的（需要 admin）：系统配置、依赖管理、备份与恢复、通知渠道的增删改、用户管理、安全设置（登录日志 / 会话 / IP 白名单 / 审计日志）、SSH Key、Open API 应用管理。

它**不是**你的登录态：你在网页端登出或改密码都不影响它，反过来它也改不了任何账号密码、看不到用户数据。

**有效期与作废时机**

面板有三条路径会签发这枚令牌 —— 定时任务执行、`ddp python` / `ddp shell`、脚本编辑器的调试运行。
**三条都是「用完立刻作废，有效期只做兜底」**：

| 签发路径 | 兜底有效期 | 什么时候作废 |
|----------|-----------|--------------|
| 定时任务执行 · 设了「超时时间」 | 超时时长 + 1 小时 | 任务收尾时 |
| 定时任务执行 · 没设超时（默认） | 7 天 | 任务收尾时 |
| `ddp python` / `ddp shell` | 7 天（与上一行同一个常量） | 命令退出时 |
| 脚本编辑器的「调试运行 / 运行代码」 | 2 小时 | 运行结束时（含点「停止」） |

「任务收尾」覆盖正常结束、失败、超时被杀、脚本异常崩溃四种情况 —— 收尾逻辑挂在 `defer` 上，走哪条路都会经过。作废之后再拿它调任何接口都会得到 `401 {"error":"令牌已被撤销"}`。

上面那列有效期只在**吊销压根没机会执行**时才起作用：面板进程被 `kill -9`、宿主断电。正常运行下这枚令牌的实际寿命就是一次运行的时长。

> 这三条是当前版本签发脚本令牌的**全部**入口 —— 它们最终都汇聚到同一段注入逻辑。
> 如果你在别处看到 `DAIDAI_TOKEN`，那也是从上面某一条继承下来的（比如脚本起的子进程）。

**请遵守**

- 🚫 **不要打印到日志**。`print(os.environ["DAIDAI_TOKEN"])` 会让令牌进入执行日志，而日志是可以被导出的
- 🚫 **不要发给第三方**。它只对本机 `127.0.0.1` 上的面板有意义，发到外网服务器上没有任何用处，只有风险
- 🚫 **不要写进通知内容**、不要提交进 Git、不要缓存到文件
- ⚠️ **不要把它当长期凭据**。一次运行结束就失效了，缓存下来下次用一定会 401。每次运行都从环境变量重新读
- ✅ 需要给外部系统长期访问，请到「系统设置 → Open API」建应用，那才是为第三方对接设计的

---

## 7. `ddp` 在哪些安装方式里有

| 安装方式 | `ddp` 位置 | 脚本里能否直接调 |
|----------|-----------|------------------|
| Docker（Alpine / Debian 镜像） | `/usr/local/bin/ddp` | ✅ 直接 `ddp` |
| Android Magisk 模块 | 容器内 `/usr/local/bin/ddp` | ✅ 直接 `ddp`（必须在容器内，宿主侧那份找不到数据库） |
| Windows 单机版 zip | 与 `daidai-server.exe` 同目录的 `ddp.exe` | ✅ 需保证它在 PATH 里，或用绝对路径 |
| Linux tar.gz | 解压后与主程序同目录的 `ddp`（**v3.0.0 起随包提供**） | ⚠️ 见下方「找不到配置」 |

### `ddp` 找不到配置怎么办

`ddp` 需要读 `config.yaml` 才知道数据库在哪，查找顺序是：

1. 环境变量 `DAIDAI_CONFIG` 指定的路径
2. `/app/config.yaml`（Docker 镜像就是靠这条）
3. `ddp` 可执行文件**同目录**下的 `config.yaml`
4. 当前工作目录下的 `config.yaml`

Docker / Magisk 走第 2 条，天然可用。**二进制部署（Linux tar.gz、Windows）要注意**：如果你把 `ddp` 单独复制到了 `/usr/local/bin`，而 `config.yaml` 留在别处，上面四条就全落空了 —— 任务执行时的工作目录是脚本所在目录，第 4 条也帮不上忙。

两种解法，任选其一：

- 把 `ddp` 留在解压出来的目录里（和 `config.yaml` 做邻居），脚本里用绝对路径调用
- 在面板的「环境变量」页面加一条 `DAIDAI_CONFIG`，值填 `config.yaml` 的绝对路径。它会被注入任务环境，`ddp` 子进程就能读到

配好之后在容器 / 终端里跑一下 `ddp status`，能打出版本和数据目录就说明找对了。

### ⚠️ 任务命令栏不能直接填 `ddp`

面板的任务命令栏只支持两种写法：**脚本文件**（`python xxx.py`、`node xxx.js`……）和**托管依赖命令**。后者只会在面板自己的 Python venv 目录和 Node `node_modules/.bin` 目录里找可执行文件，**完全不查系统 PATH**。

所以任务命令直接写 `ddp task list` 会报「找不到托管依赖命令 ddp」。

要用 `ddp`，请在脚本内部以子进程方式调用：

```python
import subprocess
result = subprocess.run(["ddp", "env", "list"], capture_output=True, text=True)
print(result.stdout)
```

```js
const { execFileSync } = require('child_process');
console.log(execFileSync('ddp', ['env', 'list'], { encoding: 'utf8' }));
```

```bash
ddp env list
```

---

## 相关文档

- [README → 容器命令 `ddp`](../README.md#容器命令-ddp)：`ddp` 全部子命令
- [README → 端口与反向代理](../README.md#端口与反向代理)：`DAIDAI_API_BASE` 里那个端口是怎么来的
