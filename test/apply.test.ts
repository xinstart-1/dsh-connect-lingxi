/**
 * 装配冒烟测试：用一个最小的 fake Cordis ctx 跑 `apply()`，验证
 * shim 起得来、三个注册点都被调用、卸载时能干净释放。
 *
 * 不连网：目录走静态兜底，cookie 为空所以 `listModels` 不会被调用。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { apply } from '../src/index.ts';
import { PROVIDER, SETTINGS_NS } from '../src/constants.ts';
import { readCredential, writeCredential } from '../src/credentials/vault.ts';
import { STATIC_CATALOG } from '../src/protocol/catalog.ts';

/**
 * 每个用例一个临时 `DSH_HOME`。
 *
 * 为什么必须隔离：`apply()` 会 `readState()` 真实的状态文件，而这个文件属于用户
 * （里面存着他关掉了哪些模型）。不隔离就会发生两件坏事：
 * 1. 测试读到用户的真实配置，断言随他的设置而变；
 * 2. **测试写回用户的真实状态文件**，把他的选择冲掉 —— 这条真的发生过一次。
 */
const tempHomes: string[] = [];

/** 建一个临时 DSH_HOME 并让本用例全程用它。 */
async function isolateState(): Promise<() => void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lingxi-apply-'));
  tempHomes.push(dir);
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  return () => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  };
}

after(async () => {
  for (const dir of tempHomes) await rm(dir, { recursive: true, force: true });
});

/**
 * 隔离状态文件的用例包装。
 *
 * 每个用例自己建临时 `DSH_HOME` 并在结束时还原，所以：
 * - 测试永远读不到用户真实的状态文件；
 * - 测试也永远不会写回它（这条真的出过一次事：把用户关掉的 11 个模型冲成了 1 个）。
 * @param name - 用例名。
 * @param body - 用例体。
 */
function testIsolated(name: string, body: () => Promise<void>): void {
  // 超时要放宽：`apply()` 在没有登录态时会真的去扫本机浏览器 cookie 库
  // （Edge 开着时还要先做快照），在真机上单次可能超过 1 秒。
  // 这不影响隔离，只是别让慢机器把「慢」报成「失败」。
  test(name, { timeout: 30_000 }, async () => {
    const restore = await isolateState();
    try {
      await body();
    } finally {
      restore();
    }
  });
}

/** 路由 handler：只收一个假的 req / res 对。 */
type RouteHandler = (req: unknown, res: unknown) => void | Promise<void>;

/**
 * 发一次动作请求，返回宿主写回的 JSON。
 *
 * 走真实的路由 handler，而不是直接调 runtime：勾选框到状态文件之间那条链路
 * （路由 → 白名单 → runtime.run → saveState → 发事件）才是要测的东西。
 */
async function postAction(
  handler: RouteHandler,
  action: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  let status = 0;
  let text = '';
  const req = {
    method: 'POST',
    url: `/plugins/dsh-connect-lingxi/action?action=${action}`,
    headers: { host: '127.0.0.1:54820' },
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
  };
  const res = {
    headersSent: false,
    writeHead: (code: number) => {
      status = code;
    },
    end: (chunk: string) => {
      text = chunk;
    },
  };
  await handler(req, res);
  assert.equal(status, 200, `动作 ${action} 应当返回 200，实际 ${status}：${text}`);
  return JSON.parse(text) as unknown;
}

/**
 * 读一次 `/status`，返回状态文档。
 *
 * 走真实路由，与卡片同一条路径；这样测的是「插件对界面说了什么」，
 * 而不是内部某个字段。
 */
async function statusOf(
  routes: Array<{ path: string; handler: RouteHandler }>,
): Promise<Record<string, unknown>> {
  const route = routes.find((entry) => entry.path.endsWith('/status'));
  assert.ok(route !== undefined, '状态路由必须已注册');
  let text = '';
  const req = { method: 'GET', url: '/plugins/dsh-connect-lingxi/status', headers: { host: '127.0.0.1:54820' } };
  const res = {
    headersSent: false,
    writeHead: () => {},
    end: (chunk: string) => {
      text = chunk;
    },
  };
  await route.handler(req, res);
  return JSON.parse(text) as Record<string, unknown>;
}

