# WPS 灵犀（Dsh）接入协议规格

> 本文件是实现 `dsh-connect-lingxi` 的**唯一事实来源**。所有端点、请求体、响应体、头部、错误语义
> 均已从两个已验证的实现中核对过：
>
> - `@kevinfx/magpie-wps-lingxi@0.3.3`（npm，MIT）—— Magpie/OpenCode provider，已跑通真机
> - `xfyang728/dsh-router-wpslingxi`（GitHub）—— DSH 侧 supplier，协议同源
>
> 参考源码副本在 `.reference/`（**不随 npm 包发布**，只用于开发对照）。

---

## 0. 上游性质

灵犀**没有开放平台 API**。下面这些是**桌面客户端自己使用的私有 app-server 接口**：

- 基址：`https://lingxi.wps.cn`，登录域名可能是 `https://lingxi.kdocs.cn`
- 鉴权：`wps_sid` cookie（+ 客户端指纹 cookie）
- 一次对话 = **三次 HTTP 握手**，最后一次才是 SSE 流

与 ima 的区别：ima 的「问问ima」是模型通道（`robot_type=10000`），灵犀是**完整 agent 通道**——
原生 `messages`/`tools` 进，原生 `tool_calls`/`reasoning_content`/`usage` 出，**可以直接当 DSH 的 agent 后端**。

---

## 1. 常量

| 名称 | 值 |
| --- | --- |
| `BASE` | `https://lingxi.wps.cn` |
| `KDOCS_BASE` | `https://lingxi.kdocs.cn`（登录域名；两个都要试） |
| `AGENT_SESSIONS_PATH` | `/api/aioffice/v1/cowork/sessions` |
| `AGENT_RUNS_PATH` | `/api/public/v1/credits/runs` |
| `AGENT_CHAT_PATH` | `/api/public/v1/agent-runtime/chat/completions` |
| `PLANS_PATH` | `/api/aioffice/v1/sessions/plans` |
| `BALANCE_PATH` | `/api/public/v1/credits/balance` |
| `PROFILE_PATH` | `/api/public/v1/account/profile` |
| `TASKS_PATH` | `/api/public/v1/tasks` |
| `CLIENT_TYPE` | `lingxi_claw` |
| `CLIENT_LANG` | `zh-CN` |
| `UA` | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36` |
| `DEVICE_ID` | `sha256("dsh-connect-lingxi-device")` 的十六进制串 |
| `RUN_TTL_MS` | `3600000`（run 缓存 1 小时） |
| `MAX_PROMPT_KB` | `320`（提示词预算；超出时截断历史并**必须打日志**） |

### 客户端指纹 cookie（每次请求都要带）

```
x-kso-app-name=win-lingxi-desktop
x-kso-app-version=1.3.31
x-kso-device-id=<DEVICE_ID>
```

拼在用户 cookie 之后：`${userCookie}; ${KSO_PARTS.join("; ")}`。

### 区域头

若 cookie 里含 `copilot_server_branch=<x>`，请求头加 `X-Cc-Region: <x>`。

---

## 2. 头部

### 2.1 基础头（会话 / run / plans / balance / profile）

```
Cookie: <userCookie + KSO 指纹>
User-Agent: <UA>
Referer: <base>/
Accept: application/json
```

### 2.2 Agent 头（对话请求）

在基础头上追加：

```
Content-Type: application/json
X-Client-Type: lingxi_claw
X-Client-Lang: zh-CN
X-Cc-Agent-Type: lingxi_claw
X-Request-Id: <每次请求唯一>
X-Cc-Session-ID: <session_id>
X-Cc-Run-ID: <run_id>
[X-Cc-Region: <region>]     // 仅当 cookie 带 copilot_server_branch
```

---

## 3. 三步握手

### 3.1 建会话

`POST <base>/api/aioffice/v1/cowork/sessions`

```json
{
  "session_type": "cowork_client",
  "agent_version": 2,
  "env": {
    "device_id": "<DEVICE_ID>",
    "device_name": "<本机用户名>",
    "work_space_dir": "<os.tmpdir()>"
  }
}
```

响应：`data.session_id`（字符串）。

### 3.2 领 run

`POST <base>/api/public/v1/credits/runs`

```json
{
  "client_request_id": "<String(Date.now())>",
  "session_id": "<session_id>",
  "model_provider": "lingxi",
  "model_id": "<模型 id>",
  "agent_input": {
    "text": "<最后一条用户消息>",
    "files": [],
    "file_ids": [],
    "expect_model": "<模型 id>",
    "refs": [],
    "permission_mode": "default",
    "current_mode": "agent",
    "browser_plugin_enabled": false
  }
}
```

响应：`data.run_id`、`data.group_id`（缺省回退 `run_id`）。

### 3.3 对话

`POST <base>/api/public/v1/agent-runtime/chat/completions`

请求体是 **OpenAI 形状**：

```json
{
  "stream": true,
  "model": "<模型 id>",
  "messages": [ /* OpenAI messages 原样 */ ],
  "tools": [ /* 可选 */ ],
  "tool_choice": "...",
  "temperature": 0.7,
  "base_llm_arguments": { "max_tokens": 4096 },
  "reasoning_effort": "high",
  "llm_arguments": { "reasoning_effort": "high" }
}
```

映射规则：

| OpenAI 字段 | 灵犀字段 |
| --- | --- |
| `max_tokens` | `base_llm_arguments.max_tokens` |
| `reasoning_effort` | 同时写 `reasoning_effort` 和 `llm_arguments.reasoning_effort` |
| `tools` / `tool_choice` | 原样 |

---

## 4. SSE 帧格式（**注意与 OpenAI 不同**）

上游每帧：

```
data: {"code":"Success","usage":{...},"choices":[{"text":"...","reasoning_content":"...","tool_calls":[...],"finish_reason":"..."}]}

