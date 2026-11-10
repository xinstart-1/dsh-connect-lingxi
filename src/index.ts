/**
 * Cordis 插件入口：装配 shim、凭证、目录、运行时与 LLM 注册。
 *
 * 装配顺序很重要：shim 必须先起来（adapter 的 baseURL 要用它的端口），
 * 但 adapter 注册不能等网络 —— 目录先用静态兜底，登录态可用时再刷新。
 *
 * 这里的职责只有**接线**：谁先谁后、谁在卸载时释放什么。真正的行为在
 * `host/runtime.ts`（状态与动作）、`shim/server.ts`（协议翻译）、
 * `protocol/`（上游契约）里，各自可单测。
 *
 * @module dsh-connect-lingxi
 */

import type { Context } from '@deepseek-ai/cordis';
import { Config, type LingxiConfig } from './config.ts';
import { BASE, PROVIDER, SETTINGS_NS, VERSION } from './constants.ts';
import { discoverCredential, loginWithBrowser } from './credentials/sources.ts';
import {
  clearCredential,
  listAccounts,
  readAccount,
  readCredential,
  readSelection,
  selectAccount,
  selectionLost,
  writeCredential,
  type StoredCredential,
} from './credentials/vault.ts';
import { registerRoutes } from './host/routes.ts';
import { LingxiRuntime } from './host/runtime.ts';
import type { StatusAccount, StatusAccountPool } from './host/status.ts';
import { visibleModels } from './host/model-flags.ts';
import {
  badgeTone,
  createLingxiAdapter,
  type AttachmentStore,
  type LingxiAdapter,
} from './llm/adapter.ts';
import { LingxiClient } from './protocol/client.ts';
import { STATIC_CATALOG, dedupeModels, type LingxiModel } from './protocol/catalog.ts';
import { normalizeUserCookie } from './protocol/headers.ts';
import { parseBalance } from './protocol/balance.ts';
import { beijingDate, parseTasks } from './protocol/tasks.ts';
import { startShim, type ShimHandle } from './shim/server.ts';
import { readState, writeState, type LingxiPluginState } from './state.ts';

/** 插件名（Cordis 用它做诊断前缀）。 */
export const name = 'dsh-connect-lingxi';

/** 依赖的服务：没有 llm 就没有模型路由可注册。 */
export const inject = ['llm'];

/**
 * 登录态来源。
 *
 * `client` = 本机灵犀客户端；`browser` = 日常浏览器 / 主动登录；
 * `manual` = 用户手填；`none` = 都没有。
 */
interface ResolvedCookie {
  value: string;
  source: 'manual' | 'client' | 'browser' | 'none';
}

/**
 * 插件应用函数。
 * @param ctx - Cordis 上下文。
 * @param rawConfig - 用户在设置页填的配置。
 */
