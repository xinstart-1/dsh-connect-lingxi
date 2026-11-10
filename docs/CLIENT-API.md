# DSH 客户端插件（浏览器半侧）槽位 API 契约

> 环境：DSH **0.2.2-rc.1**，`X:/APP/deepseek-harness/resources/app.asar`
> 取证方式：只读解析 app.asar（未解包、未执行），并以本机已装三个可用插件产物交叉验证。
> 标注约定：**【确证】**＝asar/产物原文直接可见；**【推断】**＝由确证事实推得但无直接原文；**【未确证】**＝没查到，不编。

---

## 0. 先说一个关键事实：`@deepseek-ai/dsh-client-ui-slots` 不在 asar 里

**【确证】** asar 内 22102 个条目、580 个包中，**不存在** `@deepseek-ai/dsh-client-ui-slots` 包（`dump.mjs ls ui-slots` → `count=0`；`ls dsh-client-ui-slots` → `count=0`）。
但**它的符号被别的包 import 并使用**：

```
/dsh/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js:346:
  if (!host.isLive(entry)) throw new _deepseek_ai_dsh_client_ui_slots.StaleAuthorizationError(...)
/dsh/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js:348:
  throw new _deepseek_ai_dsh_client_ui_slots.SlotOwnershipError(...)
```

结论：**`slots` 服务的真实实现住在 `dsh-client-ui-renderer`（`SlotsService` / `SlotCore` / `SlotOutlet`）**，`dsh-client-ui-slots` 只提供 type-only 契约（对外发布、运行时被 inline 进 renderer）。
`dsh-connect-trae/package.json:73` 把 `@deepseek-ai/dsh-client-ui-slots` 列进 `dsh.client.inject`，说明这些包在**开发/类型期**依赖它。

**所以：客户端插件不要 `import` `dsh-client-ui-slots` 的任何运行时值**（它不在运行时模块表里）。只用 `ctx.slots.*`，或 type-only import。

类型声明的权威副本在 runner 的构建产物里（编译进去的 d.ts 目录）：
**`/dsh/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js`**（378 个槽位目录条目 + 全部 slot 类型 `declaration:` 字符串）。下文凡写「目录」均指此文件的槽位目录。

---

## 1. 槽位注册契约

### 1.1 `ctx.slots.inject(key, callback)`

**【确证】** 实现在 `dsh-client-ui-renderer/lib/client.js:1368`，原文（含 JSDoc）：

```js
/**
 * ... runs synchronously when the declaration already exists; otherwise it runs
 * inside the declaring `register()` call after the declaration is committed.
 * Collapse disposes the effect and a later declaration runs it again.
 * Callback effects are synchronous disposers; iterable effects install
 * transactionally and dispose in reverse order. The controller belongs to
 * the caller's fiber, so plugin unload cancels a pending wait and removes any
 * active contribution.
 *
 * @param key - declared SlotMap key to depend on.
 * @param callback - creates one disposer or an iterable of disposers.
 * @returns idempotent disposer for the wait and active effect.
 * @throws callback setup failures synchronously when the slot is already declared.
 */
inject(key, callback) {
```

**语义要点（全部【确证】，来自上面的实现）：**

| 行为 | 证据 |
|---|---|
| 槽位已声明 → 回调**同步**执行 | `renderer-client.js:1416-1421`（`try { reconcile() } catch { stop(); throw error }`） |
| 未声明 → 订阅 `subscribeDeclaration`，声明出现后执行 | `renderer-client.js:1415`、`:1393`（`if (spec === void 0) return`） |
| 声明折叠（collapse）→ 自动 dispose 回调产物 | `renderer-client.js:1384-1399`（`reconcile` 先 `dispose?.()` 再重建） |
| 重新声明 → 自动重新执行 | 同上，靠 `declarationEpoch(key)` 比对（`:1387-1388`） |
| 回调里抛错 → **`queueMicrotask` 重抛**（会炸渲染器，不在 call site 被捕获） | `renderer-client.js:1400-1414` |
| 返回值是幂等 disposer | `:1424` 起 |

> ⚠️ **【确证】这是最容易踩的坑**：回调内的 try/catch 必须放在**回调里面**，不能包在 `inject()` 外层。`dsh-connect-trae/lib/client.js:10070-10078` 的注释写得很清楚：
> `slots.inject() does not necessarily run its callback now: when the slot is not declared yet it subscribes and runs the callback LATER. A later throw is re-thrown by the renderer's own changed() handler out of a queueMicrotask, where no call-site try/catch can reach it`

### 1.2 `ctx.slots.register(options, Component)`

**【确证】** 签名（`SlotCore.register`，两处重载 + 一个擦除版），原文见 `dsh-cordis-client-runner/lib/client.js:2398` 的 `declaration:` 字符串，关键部分：

```ts
register<K extends keyof SlotMap & string, const EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>, ...>(
  options: BaseOptions<K, EntryKey, D, H, M, N> & { inject?: undefined },
  component: C & SlotComponent<ComposedProps<K, NoInfer<EntryKey>, ..., object, NoInfer<M>, NoInfer<N>>> & RendersCheck<C, D>
): () => void;

register<..., I extends object, ...>(
  options: BaseOptions<...> & { inject: (...args: InjectParams<K, H>) => I },
  component: C & SlotComponent<ComposedProps<K, ..., I, ...>> & RendersCheck<C, D>
): () => void;

register(options: ErasedOptions, component: unknown): () => void;
```

**【确证】** entry 字段的实际集合（`StoredEntry`，`runner/lib/client.js:2454`）：

```ts
export interface StoredEntry {
    component: unknown;
    options: {
        key?: string;
        id?: string;
        order?: number;
        label?: SlotLabel;
        priority?: number;
    };
    select?: ((owner: never) => unknown) | undefined;
    inject?: ((...args: never[]) => Record<string, unknown>) | undefined;
    children?: Readonly<Record<string, SlotSpec<SlotEntryDef>>> | undefined;
    store?: StoreDecl | undefined;
    locale?: string | undefined;
    registrant?: string | undefined;
}
```

也就是说 **`name` 之外**，`register` 的 options 实际接受：`id` / `key` / `order` / `label` / `priority` / `inject` / `children` / `store` / `locale`。
（`name` 是必填但被 `ErasedOptions` 收在泛型里；`registrant` 由框架填，不是调用方传。）

**`BaseOptions` 本身在产物里没有独立 declaration**（`grep 'interface BaseOptions'` → `NONE`），只能从上面 `SlotCore.register` 的引用与 `StoredEntry.options` 反推。**【推断】** `label` 类型 `SlotLabel = string | (() => string)`（由目录里 `registerOptions` 的 `type: "string | (() => string)"` 与 `resolveSlotLabel()` 运行时调用共同支持）。

### 1.3 `surface` 字段：**不是框架字段**

**【重要】**
- **`StoredEntry` 里没有 `surface`**（见上，`runner/lib/client.js:2454`）。
- **renderer 里 `surface` 只出现在两处注释**（`renderer-client.txt:1113`、`:1549`），都不是 API。
- **`surface` 是插件自己的 `inject()` 返回的私有 props**，不是 `register` 的 option。

**证据（实测能跑的产物）** —— `dsh-connect-workbuddy/lib/client.js:16313-16320`：

```js
const injected = () => settingsScope === void 0 ? {
    t,
    surface: "settings"
} : {
    t,
    settingsScope,
    surface: "settings"
};
disposers.push(ctx.slots.register({
    name: "settings.section",
    id: WORKBUDDY_SETTINGS_SECTION_ID,
    order: 35,
    label: () => t("nav.panel"),
    locale: namespace,
    inject: injected
}, WorkBuddyCard));
```

对比 `dsh-connect-trae/lib/client.js:10257-10261` 用的是 **`surface: "section"`**：

```js
inject: () => ({
    t,
    settingsScope,
    surface: "section"
})
```

**【确证】两个能跑的插件用了不同的值（`"settings"` vs `"section"`），证明 `surface` 不是框架校验的枚举**，只是各自组件内部约定。**结论：不要把它当契约字段用；要传就只影响你自己的组件。**

### 1.4 `locale` 字段：注册时声明命名空间，框架自动注入 `t`

**【确证】** `renderer/lib/client.js:742-746`：

```js
if (entry.locale !== void 0) {
    const face = host.locale;
    if (face === void 0) throw new SlotAssemblyError(`entry declares locale namespace '${entry.locale}' but no locale face is installed (locale plugin missing from the composition?)`);
    kit["t"] = localeSeat(face, entry.locale);
}
```

