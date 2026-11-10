# 0.0.11：修掉发图报错 `pi-ai image input requires the durable attachment service`

> 报错截图：`UNSUPPORTED_CONTENT` · `pi-ai image input requires the durable attachment service`
>
> 直接原因是 0.0.10 把模型标成支持图片（`input: ['text','image']`），
> 但 adapter 从来没有接过宿主的附件服务 —— 用户一发图就撞上这道检查。

## 根因（一行代码）

`dsh-llm-pi-ai` 在发请求前有这么一道闸：

```js
const attachments = containsImage ? this.config.resolveAttachments?.() : void 0;
if (containsImage && attachments === void 0)
  throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT');
```

我们的 `PiAiAdapter` 配置里只有三样：

```ts
const config: PiAiAdapterOptions = {
  profiles: () => profiles,
  auth: INERT_AUTH,
  resolveApiKey: async () => options.token(),
};
```

**没有 `resolveAttachments`，也没有 `resolveImageAccess`。** 于是只要消息里出现图片，
必然抛这个错 —— 跟模型、跟上游、跟账号都无关。

## 宿主本来就提供了这个服务

`dsh-llm-pi-ai` 自己是这么接的（同一个文件，2951 行）：

```js
resolveAttachments: () => ctx.get('attachments'),
resolveImageAccess: (attachments, ref) =>
  resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
```

所以我们不需要新增任何依赖，照抄这个接法即可。

## 改了什么

| 改动 | 位置 |
| --- | --- |
| adapter 新增 `attachments` / `processPath` 选项 | `src/llm/adapter.ts` |
| 接上 `resolveAttachments` + `resolveImageAccess` | 同上 |
| 插件把 `ctx.get('attachments')` / `ctx.get('fs')` 传进去 | `src/index.ts` |
| `AttachmentStore` 类型从函数签名反推（不新增 peer dep） | `src/llm/adapter.ts` |
| 测试：接上、以及「服务晚到也能拿到」 | `test/apply.test.ts` |

## 一个关键细节：必须每次调用时现取服务

第一版我写成在 `apply()` 时就判断服务在不在：

```ts
...(ctx.get('attachments') === undefined ? {} : { attachments: ... })  // ✗ 错的
```

这是错的。Cordis 的服务是动态的，宿主可能**在本插件装配之后**才装上
`attachments`。在 apply 那一刻判空，等于永久放弃图片能力。

正确做法是只传 getter，每次调用时现取：

```ts
attachments: () => ctx.get('attachments')   // ✓
```

测试 `attachments 在调用时才解析：晚于 apply 注册的服务也能拿到` 专门钉住这一点：
先断言 apply 后取到 `undefined`，再把服务挂上去，断言同一个 getter 立刻返回它。

## 还需要你验证一件事

`shim` 与上游协议层**没有图片内容的转换代码**。我们的 shim 是把 OpenAI messages
原样透传（`WireMessage = Record<string, unknown>`），所以 `image_url` 会原样发到
上游。上游是否接受这个格式，**我没有验证过，也不打算靠猜**：

- 如果上游接受，这次修复就够了；
- 如果上游要别的格式，会返回明确的错误码，那时再按错误码改。

所以请修完后再发一张图试一次：

- 成功 → 说明格式本来就对，问题全在 `resolveAttachments`；
- 失败 → 把新的报错截图给我，那才是真正的格式问题。

## 验证

```bash
node scripts/gate.mjs
```

七道全过，测试 **205 条**（apply 13）。