export async function apply(ctx: Context, rawConfig: LingxiConfig): Promise<void> {
  const config = { ...Config({}), ...rawConfig } as LingxiConfig;
  const client = new LingxiClient();
  const warn = (message: string): void => {
    ctx.logger.warn(`[${name}] ${message}`);
  };

  let catalog: LingxiModel[] = [...STATIC_CATALOG];
  let shim: ShimHandle | undefined;
  let lingxi: LingxiAdapter | undefined;
  let disposed = false;

  /** 插件状态（界面开关）。读一次缓存在内存里，写入时同步更新。 */
  let pluginState: LingxiPluginState = await readState();

  /**
   * 逐账号的余额 / 签到缓存（内存，不落盘）。
   *
   * 为什么不落盘：余额是「此刻」的事实，落盘后下次启动会先把过期数字显示出来，
   * 用户会以为那是真的。内存缓存 + 每次打开卡片重拉，比「先显示旧数字再纠正」诚实。
   */
  const poolCredits = new Map<
    string,
    { credits?: number; checkedInToday?: boolean; error?: string }
  >();

  /**
   * 解析登录态。
   *
   * 顺序按「用户成本」从低到高：**手填 > 插件自己的仓库 > 自动探测**。
   * 手填排在最前不是因为它更好，而是因为用户显式填了就该听他的。
   *
   * 仓库排在自动探测**之前**是这一版的关键：仓库里存的是「上一次成功拿到的登录态」，
   * 它跨重载、跨插件更新都在（文件在 `$DSH_HOME` 下，不属于包目录）。排在后面
   * 就等于每次重载都重新去浏览器里碰运气 —— 浏览器一开着锁库，登录态就没了。
   *
   * 自动探测每次调用都读一次：看起来浪费，但它是唯一能让「你刚在浏览器里登录完，
   * 插件立刻就能用」成立的机制；cookie 库是本地 SQLite，比一次网络请求便宜得多。
   */
  const resolveCookie = async (): Promise<ResolvedCookie> => {
    const manual = normalizeUserCookie(config.cookie);
    if (manual !== '') return { value: manual, source: 'manual' };

    // 插件自己的仓库：上一次成功拿到的登录态。读失败/没有都只是「继续往下走」。
    const stored = await readCredential();
    if (stored !== undefined) {
      // `login` 是我们自己拉起浏览器拿到的，对用户来说就是「浏览器登录态」；
      // 只有真正手填的才显示「手动粘贴」。把 login 说成手动，是在骗用户。
      const source: ResolvedCookie['source'] =
        stored.source === 'client'
          ? 'client'
          : stored.source === 'browser' || stored.source === 'login'
            ? 'browser'
            : 'manual';
      return { value: stored.cookie, source };
    }

    if (!config.autoDetectCookie) return { value: '', source: 'none' };
    try {
      const found = await discoverCredential({
        ...(config.clientDataDir === '' ? {} : { desktopDir: config.clientDataDir }),
        allowBrowser: config.useBrowserProfile,
      });
      if (found.credential === undefined) {
        // 「库被运行中的浏览器锁着」与「没登录」必须分开说：前者关掉浏览器就解决，
        // 后者要去登录。静默当成未登录会让用户以为插件坏了。
        if (found.busy) {
          warn('检测到浏览器/客户端正在运行，cookie 库被独占锁定；关掉它即可自动读取登录态。');
        }
        return { value: '', source: 'none' };
      }
      // `browser-login` 与 `browser` 对界面是一回事：都是从浏览器里拿到的。
      const source: ResolvedCookie['source'] =
        found.credential.source === 'desktop' ? 'client' : 'browser';
      // 探测到就存一份：下一次重载不必再赌浏览器有没有锁库。
      await rememberCredential(found.credential.cookie, source, found.credential.name);
      return { value: found.credential.cookie, source };
    } catch (error) {
      warn(`自动探测登录态失败：${error instanceof Error ? error.message : String(error)}`);
      return { value: '', source: 'none' };
    }
  };

  /**
   * 把一份登录态记进插件仓库。
   *
   * 失败只记日志、不上抛：仓库是「下次省一次探测」的优化，不是本次请求的前提。
   * 为了写不进去而让登录失败，是本末倒置。
   */
  const rememberCredential = async (
    cookie: string,
    source: StoredCredential['source'],
    name?: string,
  ): Promise<void> => {
    try {
      await writeCredential({ cookie, source, ...(name === undefined ? {} : { name }) });
    } catch (error) {
      warn(`保存登录态失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /**
   * 主动登录一次：拉起浏览器让用户自己登录，插件只读 cookie。
   *
   * 只在用户点了卡片上的「登录」时走这条路 —— 它会弹浏览器窗口，
   * 不该在后台自动发生。
   */
  const loginWithBrowserNow = async (): Promise<{ ok: boolean; message: string }> => {
    try {
      const credential = await loginWithBrowser({ url: `${BASE}/` });
      // 落进插件自己的仓库：重载、升级、重装都还在（文件在 $DSH_HOME 下）。
      await rememberCredential(credential.cookie, 'login', credential.name);
      client.clearRuns();
      runtime.invalidate();
      lingxi?.invalidate();
      await refreshCatalog();
      return { ok: true, message: '登录成功' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };

  /**
   * 目录条目是否对用户可见、以及图片输入开不开。
   *
   * 禁用名单与逐模型图片开关都来自插件状态（用户在该插件设置页上的勾选）。
   * **过滤在目录出口处做**，而不是在渲染时做：模型选择器读的是
   * `registerModelDiscovery` 的返回值，只要它不返回这个模型，界面上就不可能出现；
   * 同理 `inputModalities` 直接决定 DSH 会不会给这个模型发图片。
   *
   * 规则本身只写一份（`host/model-flags.ts`），这里只是把它接到当前状态上。
   */
  const visibleCatalog = (models: readonly LingxiModel[]): LingxiModel[] =>
    visibleModels(models, pluginState);

  /**
   * 告诉宿主「本 provider 的模型目录变了」。
   *
   * 为什么非发不可：浏览器半边的模型选择器**不是**每次打开都问一次上游，
   * 它把整个目录按 Host 代次缓存在 `ModelCatalogDirectory` 里，只有收到
   * `llm/models-updated` 才 `refresh()`（`dsh-client-ui-model-selection` 的
   * `ctx.remote.$on('llm/models-updated', () => this.catalog.refresh())`）。
   *
   * 少发这一条的表现就是「勾了没反应」：状态文件与 `/status` 都已经改了，
   * 但选择器还在用页面加载时那份目录 —— 用户会认为勾选框是坏的。
   *
   * 顺序要紧：先 `invalidate()` 让 adapter 重建 provider 快照（新模型表），
   * 再发事件让浏览器重拉；反过来浏览器会拉到重建前的旧表。
   */
  const publishCatalog = (): void => {
    lingxi?.invalidate();
    ctx.emit('llm/models-updated', PROVIDER);
  };

  /** 写入状态并让运行时跟着走（刷新间隔可能变了）。 */
  const saveState = async (patch: Partial<LingxiPluginState>): Promise<LingxiPluginState> => {
    pluginState = await writeState(patch);
    runtime.rememberStateSync(pluginState);
    if (patch.pollIntervalMs !== undefined) runtime.restartPolling();
    // 三个名单都会改变「选择器里有哪些模型、哪个模型收图片」，必须让宿主知道。
    const catalogChanged =
      patch.disabledModels !== undefined ||
      patch.imageOffModels !== undefined ||
      patch.imageOnModels !== undefined;
    if (catalogChanged) publishCatalog();
    else lingxi?.invalidate();
    return pluginState;
  };

  /**
   * 登出：只删插件仓库里那份登录态。
   *
   * 顺序要紧：先删文件，再清缓存。反过来会让「缓存已清但文件还在」的中间态
   * 被下一次 `resolveCookie()` 读回来，看起来像登出失败。
   */
  const logoutNow = async (): Promise<{ ok: boolean; message: string }> => {
    try {
      await clearCredential();
      client.clearRuns();
      runtime.invalidate();
      lingxi?.invalidate();
      return { ok: true, message: '已忘记插件保存的登录态' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };

  /**
   * 账号池视图（脱敏）。
   *
   * 只回展示字段，**绝不回 cookie**：这份结构会跨到浏览器半边。
   * `current` 按「真的会用的那个」标，而不是按「用户上次点选的」标 ——
   * 两者不一致时，卡片要能一眼看出差别（那是 `selectionLost` 的场景）。
   *
   * 余额是**逐账号现拉**的：只有勾选了参与的账号才去拉（见 `refreshPoolCredits`），
   * 这里只把已有结果贴上去。没查过就是 `undefined` —— 界面显示破折号，
   * 而不是 0。这一点很重要：把「没查到」显示成 0 会让用户以为账号没钱了。
   */
  const accountsView = async (): Promise<StatusAccount[]> => {
    const [accounts, selected, current] = await Promise.all([
      listAccounts(),
      readSelection(),
      readCredential(),
    ]);
    const enabled = new Set(pluginState.enabledAccounts);
    return accounts.map((account) => {
      const cached = poolCredits.get(account.accountId);
      return {
        id: account.accountId,
        name: account.name ?? account.accountId,
        source: account.source,
        savedAtMs: account.savedAtMs,
        current: account.accountId === current?.accountId,
        // 单选标记：用户显式点选的那个（与 current 可能不同）。
        selected: account.accountId === selected,
        // 勾选标记：有资格参与自动挑选 / 批量操作的那个。
        enabled: enabled.has(account.accountId),
        ...(cached?.credits === undefined ? {} : { credits: cached.credits }),
        ...(cached?.checkedInToday === undefined
          ? {}
          : { checkedInToday: cached.checkedInToday }),
        ...(cached?.error === undefined ? {} : { creditsError: cached.error }),
      };
    });
  };

  /**
   * 逐个账号拉余额（只拉勾选了参与的）。
   *
   * 为什么只拉勾选的：每个账号一次网络请求，池里十个账号就是十次。
   * 用户没勾的账号不需要知道余额 —— 它只是留在那里备查。
   *
   * 失败**不清空**上一次的好数据，只在该账号条目上记 `error`
   * （设计纪律：网络失败绝不把好数据变成空）。
   */
  const refreshPoolCredits = async (): Promise<void> => {
    const accounts = await listAccounts();
    const enabled = new Set(pluginState.enabledAccounts);
    for (const account of accounts) {
      if (!enabled.has(account.accountId)) continue;
      const previous = poolCredits.get(account.accountId);
      try {
        const payload = await client.balancePayload(account.cookie);
        const summary = parseBalance(payload, Date.now());
        poolCredits.set(account.accountId, {
          ...(summary?.total === undefined ? {} : { credits: summary.total }),
          ...(previous?.checkedInToday === undefined
            ? {}
            : { checkedInToday: previous.checkedInToday }),
        });
      } catch (error) {
        poolCredits.set(account.accountId, {
          ...(previous?.credits === undefined ? {} : { credits: previous.credits }),
          ...(previous?.checkedInToday === undefined
            ? {}
            : { checkedInToday: previous.checkedInToday }),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  /**
   * 账号池的开关状态。
   *
   * 常驻返回，**即使只有一个账号**：WorkBuddy 的账号池是常驻显示的，
   * 只在多账号时出现会让用户以为这个功能不存在（真踩过这个反馈）。
   */
  const accountPoolView = async (): Promise<StatusAccountPool> => {
    const accounts = await listAccounts();
    const enabled = new Set(pluginState.enabledAccounts);
    // 名单里可能残留已删账号的 id：只数真实存在的。
    const selected = accounts.filter((account) => enabled.has(account.accountId)).length;
    return {
      enabled: pluginState.accountPoolEnabled === true,
      total: accounts.length,
      selected,
      deviceMode: pluginState.deviceHeaderMode,
    };
  };

  /**
   * 切换当前账号。
   *
   * 只写「选择」标记，不动任何账号内容 —— 改选择不该重写凭据，
   * 否则两个账号同时刷新时会互相覆盖。
   * @param accountId - 目标账号 id。
   * @returns 动作结果。
   */
  const switchAccountNow = async (
    accountId: string,
  ): Promise<{ ok: boolean; message: string }> => {
    const target = await readAccount(accountId);
    if (target === undefined) {
      return { ok: false, message: '这个账号已经不在本机了' };
    }
    await selectAccount(accountId);
    // 缓存里是上一个账号的余额/任务/目录，不清就会把别人的数据显示成当前账号的。
    client.clearRuns();
    runtime.invalidate();
    lingxi?.invalidate();
    await refreshCatalog();
    return { ok: true, message: `已切换到 ${target.name ?? target.accountId}` };
  };

  /**
   * 勾选进池的账号（id + 显示名）。
   *
   * 只返回真实存在且被勾选的 —— 名单里残留已删账号的 id 时不能把它算进来，
   * 否则批量操作会对着一个不存在的账号报错。
   */
  const poolAccounts = async (): Promise<Array<{ id: string; name: string }>> => {
    const accounts = await listAccounts();
    const enabled = new Set(pluginState.enabledAccounts);
    return accounts
      .filter((account) => enabled.has(account.accountId))
      .map((account) => ({
        id: account.accountId,
        name: account.name ?? account.accountId,
      }));
  };

  /**
   * 给单个账号签到（批量签到逐个调用）。
   *
   * 直接用那个账号自己的 cookie 走与单账号签到相同的上游流程，
   * **不切换当前账号** —— 批量签到不该改变「我现在在用哪个」。
   */
  const claimFor = async (
    accountId: string,
  ): Promise<{ ok: boolean; message?: string }> => {
    const account = await readAccount(accountId);
    if (account === undefined) return { ok: false, message: '账号已不在本机' };
    try {
      const tasks = await client.tasksPayload(account.cookie);
      const daily = parseTasks(tasks).find((task) => task.type === 'daily');
      if (daily === undefined) return { ok: false, message: '上游没有每日签到任务' };
      if (daily.status === 'claimed') return { ok: true, message: '今日已签到' };
      if (daily.status !== 'claimable') return { ok: false, message: '当前不可领取' };
      const date = beijingDate(Date.now());
      await client.claimTask(account.cookie, daily.key, date);
      poolCredits.set(accountId, {
        ...(poolCredits.get(accountId) ?? {}),
        checkedInToday: true,
      });
      return { ok: true, message: '签到成功' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };

  /**
   * 测单个账号是否可用：发一次最小对话。
   *
   * 为什么不只查余额：余额接口 200 不代表对话通道可用。真正能测出来的
   * 是走一次对话 —— 这也是 WorkBuddy「测试勾选的账号」的做法。
   * 会消耗少量智点，所以只在用户点按钮时执行。
   */
  /**
   * 读单个账号的余额（给输入框弹出的账号表格用）。
   *
   * 只读余额，不走对话 —— 与 {@link testAccount} 的区别就在这里：
   * 那张表要回答「每个账号还剩多少」，不需要花智点去证明通道可用。
   */
  const accountBalance = async (
    accountId: string,
  ): Promise<{ credits?: number; error?: string }> => {
    const account = await readAccount(accountId);
    if (account === undefined) return { error: '账号已不在本机' };
    try {
      const payload = await client.balancePayload(account.cookie);
      // 余额接口可能 200 但没给数字；那是「读不到」，不是 0。
      const summary = parseBalance(payload, Date.now());
      return summary === undefined ? { error: '余额接口没有给出可用数字' } : { credits: summary.total };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };

  const testAccount = async (
    accountId: string,
  ): Promise<{ ok: boolean; message?: string }> => {
    const account = await readAccount(accountId);
    if (account === undefined) return { ok: false, message: '账号已不在本机' };
    try {
      const response = await client.openChat({
        cookie: account.cookie,
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 8,
      });
      if (!response.ok) {
        return { ok: false, message: `对话接口返回 HTTP ${response.status}` };
      }
      // 读一行 SSE 就够证明通道通了；读完整条会白花时间与智点。
      const text = await response.text();
      const usable = text.includes('data:');
      return usable
        ? { ok: true, message: '可用' }
        : { ok: false, message: '对话接口有响应但没有任何数据' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };

  // 1. 运行时（先建，后面 refreshCatalog 与路由都指向它）。
  const runtime = new LingxiRuntime({
    client,
    version: VERSION,
    warn,
    state: async () => pluginState,
    saveState,
    credential: resolveCookie,
    fallbackCatalog: () => STATIC_CATALOG,
    login: loginWithBrowserNow,
    logout: logoutNow,
    accounts: accountsView,
    accountsLost: () => selectionLost(),
    accountPool: accountPoolView,
    poolAccounts,
    claimFor,
    testAccount,
    accountBalance,
    switchAccount: switchAccountNow,
  });
  runtime.rememberStateSync(pluginState);

  /** 刷新目录；失败时保留现有目录（静态兜底）。 */
  const refreshCatalog = async (): Promise<void> => {
    const resolved = await resolveCookie();
    if (resolved.value === '') return;
    const models = await client.listModels(resolved.value);
    if (models.length === 0) {
      warn('未能读到灵犀账号的模型目录，继续使用内置目录');
      return;
    }
    catalog = dedupeModels(models);
    // 上游目录变了也要发事件：否则选择器会一直停在启动时那份（可能是静态兜底表，
    // 里面还带着账号里根本没有的模型）。
    publishCatalog();
  };

  // 2. 起 shim。
  shim = await startShim({
    cookie: () => resolveCookie().then((resolved) => resolved.value),
    client,
    onWarn: warn,
  });

  // 3. 装配 adapter 并注册。
  lingxi = createLingxiAdapter({
    // adapter 的模型列表也要过一遍禁用名单，否则选择器里会出现用户关掉的模型。
    catalog: () => visibleCatalog(catalog),
    baseUrl: () => shim!.baseUrl,
    token: () => shim!.token,
    // 图片输入要走宿主的持久附件服务。用 `ctx.get` 而不是 `inject`：
    // 没有这个服务时插件仍应正常工作（只是发图会报错），
    // 而不是整个插件的模型路由都起不来。
    //
    // 关键：这个 getter 必须**每次调用时**才去取服务，不能在 apply 时就判断有没有。
    // 宿主服务可能晚于本插件装配（Cordis 的服务是动态的），apply 时取不到
    // 不代表一轮对话开始时也取不到 —— 那一刻判空会让图片能力永远用不上。
    attachments: () => ctx.get('attachments') as AttachmentStore | undefined,
    // 跨沙箱场景下宿主会把 host 路径映射成执行世界可读的路径；
    // 没有 fs 服务时 undefined 让 pi-ai 退回宿主路径。
    processPath: (hostPath) => {
      const fs = ctx.get('fs') as
        | { processPathFromHostPath?: (path: string) => string | undefined }
        | undefined;
      return fs?.processPathFromHostPath?.(hostPath);
    },
  });

  const releaseAdapter = ctx.llm.registerAdapter([PROVIDER], lingxi.adapter);
  const releaseDirectory = ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: 'WPS 灵犀',
      settingsNs: SETTINGS_NS,
      settingsPath: [],
      declared: false,
    },
  ]);
  ctx.llm.registerModelDiscovery(SETTINGS_NS, async (request, signal) => {
    if (request.provider !== undefined && request.provider !== PROVIDER) return [];
    if (!config.enabled) return [];
    const resolved = await resolveCookie();
    const models =
      resolved.value === '' ? [] : await client.listModels(resolved.value, signal);
    const source = models.length === 0 ? visibleCatalog(catalog) : dedupeModels(visibleCatalog(models));
    // 这里是**模型选择器真正读的那条路**：少了 badge/description，官网上那些
    // `NEW` / `正式版` / `首发接入` 与模式说明就不会出现在选择器里 —— 而它们在
    // `/status` 与卡片里都有，于是同一个模型在两个界面长得不一样。
    return source.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      inputModalities: model.vision ? (['text', 'image'] as const) : (['text'] as const),
      ...(model.description === undefined
        ? model.multiplier === ''
          ? {}
          : { description: `倍率 ${model.multiplier}` }
        : { description: model.description }),
      ...(model.badge === undefined
        ? {}
        : { badge: { text: model.badge, tone: badgeTone(model.badge) } }),
    }));
  });

  // 4. 卡片/胶囊用的两条宿主路由（cookie 不进页面，页面只拿归一好的展示数据）。
  registerRoutes(
    ctx as unknown as Parameters<typeof registerRoutes>[0],
    {
      status: () => runtime.status(false),
      action: (action, body) => runtime.run(action, body),
    },
  );

  // 5. 生命周期：卸载时释放注册、路由与端口。disposer 是异步的——必须等
  //    `shim.close()` 真的完成，否则进程会因为有监听句柄而不退出。
  ctx.effect(() => async () => {
    disposed = true;
    runtime.dispose();
    releaseDirectory();
    releaseAdapter();
    client.clearRuns();
    const closing = shim?.close();
    shim = undefined;
    lingxi = undefined;
    if (closing !== undefined) await closing;
  });

  // 6. 启动后预热：目录与状态各自失败都不影响启动。
  if (config.warmCatalogOnStart && (await resolveCookie()).value !== '') {
    void refreshCatalog().catch((error: unknown) => {
      warn(`预热模型目录失败：${error instanceof Error ? error.message : String(error)}`);
    });
    void runtime.status(true).catch((error: unknown) => {
      warn(`预热状态失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  // 7. 配置变化：settings 更新后重新解析登录态与目录。
  //    用 `ctx.on` 的裸字符串形式会触发类型检查（`Events` 未声明该事件），
  //    这里走 `ctx.events` 的宽松入口。
  const offUpdate = (
    ctx as unknown as {
      on(event: string, listener: () => void): (() => void) | void;
    }
  ).on('loader/volatile-update', () => {
    if (disposed) return;
    runtime.invalidate();
    void refreshCatalog().catch((error: unknown) => {
      warn(`刷新模型目录失败：${error instanceof Error ? error.message : String(error)}`);
    });
  });
  if (typeof offUpdate === 'function') ctx.effect(() => offUpdate);

  ctx.logger.info(
    `[${name}] v${VERSION} 已启动：${String(visibleCatalog(catalog).length)} 个模型，shim ${shim.baseUrl}`,
  );
}