即：**注册时写 `locale: '<ns>'`，组件 props 里就有 `t`**，且 `t` 随语言切换实时更新（`localeSeat` 按 `face.getSnapshot().revision` 缓存，`renderer-client.js:548-557`）。

**这把 `t` 从 `inject` 里解放出来** —— 但注意：**三个实测插件仍然用 `inject: () => ({ t })` 传 `t`**（minimax `:564`、workbuddy `:16313`、trae `:10257`）。两种写法都成立；`locale:` 是更干净的路径。

### 1.5 目标槽位逐个说明

**【确证】** 下表汇总目标槽位的注册契约；侧栏导航行与主面板分别注册到 `sidebar.panellist` 和 `main`，两者的目录证据与具体行为见下表及对应子节（`dsh-cordis-client-runner/lib/client.js:6228-6274`、`dsh-cordis-client-runner/lib/client.js:4758-4794`）。

`kind` 决定用 `id` 还是 `key`：**`kind: "list" | "single" | "chain"` → 用 `id`；`kind: "keyed"` → 用 `key`。**
**【确证】** `SlotKind = 'single' | 'list' | 'keyed' | 'chain'`（`runner/lib/client.js:2417`）。

| 槽位 | kind | scope | 注册字段 | 证据 |
|---|---|---|---|---|
| `settings.section` | `list` | `root` | **`id`** + `order` + `label` | 目录 `runner/lib/client.js:5753-5807` |
| `settings.section.icon` | `list` | `root` | **`id`**（必须等于对应 section 的 id） | 目录 `:5808-5856` |
| `conversation.input.left` | `list` | `session` | **`id`** + `order` | 目录 `:3760-3816` |
| `conversation.input.right` | `list` | `session` | **`id`** + `order` | 目录 `:4035-4092` |
| `conversation.input.model.label` | `single` | `session` | **无 registerOptions**（不能用 id/key） | 目录 `:3856-3894` |
| `plugins.bundle.config` | `keyed` | `root` | **`key`**（= 包名） | 目录 `:4917-4955` |
| `settings.plugin.item` | — | — | **不存在此槽位** | 全 asar grep `settings\.plugin\.item` → **0 命中** |
| `sidebar.panellist` | `list` | `root` | **【确证】`id: string` 必需**；`order?: number`（默认 0，升序）；`label?: string \| (() => string)`；公共字段 `locale` | 目录 `dsh-cordis-client-runner/lib/client.js:6228-6274`；`dsh-client-ui-sidebar/lib/client.js:690-695` |
| `main` | `keyed` | `root` | **【确证】`key: string` 必需**；公共字段 `locale` / `inject` | 目录 `dsh-cordis-client-runner/lib/client.js:4758-4794`；`dsh-cordis-client-runner/lib/client.js:2454` |

> `plugins.detail.section`（`list`，`root`，用 `id`，props `{ subject }`）存在，目录 `:5054-5102`；`plugins.item`（`list`，`root`，用 `id`）目录 `:5103-5156`；`plugins.row.config`（`keyed`，`root`，key = `<包名>#<rowId>`）目录 `:5157-5191`。
> **`settings.plugin.item` 是笔误/不存在的名字**，实际存在的对应物是 `plugins.item`（Plugins 页的官方插件卡）和 `settings.plugins.tab`。**【确证】3 个包确认无此串**。

#### `settings.section`

**【确证】** 目录原文（`runner/lib/client.js:5753-5807`），关键片段：

```js
{
    key: "settings.section",
    kind: "list",
    scope: "root",
    summary: "One settings page per list entry.",
    doc: "One settings page per list entry. Registrant options carry the nav\nidentity: `id` (section key, drives `only` filtering), `order` (nav\nposition), `label` (registrant-localized display text ...",
    registerOptions: [ {name: "id", requirement: "required", type: "string"},
                       {name: "order", requirement: "optional", type: "number"},
                       {name: "label", requirement: "optional", type: "string | (() => string)"} ],
    ownerProps: ["...export interface SettingsSectionOwnerProps {\n  /** Close the settings panel (the shell owns the open state). */\n  close: () => void\n}"],
    declaredBy: "an entry in 'sidebar.settings' (client-ui-settings-general), so it exists while that entry is mounted",
    occupants: [
        "client-ui-agent-preset AgentPresetSection id 'agent-presets'",
        "client-ui-settings-account AccountSection id 'account'",
        "client-ui-settings-general GeneralSection id 'general'",
        "client-ui-settings-models ModelsSection id 'models'",
        "client-ui-settings-plugins PluginsSettingsSection id 'plugins'"
    ],
    source: "packages/client/ui-settings/src/client/contract/slots.ts:57"
}
```

**渲染 props（owner props）= `{ close: () => void }`**，另有 standard props（见 §1.6）。
**【确证】** 渲染点 `dsh-client-ui-settings-general/lib/client.js:341`：

```js
children: active !== void 0 && renderSlot("settings.section", { close: onClose }, { only: active })
```

`{ only: active }` 就是「按 id 过滤」——与 catalog doc 里 "id (section key, drives `only` filtering)" 对应。

#### `settings.section.icon`

**【确证】** 目录 `:5808-5856`：

```js
doc: "Optional navigation icons addressed by the matching settings.section id.\nThe registration id must equal the target section's id; unmatched ids\nnever render. The icon's label option is not displayed.\nThe shell owns the button and label and keeps its default glyph when\nno icon is registered for that id.",
ownerProps: ["...export interface SettingsSectionIconOwnerProps {\n  /** Requested square edge in pixels. */\n  size: number\n  /** Whether this section is selected. */\n  active: boolean\n}"]
```

**props = `{ size: number, active: boolean }`**。
**【确证】** 渲染点 `dsh-client-ui-settings-general/lib/client.js:310`：

```js
children: renderSlot("settings.section.icon", {
    size: 16,
    active: row.id === active
}, {
    only: row.id,
    fallback: navIcon(row.id)
})
```

#### `conversation.input.left`

**【确证】** 目录 `:3760-3816`：

```js
key: "conversation.input.left",
kind: "list",
scope: "session",
summary: "Compact controls at the left of the composer tool row; fixed overlays must portal to the document body because the docked composer contains them.",
registerOptions: [ {name:"id", required}, {name:"order", optional}, {name:"label", optional} ],
ownerProps: [],
declaredBy: "an entry in 'conversation.composer.bar' (client-ui-conversation), so it exists while that entry is mounted"
```

**owner props = `{}`（空）**，即**只有 standard props**（含 `useInput`、`inputActions`、`sessionId`、`useProjection` 等，见 §1.6）。
**【确证】** 渲染点 `dsh-client-ui-conversation/lib/client.js:22102`：`renderSlot("conversation.input.left", {})`
**【确证】** 声明点 `dsh-client-ui-conversation/lib/client.js:22974-22977`：

```js
"conversation.input.left": {
    kind: "list",
    scope: "session"
},
```

> 注意 `declaredBy` 说的是「`conversation.composer.bar` 的一个 entry」——**这是 §1.1 里 `inject` 必须等待声明的真实原因**：composer 未挂载（如无 Session、hero 形态）时该槽位不存在，`inject` 会静默等待，不报错。

#### `conversation.input.right`

**【确证】** 目录 `:4035-4092`，`kind: "list"`、`scope: "session"`、owner props `[]`：
`summary: "Compact controls before the composer submit action; fixed overlays must portal to the document body because the docked composer contains them."`

#### `conversation.input.model.label`

**【确证】** 目录 `:3856-3894`：

```js
key: "conversation.input.model.label",
kind: "single",
scope: "session",
summary: "Non-interactive inline model label; selection controls remain owner-managed.",
registerOptions: [],     // ← 关键：single + 无 registerOptions
ownerProps: ["...export interface ModelLabelOwner {\n  readonly provider: Pick<ModelProviderGroup, 'id' | 'name'>\n  readonly model: ModelCatalogModel\n  readonly placement: 'trigger' | 'menu' | 'option'\n  readonly selected: boolean\n}"],
declaredBy: "an entry in 'conversation.input.model' (client-ui-model-selection), so it exists while that entry is mounted"
```

**props = `{ provider: {id, name}, model, placement: 'trigger'|'menu'|'option', selected: boolean }`**。
**`single` 槽位同一 priority 重复注册会抛错** —— 实测插件记录了这个坑（`dsh-connect-workbuddy/lib/client.js:16425-16434`）：

