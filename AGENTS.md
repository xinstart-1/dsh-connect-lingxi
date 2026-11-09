# dsh-connect-lingxi 专属记忆

> **通用规则（参考项目不能照搬 / 不许说「上游限制」/ 验证与发布纪律）
> 在上级目录的 [`../AGENTS.md`](../AGENTS.md)，先读它。**
>
> 本文件只写**这个插件独有的技术事实**，不重复通用规则。

---

## 一、这个插件是什么

把 WPS 灵犀（Lingxi Claw）接进 DSH：模型出现在选择器里、原生 tools /
`tool_calls` / `reasoning_content` 直通，插件卡片显示智点余额、签到与任务。

架构：`ctx.llm` 注册 → 本地回环 OpenAI 兼容 shim → 灵犀私有协议。
SSE 怪癖：正文在 `choices[].text`（不是 `delta.content`）、没有 `[DONE]`
（靠 `finish_reason`）、`usage.total_tokens` 是上下文大小（必须自己重算）。

---

## 二、登录态（踩过的坑，别再踩）

灵犀桌面端是 Electron、网页版是 Chromium，cookie 都存在本机。
**要求用户手粘 `wps_sid` 是本插件的失败，不是灵犀的限制。**

三条零粘贴来源，按用户成本排序：

1. **本机灵犀客户端** —— 目录是 **`%APPDATA%\kdesk`**，
   不是产品名 `WPS 灵犀`。同族还有 `kdesk_yyb`。
2. **日常浏览器** —— Edge / Chrome / Brave / 360 里已登录的灵犀网页版。
3. **一键登录** —— 拉起临时 profile 的 Chromium，用户在真实窗口自己登录，
   通过 CDP `Network.getAllCookies` 取 cookie。插件从不接触密码。

手粘只作最后兜底。

### 三个必须记住的坑

- **`Local State` 在数据目录根，`Profile N` 里没有。** 取 AES key 必须向上继承一层，
  否则 `Profile 1` 的 cookie 全部解不开。
- **profile 目录不一定叫 `Default`。** Edge 可以只建 `Profile 1`；
  判据要认 `Network/Cookies`，不能只认 `Local State`。
- **浏览器运行时 cookie 库被 WAL / 独占锁占住。** 不能直接 `open`
  （会得到 `unable to open database file`，某些 Edge 版本连读都 `EBUSY`），
  必须先做快照再读；且必须**区分「被锁」与「没登录」** —— 两种情况的用户动作完全不同。

---

## 三、一次性任务（三个 `incomplete` 都能做）

共同前提是 `execution_status` 生命周期：

```
running:   { group_id, status:"running",   run_token: group_id, lease_seconds: 90 }
completed: { group_id, status:"completed", run_token: group_id, terminal_reason:"completed" }
```

不报这个，服务端永远认为会话还在跑 → 建群 400、任务永不翻转。

| 任务 | 判据 | 做法 |
| --- | --- | --- |
| `use_lingxi_client` | 会话 `client_type: lingxi_claw` + 一次真实对话 | 建会话带 `client_type` |
| `try_expert_mode` | 再加 `session_mode` / `current_mode` 为 `expert` | 一次对话同时命中两个任务 |
| `try_group_chat` | WS 收到过 `user.input`，然后建过群 | 使用信号 → 建群 → **立刻解散** |

群聊顺序不可换：先有 WS 使用信号，`POST /api/imchat/v1/channels` 才会成功。

**纪律**：这些动作只提供真实使用信号，是否算完成由服务端判定 ——
动作后一律**重拉任务**，不假设成功；余额为 0 跳过消耗性动作（一次对话扣智点），
余额**未知**不阻止（「不知道」不等于「没有」）。

---

## 四、设计纪律

1. 网络失败**绝不清空上一次的好数据**，只记 `lastError`。
2. **不做乐观更新**：写操作后重拉上游，用前后差值报告结果。
3. UI 开关存 `$DSH_HOME/dsh-connect-lingxi-state.json`，**不进 DSH 设置** ——
   必须能不保存、不刷新就生效。
4. `autoCheckin` **默认关**：它是会改变账号状态的写操作。
5. 领取只碰 `claimable`，**永不伪造 `claimed`**。
6. Cookie 绝不进浏览器半边：页面只拿 `/plugins/dsh-connect-lingxi/status`
   的脱敏数据，所有写操作走动作白名单（`refresh` / `login` / `claim-checkin` /
   `claim-one-time` / `settings`）。

---

## 五、本仓库的验证入口

```bash
node scripts/gate.mjs            # 类型 → 构建 → 客户端自检 → 文档断言检查 → 打包检查 → 测试
node scripts/verify-published.mjs # 发布后确认 registry 上真有这个版本
node scripts/probe-credential.mjs # 现场探测这台机器能不能自动拿到登录态
```

`check-client.mjs` 与 `check-claims.mjs` 是这里特有的两道门：
前者守浏览器半边的手写脚本契约，后者守「不许写没依据的上游限制」。
