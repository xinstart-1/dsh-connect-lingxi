# 从 v0.1.0 到 v0.0.1：补齐 workbuddy 那套「设置卡片 + 积分读数」

> 目标不是复制 workbuddy，而是把它**真正有用的一半**搬过来：让用户在 DSH 里
> 看得到灵犀的智点余额、快过期的临时积分、今天签没签到、有哪些模型与倍率，
> 并且能点一下就签到 —— 不必切回灵犀客户端。

## 版本号

`0.0.1`（三位、从 0 开始）。`src/constants.ts` 的 `VERSION` 与 `package.json` 的
`version` 必须同步；卡片上的版本就是这么来的。

## 这一版加了什么

| 能力 | 在哪 | 说明 |
| --- | --- | --- |
| 智点余额 | `protocol/balance.ts` | 解析 `/credits/balance`，含 `bonus_credits` 每个赠送批次 |
| 临时积分 | 同上 | 15 天内到期的那部分单独算一个数——总额里看不出「有多少马上作废」 |
| 每日签到 | `protocol/tasks.ts` + `host/runtime.ts` | 读 `/tasks`，只在上游说没签时才发写请求 |
| 一次性任务 | 同上 | **只领 `claimable`**；`incomplete` 需要真实客户端行为，不假装去做 |
| 模型目录 | `host/status.ts` | 名称、倍率、上下文、思考/图片支持、启用状态 |
| 设置卡片 | `client/bundle.js` | 挂在 `plugins.bundle.config`（`view:'page'` 整页 / `view:'summary'` 一行） |
| 输入框读数 | 同上 | `conversation.input.left` 的胶囊，点了弹出余额详情 |
| 界面开关 | `state.ts` | 自动签到 / 胶囊 / 侧栏 / 刷新间隔（五档），点一下即生效 |
| 诊断 | `client/bundle.js` | 版本、登录态、来源、账号名、上游最近一次错误**原文** |

## 架构：为什么又加一层

```
浏览器（client/bundle.js）
   │  GET  /plugins/dsh-connect-lingxi/status     ← 已归一好的展示数据
   │  POST /plugins/dsh-connect-lingxi/action     ← 白名单动作
   ▼
host/routes.ts   （回环校验 + 白名单 + body 上限）
   ▼
host/runtime.ts  （缓存、轮询、签到/领取的决策）
   ├─ protocol/balance.ts   纯解析
   ├─ protocol/tasks.ts     纯解析
   └─ protocol/client.ts    上游三步握手（已有）
```

**cookie 永远不到浏览器**。页面拿到的只有展示数据，以及四个动作的入口。
这不是洁癖：`wps_sid` 等价于账号本身，一旦进了 DOM，任何 XSS 或截图泄露都是
账号级事故。

## 三条设计判断

1. **网络失败不清空上一次的好数据。** 每段缓存带时间戳，失败只记 `lastError`。
   卡片上宁可是三分钟前的读数，也不要因为一次 502 变成「未登录」。
2. **不做乐观更新。** 签到后重新读上游（领前/领后余额差就是奖励），
   而不是本地猜一个 `+10`。上游对重复领取是幂等假成功，猜出来的数会说谎。
3. **界面开关不进 DSH settings。** 它们要求「点一下立即生效、不经过保存」；
   走 settings 就意味着每调一次亮度都要改配置 + 重载插件。所以落在
   `$DSH_HOME/dsh-connect-lingxi-state.json`。

## 与 workbuddy 的差异（有意为之）

| workbuddy 有 | 本插件 | 原因 |
| --- | --- | --- |
| 多账号池 + 自动换号 | 没有 | 灵犀一次登录只有一份 `wps_sid`，没有第二个账号可换 |
| 生图 / 生视频工具 | 没有 | 灵犀上游没有对应端点（`docs/PROTOCOL.md` 未取证到） |
| 每日自动签到（默认关） | 有（默认关） | 这是会自动改变账号状态的写操作，必须用户显式打开 |
| 侧边栏整页入口 | 开关在，座位不占 | 侧栏座位是所有插件共用的，默认不抢 |
| 模型行活动徽标 / 繁忙度 | 没有 | 灵犀目录不返回活动或排队字段 |

## 验证

```bash
node scripts/test-report.mjs      # 逐文件跑测试，结论写进 test-report.txt
```

当前：11 个测试文件、119 个用例、0 失败。

## 已知限制

> 前两条在 0.0.1 里写成「上游限制」，实际都是本插件未实现的工作。
> 0.0.2 已修，完整记录见 `docs/CHANGELOG-0.0.2.md`。

- ~~本机没有灵犀客户端，只能手粘 cookie~~ → **0.0.2 推翻**：
  客户端目录名是 `kdesk` 而非产品名 `WPS 灵犀`；且新增「日常浏览器」与
  「一键浏览器登录」两条零粘贴来源。
- ~~一次性任务里三个 `incomplete` 做不出来~~ → **0.0.2 推翻**：
  `execution_status` 生命周期 + 建群流程已实现，三个任务都能做
  （见 `src/protocol/onetime.ts` 与 `docs/PROTOCOL.md` §13）。
- **`conversation.input.left` 的 `useProjection` 门控未在真机验证**：
  宿主没给投影时胶囊照常显示（「我不知道」不等于「藏起来」）。此条仍然成立。