```
* WHY A NEGATIVE PRIORITY (host 0.2.1-rc.2 and later). This is a `single`
* slot: it holds ONE cell, and `SlotCore.register()` THROWS when a second
* registration claims the same priority — "single slot … already has a
* registration at priority 0 — register at a different priority to shadow
* it (lowest renders)". The host itself now ships a contributor here
* (@deepseek-ai/dsh-client-ui-deepseek-model-label-1017, ...) that registers at the default 0,
* so registering at 0 makes the two race: whichever lands second throws.
```

**【确证】** 该插件结论：**注册 `conversation.input.model.label` 必须显式给负 priority**（如 `priority: -1`）以 shadow 官方条目。目录里 `replaceRisk: "shadows-shipped-ui"` 也印证。

**本插件的取舍（0.0.15 起）**：本插件也占这个格子（`priority: -105`），用来把倍率与徽标画在模型名后面（`DeepSeek V4.1 Flash · x0.11` + 徽标）。占住的代价必须讲清楚：宿主自己的官方徽标只在**格子没有占位者**时由宿主画，所以本插件的 `ModelLabel` 对**别人的 provider 行**返回「名字 + 它自己的 `model.badge`」，把它原本要画的东西还回去 —— 只损失样式，不丢信息。`keyed` 宿主上每家 provider 各占一格，退化为按 `provider.id` 注册，那时不存在这个代价。

#### `plugins.bundle.config`

**【确证】** 目录 `:4917-4955`：

```js
{
    key: "plugins.bundle.config",
    kind: "keyed",
    scope: "root",
    summary: "A bundle's own configuration, keyed by the bundle's package name and rendered on the bundle's page between its description and its rows (`view: 'page'` only).",
    registerOptions: [{ name: "key", requirement: "required", type: "string" }],
    ownerProps: ["/** The view the page asks a configuration entry for. */\nexport interface PluginConfigViewProps {\n  /** `summary` renders the one-liner alone, as text or inline nodes; `page` renders the form with its save control. */\n  readonly view: 'summary' | 'page'\n  /** Host-owned configuration values and write actions for this page's entry. */\n  readonly form?: ConfigPageForm | undefined\n}"],
    keyDomain: "open: any string the owner dispatches (no compile-time key set), already taken: @deepseek-ai/dsh-cua-bundle, @deepseek-ai/dsh-experimental-cot-translation-bundle, @deepseek-ai/dsh-experimental-voice-input-bundle",
    declaredBy: "an entry in 'main' (client-ui-plugin-manager), so it exists while that entry is mounted",
    occupants: [
        "experimental-client-ui-cot-translation TranslationSettings key '@deepseek-ai/dsh-experimental-cot-translation-bundle'",
        "experimental-client-ui-voice-input VoicePreparation key '@deepseek-ai/dsh-experimental-voice-input-bundle'",
        "cua PermissionPanel key '@deepseek-ai/dsh-cua-bundle'"
    ],
    replaceRisk: "shadows-shipped-ui",
    source: "packages/client/ui-plugin-manager/src/client/slot-contract.ts:142"
}
```

**props = `{ view: 'summary' | 'page', form?: ConfigPageForm }`**。
**【确证】** 渲染点 `dsh-client-ui-plugin-manager/lib/client.js:6022`：

```js
children: renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })
```

**`{ entryKey: pkg.name }`** 是 keyed 槽位的派发方式，与 key = 包名对应。

**注意 `capabilities` 不存在** —— owner props 只有 `view` 和 `form`。**【确证】** 目录原文如上，无 `capabilities` 字段。

#### `sidebar.panellist`

**【确证】** `kind: "list"`、`scope: "root"`；目录的 registerOptions 为必需的 `id: string`、可选的 `order: number` 与 `label: string | (() => string)`，`locale` 是公共字段。`declaredBy` 为 `sidebar` entry（`client-ui-sidebar`），随该 entry 挂载存在；`keyDomain` 为空，id 无枚举限制（`dsh-cordis-client-runner/lib/client.js:6228-6274`；公共字段与 `StoredEntry.options` 见 `dsh-cordis-client-runner/lib/client.js:2454`）。

**【确证】** 宿主传入的渲染 props（owner props）为 **`{ size: number, active: boolean }`**，只把组件当图标渲染，按钮由宿主创建（`dsh-client-ui-sidebar/lib/client.js:206-232`），渲染点 `dsh-client-ui-sidebar/lib/client.js:228`：

```js
renderSlot('sidebar.panellist', { size: wide ? 16 : 18, active }, { only: id })
```

**【确证】** 导航行名来自 entry 元数据：宿主读取 `ctx.slots.entriesOfSlot('sidebar.panellist')`，取 `options.id`，以 `options.order ?? 0` 升序排列，以 `resolveSlotLabel(options.label) ?? id` 作为行名（`dsh-client-ui-sidebar/lib/client.js:690-695`）。因此组件返回 `null` 只会留下图标空白但可点的按钮，**隐藏行必须注销 entry**（`dsh-client-ui-sidebar/lib/client.js:206-232`、`dsh-client-ui-sidebar/lib/client.js:690-695`）。

**【确证】** 侧栏行点击调用 `layout.selectPanel(id)`，因此必须存在 **同 key 的 `main` entry**；id 没有枚举限制不代表可以导航到未注册的面板，后者会抛错（`dsh-client-ui-sidebar/lib/client.js:206-232`；`dsh-client-ui-layout/lib/client.js:522-525`；见 §1.8）。

#### `main`

**【确证】** `kind: "keyed"`、`scope: "root"`；registerOptions 要求 **`key: string`**，`locale` / `inject` 是公共字段。`declaredBy` 为 `root` entry（`client-ui-layout`）（`dsh-cordis-client-runner/lib/client.js:4758-4794`；公共字段见 `dsh-cordis-client-runner/lib/client.js:2454`）。

**【确证】** 宿主渲染 props（owner props）为 **`{}`**（`dsh-client-ui-layout/lib/client.js:127`）：

```js
renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })
```

**【确证】** `surface: 'page'`、`backToConversation` 不是框架字段，是插件经 `inject` 传入的私有 props，与 §1.3 一致；本项目注入位置为 `src/client/bundle.js:1217-1226`，宿主空 owner props 的证据为 `dsh-client-ui-layout/lib/client.js:127`。

**【确证】** 目录的 keyDomain 只列出已占用的 `conversation`（`dsh-cordis-client-runner/lib/client.js:4758-4794`），运行时还有 `plugins`（`dsh-client-ui-plugin-manager/lib/client.js:7680`、`dsh-client-ui-plugin-manager/lib/client.js:7751`）与 `schedules`（`dsh-client-ui-schedule/lib/client.js:19198`、`dsh-client-ui-schedule/lib/client.js:19361`）。**【推断】** 为避免与宿主面板冲突，不要占用通用词，宜用插件包名作为 key；依据为上述已占用 key，本项目采用 `dsh-connect-lingxi`（`src/client/bundle.js:24`、`src/client/bundle.js:1257-1261`）。

### 1.6 标准 props（所有槽位都额外收到）

**【确证】** 目录里每个条目的 `standardProps` 列表（如 `runner/lib/client.js:3787-3806`，`conversation.input.left`）：

```
useRemoteAccess: (action: RemoteEndpoint) => boolean
useResource: UseResource
useContextMenu: UseContextMenu
useWorkspaces: SnapshotSelectorHook<WorkspaceSnapshot>
usePanelInfo: UsePanelInfo
useSessions: UseSessions
useSessionStatus: UseSessionStatus
useSessionRetainInfo: UseSessionRetainInfo
useSessionAccess: (sessionId: SessionId, action: RemoteEndpoint) => boolean
useWorkspaceAccess: (workspaceId: WorkspaceId, action: RemoteEndpoint) => boolean
useChat: UseChat
useConversation: UseConversation
useInput: SnapshotSelectorHook<InputState>
inputActions: InputActions
useSession: SessionSnapshotSelector
sessionId: SessionId
useProjection: UseProjection
useAccess: (action: RemoteEndpoint) => boolean
useTrajectory: UseTrajectory
```

`settings.section` / `settings.section.icon` / `plugins.bundle.config` 是 `root` scope，**只有前 10 个**（无 session 相关的 `useChat`/`useInput`/`sessionId`/`useProjection` 等）。
**【确证】** 目录 `:5781-5792`（settings.section 的 standardProps 到 `useWorkspaceAccess` 截止）。

**`useProjection` 确有**（session scope 槽位），`t` 则由 `locale:` 或 `inject` 提供（§1.4）。

