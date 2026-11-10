# 0.0.7：勾选框真的生效了（补发 `llm/models-updated`）

> 0.0.6 加了逐模型勾选框，但勾完**选择器里什么都没变**。截图取证时更明显：选择器里
> 还列着「自动推荐 (Auto)」「DeepSeek V4 Flash」—— 那是**静态兜底表**里的条目，
> 账号目录里根本没有它们。
>
> 状态本身是对的：`/status` 与 `dsh-connect-lingxi-state.json` 都显示 11 个模型已禁用。
> 错的是**没有通知宿主**。

## 根因

DSH 的模型选择器**不是每次打开都问一次 Host**。它把整个目录按 **Host 代次**缓存在
`ModelCatalogDirectory` 里，只有收到 `llm/models-updated` 才重拉：

```js
// dsh-client-ui-model-selection/lib/client.js
ctx.remote.$on('llm/models-updated', () => { this.catalog.refresh(); });
```

本插件从 0.0.4 起只注册了 `registerAdapter` / `registerModelDiscovery`，**从来没发过
这个事件**。于是：

```
勾选框 → POST /action?action=settings → 写状态文件 → ✅ 成功
                                                    ↓
                                        选择器：没收到事件，继续用页面加载时那份目录
```

用户看到的就是「勾了没反应」。同理，启动后 `refreshCatalog()` 拉到真实目录时也没发事件，
所以选择器可能一直停在静态兜底表上 —— 这正是截图里 Auto / V4 Flash 的来源。

## 这一版改了什么

| 改动 | 位置 | 说明 |
| --- | --- | --- |
| `publishCatalog()` | `src/index.ts` | **先** `adapter.invalidate()`（重建 provider 模型表），**再** `ctx.emit('llm/models-updated', PROVIDER)` |
| 三个名单变化时发 | 同上 | `disabledModels` / `imageOffModels` / `imageOnModels` 任一变化都发 |
| 上游目录变化时发 | 同上 | `refreshCatalog()` 成功拉到目录后也发 |
| 纯界面开关不发 | 同上 | 胶囊 / 侧栏 / 刷新间隔不影响目录，让选择器无谓重拉是浪费 |
| 事件测试 | `test/apply.test.ts` | 走真实 `/action` 路由：模型写入恰好 1 次事件、带 provider；界面写入 0 次 |

顺序不能反：先发事件后重建快照，浏览器会拉到重建前的旧表。

## 顺带修掉一个测试隔离缺陷（这条比上面更该记住）

`apply()` 会读写 `$DSH_HOME/dsh-connect-lingxi-state.json` —— 那是**用户的状态文件**。
跑一次测试，用户关掉的 11 个模型被冲成 1 个，`composerPill` 也被改成 `false`。

`test/state.test.ts` 一直是隔离的（临时 `DSH_HOME`），但 `test/apply.test.ts` 没有。
现在每个 apply 用例都跑在临时 `DSH_HOME` 里并在结束时还原：

```ts
function testIsolated(name: string, body: () => Promise<void>): void {
  test(name, async () => {
    const restore = await isolateState();   // 建临时 DSH_HOME
    try { await body(); } finally { restore(); }
  });
}
```

用户的状态文件已按原值恢复（11 个禁用、`composerPill: true`）。

## 验证

```bash
node scripts/gate.mjs
```

七道全过；测试 **172 条**（apply 新增 1 条，覆盖事件；其余不变）。

## 怎么确认修好了

重启 DSH 后打开模型选择器：只应看到 `/status` 里 `enabled: true` 的那几个模型。
再勾掉一个，**不刷新页面**，选择器里的那一项应当立刻消失。
