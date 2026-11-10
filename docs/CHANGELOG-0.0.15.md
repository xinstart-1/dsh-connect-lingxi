# 0.0.15 —— 输入框读数重画 + 请求体形状归一

这一版两件事：**输入框弹出的那张读数改成账号表**（含模型名后的倍率徽标），
以及**把 DSH 发来的请求体归一成上游能吃的形状**（否则每个新会话第一句就 400）。

两件都不涉及对话通道本身：界面只加了一个「读余额」的只读动作，归一化只改请求体形状。

---

## 弹层改成账号表

原来点开只报一行「本机账号 / 智点」。现在是一张表：

```
灵犀 积分                        刷新   设置
账号                                积分
895****935                        1,778
当前选用
```

- **每个账号一行**，余额右对齐、等宽数字（`tabular-nums`），千分位与卡片一致。
- **当前账号**用绿色「当前选用」标出；没勾进池的标灰「未加入账号池」。
- **读不到余额的那一行**显示红字原因（`HTTP 401` 这种原文），不画破折号，
  更不画 `0` —— 「读不到」和「余额是 0」是两件事。
- 底部「最近刷新 12:07」，读不到就说「余额没读到」，不假装表是新的。
- 标题栏的「刷新」重读一次；「设置」打开插件页。
- 账号名遮成 `895****935`（前 3 + 后 3）：既认得是哪个号，又不把完整 uid
  摆进截图。非数字的名字整体保留，遮中文昵称只会变乱码。

### 每个账号的余额只在弹层打开时读

新增 `account-balances` 动作：**串行**读每个已保存账号的余额，一个失败不影响
其它行。它不跟着状态轮询走 —— 状态 5 分钟一次，账号有 N 个就会变成 N 倍上游
请求，而灵犀按设备限流，多账号高频轮询正好是最容易踩线的用法。

## 模型名后面贴上倍率与徽标

`conversation.input.model.label` 槽位（`single`，宿主的官方徽标在 priority 0）：

```
DeepSeek V4.1 Flash · x0.11  [正式版]
```

- 倍率从状态文档的目录里取（`models[].multiplier`），不再从下拉说明里解析。
- 因此**下拉说明里不再重复倍率**，只剩上游文案（两处都写会一行两份「倍率」）。
- priority 必须是负数（`-105`）：同优先级第二份注册会直接抛。
- **别人的模型行返回「名字 + 它自己的 `model.badge`」**：这个格子只有一个座位，
  占住它就等于替所有 provider 画名字；宿主自己的徽标只在格子空着时画，所以
  它那一半得我们补回。`keyed` 宿主上按 `provider.id` 各占一格，没有这个代价。

## 修掉一个会让 gate 说谎的缺陷

`scripts/test-report.mjs` 只写报告、**从不动退出码**，于是 `gate.mjs` 的
`tests` 一步永远打印 `ok` —— 一条真的失败的测试也能汇成「全部通过」。
现在只要任一文件 `fail != 0`、进程非 0 退出、或连结论行都没打印出来（`pass=?`），
它就置非 0 退出码。这条缺陷是本次改界面时被自己的测试撞出来的。

---

## 同一版本里的第二件事：请求体形状归一

修掉了「每个新会话第一句就 400」：DSH 发来的**分段 `content`** 与**对象 `tool_choice`**，
上游一律 `400 InvalidArgument 参数错误`（插件侧归一化后记为 404）。

## 为什么

DSH（pi-ai 形状）的 `messages[].content` 是 `[{type:'text',text}]` 数组，
`tool_choice` 也可能是 `{type:'function',function:{name}}` 对象。
灵犀 `agent-runtime/chat/completions` 两样都不收，只吃字符串 —— 真机实测：

| 请求体 | 上游响应 |
| --- | --- |
| `content` 为分段数组（`user` / `assistant` / `tool` 任一角色） | `400 InvalidArgument` |
| `tool_choice` 为对象 | `400 InvalidArgument` |
| 同一内容展平成字符串 | `200` |
| `tool_choice` 为 `"auto"` / `"none"` / `"required"` | `200` |
| `tools[].function.strict: true` | `200` |

## 改了什么

- 新增 `src/protocol/normalize.ts`：`flattenContent` / `normalizeMessages` / `normalizeToolChoice`。
- `buildAgentBody` 统一归一：分段 `content` 拼成字符串；对象 `tool_choice` 降级为字符串
  （指定具体函数 → `"required"`，其余 → `"auto"`）；两者被触发时都走 `onWarn` 说明。
- `lastUserText` 复用 `flattenContent`，删掉一份重复的展平实现。
- `docs/PROTOCOL.md` §3.3.1 记录这两条硬约束与实测错误码。
- `test/normalize.test.ts`：9 条用例覆盖展平、丢弃、降级与 `buildAgentBody` 的最终形状。

## 验证

```bash
node scripts/gate.mjs   # typecheck / build / copy-client / check-client / check-claims / prepublish-check / tests 全通过
```

另有一次性端到端验证：按 DSH 形状（分段 content + 对象 tool_choice + tools）打本地 shim，
上游 `200`、工具调用正常流出、`onWarn` 提示降级。

---

## 胶囊上换成产品名，读数不再带千分位

输入框右侧那颗胶囊原先是 `895****935 · 3,000 智点`。它有两个问题：一行里
塞了「账号 + 余额」，小字号下挤成一片；而且同一个 `895****935` 在弹层的
账号表里又出现一次，等于同一条信息画两遍。

现在胶囊是：

```
WPS灵犀 · 3000 智点
```

- **账号名没有丢**：挪进 `title`（悬停显示「当前账号 895****935」），
  以及弹层那张账号表。完整 uid 仍然不整串外露。
- **数字不带千分位**（`plainCredits()`）：`3000` 而不是 `3,000`。账号表
  空间充足，仍用 `credits()` 的千分位。
- 未登录（没有账号）时仍然只报余额，不拿产品名冒充账号。