**完整 props 类型 = `ComposedProps`，【确证】** `runner/lib/client.js:1946`：

```ts
export type ComposedProps<K extends keyof SlotMap & string, EntryKey extends EntryKeyOf<K>, S extends keyof SlotMap & string, H, I extends object, M = never, N = undefined> = PropsRuntime<K, EntryKey> & PropsRenderSlots<S> & PropsRenderFactories & PropsStore<H> & InjectFace<I> & MatchedShare<SlotMap[K], M> & PropsLocale<N>;
```

各分量（同文件）：

```ts
// :2242
export type PropsRuntime<K extends keyof SlotMap & string, EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>> = OwnerOf<K> & KeyPropsOf<K, EntryKey> & SlotInjectFace<SlotInjectOf<K>> & ScopeStandardProps<ScopeOf<K>>;
// :2230
export type PropsLocale<N> = N extends keyof LocaleNamespaceMap & string ? { t: TranslateNS<N>; } : object;
// :2250
export type PropsStore<H> = H extends StoreHandle<infer T, infer A> ? { useStore: SnapshotSelectorHook<T>; actions: BakedActions<T, A>; } : object;
// :2238
export type PropsRenderSlots<S extends keyof SlotMap & string> = {
    renderSlot: RenderSlotFn<Exclude<S, ChainKeysOf<S>>>;
    readonly __renders?: ((key: S) => void) | undefined;
} & (...) & (... { SessionProvider: SessionProviderComponent })
```

### 1.7 插件 apply ctx 里怎么拿到 `slots`

**【确证】** 插件模块导出 `inject: ['slots']`，Cordis 把服务挂到 `ctx.slots`。三家实测插件产物原文：

`dsh-connect-minimaxcode/lib/client.js:543-553`：

```js
return {
    inject: ['slots', 'locale'],
    apply(ctx) {
        const context = ctx;
        // Visible text goes through the host's locale service.
        context.effect(() => context.locale.register(NAMESPACE, { zh, en }), `${BUNDLE_NAME}: locale`);
        ...
        const t = context.locale.bind(NAMESPACE);
```

`dsh-connect-workbuddy` / `dsh-connect-trae` 同构（`ctx.slots.inject(...)`、`ctx.slots.register(...)`）。

**目录给的官方最小形态**（`runner/lib/client.js:3814`，`example:` 字段原文）：

```js
return {
  inject: ['slots'],
  apply(ctx) {
    ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
      { name: 'conversation.input.left', id: 'my-entry', order: 100, label: 'My entry' },
      () => React.createElement('div', null, 'hello'),
    ))
  },
}
```

---

### 1.8 `layout` 服务：软取与面板切换

**【确证】** `ctx.get(name)` 是 Cordis 的软取写法；使用 `ctx.get('layout')` 探测服务，workbuddy 实测调用见 `dsh-connect-workbuddy/lib/client.js:16255`，本项目的软探测及 `selectPanel` 函数检查见 `src/client/bundle.js:1201-1208`。

**【确证】** 方法签名为 `selectPanel(panelId: string | null): void`，以下行为由服务实现与契约共同确认（`dsh-client-ui-layout/lib/client.js:522-525`、`dsh-cordis-client-runner/lib/client.js:1288-1294`）：

| 参数 / 条件 | 结果 | 证据 |
|---|---|---|
| 已注册的 `main` key | 【确证】中间列切换到对应面板 | `dsh-client-ui-layout/lib/client.js:522-525`；渲染点 `dsh-client-ui-layout/lib/client.js:127` |
| `null` | 【确证】回到对话，不更换 Session | `dsh-cordis-client-runner/lib/client.js:1288-1294`；`dsh-client-ui-layout/lib/client.js:522-525` |
| 未注册的 id | 【确证】抛出 `layout.selectPanel: main panel "<id>" is not registered`，原选择保持不变 | `dsh-client-ui-layout/lib/client.js:522-525` |

**【确证】** 本项目不硬依赖 `layout`：软探测取不到服务时，不提供 `openPanel` / `backToConversation` 回调，并隐藏「打开面板 / 返回对话」按钮，避免留下点击会抛错的按钮（`src/client/bundle.js:1201-1208`、`src/client/bundle.js:1217-1226`、`src/client/bundle.js:1334-1339`；按钮条件见 `src/client/bundle.js:919-921`、`src/client/bundle.js:1136-1141`）。

## 2. locale 服务

### 2.1 `ctx.locale.register(ns, dicts)` 与 `ctx.locale.bind(ns)`

**【确证】** 两个重载都在实现里（`dsh-client-locale/lib/client.js:1675`、`:1702`），原文：

```js
register(ns, localeOrDicts, dict) {
    const pairs = typeof localeOrDicts === "string" ? [[localeOrDicts, dict]] : Object.entries(localeOrDicts);
    for (const [locale] of pairs) if (!LOCALE_ID_PATTERN.test(locale)) throw new Error(`locale id "${locale}" is not a BCP 47-style tag`);
    let locales = this.dicts.get(ns);
    if (!locales) {
        locales = /* @__PURE__ */ new Map();
        this.dicts.set(ns, locales);
    }
    for (const [locale] of pairs) if (locales.has(localeKey(locale))) throw new Error(`locale namespace "${ns}" already has locale "${locale}"`);
    for (const [locale, entries] of pairs) locales.set(localeKey(locale), entries);
    this.publish(this.snapshot.active, false);
    return () => { ... };   // ← 返回 disposer
}
```

```js
bind(ns) {
    let t = this.bound.get(ns);
    if (!t) {
        t = (key, params) => this.translate(ns, key, params);
        this.bound.set(ns, t);
        return t;
    }
    return t;
}
translate(ns, key, params) {
    const chain = this.fallbackChain(this.snapshot.active);
    const template = this.lookup(ns, key, chain) ?? (ns !== "common" ? this.lookup("common", key, chain) : void 0) ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
}
```

**契约小结（全部【确证】）：**

| 项 | 事实 | 证据 |
|---|---|---|
| 两种调用形态 | `register(ns, { zh, en, ja })` **或** `register(ns, 'it', { ... })` | `:1676` |
| 返回 | **disposer**（必须交给 `ctx.effect` 或自行保管） | `:1686` |
| 重复同名 ns+locale | **抛错** | `:1683` |
| 绑定函数身份稳定 | `bound` Map 缓存，重复 `bind(ns)` 返回**同一函数** | `:1703-1709` |
| 插值语法 | `{name}`，`params` 缺键则原样保留 `{name}` | `:1715` |
| 查找顺序 | 本 ns 沿 fallback 链 → `common` 沿链 → **键名本身** | `:1713` |
| 中文/英文必需 | README 明示「要求两个基础 locale（`zh` 和 `en`）齐全」 | `README.zh.md:40` |
| `resolveText(text)` | 解析 `LocalizedText`（插件标题/描述），字面串原样返回 | `:1529-1532` |
| `addLanguage({id,label,fallback})` | 注册新语言，fallback 必须已注册且终止于 `en` | `:1585-1598` |

**README 原文（`dsh-client-locale/README.zh.md:40`）：**

> 用已合并进 `LocaleNamespaceMap` 的命名空间调用 `ctx.locale.register(ns, { zh, en, ja })`；编译器会对照该命名空间的类型化键并集检查每个键，并要求两个基础 locale（`zh` 和 `en`）齐全。… 消费方通过 `ctx.locale.bind(ns)` 或框架注入的 `t` 席位翻译。

**实测用法（minimax `:548-553`，原文）：**

```js
context.effect(() => context.locale.register(NAMESPACE, { zh, en }), `${BUNDLE_NAME}: locale`);
const t = context.locale.bind(NAMESPACE);
```

### 2.2 `locale/*.json` 命名空间文件格式

**【确证】** 内置包的文件（`dsh-client-locale/locale/zh.json`，全文）：

```json
{
  "meta": {
    "title": "界面语言",
    "description": "管理界面语言偏好和各插件的翻译文案。"
  }
}
```

`en.json` 同构。**只含 `meta.title` / `meta.description`**（这是**包级**元信息，供插件管理页显示，不是运行时字典）。

**【确证】** 实测插件的同名文件（`dsh-connect-minimaxcode/locale/zh.json` 全文）：

```json
{
  "meta": {
    "title": "DSH Connect MiniMax Code",
    "description": "把 MiniMax Code 的模型接入 DSH：复用桌面 App 登录态，或用 OAuth 设备码自己登录；带实时模型目录、每日签到，以及跟随所选模型显示的积分余额与到期提示。"
  }
}
```