```

关键差异：

1. **正文在 `choices[].text`，不是 `choices[].delta.content`**。
2. **没有 `[DONE]` 结束帧**，靠 `choices[].finish_reason` 收尾。
3. `usage` 的字段名与 OpenAI 不完全一致（缓存/推理字段名不同），需归一化：
   `prompt_tokens` / `completion_tokens` / `total_tokens`，
   缓存命中映射到 `prompt_tokens_details.cached_tokens`。
4. `tool_calls` 按 `index` 聚合：同 index 的 `id` / `function.name` 取首个非空，
   `function.arguments` **字符串拼接**。

### 4.1 翻译目标

本地 shim 对外暴露标准 OpenAI SSE：

```
data: {"id":"chatcmpl-lingxi-<ts>","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"..."}}]}

data: {"id":"...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"..."}}]}

data: {"id":"...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"...","type":"function","function":{"name":"...","arguments":"..."}}]}}]}

data: {"id":"...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"id":"...","object":"chat.completion.chunk","choices":[],"usage":{...}}

data: [DONE]
```

非流式模式（`stream:false`）则聚合成标准 `chat.completion` JSON。

---

## 5. 错误语义

| 上游情况 | 状态码 | 语义 |
| --- | --- | --- |
| 审核拦截（body 含 audit 标记） | 400 | `audit_blocked`，**不是**登录失效 |
| 401 / 403 且文案含 `unauthor\|登录\|凭据\|credential\|cookie\|sid` | 401 | 登录失效 |
| 401 / 403 其它 | 404 | 映射成模型不存在 |
| 400 / 404 / 422 | 404 | 模型或参数不对 |
| 5xx | 原样 | 服务端错误 |
| 其它 | 502 | 兜底 |

**关键**：只有明确的鉴权失败才报 401。否则会把账号误标成「未登录」并从 provider 列表里摘掉。

run 失效（如 `run_id` 过期）→ 删除缓存的 run，重建一次再试（只重试一次）。

---

## 6. 模型目录

### 6.1 动态（登录后）

`GET <base>/api/aioffice/v1/sessions/plans`

响应 `data.plans[]`（模式）与 `data.models[]`（模型），每项：

```json
{
  "key": "deepseek-v4.1-flash",
  "name": "DeepSeek V4.1 Flash",
  "desc": "...",
  "multiplier": "0.12x",
  "max_context_tokens": 1048576,
  "max_new_tokens": 8192,
  "support_multimodal": true,
  "reasoning_efforts": ["low", "high"]
}
```

### 6.2 静态兜底（未登录 / 接口失败时）

14 个模型（客户端 1.3.31 对齐）：

| id | 名称 | 上下文 | 倍率 | 思考 | 图片 |
| --- | --- | --- | --- | --- | --- |
| `auto` | 自动推荐 (Auto) | 1048576 | 1.0x | ✅ | ❌ |
| `deepseek-v4.1-flash` | DeepSeek V4.1 Flash | 1048576 | 0.12x | ✅ | ✅ |
| `deepseek-v4-flash-0731` | DeepSeek V4 Flash | 1048576 | 0.09x | ✅ | ❌ |
| `deepseek-v4-pro-0813` | DeepSeek V4 Pro | 1048576 | 0.40x | ✅ | ❌ |
| `kimi-k3` | Kimi-K3 | 1048576 | 1.60x | ✅ | ✅ |
| `GLM-5.3` | GLM-5.3 | 1048576 | 0.75x | ✅ | ❌ |
| `GLM-5.3-Flash` | GLM-5.3-Flash | 1048576 | 0.11x | ✅ | ✅ |
| `qwen3.8_max` | Qwen3.8-Max | 1048576 | 0.80x | ✅ | ✅ |
| `qwen3.8_flash` | Qwen3.8-Flash | 1048576 | 0.08x | ✅ | ✅ |
| `minimax_m3` | minimax-M3 | 1048576 | 0.20x | ❌ | ✅ |
| `doubao_seed_2_1_pro_260628` | Doubao-Seed-2.1 Pro | 262144 | 0.50x | ✅ | ✅ |
| `mimo-v2.6-pro` | Xiaomi MiMo-V2.6 Pro | 1048576 | 0.10x | ❌ | ✅ |
| `plan_pro` | Pro 模式 (深度推理) | 1048576 | 1.0x | ✅ | ❌ |
| `plan_max` | Max 模式 (复杂任务) | 1048576 | 1.0x | ✅ | ❌ |

模型 id 归一：去掉 `wps-lingxi/` 前缀；`default` → `deepseek-v4.1-flash`。

---

## 7. 凭证

三条获取路径，**优先级按「用户成本」从低到高**（手粘是最后兜底）：

### 7.1 读本机灵犀客户端 Cookie 库（零交互，Windows）

**目录名是 `kdesk`，不是产品名。** 实际布局：

```
%APPDATA%\kdesk\Network\Cookies
%APPDATA%\kdesk\Partitions\<n>\Network\Cookies
%APPDATA%\kdesk_yyb\...（同族变体）
```

探测时把 `%APPDATA%` 下名字匹配 `lingxi|kdesk|wps` 的目录全试一遍。

- `Local State` 里 `os_crypt.encrypted_key` 是 **DPAPI 包装**的 32 字节 AES key
  （前缀 `DPAPI`，5 字节）。
- 解 DPAPI：借 **PowerShell 一次性**（`ProtectedData.Unprotect`，CurrentUser），
  **不引入原生依赖**。
- Cookie 值是 Chromium **OSCrypt v10/v11**（AES-256-GCM）：前 3 字节版本，
  nonce 12 字节，tag 16 字节，密文其余；`v20` 在密文前多 32 字节 host hash。

### 7.2 复用日常浏览器的登录态（零交互）

```
%LOCALAPPDATA%\Microsoft\Edge\User Data\Local State            ← AES key 在这
%LOCALAPPDATA%\Microsoft\Edge\User Data\Profile 1\Network\Cookies
%LOCALAPPDATA%\Google\Chrome\User Data\Default\Network\Cookies
```

**两个必须记住的坑：**

1. `Local State` 在**数据目录根**，所有 `Profile N` 共用同一个 key —
   取 key 必须向上一层找，否则 `Profile 1` 的 cookie 全解不开。
2. profile 目录**不一定叫 `Default`**（Edge 可以只建 `Profile 1`）—
   判据要认 `Network/Cookies`。

**读库的两个硬约束：**

- 不能直接开原库：Chromium 用 WAL，进程活着时 `open` 得到
  `unable to open database file`。必须先复制快照（`Cookies` + `-wal` + `-shm`）。
- 某些 Edge 版本对库加独占锁（`EBUSY`）。此时**如实回报 `busy`**，
  界面提示「关掉浏览器即可」——这与「没登录」的用户动作完全不同。

### 7.3 一键浏览器登录（CDP）

拉起**临时 profile** 的 Chromium：

```
<browser>.exe --user-data-dir=<tmp> --remote-debugging-port=0 https://lingxi.wps.cn/
读 <tmp>/DevToolsActivePort 拿端口 → GET /json/list 找 page target
→ 连 webSocketDebuggerUrl → Network.enable → Network.getAllCookies → 取 wps_sid/uid
```

不碰密码（用户在真实浏览器里自己登录）；临时 profile 不污染日常浏览器。
浏览器候选：Edge → Chrome → Brave → 360 极速；`DSH_LINGXI_BROWSER` 可覆盖。

### 7.4 手粘 cookie（最后兜底）

设置页填 `wps_sid` 或整段 `Cookie:` 串。校验：`GET /api/public/v1/account/profile`
返回 200 且 `result !== "UserUnauthorized"` 才算有效。

> 要求用户手粘是**本插件的失败**，不是灵犀的限制 —— 上面三条都能做到零粘贴。

### 存储

凭证一律走 **DSH 凭据库**（`ctx.credentials`），加密落盘，**不进代码、不进仓库、不打日志**。

---

## 8. DSH 侧接入方式

### 8.1 架构：本地 shim + pi-ai provider

```
DSH  →  PiAiAdapter (@deepseek-ai/dsh-llm-pi-ai)
          → pi-ai provider (openaiCompletionsApi)
              → http://127.0.0.1:<随机端口>/v1/chat/completions   ← 本地 shim
                  → 灵犀三步握手 + SSE 翻译
```

shim 用 `node:http` 自己监听 `listen(0, '127.0.0.1')`（内核随机端口、仅回环），
**不占用固定端口、不对外暴露**。

### 8.2 三个注册点

```ts
ctx.llm.registerAdapter([PROVIDER], adapter)            // adapter = new PiAiAdapter({...})
ctx.llm.registerConfigurableProviders([{
  provider: PROVIDER, displayName: "WPS 灵犀",
  settingsNs, settingsPath: [], declared: false,
}])
ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => [
  { id, name, contextWindow, maxTokens, inputModalities },
])
```

`PROVIDER = "wps-lingxi"`。

### 8.3 PiAiAdapter 的 config 形状

```ts
new PiAiAdapter({
  profiles: () => Map<string, Profile>,
  auth: INERT_AUTH,
  resolveApiKey: async () => "<shim 的共享密钥>",
})
```

`Profile` 至少包含：

```ts
{
  provider: PROVIDER,
  displayName: "WPS 灵犀",
  streamIdleTimeoutMs: <ms>,
  retryPolicy: undefined,
  configuredMaxTokens: new Map(),
  modelErrors: new Map(),
  reasoning: "<默认档>",
  piProvider: <pi-ai provider>,
}
```

pi-ai provider：

```ts
createProvider({
  id: PROVIDER,
  name: "WPS 灵犀",
  auth: { apiKey: { name: "WPS 灵犀会话", resolve: async ({credential}) => credential?.key ? { auth: { apiKey: credential.key }, source: "WPS 灵犀" } : undefined } },
  models: <pi-ai model 列表>,
  api: openAICompletionsApi(),
})
```

### 8.4 model 目录 → pi-ai model

每个模型映射：`id`（加 `wps-lingxi/` 前缀与否由实现决定，但**必须与 `listModels` 返回的 id 一致**）、
`name`、`context`（contextWindow）、`maxTokens`、`reasoning`（该模型是否支持思考档）、
`inputModalities`（`text` / `image`）。

---

## 9. 提示词预算

`MAX_PROMPT_KB = 320`。超出时**按顺序丢弃最老的历史消息**，并对超长单条消息做截断。
丢弃/截断必须 `ctx.logger.warn` 一行（静默截断会让用户以为上下文完整）。

---

## 10. v2 范围（0.0.2 已完成）

**做**：

- 三步握手 + SSE 翻译 + 本地 shim
- 动态模型目录 + 静态兜底
- `ctx.llm` 三个注册点
- 余额读取（`/credits/balance`）与设置页展示
- 每日签到 / 一次性任务领取（§13）
- **零粘贴登录**：客户端 Cookie 库 / 日常浏览器 / 一键浏览器登录（§11）
- 客户端 UI 卡片（余额、任务、模型、设置、诊断）+ 输入框积分胶囊
- 单元测试：SSE 翻译、模型目录归一、余额/任务解析、运行时编排、凭据探测

**仍未做**：

- 多账号池（灵犀一次登录只有一份 `wps_sid`，没有第二个账号可换）

---

## 11. 登录态来源（零粘贴）

**结论先行**：要求用户手粘 `wps_sid` 是**本插件的失败**，不是灵犀的限制。
灵犀客户端是 Electron、网页版是 Chromium，cookie 都存在本机，三条路径都能读。

### 11.1 本机灵犀客户端

**目录名是 `kdesk`，不是产品名 `WPS 灵犀`**（本机实测；`kdesk_yyb` 是同族变体）。

```
%APPDATA%\kdesk\...\Network\Cookies
%APPDATA%\kdesk\...\Partitions\<n>\Network\Cookies
```

判据：`%APPDATA%` 下名字匹配 `lingxi|kdesk|wps` 的目录全试一遍。

### 11.2 日常浏览器

```
%LOCALAPPDATA%\Microsoft\Edge\User Data\Local State          ← AES key 在这
%LOCALAPPDATA%\Microsoft\Edge\User Data\Profile 1\Network\Cookies
```

**两个必须记住的坑（本插件真实踩过）**：

1. **`Local State` 在数据目录根，不在 `Profile N` 里**。取 key 必须向上一层找，
   否则 `Profile 1` 的 cookie 全部解不开。
2. **profile 目录不一定是 `Default`**。Edge 可以只建 `Profile 1`；
   判据要认 `Network/Cookies`，不能只认 `Local State`。

### 11.3 读库的两个硬约束

1. **不能直接开原库**：Chromium 用 WAL，进程活着时 `open` 得到
   `unable to open database file`。必须先复制快照
   （`Cookies` + `-wal` + `-shm`）到临时目录。
2. **某些 Edge 版本对库加独占锁**：`CopyFile` / `readFileSync` 都 `EBUSY`。
   此时如实回报 `busy` —— 界面提示「关掉浏览器即可」，而不是含糊的「未登录」。
   这两种情况的用户动作完全不同，不能混。

### 11.4 一键登录（CDP）

拉起**临时 profile** 的 Chromium（`--user-data-dir=<tmp> --remote-debugging-port=0`），
打开 `https://lingxi.wps.cn/`，轮询 `http://127.0.0.1:<port>/json/list` 找到 page target、
连它的 `webSocketDebuggerUrl`、`Network.enable` + `Network.getAllCookies`，
取 `wps_sid` 与 `uid`。

- **不碰密码**：用户在真实浏览器里自己登录。
- **临时 profile**：不污染日常浏览器，也读不到别的站点 cookie。
- 浏览器候选：Edge → Chrome → Brave → 360 极速；可用 `DSH_LINGXI_BROWSER` 覆盖。

---

## 12. 任务中心与领取

`GET /api/public/v1/tasks` → `{ data: { tasks: [...] } }`，每条：

```json
{
  "task_key": "daily_check_in",
  "type": "daily",
  "status": "claimed | claimable | incomplete | locked",
  "reward_amount": 10,
  "action": "expert_mode | group_chat | download_client",
  "extra": { "consecutive_days": 3, "today_reward": 10, "check_in_days": [{ "date": "2026-11-09", "status": "claimed" }] }
}
```

领取：`POST /api/public/v1/tasks/{task_key}/claim[?date=YYYY-MM-DD]`，body `{}`。

- 响应 `result === "ok"` 为成功；`result` 缺失按成功（HTTP 200 已是成功信号）。
- 「已领过」也表达成非 ok 的 `result` + 中文 `hint`：**不是错误**，报成失败会让用户以为签到坏了。
- 签到日期优先取档位里等于**今天（+08:00）**的那天；没有就取第一个 `available`；再没有就发今天。

---

## 13. 一次性任务（三个 `incomplete` 都能做）

**共同前提：`execution_status` 生命周期。**

```
PUT /api/public/v1/sessions/{session_id}/execution_status
  running:   { group_id, status:"running",   run_token: group_id, lease_seconds: 90 }
  completed: { group_id, status:"completed", run_token: group_id, terminal_reason: "completed" }
```

不报的话服务端永远认为会话还在跑 → 建群 400、任务永不翻转。

| 任务 | 判据 | 复刻 |
| --- | --- | --- |
| `use_lingxi_client` | 会话 `client_type: lingxi_claw` + 一次真实对话 | 建会话带 `client_type`，领 run 带 `clientType` |
| `try_expert_mode` | 会话 `session_mode: expert` + `agent_input.current_mode: expert` + 一次对话 | 同上再加两个 expert 字段 |
| `try_group_chat` | WS `completions/ws` 收到过 `user.input`，然后建过群 | 见下 |

### 13.1 专家 + 客户端：一次对话同时命中

```
POST /api/aioffice/v1/cowork/sessions   { session_type:"cowork_client", client_type:"lingxi_claw", session_mode:"expert" }
POST /api/public/v1/credits/runs        { ..., agent_input.current_mode:"expert" }
PUT  .../execution_status               running
POST /api/public/v1/agent-runtime/chat/completions   { stream:false, max_tokens:4096 }
PUT  .../execution_status               completed
```

- 模型固定 `plan_pro`（网页端一致）。
- `max_tokens: 4096`：上游按用量扣智点（整数余额），回答太短可能凑不够 1 智点而不产生计费记录。
- 话术不能用「hi」这类裸词（cowork 风控会拒）：用
  `请用两三句话介绍一下你自己，包括你擅长的任务类型`。

### 13.2 群聊：使用信号 → 建群 → 解散

```
POST /api/aioffice/v1/cowork/sessions            { session_type:"cowork_web" }
WS   /api/aioffice/v1/sessions/{id}/completions/ws
     send { event:"user.input", data:{ agent_input:{...expect_model:"plan_pro"}, headers:{client_type:"lingxi_claw"} } }
     等 event ∈ run.end / stream.end / done
POST /api/imchat/v1/channels                     { session_id, expect_model:"plan_pro" } → channel_id
DELETE /api/imchat/v1/channels/{channel_id}       ← 立刻解散，不留垃圾群
```

- 顺序不能改：先有 WS 使用信号，`POST channels` 才会成功。
- **WS 必须能带 Cookie**：Node 内置 `WebSocket` 不支持自定义头，
  需要能带头的实现（或测试注入）。跑不通时会如实报「WS 对话未完成」。
- 解散失败不影响任务判定，但会在 detail 里写出来。

### 13.3 纪律

这些动作只提供**真实使用信号**，是否算完成由服务端判定。所以：

1. 动作之后**一律重拉任务**，不假设成功。
2. **余额为 0 时跳过**消耗性动作（一次对话会扣智点，没钱只是白失败）。
   余额**未知**时不阻止 —— 「不知道」不等于「没有」。
3. 领取顺序：**先做动作 → 重拉任务 → 领 claimable**。反过来会领到空。

