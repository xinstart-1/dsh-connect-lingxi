# dsh-connect-lingxi

> 把 **WPS 灵犀（Lingxi Claw）** 接入 **DeepSeek Harness**：原生 `tools` / `tool_calls` /
> `reasoning_content` / `usage` 直通，官网那 11 个模型 + 2 个模式直接出现在 DSH 的模型选择器里。
> **v0.0.1 起**，插件详情页还会告诉你智点余额、快过期的临时积分、今天签没签到，
> 输入框左侧有一枚可点的读数。

## 它是什么

灵犀**没有开放平台 API**。本插件走的是灵犀桌面客户端自己使用的私有 app-server 协议
（`/api/aioffice/v1/cowork/sessions` → `/api/public/v1/credits/runs` →
`/api/public/v1/agent-runtime/chat/completions`），协议细节见 [`docs/PROTOCOL.md`](docs/PROTOCOL.md)。

与「问问 ima」那种模型通道不同，灵犀是**完整 agent 通道**：DSH 发过去的 tool 定义会
被灵犀执行，返回的 `tool_calls` 会回到 DSH —— 可以真正当 agent 后端用。

## 能力

- **逐字段对齐上游的模型清单**：11 个模型 + Pro / Max 两个模式，上下文、输出上限、
  倍率、徽标（`NEW` / `正式版` / `首发接入`）、思考档位全部来自一次真实
  `/sessions/plans` 响应（`node scripts/capture-plans.mjs` 可复现核对）。
  思考档位按上游声明露出：9 个思考模型各 3 档（低 / 高 / 超高），
  4 个非思考模型没有开关。
- **原生工具调用**：上游返回的 `tool_calls` 直接进 DSH 的工具循环。
- **思考过程**：`reasoning_content` 独立通道，不混进正文。
- **动态模型目录**：登录后从 `/api/aioffice/v1/sessions/plans` 拉取账号真实目录，
  跟随灵犀上下架；未登录时用静态兜底表。
- **凭证不出本机**：存在 `$DSH_HOME/lingxi-vault/credential.json`（权限 0600，
  重载/更新/重装都不丢），不进代码、不进仓库、不打日志，也永不进浏览器半边。
- **智点余额**：设置卡片实时显示剩余额度。**新增**：还会单独算出「15 天内会过期」的
  那部分——总额里看不出「有多少马上作废」，而那是真正该急着用的。
- **每日签到 / 一次性任务**（新）：卡片上有签到按钮，点一下就领。已签到不会重复发写请求。
  三个一次性任务**都能做**：专家模式与客户端由一次带 `client_type` / `session_mode`
  的对话带出，群聊任务走「WS 使用信号 → 建群 → 立刻解散」——都靠
  `execution_status` 生命周期上报，`docs/PROTOCOL.md` §13 有完整流程。
- **模型目录与倍率**：卡片列出每个模型的名称、倍率、上下文、思考/图片支持与启用状态。
- **逐模型开关**（新）：模型页每行两个勾选框 —— **启用**（决定它出不出现在 DSH 的
  模型选择器里）与**图片**（决定它能不能接收图片输入）。点一下即生效，不用去
  「设置 → 模型」走「保存 → 重载插件」；至少保留一个模型。
- **输入框读数**：输入框左侧一枚胶囊（`灵犀 · 1,072`），点了弹出余额与到期提醒，
  以及一个「打开灵犀面板」入口。
- **侧栏整页**（新）：开关打开后侧栏多一项「WPS 灵犀」，点进去是**分页**的整页
  （账号 / 模型 / 任务 / 设置 / 诊断），卡片分组，和 `dsh-connect-workbuddy` 一个样式。
  **关掉开关只是收起导航行，页面照常在册**——所以胶囊那个入口永远能打开它。
- **界面开关**：自动签到 / 胶囊 / 侧栏入口 / 刷新间隔（1·5·10·30·60 分钟），
  点一下即生效，不走「保存」。

## 安装

```bash
dsh plugin --profile desktop add dsh-connect-lingxi
```

装完**重启 DSH**。

### 登录：不需要手粘 cookie

插件按「用户成本」从低到高自己找登录态：

1. **本机灵犀客户端**（`%APPDATA%\kdesk`）—— 装了并登录过，零交互。
2. **你日常的浏览器**（Edge / Chrome / Brave / 360）—— 在浏览器里用过灵犀网页版就够。
3. **点一下登录** —— 卡片上的「登录灵犀」拉起一个浏览器窗口，你自己登录，
   插件只读登录后的 cookie。**从不接触密码。**

手粘 cookie 仍然保留，但只是**最后的兜底**，不是主路径。