**结论：`locale/<lang>.json` 只是包的显示元信息（`meta.title`/`meta.description`），运行时字典走 `ctx.locale.register()` 的 JS 对象**（minimax 把 `zh`/`en` 字典直接写成 JS 常量，`:30-113`）。两者不混用。**【确证】**

---

## 3. 客户端模块加载

### 3.1 `window.__ModuleLoader__.load({ id, factory })`

**【确证】** 每个 client bundle 的开头就是它。原文（`dsh-client-modules/lib/client.js:1-6`）：

```js
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-modules",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
```

**契约（【确证】，`client-modules/lib/client.js` 各处）：**

| 项 | 事实 | 证据 |
|---|---|---|
| 形状 | `load({ id, factory })`，`factory(require) => exports` | `:1-3` |
| `id` | **包名**（`<pkg>`；`<pkg>/client` 归一化到同一导出） | `:116-118`、README.zh.md:43 |
| 执行时机 | **只注册 factory**，模块体副作用全部在 factory 闭包里，物化时才跑 | `:16-23` |
| 重复注册 | **抛错** `duplicate factory registration for "<id>" (bundle executed twice without invalidate?)` | `:710` |
| 物化 | 同步、`loadCache` 记忆化、递归物化依赖 | `:819`、`:20-23` |
| require 环 | **抛错** `require cycle through "<id>" (factory-form CJS cannot deliver partial exports)` | `:812` |
| 未解析 specifier | **抛错** `require("<spec>") missed the module table — ...` | `:842`、`:889` |
| 脚本未注册 | **抛错** `bundle <url> loaded without registering "<id>" via __ModuleLoader__.load` | `:760`、`:877` |

**factory 返回的模块导出必须有哪些？**

**【确证】** 必须是 Cordis 插件形状：**`inject`（字符串数组，可选）+ `apply(ctx)`（函数，必需）**。三家实测产物：

```js
// dsh-connect-minimaxcode/lib/client.js:543-545
return {
    inject: ['slots', 'locale'],
    apply(ctx) { ... },
};
```

`dsh-connect-workbuddy` / `dsh-connect-trae` 同构；目录示例亦为 `{ inject: ['slots'], apply(ctx) {...} }`（`runner :3814`）。

**`name` 不是必需的** —— 三家实测产物**都没有导出 `name`**（`grep "name:" minimax client.js` 无顶层 name 导出）。**【确证】** 模块身份由 `load({id})` 的 `id`（包名）承担，不是导出字段。

> **【推断】** Cordis 的「named plugin」语义允许 `name`，但本仓库的模块系统用 `id` 定身份，因此不写 `name`。若要写，也不影响加载。

### 3.2 `require` 能解析哪些模块

**【确证】** 分支顺序（`client-modules/lib/client.js:25-31` 注释原文）：

```
* Resolution branch order (import): seed word → shell instance; memoized
* record → exports; graph row → register its dependency factories and own
* factory; registered factory → materialize; anything else → throw (loud —
* the runtime mirror of the build-time bundle purity gate).
* The synchronous `require` handed to factories walks the same order minus
* the load branch.
```

**平台 seed 表（`PLATFORM_MODULES`）里的模块**才是全局可 require 的。**【确证】** 所有官方包实际 require 的只有 React 三件套：

```
/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js:8:  let react_jsx_runtime = require("react/jsx-runtime");
/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js:12: let react_dom = require("react-dom");
/dsh/node_modules/@deepseek-ai/dsh-client-ui-attachment/lib/client.js:10: let react_dom = require("react-dom");
```
（`dsh-client-ui-*` 系列 40+ 个包，模式一致。）

**结论（【确证】+【推断】）：**
- **`react`**、**`react-dom`**、**`react/jsx-runtime`** 可用 —— **【确证】**，`dsh-connect-minimaxcode/lib/client.js:120` 就是 `const React = require('react');`
- **宿主服务不是通过 require 拿的** —— 服务走 `inject: ['slots','locale']` 的 Cordis 机制，**不**通过 `require('@deepseek-ai/dsh-client-locale')`。**【确证】**：三家实测插件全部用 `inject` 取服务，`require` 只用于 react。
- `require.asset(reference)` 取包资源；`require.async(spec)` 取异步 chunk。**【确证】** `client-modules/lib/client.js:844-851`：

```js
require.asset = (reference) => this.resolveAsset(reference);
require.async = async (spec) => {
    edges.add(spec);
    if (!spec.startsWith("./")) return await this.import(spec);
    const fileName = spec.slice(2);
    if (!CLIENT_CHUNK.test(fileName)) throw new Error(`client-modules: invalid relative chunk request ${JSON.stringify(spec)}`);
    return await this.importChunk(ownerId, fileName);
};
```

**完整平台 seed 名单未在 asar 里找到**（`PLATFORM_MODULES` 定义在 `@deepseek-ai/dsh-web` 的 shell 包，asar 内 grep 不到该常量）→ **【未确证】**。文档说其定义在 [`PLATFORM_MODULES`](../web/README.zh.md#the-shared-module-table)（`client-modules/README.zh.md:56`），但那个 README 也不在 asar 内。

### 3.3 `dsh.client.external` 的用途

**【确证】** README 原文（`client-modules/README.zh.md:56`）：

> 外壳初始化一张冻结的模块表（`PLATFORM_MODULES`）；每个动态 bundle 都精确针对该基座解析其 external。**`dsh.client.external` 只添加基座之外的精确请求**；系统会将每个请求解析到其指定的动态包 row 或完全匹配的静态表键。纯类型 import 会被擦除，不产生请求。组合阶段会拒绝畸形请求、缺失提供方、自请求与同步请求环。

**【确证】** 实现（`client-modules/lib/client.js` 内联在 index.js 的 compose 段，`:491-493`）：

```js
for (const name of entry.external ?? []) {
    ...
    if (dependency === entry) throw new Error(`client-modules: "${entry.id}" requests module "${name}" that it answers itself — a row must not declare its own package in dsh.client.external`);
```

**用途总结：** 当你 bundle 里 `import` 了**不在平台 seed 表、也不在你自己的包里**的模块（例如 `import { x } from '@deepseek-ai/dsh-api-gateway/client'`），必须把该 specifier 列进 `dsh.client.external`，组合器才会把那个包排到你前面并建立依赖边。否则运行时 `require` 命中不到 → 抛 `missed the module table`。

**实测：三个 connect 插件的 `external` 都是 `[]`**（minimax `package.json:108-117` 无 external 字段；trae 同），因为它们的客户端只用 `require('react')` + `inject` 服务。**【确证】**

### 3.4 `dsh.client` 的 `platform` / `inject` / `immediately`

**【确证】** 校验器原文（`client-modules/lib/index.js:86-100`）：

```js
function parseDshClient(pkgName, value) {
	if (value === void 0) return void 0;
	if (typeof value !== "object" || value === null) throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`);
	const decl = value;
	if (typeof decl.platform !== "string") throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
	const inject = optionalStringArray(pkgName, "dsh.client.inject", decl.inject);
	const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);
	if (decl.immediately !== void 0 && typeof decl.immediately !== "boolean") throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`);
	return {
		platform: decl.platform,
		...inject !== void 0 ? { inject } : {},
		...external !== void 0 ? { external } : {},
		...decl.immediately !== void 0 ? { immediately: decl.immediately } : {}
	};
}
```

**生效条件（【确证】）：`platform` 必须恰好是字符串 `'web'`，否则整包跳过。**

```js
// client-modules/lib/index.js:790
if (decl === void 0 || decl.platform !== "web") return null;
```

| 字段 | 类型 | 含义 | 生效条件 | 证据 |
|---|---|---|---|---|
| `platform` | `string` | 平台标识。**只有 `'web'` 会被组合**，其他值（如 `'desktop'`）静默跳过 | 必须 `=== 'web'` | `index.js:790` |
| `inject` | `string[]` | **客户端包名列表**：本 bundle 依赖哪些客户端的**包**（不是 Cordis 服务名） | 可选；进启动图 row 的依赖边 | `index.js:91,96,465,798` |
| `immediately` | `boolean` | 是否**立即**加载（不等按需）。true → 进 bootstrap/application combo 首屏批次 | 可选；缺省视为 false | `index.js:93,98,466,800` |
| `external` | `string[]` | 平台表之外的模块请求 | 可选 | `index.js:92,97,467,799` |

**`inject` 里列的是「必须已加载的客户端包」——【确证】**。证据：

