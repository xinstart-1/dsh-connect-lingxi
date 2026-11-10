# 0.0.6：模型页可以勾选了（启用 / 图片），不用再去「设置 → 模型」

> 0.0.5 的模型页是一张**只读清单**：它列出名称、倍率、上下文和「思考 / 图片」两枚标签，
> 但一个都不能改。想停用一个模型、或者把某个模型设成不收图片，只能去 DSH 自己的
> 「设置 → 模型」里翻表单 —— 那是 `declared: false` 的动态目录，改一次要过
> 「保存 → 重载插件」，而这里要的是「点一下立刻生效」。
>
> 这一版照 `dsh-connect-workbuddy` 的模型页补上两个勾选框：**启用**（决定它出不出现在
> DSH 的模型选择器里）与**图片**（决定它能不能接收图片输入）。

## 这一版改了什么

| 改动 | 位置 | 说明 |
| --- | --- | --- |
| 启用勾选框 | `src/client/bundle.js` | 行首。关掉 → 该模型从 `registerModelDiscovery` 的返回里消失，选择器里就没有它 |
| 图片勾选框 | 同上 | 行尾。控制该模型 `inputModalities` 里有没有 `image` |
| 「最后一个不许关」 | 同上 + `src/host/runtime.ts` | 界面上最后一行禁用，宿主侧再挡一次（状态可能比界面新） |
| 生效值统一 | `src/host/model-flags.ts`（新） | 图片开关的**唯一判定处**：用户关 > 用户开 > 上游声明 |
| 状态字段 | `src/state.ts` | 新增 `imageOffModels` / `imageOnModels` 两张名单 |
| 状态文档 | `src/host/status.ts` | `StatusModel` 新增 `visionNative`；`vision` 改成**生效后**的值 |
| 动作白名单 | `src/host/runtime.ts` | `settings` 动作接受两张新名单 |
| 规则测试 | `test/model-flags.test.ts`（新） | 7 条：优先级、冲突、对象身份、目录出口 |
| 渲染测试 | `test/model-ui.test.ts`（新） | 5 条：勾选框在不在、点一下 POST 的 body 对不对、最后一行禁用 |

## 三个判断，以及为什么

### 1. 图片开关存「两张相对名单」，不存一份绝对名单

`imageOffModels` 记「上游声明支持、但用户不要的」；`imageOnModels` 记「上游没声明、
用户自己确认能用的」。两张都只记录**与上游默认不同**的那一侧：

```
上游以后给某个模型加上多模态 → 默认值自动跟上，不会卡在旧快照里
用户勾回「和上游一样」        → 两张名单都清掉，默认值重新接管
```

存一份绝对名单（「哪些模型收图片」）会把当前目录钉死：上游新增的能力要等用户
重新点一遍才生效，而上游去掉的能力会留下一个永远勾着的框。

冲突时**「关」胜出**（`normalizeState` 里就按这个规则去重）：否则勾选框显示「开」
而实际生效的是「关」，是那种看起来像事实的错误陈述。

### 2. 规则只写一份：`host/model-flags.ts`

同一个问题在三处被问 —— DSH 的模型选择器（`inputModalities`）、`/status` 文档
（卡片上的勾选框）、adapter 的模型表（`Model.input`）。三处各写一遍 `??` 就是三次
机会让它们互相矛盾。所以规则独立成一个模块，三处都调它：

```ts
imageEnabled(model, state)  // 用户关 > 用户开 > 上游声明
visibleModels(models, state) // 过滤禁用名单 + 把图片开关落到 vision 上
```

`withImageFlag` 在没变化时返回**同一引用**：pi-ai 的 provider 快照按身份判断
「配置有没有变」，每次返回新对象会让它以为一直在变。

### 3. 「最后一个不许关」要挡两次

界面上最后一行禁用是**显示层**的保证；但 `/status` 可能是几分钟前的（另一个窗口刚关掉
一个模型），所以 `applySettings` 里再挡一次，并如实说明为什么没改：

```
至少保留一个模型：全关掉之后模型选择器里就没有灵犀了
```

全关掉的后果不是「配置不好看」，是选择器里一个灵犀模型都不剩 —— 用户会以为插件坏了。

## 验证

```bash
node scripts/gate.mjs
```

`typecheck / build / copy-client / check-client / check-claims / prepublish-check / tests`
七道全过；测试 171 条（新增 12 条）。
