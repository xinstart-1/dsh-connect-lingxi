# 0.0.16 —— 倍率并进选择器的模型名，徽标走目录字段

这一版只改「模型在下拉里长什么样」：名字后面带上官网原文的倍率，徽标交给宿主的
目录渲染去画。不再占客户端的模型标签格子。

```
DeepSeek V4.1 Flash · ~0.12x   [NEW]
DeepSeek V4 Pro      · 0.40x
Pro 模式
```

## 为什么 0.0.15 的做法在这台宿主机上没生效

0.0.15 在客户端占 `conversation.input.model.label` 槽位画「名字 · x倍率 + 徽标」，
但那个槽位是 `single` —— 一个格子，谁注册谁独占；别的插件先注册同一格时，
后注册的那份直接抛「already has a registration」。真机截图里名字旁边既没有倍率
也没有徽标。

沿着宿主源码查清了选择器的数据来源：

| 通道 | 谁在读 | 能带什么字段 |
| --- | --- | --- |
| `ctx.llm.listModels(provider)` → `buildModelCatalog()` | **模型选择器（下拉 + 触发器）** | `id` / `name` / `description` / `badge` / `inputModalities`（白名单校验） |
| `registerModelDiscovery` 回调 | 设置页「从接口读模型」的候选清单 | 被白名单成 `id` / `name` / `contextWindow` / `maxTokens` / `inputModalities`，**改坏字段名会被丢掉** |
| `conversation.input.model.label` 槽位 | 只有占住格子的那个插件 | 渲染成败取决于谁先注册 |

pi-ai 的 `PiAiAdapter.listModels()` 只回 `provider/id/name/inputModalities` ——
倍率与徽标在宿主那一层**根本没有字段可挂**。所以 0.0.15 的两条路一条走不通、
一条会抢格子。

## 改了什么

1. **倍率并进名字**（`catalogName()`）：`DeepSeek V4.1 Flash · ~0.12x`。
   倍率照抄官网原文，`~` 是折扣价标记，不改成确定值；模式（`plan_pro` / `plan_max`）
   没有倍率，名字保持原样，不会多出一个空的 ` · `。
2. **徽标补进目录**（`withCatalogDetails()`）：在 `PiAiAdapter.listModels` 外面包一层，
   把目录里的倍率 / 徽标 / 上游说明补到选择器真正读到的那几项上。宿主自己的渲染
   （或占了格子的别的插件）按 `LlmModelInfo.badge` 画徽标。
3. **删掉客户端 `ModelLabel` 与槽位注册**：不再占 `conversation.input.model.label`，
   把格子还给宿主和其它插件；`bundle.js` 里那套 `BadgeChip` / `findMultiplier` /
   `localizedText` 一并删掉（没有别的地方用）。
4. **发现回调与选择器同一套说法**：`registerModelDiscovery` 也走 `catalogName()` /
   `modelBadge()`，并去掉原来「没有说明就写 `倍率 x`」的兜底 —— 倍率已经在名字里，
   说明再写一遍就是一行两份。
5. **触发器里把徽标挪到名字后面**：宿主在触发器（输入框左侧）里按「徽标 名字」排，
   下拉菜单里却是「名字 徽标」。本插件注入一条只作用于自己模型行的顺序样式
   （`[class*="triggerLabel"] [data-provider-id="wps-lingxi"] [class*="badgedNameText"]{order:-1}`），
   两处统一成 `DeepSeek V4.1 Flash · ~0.12x  NEW`。
   - 只改视觉顺序，元素与语义不变：宿主自己的渲染不在我们的 `try/catch` 之外，
     换布局时规则最多不命中，不会让触发器渲染失败。
   - 选择器锚在 CSS Module 类名的后缀上（宿主会加哈希前缀），宿主重命名类名后
     这条规则静默失效、退回默认顺序 —— 这是有意的降级路径，不是错误。
6. 版本号 0.0.16；`docs/CLIENT-API.md` 里「本插件的取舍（0.0.15 起）」整段改写为
   现在的结论，并补上「模型目录只有 `llm.listModels` 一条路」这条宿主事实。

## 验证

```bash
node scripts/gate.mjs   # typecheck / build / copy-client / check-client / check-claims / prepublish-check / tests 全通过
```

新增单测：

- `test/catalog.test.ts`：`catalogName()` 带原文倍率（`~0.12x` 原样保留）、模式名不变；
  `withCatalogDetails()` 给 `listModels` 的原始条目补上倍率与徽标、保留原有字段、
  目录里没有的 id 原样还回去。
- `test/bundle-runtime.test.ts`：启动后**不**注册 `conversation.input.model.label`；
  注入的顺序样式存在且只作用于触发器里的本插件模型行。

## 已知边界

- 名字里的倍率是**文本**，不是宿主的独立字段，所以不能靠 CSS 把它调暗；
  想弱化只能改文案本身。
- 徽标能不能显示出一个「彩色小标签」取决于宿主的渲染（或占住格子的插件），
  数据已经送到位；本插件自己不再画它。
- 顺序样式依赖宿主 `ModelSelect` 的两个类名后缀（`triggerLabel` / `badgedNameText`）。
  宿主改布局时这条规则失效、触发器退回「徽标 名字」，其余功能不受影响。
