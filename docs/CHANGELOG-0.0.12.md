# 0.0.12：账号池（照 `dsh-connect-workbuddy` 的做法）+ 修掉发图报错

这一版做两件事：

1. **修掉你截图里的报错** —— `UNSUPPORTED_CONTENT` · `pi-ai image input requires the durable attachment service`
2. **实现账号池** —— 多个灵犀账号各存一份，卡片上点一下就切换

---

## 一、发图报错（先说这个，因为它挡着你用）

### 根因

`dsh-llm-pi-ai` 在发请求前有一道闸：

```js
const attachments = containsImage ? this.config.resolveAttachments?.() : void 0;
if (containsImage && attachments === void 0)
  throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT');
```

我们的 `PiAiAdapter` 只配了三样（`profiles` / `auth` / `resolveApiKey`），**没有 `resolveAttachments`**。
而 0.0.10 又把模型标成支持图片（`input: ['text','image']`），于是只要消息里出现图片，
必然抛这个错 —— 跟模型、跟上游、跟账号都无关。

### 修复

宿主本来就提供了这个服务，`dsh-llm-pi-ai` 自己是这么接的：

```js
resolveAttachments: () => ctx.get('attachments'),
resolveImageAccess: (a, ref) => resolveImageAttachmentAccess(a, p => ctx.get('fs')?.processPathFromHostPath(p), ref)
```

我们照抄这个接法，没有新增任何依赖（`AttachmentStore` 类型从函数签名反推）。

**一个关键细节**：服务必须**每次调用时现取**，不能在 `apply()` 时判空。
Cordis 的服务是动态的，宿主可能在本插件装配之后才装上 `attachments` ——
apply 那一刻判空等于永久放弃图片能力。测试
`attachments 在调用时才解析：晚于 apply 注册的服务也能拿到` 专门钉住这一点。

### 还没验证的事

我们的 shim 是把 OpenAI messages **原样透传**的，所以 `image_url` 会原样发到上游。
**上游是否接受这个格式，我没有验证过**，也不打算靠猜：

- 如果上游接受 → 这次修复就够了
- 如果上游要别的格式 → 它会返回明确的错误码，那时按错误码改

---

## 二、账号池

### 照的是 workbuddy 的哪几点

读 `dsh-connect-workbuddy` 的实现后，抽出来的可借鉴部分：

| 机制 | workbuddy 的做法 | 我们的做法 |
| --- | --- | --- |
| 存储布局 | `workbuddy-vault/<region>/<accountId>.json`，**一个账号一个文件** | `lingxi-vault/accounts/<accountId>.json` |
| 账号 id | 由账号内容派生（`workbuddyAccountId`） | 由 cookie 的 `uid` 派生，没有则用 cookie 哈希 |
| 当前选择 | 单独的 `accountId` 字段，**与凭据分开存** | 单独的 `selected.json` |
| 运行时轮换 | `rotatedAccountId`，**从不持久化、从不改用户选择** | 暂未实现（见下方「没做的」） |
| 选择失效 | `selectionLost()` 单独报告，不静默回退 | 同 |
| 目录 ACL | 收紧 vault **根**、绝不碰 home | 同（并踩过同一个坑，见下） |

### 为什么必须一个账号一个文件

两个账号轮流登录时，写同一个文件会互相覆盖 —— 账号池就永远只有一个成员。
分开存还让「删掉一个账号」不会动到别的账号。

### 为什么账号 id 不能用序号

删掉中间一个账号，后面所有账号的序号都会变，用户「当前选用」的那份就指向了别人。
用 cookie 派生的 id 才稳定：同一个账号重复登录不会变成两个成员
（重新登录会换 `wps_sid`，但 `uid` 不变，所以身份认得出来）。

### 为什么「选择」要单独存

用户的**选择**是设置，账号的**内容**是凭据。混在一个文件里，改选择就得重写凭据，
两个账号同时刷新时会互相覆盖。