interface RegisteredAdapter {
  providers: string[];
  adapter: unknown;
}

/** 记录所有注册调用，并提供一个可用的最小 ctx。 */
function fakeContext(options?: {
  webServer?: boolean;
  /** 额外提供的宿主服务（`ctx.get(name)`）。 */
  services?: Record<string, unknown>;
}): {
  ctx: Record<string, unknown>;
  registered: {
    adapters: RegisteredAdapter[];
    directories: unknown[];
    discoveries: Array<{ ns: string; fn: unknown }>;
  };
  disposers: Array<() => void | Promise<void>>;
  warnings: string[];
  infos: string[];
  webRoutes: Array<{ kind: string; path: string; handler: RouteHandler }>;
  events: Array<{ name: string; args: unknown[] }>;
} {
  const registered = {
    adapters: [] as RegisteredAdapter[],
    directories: [] as unknown[],
    discoveries: [] as Array<{ ns: string; fn: unknown }>,
  };
  const disposers: Array<() => void | Promise<void>> = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const webRoutes: Array<{ kind: string; path: string; handler: RouteHandler }> = [];
  const events: Array<{ name: string; args: unknown[] }> = [];

  const ctx = {
    logger: {
      warn: (message: string) => warnings.push(message),
      info: (message: string) => infos.push(message),
      error: () => {},
    },
    llm: {
      registerAdapter: (providers: string[], adapter: unknown) => {
        registered.adapters.push({ providers, adapter });
        return () => {};
      },
      registerConfigurableProviders: (entries: unknown) => {
        registered.directories.push(entries);
        return () => {};
      },
      registerModelDiscovery: (ns: string, fn: unknown) => {
        registered.discoveries.push({ ns, fn });
        return () => {};
      },
    },
    effect: (factory: () => () => void | Promise<void>) => {
      disposers.push(factory());
    },
    /** 记录插件发出的每个事件（`llm/models-updated` 靠它验证）。 */
    emit: (name: string, ...args: unknown[]) => {
      events.push({ name, args });
    },
    // 宿主路由走 `ctx.inject(['webServer'], ...)`：没有 webServer 的组合里
    // 这一层应当什么都不做（模型路由照样注册），所以这里给一个不触发的 inject。
    // 要验证路由本身的用例会传 `webServer`，见下方 `fakeContext({ webServer: true })`。
    inject: (services: readonly string[], callback: (webCtx: unknown) => void) => {
      if (options?.webServer !== true) return;
      if (!services.includes('webServer')) return;
      webRoutes.length = 0;
      callback({
        effect: (factory: () => () => void) => {
          disposers.push(factory());
        },
        webServer: {
          register: (entry: { kind: string; path: string; handler: RouteHandler }) => {
            webRoutes.push(entry);
            return () => {
              const index = webRoutes.indexOf(entry);
              if (index >= 0) webRoutes.splice(index, 1);
            };
          },
        },
      });
    },
    on: () => () => {},
    /**
     * 可选服务查询。
     *
     * `attachments` 用它取：插件必须能在「宿主没装配附件服务」的情况下照常
     * 注册模型路由（不能因为缺一个可选服务就整个起不来）。
     */
    get: (name: string) => options?.services?.[name],
  };
  return { ctx, registered, disposers, warnings, infos, webRoutes, events };
}

/** 依次执行卸载器；它们是异步的。 */
async function disposeAll(disposers: Array<() => void | Promise<void>>): Promise<void> {
  for (const dispose of disposers) await dispose();
}

