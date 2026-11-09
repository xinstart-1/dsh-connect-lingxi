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
import { registerRoutes } from './host/routes.ts';
import { LingxiRuntime } from './host/runtime.ts';
import { createLingxiAdapter, type LingxiAdapter } from './llm/adapter.ts';
import { LingxiClient } from './protocol/client.ts';
import { STATIC_CATALOG, dedupeModels, type LingxiModel } from './protocol/catalog.ts';
import { normalizeUserCookie } from './protocol/headers.ts';
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
   * 解析登录态。
   *
   * 顺序按「用户成本」从低到高：**手填 > 自动探测（本机客户端 / 日常浏览器）**。
   * 手填排在最前不是因为它更好，而是因为用户显式填了就该听他的。
   *
   * 自动探测每次调用都读一次：看起来浪费，但它是唯一能让「你刚在浏览器里登录完，
   * 插件立刻就能用」成立的机制；cookie 库是本地 SQLite，比一次网络请求便宜得多。
   */
  const resolveCookie = async (): Promise<ResolvedCookie> => {
    const manual = normalizeUserCookie(config.cookie);
    if (manual !== '') return { value: manual, source: 'manual' };
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
      return { value: found.credential.cookie, source };
    } catch (error) {
      warn(`自动探测登录态失败：${error instanceof Error ? error.message : String(error)}`);
      return { value: '', source: 'none' };
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
      // 拿到的 cookie 直接当成「手填」的那份：重启后仍然有效。
      config.cookie = credential.cookie;
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
   * 目录条目是否对用户可见。
   *
   * 禁用名单来自插件状态（用户在该插件设置页上的勾选）。**过滤在目录出口处做**，
   * 而不是在渲染时做：模型选择器读的是 `registerModelDiscovery` 的返回值，
   * 只要它不返回这个模型，界面上就不可能出现。
   */
  const visibleCatalog = (models: readonly LingxiModel[]): LingxiModel[] =>
    models.filter((model) => !pluginState.disabledModels.includes(model.id));

  /** 写入状态并让运行时跟着走（刷新间隔可能变了）。 */
  const saveState = async (patch: Partial<LingxiPluginState>): Promise<LingxiPluginState> => {
    pluginState = await writeState(patch);
    runtime.rememberStateSync(pluginState);
    if (patch.pollIntervalMs !== undefined) runtime.restartPolling();
    lingxi?.invalidate();
    return pluginState;
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
    lingxi?.invalidate();
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
    return source.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      inputModalities: model.vision ? (['text', 'image'] as const) : (['text'] as const),
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