### 一个刻意不做的事：不静默回退

用户选中的账号已经不在了，但池里还有别的账号时，`readCredential()` 返回
`undefined`，**不回退到别的账号**。回退会让 shim 用用户没选过的账号发请求，
而卡片上还标着另一个 —— 那是最难查的一类问题。

卡片改为明确说明「你之前选中的账号已经不在这台机器上了，请重新选一个」，
而不是笼统地让人重新登录（他的凭据通常是好的，重新登录也修不好一个孤儿 id）。

### 升级兼容

旧版单账号文件 `lingxi-vault/credential.json` 仍被读成账号池成员。
不这么做的话，用户升级插件后会看到「未登录」——等于把人踢下线。
已在你机器上验证：现有登录态被识别为 `uid-895137935`。

---

## 三、踩到的坑：`icacls` 把目录权限剥空了

第一版把账号池目录收紧成 `${user}:(OI)(CI)F`，结果**当前进程自己也写不进去**，
测试全是 `EPERM`，连临时目录都删不掉。

原因：`(OI)(CI)` 是「对象继承 / 容器继承」，**只对子项生效**，目录自己拿不到权限。
配合 `/inheritance:r` 把继承 ACE 全剥掉之后，这个目录的 ACL 就是空的。

修复：显式给目录自己 `(F)`，继承标记单列：

```
icacls <dir> /inheritance:r /grant:r "<user>:(F)" /grant:r "<user>:(OI)(CI)(IO)(F)"
```

这与 workbuddy 的 issue #208 是同一类问题的两个面（它那边是收紧到了 home 本身，
导致 `attachments` 不可读）。所以这里也加了保护：**绝不收紧 DSH home 或其祖先**。

---

## 四、改了什么

| 改动 | 位置 |
| --- | --- |
| 接上宿主的附件服务（修发图报错） | `src/llm/adapter.ts`、`src/index.ts` |
| 仓库改为账号池：一个账号一个文件 + 独立的选中标记 | `src/credentials/vault.ts`（重写） |
| 账号池视图（脱敏，不含 cookie） | `src/host/status.ts`、`src/host/runtime.ts` |
| `switch-account` 动作 | `src/host/routes.ts`、`src/host/runtime.ts` |
| 卡片账号池 UI（点行切换） | `src/client/bundle.js` |
| 测试 | `test/vault.test.ts` 重写 21 条、`test/apply.test.ts` +2、`test/model-ui.test.ts` +4 |

## 五、没做的（明确说明，不留悬念）

1. **冷却与自动轮换**：workbuddy 会在某个账号被限流后自动切到下一个。
   灵犀这边**我还没见过被限流的真实响应**，不知道它长什么样、用什么错误码。
   没有真实响应就写轮换逻辑，只能靠猜 —— 猜出来的代码在真限流时不一定生效，
   反而会掩盖问题。所以这一版只做**手动切换**，自动轮换等拿到真实限流响应再说。
2. **账号名**：上游 `/account/profile` 能拿到名字，但当前登录流程没把它取回来，
   所以卡片上暂时显示 `uid-xxxx`。取名字要多打一次接口，这一版没做。

## 六、验证

```bash
node scripts/gate.mjs
```

七道全过，测试 **224 条**（vault 21、apply 13、model-ui 9）。

你机器上的实测：

```
账号数: 1
 - uid-895137935 | (无名) | login
当前: uid-895137935
显式选择: 无
选择失效: false
```

旧格式文件被正确识别成账号池成员。

## 七、下一步

重启 DSH，然后在卡片「账号」页：

1. 点「登录灵犀」再登一个**不同**的账号 → 账号池会出现两行
2. 点第二行 → 立刻切换，余额与模型目录都跟着变
3. 发一张图片 → 应该不再报 `UNSUPPORTED_CONTENT`

第 3 步如果还报错，把新报错截图给我（那会是真正的图片格式问题，与这次的修复无关）。