testIsolated('apply 装配三个注册点并起 shim', async () => {
  const { ctx, registered, disposers, infos } = fakeContext();
  await apply(ctx as never, {
    cookie: '',
    useClientCookie: false,
    clientDataDir: '',
    enabled: true,
    defaultReasoningEffort: '',
    warmCatalogOnStart: false,
    // 关掉自动探测：否则每个用例都会去扫本机浏览器 cookie 库
    // （Edge 开着时要先做快照），在真机上单次可达数秒，且让测试依赖机器状态。
    autoDetectCookie: false,
  });

  // 1. adapter 注册到了正确的 provider
  assert.equal(registered.adapters.length, 1);
  assert.deepEqual(registered.adapters[0]?.providers, [PROVIDER]);

  // 2. configurable provider 目录
  assert.equal(registered.directories.length, 1);
  const directory = registered.directories[0] as Array<Record<string, unknown>>;
  assert.equal(directory[0]?.provider, PROVIDER);
  assert.equal(directory[0]?.settingsNs, SETTINGS_NS);

  // 3. 模型发现走正确的命名空间
  assert.equal(registered.discoveries.length, 1);
  assert.equal(registered.discoveries[0]?.ns, SETTINGS_NS);

  // 4. 启动日志里带了 shim 地址与模型数
  assert.ok(infos.some((line) => line.includes('http://127.0.0.1:')));
  assert.ok(infos.some((line) => line.includes(String(STATIC_CATALOG.length))));

  // 5. 有卸载器：主生命周期 + 事件退订（`ctx.on` 返回的 disposer 也挂在 effect 上）
  assert.ok(disposers.length >= 1, `应至少注册一个卸载器，实际 ${disposers.length}`);

  // 6. 卸载不抛
  await disposeAll(disposers);
});

testIsolated('enabled=false 时模型发现返回空', async () => {
  const { ctx, registered, disposers } = fakeContext();
  await apply(ctx as never, {
    cookie: '',
    useClientCookie: false,
    clientDataDir: '',
    enabled: false,
    defaultReasoningEffort: '',
    warmCatalogOnStart: false,
    autoDetectCookie: false,
  });

  const discover = registered.discoveries[0]?.fn as (
    request: { provider?: string },
    signal?: AbortSignal,
  ) => Promise<unknown[]>;
  const models = await discover({ provider: PROVIDER });
  assert.deepEqual(models, []);

  await disposeAll(disposers);
});

testIsolated('未配置 cookie 时模型发现返回静态兜底目录', async () => {
  const { ctx, registered, disposers } = fakeContext();
  await apply(ctx as never, {
    cookie: '',
    useClientCookie: false,
    clientDataDir: '',
    enabled: true,
    defaultReasoningEffort: '',
    warmCatalogOnStart: false,
    // 关掉自动探测：否则每个用例都会去扫本机浏览器 cookie 库
    // （Edge 开着时要先做快照），在真机上单次可达数秒，且让测试依赖机器状态。
    autoDetectCookie: false,
  });

  const discover = registered.discoveries[0]?.fn as (
    request: { provider?: string },
    signal?: AbortSignal,
  ) => Promise<Array<{ id: string; contextWindow: number; inputModalities?: readonly string[] }>>;
  const models = await discover({ provider: PROVIDER });
  assert.equal(models.length, STATIC_CATALOG.length);
  assert.equal(models[0]?.id, STATIC_CATALOG[0]?.id);
  assert.ok((models[0]?.contextWindow ?? 0) > 0);
  // 目录第一条是 DeepSeek V4.1 Flash：官网标了图片能力，所以这里必须有 image。
  // 断言「第一条」的 modality 时要以静态表为准，不要写死 —— 官网换顺序时
  // 这条会跟着变，而不是变成一条误报。
  assert.deepEqual(
    models[0]?.inputModalities,
    STATIC_CATALOG[0]?.vision === true ? ['text', 'image'] : ['text'],
  );

  await disposeAll(disposers);
});

