# 0.0.19：模型选择器里的徽标回来了（插件自绘）

0.0.18 装到 DSH 0.2.2-rc.2 之后，输入框模型选择器里 `NEW` / `正式版` / `首发接入`
全不见了。这一版把徽标改成**插件自己画**，样式照灵犀网页。

## 症状

模型选择器（触发器 + 下拉菜单）里只剩名字与倍率，例如
`DeepSeek V4.1 Flash · ~0.12x`，后面什么都没有；同一个模型的
`NEW` / `正式版` / `首发接入` 标签一个都不显示。

## 根因

- 宿主 `dsh-llm` 的目录里 `badge` 还在（`/status` 能读到、`llm.listModels`
  也照常返回 `{text, tone}`），`dsh-client-ui-model-selection` 的渲染代码里
  也仍然写着 `model.badge === void 0 ? model.name : …Tag …`。
- 但 0.2.2-rc.2 的界面路径上这个 Tag 不再出现（升级前 0.2.1 能看见）。
  也就是说：**数据没丢，是宿主没画**。插件这边 0.0.18 只改了 CSS 配色，
  管不到「宿主根本不渲染」这件事。

## 这一版做了什么

- **插件自绘徽标**：客户端拿到 `/status` 的模型目录后，按 `models[].badge`
  生成样式，用伪元素把胶囊画在模型名后面：
  `[data-provider-id="wps-lingxi"][data-model-id="<id>"]::after { content:"NEW" … }`。
- **先藏宿主的 Tag**：`[data-provider-id="wps-lingxi"] [class*="badge"]:not([class*="badgedName"]){display:none}`。
  这样以后宿主恢复渲染也不会出现两份。
- **配色照灵犀网页**：浅橙底 `#fef1ea`、橙字 `#e2651a`、全圆角胶囊、
  `10px/18px`、左右 `7px` —— 与官网截图逐像素取值一致。
- 目录刷新（每次 `/status` 轮询）都会重建这份样式，模型增删、上游换标签都跟得上。

## 验证

- `gate` 全绿（typecheck / build / client 自检 / 文档断言 / 打包检查 / 测试）。
- `bundle-runtime` 测试改成钉住新契约：apply 时先藏宿主 Tag（只在本插件行），
  状态回来时调用 `applyModelBadges(document.models)`，按 `data-model-id` 用
  `::after` 画胶囊，颜色必须是 `#fef1ea` / `#e2651a`。