1. 类型与 `external` 同为「package name 数组」，在 `graphRow()` 里并排写入 row（`index.js:460-468`），而 `external` 明确是「包 row 或静态表键」。
2. 实测值全是包名，例如 `@deepseek-ai/dsh-client-ui-plugin-manager/package.json`：

```json
"dsh": {
  "client": {
    "inject": [
      "@deepseek-ai/dsh-api-remotes",
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-layout",
      "@deepseek-ai/dsh-client-ui-sidebar"
    ],
    "platform": "web"
  }
}
```

3. `dsh-connect-minimaxcode/package.json:108-117`：

```json
"client": {
  "platform": "web",
  "immediately": true,
  "inject": [
    "@deepseek-ai/dsh-client-ui-renderer",
    "@deepseek-ai/dsh-client-ui-conversation",
    "@deepseek-ai/dsh-client-ui-plugin-manager",
    "@deepseek-ai/dsh-client-locale"
  ]
}
```

这些全是包名，且都是它 `ctx.slots.inject` / `ctx.locale` 需要的宿主包 —— **即「我的客户端代码运行前，这些包的 client bundle 必须已加载」**。

**【确证】** asar 内 105+ 个 `dsh.client` 声明的组合统计（21 种）：

```
4   platform=web immediately=true  inject=1 external=0
14  platform=web immediately=false inject=4 external=0
10  platform=web immediately=false inject=5 external=0
 9  platform=web immediately=false inject=3 external=0
...
```

→ **绝大多数是 `immediately: false` + 若干 `inject`**；只有少数 kernel 级包 `immediately: true`。

**【未确证】** `immediately` 与 combo 相位（bootstrap vs application）的精确对应关系 —— README 说「bootstrap combo」优先，但代码里 `immediately` 只进了 row 字段，具体排期在 `buildBatch`/`EntryTree` 侧，未逐行确证。

---

## 4. 宿主侧 HTTP 路由（`ctx.webServer.register`）

**【确证】** 实现（`dsh-host-webserver/lib/index.js:375-382`）：

```js
/**
 * Register a named route. Duplicate (kind, path) throws — route patterns are
 * a composition-level contract, so a collision is a misconfiguration.
 * @param route - kind, path, and the owning handler or resource.
 * @returns the disposer removing the route.
 */
register(route) {
	const table = route.kind === "exact" ? this.exact : this.prefixes;
	if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
	table.set(route.path, route);
	return () => {
		table.delete(route.path);
	};
}
```

**`kind` 可选值：【确证】** 只有两个 —— **`'exact'`** 和 **`'prefix'`**（`route.kind === "exact" ? this.exact : this.prefixes`）。
【推断】这是二分法：任何非 `'exact'` 都进 prefix 表，但契约上只有 `'prefix'`。

**handler 签名：【确证】** `handler(req, res)`，标准 `node:http` 的 `IncomingMessage` / `ServerResponse`（`index.js:471`）：

```js
if (typeof responder === "function") await responder(req, res);
else if ("resource" in responder) await this.serveResource(req, res, target, responder.resource);
else await responder.handler(req, res);
```

dispatch 原文（`index.js:459-472`）：

```js
const handle = async (req, res) => {
	const target = new URL(req.url ?? "/", "http://x");
	const responder = this.responderFor(target.pathname);
	if (responder === void 0) {
		res.writeHead(404);
		res.end();
		return;
	}
	if (typeof responder === "function") await responder(req, res);
	else if ("resource" in responder) await this.serveResource(req, res, target, responder.resource);
	else await responder.handler(req, res);
};
```

**`isLoopbackHost` 是导出**：【确证】`index.js:663` 的 export 列表：

```js
export { WebServer, WebServer as default, bindUrlHost, isLoopbackHost, isWildcardHost, normalizeBindAddress, renderIndexInjections };
```

实现（`index.js:164-167`）：

```js
function isLoopbackHost(host) {
	const parsed = parseIpLiteral(host);
	return parsed !== void 0 && parsed.range() === "loopback";
}
```

> ⚠️ 注意 `isLoopbackHost(host)` 接受的是 **IP 字面量**（`parseIpLiteral`），不是 `Host` header。实测插件是**自己写 `isLoopback`** 判断 `req.headers.host`（`dsh-connect-minimaxcode/lib/index.js:2525`：`if (!isLoopback(req.headers.host))`），不是直接用这个导出。**【确证】**

**`ctx.inject(['webServer'], ...)` 用法**：【确证】实测原文（`dsh-connect-minimaxcode/lib/index.js:2520-2528`）：

```js
ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
        kind: "exact",
        path: MINIMAX_STATUS_PATH,
        handler: async (req, res) => {
            if (!isLoopback(req.headers.host)) {
                res.writeHead(403, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "loopback only" }));
                return;
            }
```

**要点（全部【确证】）：**
- `kind: "exact"`，`path: "/plugins/<pkg>/status"`（minimax 的 `STATUS_PATH`，`client.js:20`）
- 返回 disposer，必须包进 `ctx.effect(...)`（或 `webCtx.effect(...)`）
- `ctx.inject(['webServer'], cb)` 只在服务可用时跑 cb；服务不在就不跑（**这是 web/desktop 兼容的正确姿势**）
- 路由匹配顺序（README `:61`）：exact 全表 → 最长 prefix → fallback

**`registerUpgrade(route)`** 亦存在（`index.js:389`），用于 WebSocket upgrade，精确 pathname。
**`resource(request, peer?)`** 是 `handler` 的替代：Fetch `Request` → `Response`（README `:63`）。

---

## 5. 交叉验证：文档契约 vs 三个实测产物

| 契约点 | asar 文档/类型 | minimax（32KB） | workbuddy（890KB） | trae（539KB） | 结论 |
|---|---|---|---|---|---|
| 入口形态 | `inject:['slots']` + `apply(ctx)` | `inject: ['slots','locale']` + `apply` `:543` | 同构 | 同构 | **一致** |
| `settings.section` 用 `id` | kind=`list`，`id` required | 未用 | `id: WORKBUDDY_SETTINGS_SECTION_ID, order: 35, label: () => t(...)` `:16321` | `id: traeSettingsId, order: 30` `:10251` | **一致** |
| `settings.section` props | `{ close }` | 未用 | 组件内用 `surface` 私有 prop | 同 | **一致**（`close` 未被使用，不等于不存在） |
| `settings.section.icon` 用同 `id` | `id` 必须等于 section id | 未用 | `id: WORKBUDDY_SETTINGS_SECTION_ID` `:16332` | `id: traeSettingsId` `:10278` | **一致** |
| `settings.section.icon` props | `{ size, active }` | 未用 | `iconProps?.size`、`iconProps?.active` `:16336,16343` | 同构 | **一致** |
| `conversation.input.left` 用 `id` | kind=`list` | `id: 'minimax-credits', order: 4` `:561` | 改用 `input.right`（注释说明）| 未用 | **一致** |
| `conversation.input.right` 用 `id` | kind=`list` | 未用 | `id: "dsh-connect-workbuddy-composer-credits", order: 4` `:16398` | 未用 | **一致** |
| `plugins.bundle.config` 用 `key`=包名 | kind=`keyed` | `key: BUNDLE_NAME`（=`dsh-connect-minimaxcode`）`:570` | 已移除该槽位（改为 settings.section） | 未用 | **一致** |
| `plugins.bundle.config` props `{view, form?}` | `view: 'summary'\|'page'` | `if (props.view === 'summary')` `:425`，用 `props.t` | — | — | **一致** |
| `locale:` 注册期注入 `t` | `renderer:742-746` | 用 `inject: () => ({t})`（等价） | 用 `locale: namespace` + `inject` 两者 | 两者 | **不冲突**，两条路都通 |
| `locale.register(ns,{zh,en})` 返回 disposer | `:1686` | `ctx.effect(() => ctx.locale.register(...))` `:548` | `ctx.effect(() => ctx.locale.register(namespace, {...}))` `:16250` | `ctx.effect(...)` `:10130` | **一致** |
| `ctx.locale.bind(ns)` 稳定身份 | `:1703` | `const t = context.locale.bind(NAMESPACE)` `:553` | `const t = ctx.locale.bind(namespace)` `:16254` | `:10134` | **一致** |
| `single` 槽位需 priority 避让 | 目录 `replaceRisk: shadows-shipped-ui` | — | 记录必须负 priority `:16425-16434` | — | **一致（且是重要补充）** |
| `slots.inject` 回调晚执行、必须内层 try/catch | `renderer-client.js:1400-1414` | 未处理 | 内层 try/catch `:16310,16360` | 明确注释 + 内层 catch `:10070-10117` | **一致（重要补充）** |
| `surface` 是框架字段？ | **不是**（`StoredEntry` 无此字段） | 未用 | `surface: "settings"` `:16315` | `surface: "section"` `:10260` | **两家值不同 → 证明非契约** |
| `webServer.register({kind:'exact'})` | `index.js:375-382` | `kind:"exact"` + `ctx.inject(['webServer'])` `:2520` | — | 同构 | **一致** |