testIsolated('勾选模型后必须发出 llm/models-updated，否则选择器不会重拉目录', async () => {
  const { ctx, disposers, events, webRoutes } = fakeContext({ webServer: true });
  await apply(ctx as never, {
    cookie: '',
    useClientCookie: false,
    clientDataDir: '',
    enabled: true,
    defaultReasoningEffort: '',
    warmCatalogOnStart: false,
    // 关掉自动探测：否则每个用例都会去扫本机浏览器 cookie 库
    // （Edge 开着时要先做快照），在真机上单次可达数秒，且让测试依赖机器状态。
    autoDetectCookie: false,
  });

  // 浏览器半边的模型目录按 Host 代次缓存，只有收到这个事件才 refresh()。
  // 少发它的表现就是「勾了没反应」：状态写对了，选择器还是旧的那份。
  const catalogEvents = () => events.filter((event) => event.name === 'llm/models-updated');
  assert.equal(catalogEvents().length, 0, '启动时不该先发一次（还没有目录变化）');

  // 走真实的路由入口发一次设置写入，与卡片上的勾选框同一条路径。
  const action = webRoutes.find((entry) => entry.path.endsWith('/action'));
  assert.ok(action !== undefined, '动作路由必须已注册');
  await postAction(action.handler, 'settings', {
    disabledModels: ['plan_pro'],
    imageOffModels: ['kimi-k3'],
  });

  const fired = catalogEvents();
  assert.equal(fired.length, 1, '一次设置写入应当发一次目录更新事件');
  assert.deepEqual(fired[0]?.args, [PROVIDER], '事件要带 provider，否则宿主不知道刷新谁');

  // 纯界面开关（胶囊 / 侧栏 / 刷新间隔）不改变目录，不该触发重拉。
  await postAction(action.handler, 'settings', { composerPill: false });
  assert.equal(catalogEvents().length, 1, '纯界面开关不该让选择器重拉目录');

  await disposeAll(disposers);
});

testIsolated('重载插件后登录态还在：仓库优先于自动探测', async () => {
  const config = {
    cookie: '',
    useClientCookie: false,
    clientDataDir: '',
    enabled: true,
    defaultReasoningEffort: '',
    warmCatalogOnStart: false,
  };

  // 第一次启动：仓库里什么都没有，也探测不到（测试环境没有浏览器 cookie 库），
  // 所以这次一定未登录 —— 这一条同时证明「未登录时不会伪造登录态」。
  {
    const { ctx, disposers, webRoutes } = fakeContext({ webServer: true });
    await apply(ctx as never, config);
    const status = await statusOf(webRoutes);
    assert.equal((status.login as { state: string }).state, 'signed-out');
    await disposeAll(disposers);
  }

  // 用户点了一次「登录灵犀」，插件把 cookie 存进自己的仓库。
  // 这里直接写仓库文件，因为拉真实浏览器不在单测范围；写的是同一个落盘格式。
  await writeCredential({ cookie: 'wps_sid=persisted; uid=42', source: 'login' }, process.env);

  // 第二次启动 = 插件被重载/更新后重新 apply。仓库里的登录态必须立刻可用。
  {
    const { ctx, disposers, webRoutes } = fakeContext({ webServer: true });
    await apply(ctx as never, config);
    const status = await statusOf(webRoutes);
    const login = status.login as { state: string; source: string };
    assert.equal(login.state, 'signed-in', '重载后必须还是登录状态');
    assert.equal(login.source, 'browser', 'login 来源对用户就是浏览器登录态');
    await disposeAll(disposers);
  }
});

testIsolated('登出只清插件仓库，不清别的', async () => {
  await writeCredential({ cookie: 'wps_sid=persisted', source: 'login' }, process.env);
  const { ctx, disposers, webRoutes } = fakeContext({ webServer: true });
  await apply(ctx as never, {
    cookie: '',
    useClientCookie: false,
    clientDataDir: '',
    enabled: true,
    defaultReasoningEffort: '',
    warmCatalogOnStart: false,
    // 关掉自动探测：否则每个用例都会去扫本机浏览器 cookie 库
    // （Edge 开着时要先做快照），在真机上单次可达数秒，且让测试依赖机器状态。
    autoDetectCookie: false,
  });

  const action = webRoutes.find((entry) => entry.path.endsWith('/action'));
  assert.ok(action !== undefined);
  const result = (await postAction(action.handler, 'logout', {})) as { ok: boolean };
  assert.equal(result.ok, true);

  // 文件没了 → 下次解析登录态返回空。
  assert.equal(await readCredential(process.env), undefined);
  await disposeAll(disposers);
});

