# 0.0.10：按真实上游响应逐字段校准模型目录（含思考档位）

> 0.0.9 的「与官网同步」只对了清单、顺序、倍率、徽标 —— 数据来源是**截图**。
> 这一版登录后抓了一次真实的 `/sessions/plans`，逐字段核对，发现 **5 类偏差**，
> 其中两类是 0.0.9 自己改错的。

## 核对方法（可复现）

```bash
node scripts/capture-plans.mjs
```

新脚本只读，把每个条目的全部字段打出来并落成
`.scratch/plans-normalized.json`。`STATIC_CATALOG` 现在逐字段来自这份输出，
并有 `.scratch/verify-parity.mjs` 做逐字段比对（含顺序），结果为「完全一致」。

## 五类偏差

### 1. `maxTokens` 全错（最严重）

上游字段是 `max_new_tokens`，各模型差别极大：

| 模型 | 上游真实值 | 0.0.9 写的 | 偏差 |
| --- | --- | --- | --- |
| `kimi-k3` | 1048576 | 65536 | 少了 16 倍 |
| `kimi-k3.1-pro` | 1048576 | 65536 | 少了 16 倍 |
| `minimax_m3` | 524288 | 65536 | 少了 8 倍 |
| `deepseek-v4.1-flash` | 393216 | 65536 | 少了 6 倍 |
| `deepseek-v4-pro-0813` | 393216 | 65536 | 少了 6 倍 |
| `doubao_seed_2_1_pro_260628` | 262144 | 32768 | 少了 8 倍 |
| 其余 5 个模型 | 131072 | 65536 | 少了一半 |
| `plan_pro` / `plan_max` | 131072 | 65536 | 少了一半 |

旧值 65536 是把输出上限砍到实际值的 1/6。DSH 用它算请求预算，这个错会
**直接导致长回复被截断**。

### 2. 思考能力判断错了（4 个模型）

旧代码 `reasoning: kind === 'plan' ? true : true` —— 三元两边都是 `true`，
等于写死「所有模型都支持思考」。实测上游对以下 4 个**不给** `reasoning_efforts`：

- `mimo-v2.6-pro`
- `minimax_m3`
- `plan_pro`
- `plan_max`

它们没有思考档，旧代码会给它们凭空造出一个点了没用的开关。

现在改为：**有 `reasoning_efforts` 声明才是思考模型**。

### 3. 思考档位全开（7 档 vs 3 档）

上游给 9 个思考模型都是 `["low","high","max"]`（低 / 高 / 超高）。
旧 adapter 把 pi-ai 的七档全部映射成自身，用户能选到官网没有的档位，
而且 `medium` 被静默替换成 `high`（选了「中」实际发「高」）。

新增 `src/llm/thinking.ts`：按上游声明生成 `thinkingLevelMap`，
**没声明的档位显式写 `null`（不提供）**，而不是靠 pi-ai 的默认规则 ——
它对五个基础档和 `xhigh`/`max` 的缺键语义是相反的，靠默认值一定会错。

现在 9 个思考模型各露出 3 档，4 个非思考模型没有开关。

### 4. 倍率里的全角波浪号

上游混用三种字形：ASCII `~`（U+007E）、全角 `～`（U+FF5E）、日文 `〜`（U+301C）。
不归一的话同一列里会出现两种字形。解析时统一成 ASCII `~`。

### 5. 徽标字段名是 `tag`

上游用 `tag`，不是 `badge`。解析层本来就三种都认（`badge`/`tag`/`label`），
所以这条 0.0.9 是对的 —— 记在这里是为了以后别改回只认一个名字。

## 一个顺带确认的事实

上游 `desc` 对所有**模型**都是空字符串，只有两个**模式**有说明
（“适用于日常任务，智点消耗较少” / “为复杂任务设计，智点消耗较多”）。
模型的那句介绍在 `intro` 字段里（“已更新为 1017 最新版本…”）。
按你的要求**不做悬浮说明**，所以只取 `desc`，不取 `intro`。

## 改了什么

| 改动 | 位置 |
| --- | --- |
| `STATIC_CATALOG` 逐字段按真实响应重写（13 项，含顺序） | `src/protocol/catalog.ts` |
| `reasoning` 以上游 `reasoning_efforts` 声明为准 | 同上 |
| 倍率波浪号归一 | 同上 |
| `maxTokens` 兜底值 65536 → 131072 | 同上 |
| 思考档位按声明生成（新） | `src/llm/thinking.ts` |
| adapter 用新档位逻辑 | `src/llm/adapter.ts` |
| 抓取脚本（新，可复现核对） | `scripts/capture-plans.mjs` |
| 测试 | `test/catalog.test.ts` +3、`test/thinking.test.ts` 新增 8 |

## 验证

```bash
node scripts/gate.mjs          # 七道全过
node scripts/capture-plans.mjs # 重新抓一次，与静态表对照
```

测试 **204 条**（catalog 13、thinking 8）。

逐字段比对结果：

```
静态表条数 13 | 上游条数 13
✓ 逐字段完全一致（含顺序）
```

档位核对结果：

```
deepseek-v4.1-flash            露出的档位: low/high/max
mimo-v2.6-pro                  无思考档（非思考模型）
plan_pro                       无思考档（非思考模型）
```

## 需要你注意的一点

DSH 的思考档名称是固定的英文（Off/Minimal/Low/Medium/High/XHigh/Max），
**无法显示成中文「低 / 高 / 超高」**。这是 DSH 的界面契约，插件改不了。
现在做到的是**档位数量与含义**与官网一致（3 档：low/high/max）。