**不一致项（唯一的真冲突）：`surface` 的取值。**
- 文档/类型：**无此字段**。
- workbuddy 用 `"settings"`，trae 用 `"section"`，**两者同时能跑**。
- **判定：`surface` 不是契约；是两个插件各自组件内的私有约定。文档不写它。**

---

### 5.1 本项目落地：常驻主面板与按需侧栏行

**【确证】** `src/client/bundle.js` 的 `main` 面板常注册，不随侧栏开关注销；key 为 `dsh-connect-lingxi`，`inject` 提供 `{ t, surface: 'page', backToConversation? }`，返回回调仅在软探测到 `layout` 时提供（`src/client/bundle.js:24`、`src/client/bundle.js:1217-1226`、`src/client/bundle.js:1257-1261`）。

**【确证】** `sidebar.panellist` 行只在 `status.settings.sidebarPanel === true` 时注册，关闭即 dispose。实现以 `panelDisposers` 保存注销函数，由 `syncPanelRow()` 同步；`panelRowWanted` 比较前后开关值，只在值真正变化时更新，避免 60 秒轮询带来的无意义重注册；状态尚未读到时直接返回（`src/client/bundle.js:1262-1296`；轮询间隔见 `src/client/bundle.js:28`）。

**【确证】** 插件详情页注入 `surface: 'detail'`，设置页注入 `surface: 'settings'`，两处都不显示返回按钮；返回入口仅属于 `surface: 'page'` 且提供返回回调的主面板，详情页与设置页没有「对话」可返回（`src/client/bundle.js:1209-1226`、`src/client/bundle.js:1317-1320`、`src/client/bundle.js:1364-1366`；渲染条件见 `src/client/bundle.js:919-921`）。

**【确证】** 对应测试已包含四条：main 常注册并声明整页 props（`test/bundle-runtime.test.ts:143-154`）、开关关闭时不占侧栏座位（`test/bundle-runtime.test.ts:156-168`）、开关打开时注册一行并提供 id / label（`test/bundle-runtime.test.ts:170-181`）、无 layout 时不伪造返回按钮（`test/bundle-runtime.test.ts:183-197`）。此处记录测试内容，不代表本次文档修改执行了测试。

## 6. 最小可用客户端插件骨架

下面是按上面**已确证**的契约写成的、可直接照抄的骨架。三个槽位全用上：设置页 + 输入框左侧胶囊 + 插件详情页；带 `locale.register` 与 `ctx.effect`。

**`package.json` 关键字段（照抄 minimax 的已验证形状）：**

```json
{
  "name": "dsh-connect-lingxi",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./locale/*": "./locale/*",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-ui-plugin-manager",
        "@deepseek-ai/dsh-client-locale"
      ]
    }
  }
}
```

> `inject` 里列的必须是你 `ctx.slots.inject` / `ctx.locale` 实际需要的宿主包（§3.4）。
> `immediately: true` 让它在首屏批次加载；若你只在打开详情页时才需要，可设 `false`。

**`lib/client.js`（完整骨架）：**

```js
"use strict";
/**
 * 浏览器半侧：一个设置页 + 一个输入框左侧胶囊 + 一个插件详情页。
 *
 * 契约来源（全部在本机 asar 内确证）：
 *  - window.__ModuleLoader__.load({ id, factory })      dsh-client-modules/lib/client.js:1-23
 *  - factory 返回 { inject: [...], apply(ctx) }          三家实测插件一致
 *  - ctx.slots.inject(key, cb)                            dsh-client-ui-renderer/lib/client.js:1368
 *  - ctx.slots.register(options, Component)               dsh-cordis-client-runner/lib/client.js:2398
 *  - ctx.locale.register(ns, {zh,en}) / bind(ns)          dsh-client-locale/lib/client.js:1675,1702
 */
(function bootstrapLingxiClient() {
    const BUNDLE_NAME = 'dsh-connect-lingxi';
    const NAMESPACE = 'dsh-connect-lingxi';
    // 设置页/胶囊/详情页共用的宿主接口（宿主侧 webServer 提供，见 §4）
    const STATUS_PATH = '/plugins/dsh-connect-lingxi/status';

    // ---- 词典：ctx.locale.register 要求至少 zh + en ----
    const zh = {
        nav: '灵犀',
        pill: '灵犀 {state}',
        pillIdle: '待命',
        cardTitle: '灵犀连接状态',
        loading: '读取中…',
        failed: '读取失败',
        summary: '灵犀：{state}',
        close: '关闭',
    };
    const en = {
        nav: 'Lingxi',
        pill: 'Lingxi {state}',
        pillIdle: 'idle',
        cardTitle: 'Lingxi connection',
        loading: 'Loading…',
        failed: 'Unavailable',
        summary: 'Lingxi: {state}',
        close: 'Close',
    };

    const loader = globalThis.__ModuleLoader__;
    if (loader === undefined) return;

    loader.load({
        id: BUNDLE_NAME,
        factory(require) {
            const React = require('react');
            const h = React.createElement;

            // ---------- 共享状态（一个轮询喂三个表面）----------
            const listeners = new Set();
            let snapshot;
            let timer;
            async function load() {
                try {
                    const response = await fetch(STATUS_PATH, { headers: { accept: 'application/json' } });
                    if (!response.ok) return;
                    snapshot = await response.json();
                    for (const listener of listeners) listener(snapshot);
                } catch {
                    // 轮询失败保留上次值，不清空 UI
                }
            }
            function subscribe(listener) {
                listeners.add(listener);
                if (listeners.size === 1) {
                    void load();
                    timer = setInterval(() => { void load(); }, 20000);
                }
                return () => {
                    listeners.delete(listener);
                    if (listeners.size === 0 && timer !== undefined) {
                        clearInterval(timer);
                        timer = undefined;
                    }
                };
            }
            function useStatus() {
                const [state, setState] = React.useState(undefined);
                React.useEffect(() => subscribe(setState), []);
                return state;
            }

            // ---------- 表面 1：设置页（settings.section，list，id）----------
            // owner props = { close: () => void }  （runner:5779）
            function SettingsSection(props) {
                const status = useStatus();
                const t = props.t;
                return h('div', { style: { padding: '12px', fontSize: '13px' } },
                    h('div', { style: { fontWeight: 600, marginBottom: '8px' } }, t('cardTitle')),
                    h('div', null, status === undefined
                        ? t('loading')
                        : t('pill', { state: status.state ?? t('pillIdle') })),
                    h('button', {
                        type: 'button',
                        onClick: () => props.close(),   // 唯一的 shell affordance
                        style: { marginTop: '12px' },
                    }, t('close')),
                );
            }

            // ---------- 表面 2：输入框左侧胶囊（conversation.input.left，list，id）----------
            // owner props = {}；standard props 含 useInput/inputActions/sessionId/useProjection
            function CreditPill(props) {
                const status = useStatus();
                const t = props.t;
                const [open, setOpen] = React.useState(false);
                const state = status === undefined ? '…' : String(status.state ?? t('pillIdle'));
                return h('div', { style: { position: 'relative', display: 'inline-flex' } },
                    h('button', {
                        type: 'button',
                        'data-lingxi-pill': true,
                        onClick: () => setOpen((v) => !v),
                        style: { appearance: 'none', border: '1px solid var(--dsh-panel-border, currentColor)',
                                 borderRadius: '999px', padding: '2px 10px', fontSize: '12px', cursor: 'pointer' },
                    }, t('pill', { state })),
                    open ? h('div', {
                        // 固定定位浮层必须 portal 到 document.body —— 见 conversation.input.left 的 doc
                        style: { position: 'fixed', zIndex: 9999, marginTop: '24px', padding: '8px 12px',
                                 background: 'var(--dsh-panel-bg, Canvas)', border: '1px solid var(--dsh-panel-border, currentColor)',
                                 borderRadius: '8px', fontSize: '12px' },
                    }, state) : null,
                );
            }

            // ---------- 表面 3：插件详情页（plugins.bundle.config，keyed，key=包名）----------
            // owner props = { view: 'summary' | 'page', form?: ConfigPageForm }  （runner:4929）
            function PluginPage(props) {
                const status = useStatus();
                const t = props.t;
                const state = status === undefined ? t('loading') : String(status.state ?? t('pillIdle'));

                if (props.view === 'summary') {
                    // summary：一行纯文本/内联节点，插件列表卡片上显示
                    return h('span', { 'data-lingxi-summary': true, }, t('summary', { state }));
                }
                // page：完整表单/卡片
                return h('div', { 'data-lingxi-card': true, style: { padding: '12px', fontSize: '13px' } },
                    h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, t('cardTitle')),
                    h('div', null, state),
                );
            }

            return {
                // Cordis 服务名（不是包名）：slots 来自 ui-renderer，locale 来自 client-locale
                inject: ['slots', 'locale'],
                apply(ctx) {
                    // ---- locale：返回 disposer，必须交给 ctx.effect ----
                    ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), `${BUNDLE_NAME}: locale`);
                    const t = ctx.locale.bind(NAMESPACE);

                    // ---- 设置页 + 导航图标：同一个 inject 回调里注册，成组随声明生灭 ----
                    ctx.slots.inject('settings.section', () => {
                        const disposers = [];
                        try {
                            disposers.push(ctx.slots.register({
                                name: 'settings.section',
                                id: 'lingxi',                 // list 槽位：用 id
                                order: 60,
                                label: () => t('nav'),
                                locale: NAMESPACE,            // 声明后框架自动注入 props.t
                            }, SettingsSection));

                            // 图标：id 必须与 section 相同，否则永不渲染
                            try {
                                disposers.push(ctx.slots.inject('settings.section.icon', () =>
                                    ctx.slots.register({
                                        name: 'settings.section.icon',
                                        id: 'lingxi',         // 必须 === section 的 id
                                        locale: NAMESPACE,
                                    }, (iconProps) => h('span', {
                                        style: {
                                            display: 'block',
                                            width: `${typeof iconProps?.size === 'number' ? iconProps.size : 16}px`,
                                            height: `${typeof iconProps?.size === 'number' ? iconProps.size : 16}px`,
                                            borderRadius: '4px',
                                            background: 'currentColor',
                                            opacity: iconProps?.active === false ? 0.75 : 1,
                                        },
                                    }))));
                            } catch (error) {
                                console.error(`[${BUNDLE_NAME}] settings icon failed (page unaffected):`, error);
                            }
                        } catch (error) {
                            for (const dispose of disposers) { try { dispose(); } catch {} }
                            throw error;
                        }
                        // 一个合并的 disposer：collapse 时同时撤下页面和图标
                        return () => {
                            for (const dispose of disposers) { try { dispose(); } catch {} }
                        };
                    });

                    // ---- 输入框左侧胶囊 ----
                    // 该槽位由 'conversation.composer.bar' 的一个 entry 声明，
                    // 无 Session / hero 形态时不存在 —— inject 会静默等待，不报错。
                    ctx.slots.inject('conversation.input.left', () =>
                        ctx.slots.register({
                            name: 'conversation.input.left',
                            id: 'lingxi-pill',            // list 槽位：用 id
                            order: 20,
                            locale: NAMESPACE,
                        }, CreditPill));

                    // ---- 插件详情页 ----
                    // keyed 槽位：key = 本包包名，必须与 load({ id }) / package name 一致。
                    ctx.slots.inject('plugins.bundle.config', () =>
                        ctx.slots.register({
                            name: 'plugins.bundle.config',
                            key: BUNDLE_NAME,             // keyed 槽位：用 key，不是 id
                            locale: NAMESPACE,
                        }, PluginPage));
                },
            };
        },
    });
})();
```