> 如果插件提示「库被浏览器独占锁定」：那是浏览器正在运行，关掉它再刷新即可。
> 这与「没登录」是两件事，提示文案会分开说。

## 架构

```
DSH
 └─ PiAiAdapter (@deepseek-ai/dsh-llm-pi-ai)
     └─ pi-ai provider (openAICompletionsApi)
         └─ http://127.0.0.1:<随机端口>/v1/chat/completions   ← 本地 shim（仅回环）
             └─ 灵犀三步握手 + SSE 翻译

浏览器（设置卡片 / 输入框胶囊）
   ├─ GET  /plugins/dsh-connect-lingxi/status    ← 已归一好的展示数据
   └─ POST /plugins/dsh-connect-lingxi/action    ← 白名单动作（refresh / 签到 / 领取 / 开关）
```

shim 用 `node:http` 监听 `listen(0, "127.0.0.1")`——内核随机分配端口、只连回环，
不占固定端口、不对外暴露。宿主路由同样只接受回环 `Host`，cookie 永远不进页面。

## 与其它 provider 的关系

| 插件 | 定位 |
| --- | --- |
| `dsh-connect-lingxi`（本插件） | WPS 灵犀 → DSH，原生 agent 通道 + 智点/签到卡片 |
| `dsh-connect-workbuddy` | WorkBuddy → DSH，原生 agent 通道 + 账号池/积分/签到 |
| `@kevinfx/magpie-wps-lingxi` | 同一协议，但走 Magpie 网关（多一跳） |

本插件不依赖 Magpie。与 workbuddy 的功能差异见
[`docs/CHANGELOG-0.0.1.md`](docs/CHANGELOG-0.0.1.md#与-workbuddy-的差异有意为之)；
0.0.5 把侧栏整页与插件页样式对齐到 workbuddy 的做法，记录在
[`docs/CHANGELOG-0.0.5.md`](docs/CHANGELOG-0.0.5.md)；0.0.6 补上模型页的
逐模型「启用 / 图片」勾选（[`docs/CHANGELOG-0.0.6.md`](docs/CHANGELOG-0.0.6.md)），
0.0.7 修掉「勾了不生效」—— 缺的是 `llm/models-updated` 事件
（[`docs/CHANGELOG-0.0.7.md`](docs/CHANGELOG-0.0.7.md)）；0.0.8 让登录态跨重载/更新
保留 —— 自建凭据仓库 `$DSH_HOME/lingxi-vault/`
（[`docs/CHANGELOG-0.0.8.md`](docs/CHANGELOG-0.0.8.md)）；0.0.9 让模型清单、顺序、
倍率与徽标与灵犀官网一致（[`docs/CHANGELOG-0.0.9.md`](docs/CHANGELOG-0.0.9.md)）；
0.0.10 按真实上游响应逐字段校准，修掉 `maxTokens` 全错与思考档位全开
（[`docs/CHANGELOG-0.0.10.md`](docs/CHANGELOG-0.0.10.md)）；0.0.11 接上宿主的附件服务，
修掉发图报 `UNSUPPORTED_CONTENT`（[`docs/CHANGELOG-0.0.11.md`](docs/CHANGELOG-0.0.11.md)）；0.0.12 加上账号池
（多账号各存一份，卡片上点一下就切换，照 `dsh-connect-workbuddy` 的做法）
（[`docs/CHANGELOG-0.0.12.md`](docs/CHANGELOG-0.0.12.md)）；0.0.13 把账号池做成
WorkBuddy 那样：常驻显示、逐账号勾选、批量签到与测试、每个账号显示余额
（[`docs/CHANGELOG-0.0.13.md`](docs/CHANGELOG-0.0.13.md)）；0.0.14 把账号+智点读数
挪到模型选择器前面，并统一了倍率与徽标的显示
（[`docs/CHANGELOG-0.0.14.md`](docs/CHANGELOG-0.0.14.md)）。

## 开发

```bash
node scripts/test-report.mjs    # 逐文件跑测试，结论写进 test-report.txt
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node node_modules/tsdown/dist/run.mjs && node scripts/copy-client.mjs   # = npm run build
```

- `src/client/bundle.js` 是**手写的经典脚本**（不是 TS、不进 bundler）：
  宿主用 `<script>` 加载它，`require('react')` 解析到宿主自己的 React。
  被打包就会变成两份 React，hooks 立刻炸。
- 客户端槽位契约（哪个槽位用 `id`、哪个用 `key`、props 有哪些）见
  [`docs/CLIENT-API.md`](docs/CLIENT-API.md)——全部从本机 DSH 的 asar 与三个
  已在跑的同级插件产物里交叉验证过。

## 许可

MIT
