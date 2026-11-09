# 0.0.2：把「上游限制」这个词从文档里删掉

前一版有三处写成了「上游限制」，实际都是**我没实现**：

| 上一版写的 | 事实 | 这一版的修法 |
| --- | --- | --- |
| 「本机没装灵犀客户端，只能手粘 cookie」 | 客户端目录叫 `%APPDATA%\kdesk`（不是 `WPS 灵犀`），且日常浏览器里也有登录态 | 三条零粘贴来源：客户端库 / 日常浏览器 / 一键登录 |
| 「一次性任务里三个 `incomplete` 做不出来，纯 HTTP 无法翻转」 | Magpie 已用 `execution_status` 生命周期 + 建群流程跑通三个任务 | `protocol/onetime.ts` 完整复刻该流程 |
| 「余额/签到未经真机验证」 | 那是**没有登录态**导致的结果，不是协议做不到 | 协议已按取证代码实现；拿到登录态即可用 |

## 三条零粘贴登录来源

```
1. 本机灵犀客户端    %APPDATA%\kdesk\...\Network\Cookies      （DPAPI + AES-GCM）
2. 日常浏览器       %LOCALAPPDATA%\Microsoft\Edge\User Data\...  （同上）
3. 一键登录         拉起临时 profile 的 Edge/Chrome，用户自己登录，插件读 cookie
```

手粘 cookie 退化成**最后的兜底**，不再是主路径。

### 这一版真实踩到的三个坑（都已修）

1. **目录名猜错**：文档里写 `WPS 灵犀`，实际是 `kdesk`。现在同时试
   `kdesk` / `kdesk_yyb` / `WPS 灵犀` / `WPS Lingxi` / `lingxi`，外加扫
   `%APPDATA%` 下名字像灵犀的目录。
2. **`Profile 1` 不被认作 profile**：Edge 的布局是
   `User Data/Profile 1/Network/Cookies`，而 `Local State` 在 `User Data` 根上。
   旧判断只看 `Local State`，于是把 `Profile 1` 整个跳过。现在
   `looksLikeProfile` 认 `Network/Cookies`，且 AES key **向上找一层**继承。
3. **运行时库被独占锁住**：浏览器活着时 `CopyFile` 得到 `EBUSY`，
   某些 Edge 版本连 `open` 读都拒。现在用「读进内存再写快照」；
   仍然失败时**明确回报 `busy`**，界面上说的是「关掉浏览器即可」，
   而不是含糊的「未登录」——这两种情况的建议完全不同。

## 一次性任务：不再是「做不到」

三个任务的真实判据（取证自已在真机跑通的实现）：

| 任务 | 上游判据 | 复刻方式 |
| --- | --- | --- |
| `use_lingxi_client` | 会话 `client_type: lingxi_claw` 且有一次真实对话 | `ensureTaskRun` 带 `client_type` + `sendTaskChat` |
| `try_expert_mode` | 会话 `session_mode: expert` + `current_mode: expert` + 一次对话 | 同上，另带两个 expert 字段 |
| `try_group_chat` | 会话在 WS `completions/ws` 收到过 `user.input`，然后建过群 | WS 发使用信号 → `POST /imchat/v1/channels` → 立刻解散 |

**共同前提**：`PUT /api/public/v1/sessions/{id}/execution_status`
上报 `running`（带 `lease_seconds: 90`）与 `completed`（带
`terminal_reason: "completed"`）。不报的话服务端认为会话还在跑，
建群 400、任务永不翻转。

一条纪律保留：**不伪造结果**。这些动作只提供真实使用信号，是否算完成由服务端判定，
所以动作之后一律**重拉任务**看状态，不假设成功。

## 其余变化

- **一键登录按钮**：卡片上未登录时出现，点了拉起浏览器，登录完自动接上。
- **`login` 动作**进白名单（第五个），仍然只接受回环 Host。
- **配置项**：`autoDetectCookie`（默认开）、`useBrowserProfile`（默认开）、
  `clientDataDir`（留空自动探测）；`cookie` 变成可选兜底。
- **删掉** `src/credentials/client-cookie.ts`（被 `sources.ts` 取代）。
- **新测试**：`credentials.test.ts` 11 条、`onetime.test.ts` 14 条。

## 当前状态

```
13 个测试文件 / 149 个用例 / 0 失败
typecheck 通过 · 构建通过 · 发布前检查 16/16
```

## 仍然存在的真实边界（这次是真的）

- **本机 Edge 的 cookie 库被独占锁住**：探测确实看到了库，但 `open` 被拒。
  这不是代码问题 —— 关掉 Edge 再让插件读即可，或直接用「一键登录」。
- **一次对话会扣智点**：做一次性任务时余额为 0 会跳过（不白花），
  余额未知时不阻止（「不知道」不等于「没有」）。
