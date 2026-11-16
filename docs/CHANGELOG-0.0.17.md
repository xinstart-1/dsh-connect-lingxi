# 0.0.17：输入框胶囊消失的排查通道

这一版不改业务行为，只做两件事：**把胶囊的静默失败变成可读的诊断**，以及
**把「读不到投影」从「藏起来」改成「照常显示」**。

## 症状

输入框里那颗「WPS 灵犀 · 3000 智点」胶囊不见了，而模型选择器照常显示
（`DeepSeek V4.1 Flash · ~0.12x`，正是本插件的 provider）。

## 为什么之前查不出来

胶囊的注册在 `apply()` 里排在 `main` / `plugins.bundle.config` **之后**：
`apply` 中途抛异常，前面几项已经注册好、界面照常，胶囊那一行则**根本不会执行**。
而 `ctx.slots.inject` 的回调是晚执行的、异常会被宿主重新抛到渲染器之外，
宿主控制台的那条堆栈也不归我们看。结果就是三种完全不同的原因在界面上是同一个
「什么都没有」：

1. 客户端模块没加载（宿主没执行到 `apply`）；
2. 加载了，但 `apply` 中途抛异常，后面的注册没跑到；
3. 注册了，但门控把组件挡住了，或者渲染时崩溃。

## 这一版做了什么

- **诊断上报**：浏览器半侧在模块入口、`apply` 开始/结束、每次槽位注入、
  门控判定、胶囊挂载、渲染异常处各报一条事件到宿主（`POST /action?action=client-report`，
  同一事件 60 秒内只报一次）。
- **宿主侧的观察**：新增只读路由 `GET /plugins/dsh-connect-lingxi/diag`，返回
  客户端上报过的事件，以及宿主客户端模块表里**本插件条目**（在不在图里、rev、
  url）和**它读到的那份客户端文件**（字节数、mtime、是否含 `conversation.input.right`
  注册）。这一步把「加载侧」和「执行侧」切开。
- **门控失败打开**：读 `modelSelection` 投影抛异常时，上报 `gate-error` 后
  按「不知道」处理、照常显示胶囊 —— 与既有的「宿主没给投影就照常显示」一致。
- **错误边界**：胶囊外面包一层 `PillBoundary`，渲染异常时报一条并只吞掉这一格，
  不再让整个槽位静默变空。

## 怎么用

1. 重启 DSH（宿主半侧新增了 `/diag`，需要重新加载 `lib/`）。
2. 打开有输入框的页面（刷新一次）。
3. `curl http://127.0.0.1:<端口>/plugins/dsh-connect-lingxi/diag` —— 看
   `clientModules.file.registersInputRight` 与 `client.reports` 的顺序：
   - 没有 `module` 事件 → 客户端模块没执行到（加载侧）；
   - 有 `module`、没有 `apply-done` → `apply` 中途抛了；
   - 有 `gate` 且 `provider=wps-lingxi`、没有 `pill-mounted` → 门控过了但渲染崩了；
   - 有 `pill-mounted` → 胶囊画出来了但没显示（样式/位置问题）。
4. 设置页「诊断」多一行**输入框胶囊**：直接写当前 provider 以及胶囊是
   「显示中」还是「已隐藏（当前 provider 不是灵犀的模型）」。

## 顺带查清的事：胶囊按设计会随 provider 隐藏

门控从 0.0.4 起就在：**只有当这个会话里 `modelSelection` 落到的 provider 是
`wps-lingxi` 时**，灵犀的智点胶囊才显示 —— 选了别的连接器（例如同一台机器上
`dsh-connect-raccoon` 的模型）还显示灵犀余额，是一句看起来像事实的错误陈述。

用 0.0.17 的诊断实测：同一个宿主里两个会话各画一个输入框，一个会话选的是灵犀的
`deepseek-v4.1-flash`（`gate → wps-lingxi`，紧接着 `pill-mounted total=3000`），
另一个选的是 raccoon 的 `sn-deepseek-v4-1-flash-1017`（`gate → raccoon`，不出胶囊）。
两个连接器的模型名在界面里都长成 `DeepSeek V4.1 Flash · ~0.12x`，**光看名字分不出
是哪个 provider**，要以模型选择器里的分组为准。所以这不是胶囊坏了，是「这个会话
的请求不归灵犀结算」。
