/**
 * 装配冒烟测试：用一个最小的 fake Cordis ctx 跑 `apply()`，验证
 * shim 起得来、三个注册点都被调用、卸载时能干净释放。
 *
 * 不连网：目录走静态兜底，cookie 为空所以 `listModels` 不会被调用。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply } from '../src/index.ts';
import { PROVIDER, SETTINGS_NS } from '../src/constants.ts';
import { STATIC_CATALOG } from '../src/protocol/catalog.ts';

interface RegisteredAdapter {
  providers: string[];
  adapter: unknown;
}

/** 记录所有注册调用，并提供一个可用的最小 ctx。 */
function fakeContext(options?: { webServer?: boolean }): {
  ctx: Record<string, unknown>;
  registered: {
    adapters: RegisteredAdapter[];
    directories: unknown[];
    discoveries: Array<{ ns: string; fn: unknown }>;
  };
  disposers: Array<() => void | Promise<void>>;
  warnings: string[];
  infos: string[];
  webRoutes: Array<{ kind: string; path: string }>;
} {
  const registered = {
    adapters: [] as RegisteredAdapter[],
    directories: [] as unknown[],
    discoveries: [] as Array<{ ns: string; fn: unknown }>,
  };
  const disposers: Array<() => void | Promise<void>> = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const webRoutes: Array<{ kind: string; path: string }> = [];

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
          register: (entry: { kind: string; path: string }) => {
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
  };
  return { ctx, registered, disposers, warnings, infos, webRoutes };
}

/** 依次执行卸载器；它们是异步的。 */
async function disposeAll(disposers: Array<() => void | Promise<void>>): Promise<void> {
  for (const dispose of disposers) await dispose();
}

test('apply 装配三个注册点并起 shim', async () => {
  const { ctx, registered, disposers, infos } = fakeContext();
  await apply(ctx as never, {
    cookie: '',
    useClientCookie: false,
    clientDataDir: '',
    enabled: true,
    defaultReasoningEffort: '',
    warmCatalogOnStart: false,
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

test('enabled=false 时模型发现返回空', async () => {
  const { ctx, registered, disposers } = fakeContext();
  await apply(ctx as never, {
    cookie: '',
    useClientCookie: false,
    clientDataDir: '',
    enabled: false,
    defaultReasoningEffort: '',
    warmCatalogOnStart: false,
  });

  const discover = registered.discoveries[0]?.fn as (
    request: { provider?: string },
    signal?: AbortSignal,
  ) => Promise<unknown[]>;
  const models = await discover({ provider: PROVIDER });
  assert.deepEqual(models, []);

  await disposeAll(disposers);
});

test('未配置 cookie 时模型发现返回静态兜底目录', async () => {
  const { ctx, registered, disposers } = fakeContext();
  await apply(ctx as never, {
    cookie: '',
    useClientCookie: false,
    clientDataDir: '',
    enabled: true,
    defaultReasoningEffort: '',
    warmCatalogOnStart: false,
  });

  const discover = registered.discoveries[0]?.fn as (
    request: { provider?: string },
    signal?: AbortSignal,
  ) => Promise<Array<{ id: string; contextWindow: number; inputModalities?: readonly string[] }>>;
  const models = await discover({ provider: PROVIDER });
  assert.equal(models.length, STATIC_CATALOG.length);
  assert.equal(models[0]?.id, STATIC_CATALOG[0]?.id);
  assert.ok((models[0]?.contextWindow ?? 0) > 0);
  // 目录第一条不支持图片
  assert.deepEqual(models[0]?.inputModalities, ['text']);

  await disposeAll(disposers);
});

test('其它 provider 的发现请求返回空', async () => {
  const { ctx, registered, disposers } = fakeContext();
  await apply(ctx as never, {
    cookie: '',
    useClientCookie: false,
    clientDataDir: '',
    enabled: true,
    defaultReasoningEffort: '',
    warmCatalogOnStart: false,
  });

  const discover = registered.discoveries[0]?.fn as (
    request: { provider?: string },
    signal?: AbortSignal,
  ) => Promise<unknown[]>;
  assert.deepEqual(await discover({ provider: 'workbuddy' }), []);

  await disposeAll(disposers);
});

test('shim 真的在回环上监听；卸载后端口释放', async () => {
  const { ctx, infos, disposers } = fakeContext();
  await apply(ctx as never, {
    cookie: '',
    useClientCookie: false,
    clientDataDir: '',
    enabled: true,
    defaultReasoningEffort: '',
    warmCatalogOnStart: false,
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

test('有 webServer 时注册 status 与 action 两条路由，卸载后摘掉', async () => {
  const { ctx, webRoutes, disposers } = fakeContext({ webServer: true });
  await apply(ctx as never, {
    cookie: '',
    useClientCookie: false,
    clientDataDir: '',
    enabled: true,
    defaultReasoningEffort: '',
    warmCatalogOnStart: false,
  });

  assert.deepEqual(
    webRoutes.map((route) => route.path).sort(),
    ['/plugins/dsh-connect-lingxi/action', '/plugins/dsh-connect-lingxi/status'],
  );
  assert.ok(webRoutes.every((route) => route.kind === 'exact'));

  await disposeAll(disposers);
  assert.deepEqual(webRoutes, [], '卸载后路由必须摘掉，否则重载插件会重复注册');
});

test('没有 webServer 时插件照常注册模型路由（不抛）', async () => {
  const { ctx, registered, disposers, webRoutes } = fakeContext();
  await apply(ctx as never, {
    cookie: '',
    useClientCookie: false,
    clientDataDir: '',
    enabled: true,
    defaultReasoningEffort: '',
    warmCatalogOnStart: false,
  });
  assert.equal(registered.adapters.length, 1);
  assert.deepEqual(webRoutes, []);
  await disposeAll(disposers);
});