**`locale/zh.json` / `locale/en.json`（包元信息，供插件管理页显示）：**

```json
{
  "meta": {
    "title": "DSH Connect 灵犀",
    "description": "把灵犀接入 DSH：在输入框左侧显示连接状态，并在设置页与插件详情页提供配置。"
  }
}
```

**宿主侧 `lib/index.js` 的最小路由（供 `STATUS_PATH` 用）：**

```js
export const inject = ['webServer'];

export function apply(ctx) {
    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-connect-lingxi/status',
        handler: async (req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ state: 'ok' }));
        },
    }), 'lingxi: status route');
}
```

> 若要在没有 webServer 的组成里也安全（桌面 `file://` 壳），用 `ctx.inject(['webServer'], (webCtx) => { webCtx.effect(...) })`，见 §4。

---

## 7. 没查到 / 不确定的项（不编）

| # | 项 | 状态 | 说明 |
|---|---|---|---|
| 1 | `@deepseek-ai/dsh-client-ui-slots` 的 `README.zh.md` 与 `lib/types/*.d.ts` | **不存在** | 该包不在 asar 内（`ls` 两次均 `count=0`）。类型只能从 `dsh-cordis-client-runner/lib/client.js` 内联的 `declaration:` 字符串读，那是权威副本但非独立 d.ts。 |
| 2 | `BaseOptions` 的完整定义 | **未确证** | 产物里 **无独立 declaration**（`grep 'interface BaseOptions'` → `NONE`），只能从 `SlotCore.register` 的引用 + `StoredEntry.options` 反推字段集。 |
| 3 | `PLATFORM_MODULES` 完整 seed 名单 | **未确证** | 定义在 shell/web 包，asar 内 grep 不到该常量。已确证可用：`react`、`react-dom`、`react/jsx-runtime`。 |
| 4 | `settings.plugin.item` 槽位 | **不存在** | 全 asar grep → **0 命中**。最接近的是 `plugins.item`（插件页官方插件卡，list/id）与 `settings.plugins.tab`。 |
| 5 | `plugins.bundle.config` 的 `capabilities` prop | **不存在** | owner props 只有 `{ view, form? }`（目录 `:4929` 原文）。 |
| 6 | `surface` 字段的框架语义 | **不是框架字段** | `StoredEntry` 无此字段；两家实测插件用了不同值（`"settings"` / `"section"`）且都能跑。 |
| 7 | `immediately` 与 combo 相位的精确映射 | **未确证** | 只确证它进了启动图 row 字段（`index.js:466`），具体排期在 `buildBatch`/`EntryTree` 侧未逐行验证。 |
| 8 | `register` 的 `priority` 默认值与 `single` 冲突的确切错误文本 | **部分确证** | 默认 0 由 workbuddy 注释引用官方错误串「already has a registration at priority 0 — register at a different priority to shadow it (lowest renders)」；`SlotCore` 里对应的 throw 语句未定位到确切行。 |
| 9 | `webServer` 的 `kind` 是否有第三个值 | **未确证（倾向无）** | 实现是 `route.kind === "exact" ? this.exact : this.prefixes` 二分，但类型层是否只允许 `'exact'|'prefix'` 未在 d.ts 中读到（`host-webserver/lib/types` 未在 asar 内）。 |
| 10 | `dsh-client-ui-renderer` 里 `slots` 服务的 `Service.provide` 声明 | **未确证** | grep 到 `installLocale`（`:1450`）与 23 处 service 相关行，但没找到 `service('slots')` 的确切注册点；`ctx.slots` 的可用性由实测插件 `inject: ['slots']` 反证存在。 |
| 11 | `ctx.slots.register` 的 `select` 字段用法 | **未确证** | `StoredEntry.select` 存在于类型，但目录里 `chain` 槽位才用它，目标七槽位均未涉及。 |

---

## 附录：证据文件索引

| 简称 | 完整路径 |
|---|---|
| `renderer-client.js` | `dsh/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js`（asar 内） |
| `runner/lib/client.js` | `dsh/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js`（asar 内，槽位目录 + 类型副本） |
| `client-modules/lib/client.js` | `dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js`（asar 内，浏览器半侧） |
| `client-modules/lib/index.js` | `dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js`（asar 内，宿主半侧 + 校验器） |
| `client-locale/lib/client.js` | `dsh/node_modules/@deepseek-ai/dsh-client-locale/lib/client.js`（asar 内） |
| `host-webserver/lib/index.js` | `dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js`（asar 内） |
| `minimax` | `~/.dsh/profiles/desktop/node_modules/dsh-connect-minimaxcode/lib/client.js`（实测，578 行） |
| `workbuddy` | `~/.dsh/profiles/desktop/node_modules/dsh-connect-workbuddy/lib/client.js`（实测，16943 行） |
| `trae` | `~/.dsh/profiles/desktop/node_modules/dsh-connect-trae/lib/client.js`（实测，10523 行） |