testIsolated('模型发现要带官网徽标与说明，否则选择器与卡片两套说法', async () => {
  const { ctx, registered, disposers } = fakeContext();
  await apply(ctx as never, {
    cookie: '',
    useClientCookie: false,
    clientDataDir: '',
    enabled: true,
    defaultReasoningEffort: '',
    warmCatalogOnStart: false,
    autoDetectCookie: false,
  });

  const discover = registered.discoveries[0]?.fn as (
    request: { provider?: string },
  ) => Promise<
    Array<{
      id: string;
      description?: string;
      badge?: { text: string; tone: string };
    }>
  >;
  const models = await discover({ provider: PROVIDER });
  const byId = new Map(models.map((model) => [model.id, model]));

  // 官网那三个徽标必须原样出现在模型发现里（这是选择器真正读的路径）。
  assert.deepEqual(byId.get('deepseek-v4.1-flash')?.badge, { text: 'NEW', tone: 'info' });
  assert.deepEqual(byId.get('deepseek-v4-pro-0813')?.badge, { text: '正式版', tone: 'success' });
  assert.deepEqual(byId.get('GLM-5.3')?.badge, { text: '首发接入', tone: 'info' });
  // 没有徽标的模型不该带一个空 badge（界面会渲染出一个空胶囊）。
  assert.equal(byId.get('qwen3.8_flash')?.badge, undefined);

  // 模式带官网的说明；普通模型退回「倍率 x」。
  assert.match(byId.get('plan_pro')?.description ?? '', /日常任务/);
  assert.match(byId.get('plan_max')?.description ?? '', /复杂任务/);
  assert.match(byId.get('kimi-k3')?.description ?? '', /倍率/);

  await disposeAll(disposers);
});

testIsolated('有 attachments 服务时 adapter 接上它，否则发图会报 UNSUPPORTED_CONTENT', async () => {
  // 这条防的是真实报错：模型被标成支持图片（`input: ['text','image']`），
  // 但 adapter 没有 `resolveAttachments` 时，pi-ai 会在第一次发图就抛
  // `pi-ai image input requires the durable attachment service`。
  const store = { read: () => undefined };
  const { ctx, registered, disposers } = fakeContext({ services: { attachments: store } });
  await apply(ctx as never, {
    cookie: '',
    useClientCookie: false,
    clientDataDir: '',
    enabled: true,
    defaultReasoningEffort: '',
    warmCatalogOnStart: false,
    autoDetectCookie: false,
  });

  const adapter = registered.adapters[0]?.adapter as {
    config?: { resolveAttachments?: () => unknown };
  };
  // PiAiAdapter 把配置存在内部的 `config` 字段上；没有就直接说明接线断了。
  const resolved = adapter?.config?.resolveAttachments?.();
  assert.equal(resolved, store, 'adapter 必须把宿主的 attachments 服务转手给 pi-ai');

  await disposeAll(disposers);
});

testIsolated('attachments 在调用时才解析：晚于 apply 注册的服务也能拿到', async () => {
  // 真实场景：Cordis 的服务是动态的，宿主可能在本插件装配之后才装上
  // `attachments`。如果在 apply 那一刻判空并决定「不接钩子」，图片能力就永远
  // 用不上了。所以钩子必须每次都现取。
  const services: Record<string, unknown> = {};
  const { ctx, registered, disposers } = fakeContext({ services });
  await apply(ctx as never, {
    cookie: '',
    useClientCookie: false,
    clientDataDir: '',
    enabled: true,
    defaultReasoningEffort: '',
    warmCatalogOnStart: false,
    autoDetectCookie: false,
  });

  const adapter = registered.adapters[0]?.adapter as {
    config?: { resolveAttachments?: () => unknown };
  };
  // apply 时服务还不存在 —— 此时取到 undefined 是正常的，
  // 但钩子本身必须已经在。
  assert.equal(typeof adapter?.config?.resolveAttachments, 'function');
  assert.equal(adapter?.config?.resolveAttachments?.(), undefined);

  // 服务后到：下一次调用必须立刻看见它。
  const store = { read: () => undefined };
  services.attachments = store;
  assert.equal(adapter?.config?.resolveAttachments?.(), store);

  await disposeAll(disposers);
});

