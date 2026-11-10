# 0.0.5：侧栏面板真的能用 + 页面改成 workbuddy 那种「Tab + 卡片」

> 上一版的「在侧边栏显示灵犀面板」是一个**只写了一个布尔值**的开关：它会存进
> `dsh-connect-lingxi-state.json`，也会在设置页显示成已打开，但浏览器半边**没有注册
> 任何槽位** —— 宿主那边没有它的座位，界面上什么都不会出现。这一版把它补完，
> 并把插件页从「一列纵向堆叠」改成与 `dsh-connect-workbuddy` 一致的分页布局。

## 这一版改了什么

| 改动 | 位置 | 说明 |
| --- | --- | --- |
| 侧栏导航行 | `src/client/bundle.js` | 注册 `sidebar.panellist`（`id` = 面板 id，`order` 60），图标是灵犀星形，跟随主题色 |
| 整页面板 | 同上 | 注册 `main`（`key` = 面板 id），**常注册**；页面里带「← 返回对话」 |
| 五段分页 | 同上 | 账号 / 模型 / 任务 / 设置 / 诊断，`role="tablist"` + `aria-selected`，选中态是下划线 |
| 卡片分组 | 同上 | 每个分组一张卡（圆角 12px、layer-3 底色、14–16px 内边距） |
| 样式注入 | 同上 | `style[data-plugin-css="dsh-connect-lingxi/client.css"]` 幂等注入，与 workbuddy 同一套做法 |
| 胶囊入口 | 同上 | 输入框胶囊的弹层里多一行「打开灵犀面板」 |
| 运行期测试 | `test/bundle-runtime.test.ts` | 4 条：main 常注册 / 开关关时不占座位 / 开关开时注册一行 / 无 layout 时不伪造返回按钮 |

## 三个判断，以及为什么

### 1. `main` 常注册，只有导航行跟随开关

侧栏那一行是**所有插件共用的座位**，所以默认不抢（`sidebarPanel` 默认 `false`）。
但页面本身要常注册，理由是胶囊的「打开灵犀面板」按钮：

```
关掉开关 → 导航行注销
         → 页面仍在册 → 胶囊那个按钮照样能打开它
```

反过来把两者绑在一起，就会出现「按钮点了报 `main panel is not registered`」。
workbuddy 在 5.x 里踩过这个坑并单独修过，这里一开始就分开。

### 2. 行必须**注销**，不能靠组件返回 `null` 隐藏

宿主是这样建导航行的：

```js
ctx.slots.entriesOfSlot('sidebar.panellist').map(({ options }) => ({
  id: options.id,
  order: options.order ?? 0,
  label: resolveSlotLabel(options.label) ?? id,
}))
```

**行来自 entry 元数据，不来自组件**。所以组件返回 `null` 只会留下一枚空白但仍可点的
按钮 —— 看起来像「灵犀这一项坏了」，而不是「没打开」。开关的实现必须是
`dispose()` 掉 entry，这就是 `panelDisposers` + `syncPanelRow()` 的原因。

### 3. 只在开关**真的变化**时才重注册

`watch()` 只往共享 store 的监听表里加一个函数，**不启动轮询**（轮询归
`subscribe()` 管，它按订阅者计数决定启停）；导航行自己的注册状态另记一个
`panelRowWanted`。否则每 60 秒一次的状态刷新都会注销并重建一次侧栏行：视觉上看不出
变化，但宿主会重排导航、图标组件重新挂载。

## 宿主契约（本机 asar 取证，全部写进 `docs/CLIENT-API.md`）

| 槽位 / 服务 | 关键点 |
| --- | --- |
| `sidebar.panellist` | `kind: list`、`scope: root`；必须给 `id`；props 是 `{ size, active }`；行名来自 `label` |
| `main` | `kind: keyed`、`scope: root`；必须给 `key`；props 是空对象 —— `surface` / `backToConversation` 是插件自己 `inject` 的私有字段 |
| `layout.selectPanel(id)` | 传 main 的 key 打开面板，`null` 回到对话，**未注册的 id 会抛错** |

`layout` 是软探测的：`ctx.get('layout')` 拿不到时，返回按钮与「打开面板」按钮都不渲染，
而不是渲染一个点了会抛的按钮。

## 验证

```bash
node scripts/gate.mjs   # typecheck → build → copy-client → check-client → check-claims → prepublish → tests
```

`test/bundle-runtime.test.ts` 是这个仓库第一份**跑真的 `apply()`** 的客户端测试：
用桩 `fetch` + 假 React 装载 `src/client/bundle.js`，然后断言注册表里
有没有 `main`、有没有 `sidebar.panellist`。静态检查（`client.test.ts`、
`check-client.mjs`）只能证明「能解析、文案齐全」，证明不了「槽位注册对了」。