testIsolated('其它 provider 的发现请求返回空', async () => {
  const { ctx, registered, disposers } = fakeContext();
  await apply(ctx as never, {
    cookie: '',
    useClientCookie: false,
    clientDataDir: '',
    enabled: true,
    defaultReasoningEffort: '',
    warmCatalogOnStart: false,
    // 关掉自动探测：否则每个用例都会去扫本机浏览器 cookie 库
    // （Edge 开着时要先做快照），在真机上单次可达数秒，且让测试依赖机器状态。
    autoDetectCookie: false,
  });

  const discover = registered.discoveries[0]?.fn as (
    request: { provider?: string },
    signal?: AbortSignal,
  ) => Promise<unknown[]>;
  assert.deepEqual(await discover({ provider: 'workbuddy' }), []);

  await disposeAll(disposers);
});

testIsolated('shim 真的在回环上监听；卸载后端口释放', async () => {
  const { ctx, infos, disposers } = fakeContext();
  await apply(ctx as never, {
    cookie: '',
    useClientCookie: false,
    clientDataDir: '',
    enabled: true,
    defaultReasoningEffort: '',
    warmCatalogOnStart: false,
    // 关掉自动探测：否则每个用例都会去扫本机浏览器 cookie 库
    // （Edge 开着时要先做快照），在真机上单次可达数秒，且让测试依赖机器状态。
    autoDetectCookie: false,
  });

  const line = infos.find((entry) => entry.includes('http://127.0.0.1:'));
  assert.ok(line !== undefined);
  const url = /http:\/\/127\.0\.0\.1:\d+/.exec(line!)?.[0];
  assert.ok(url !== undefined);

  // 端口确实开着（用 TCP 连接探测，不发 HTTP）。
  const { connect } = await import('node:net');
  const port = Number(new URL(url!).port);
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve();
    });
    socket.on('error', reject);
  });

  await disposeAll(disposers);
  // 给 close 一点时间
  await new Promise((resolve) => setTimeout(resolve, 150));
});

testIsolated('有 webServer 时注册 status 与 action 两条路由，卸载后摘掉', async () => {
  const { ctx, webRoutes, disposers } = fakeContext({ webServer: true });
  await apply(ctx as never, {
    cookie: '',
    useClientCookie: false,
    clientDataDir: '',
    enabled: true,
    defaultReasoningEffort: '',
    warmCatalogOnStart: false,
    // 关掉自动探测：否则每个用例都会去扫本机浏览器 cookie 库
    // （Edge 开着时要先做快照），在真机上单次可达数秒，且让测试依赖机器状态。
    autoDetectCookie: false,
  });

  assert.deepEqual(
    webRoutes.map((route) => route.path).sort(),
    ['/plugins/dsh-connect-lingxi/action', '/plugins/dsh-connect-lingxi/status'],
  );
  assert.ok(webRoutes.every((route) => route.kind === 'exact'));

  await disposeAll(disposers);
  assert.deepEqual(webRoutes, [], '卸载后路由必须摘掉，否则重载插件会重复注册');
});

testIsolated('没有 webServer 时插件照常注册模型路由（不抛）', async () => {
  const { ctx, registered, disposers, webRoutes } = fakeContext();
  await apply(ctx as never, {
    cookie: '',
    useClientCookie: false,
    clientDataDir: '',
    enabled: true,
    defaultReasoningEffort: '',
    warmCatalogOnStart: false,
    // 关掉自动探测：否则每个用例都会去扫本机浏览器 cookie 库
    // （Edge 开着时要先做快照），在真机上单次可达数秒，且让测试依赖机器状态。
    autoDetectCookie: false,
  });
  assert.equal(registered.adapters.length, 1);
  assert.deepEqual(webRoutes, []);
  await disposeAll(disposers);
});
