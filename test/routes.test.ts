/**
 * 宿主路由的单元测试。
 *
 * 用一个内存里的 fake webServer 代替真实 HTTP 服务器：路由层只做协议编排，
 * 真正的业务逻辑通过注入的回调来，所以这里能完整覆盖 403 / 405 / 未知动作 /
 * 异常 / body 上限这些边界，而不需要监听端口。
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ACTION_PATH,
  STATUS_PATH,
  isLoopbackHost,
  registerRoutes,
  type LingxiAction,
  type WebServerEntry,
} from '../src/host/routes.ts';

/** 内存里的 webServer：保存注册项，供测试直接调用 handler。 */
function fakeWebServer(): {
  entries: WebServerEntry[];
  effects: Array<() => () => void>;
  webServer: { register: (entry: WebServerEntry) => () => void };
} {
  const entries: WebServerEntry[] = [];
  return {
    entries,
    effects: [],
    webServer: {
      register: (entry) => {
        entries.push(entry);
        return () => {
          const index = entries.indexOf(entry);
          if (index >= 0) entries.splice(index, 1);
        };
      },
    },
  };
}

/** 一次假的响应记录。 */
interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** 造一个假响应对象。 */
function fakeResponse(captured: Captured): ServerResponse {
  const response = {
    headersSent: false,
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status;
      captured.headers = headers;
      response.headersSent = true;
      return response;
    },
    end(body?: string) {
      captured.body = body ?? '';
    },
  };
  return response as unknown as ServerResponse;
}

/** 造一个假请求：只要有 headers / method / url 和可异步迭代的 body。 */
function fakeRequest(
  init: { method?: string; url?: string; host?: string; body?: string },
): IncomingMessage {
  const stream = Readable.from(init.body === undefined ? [] : [Buffer.from(init.body, 'utf8')]);
  return Object.assign(stream, {
    headers: init.host === undefined ? {} : { host: init.host },
    method: init.method ?? 'GET',
    url: init.url ?? ACTION_PATH,
  }) as unknown as IncomingMessage;
}

/** 装配：注册路由并取出两条 handler。 */
function setup(status?: () => Promise<unknown>, action?: (a: LingxiAction, b: Record<string, unknown>) => Promise<unknown>) {
  const fake = fakeWebServer();
  const calls: Array<{ action: LingxiAction; body: Record<string, unknown> }> = [];
  const ctx = {
    inject: (services: readonly string[], callback: (webCtx: unknown) => void) => {
      assert.deepEqual([...services], ['webServer']);
      callback({ effect: (fn: () => () => void) => fake.effects.push(fn), webServer: fake.webServer });
    },
  };
  registerRoutes(ctx, {
    status: status ?? (async () => ({ ok: true })),
    action:
      action ??
      (async (a, b) => {
        calls.push({ action: a, body: b });
        return { ok: true, action: a };
      }),
  });
  // 执行 effect 才会真正 register。
  for (const effect of fake.effects) effect();
  const statusEntry = fake.entries.find((entry) => entry.path === STATUS_PATH);
  const actionEntry = fake.entries.find((entry) => entry.path === ACTION_PATH);
  assert.ok(statusEntry !== undefined, '状态路由应当注册');
  assert.ok(actionEntry !== undefined, '动作路由应当注册');
  return { statusEntry, actionEntry, calls };
}

/** 调一次 handler 并收集响应。 */
async function call(
  entry: WebServerEntry,
  req: IncomingMessage,
): Promise<Captured> {
  const captured: Captured = { status: 0, headers: {}, body: '' };
  await entry.handler(req, fakeResponse(captured));
  return captured;
}

test('注册两条路由：status 与 action', () => {
  const { statusEntry, actionEntry } = setup();
  assert.equal(statusEntry.path, '/plugins/dsh-connect-lingxi/status');
  assert.equal(actionEntry.path, '/plugins/dsh-connect-lingxi/action');
  assert.equal(statusEntry.kind, 'exact');
});

test('非回环 Host 一律 403', async () => {
  const { statusEntry, actionEntry } = setup();
  for (const host of ['10.0.0.5:61240', 'evil.example', undefined]) {
    const statusResponse = await call(statusEntry, fakeRequest({ host, method: 'GET' }));
    assert.equal(statusResponse.status, 403);
    assert.match(statusResponse.body, /loopback only/);
    void actionEntry;
  }
});

test('status 只收 GET/HEAD；action 只收 POST', async () => {
  const { statusEntry, actionEntry } = setup();
  assert.equal((await call(statusEntry, fakeRequest({ host: '127.0.0.1:61240', method: 'POST' }))).status, 405);
  assert.equal((await call(actionEntry, fakeRequest({ host: '127.0.0.1:61240', method: 'GET' }))).status, 405);
});

test('status 走 GET 时返回状态文档', async () => {
  const { statusEntry } = setup(async () => ({ version: '0.0.1', login: { state: 'signed-in' } }));
  const response = await call(statusEntry, fakeRequest({ host: '127.0.0.1:61240', method: 'GET' }));
  assert.equal(response.status, 200);
  assert.match(response.headers['Content-Type'] ?? '', /application\/json/);
  assert.equal(JSON.parse(response.body).version, '0.0.1');
});

test('action 未知动作返回 ok:false 且不调用回调', async () => {
  const { actionEntry, calls } = setup();
  const response = await call(
    actionEntry,
    fakeRequest({ host: '127.0.0.1:61240', method: 'POST', url: `${ACTION_PATH}?action=drop-tables` }),
  );
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).ok, false);
  assert.match(JSON.parse(response.body).error, /未知操作/);
  assert.equal(calls.length, 0);
});

test('action 白名单内的四个动作都放行，body 原样交给回调', async () => {
  const { actionEntry, calls } = setup();
  for (const name of ['refresh', 'claim-checkin', 'claim-one-time', 'settings']) {
    const response = await call(
      actionEntry,
      fakeRequest({
        host: '127.0.0.1:61240',
        method: 'POST',
        url: `${ACTION_PATH}?action=${name}`,
        body: JSON.stringify({ autoCheckin: true }),
      }),
    );
    assert.equal(response.status, 200, `${name} 应当放行`);
    assert.equal(JSON.parse(response.body).ok, true);
  }
  assert.deepEqual(
    calls.map((call) => call.action),
    ['refresh', 'claim-checkin', 'claim-one-time', 'settings'],
  );
  assert.equal(calls[3]?.body.autoCheckin, true);
});

test('坏 JSON body 当空对象，不炸', async () => {
  const { actionEntry, calls } = setup();
  const response = await call(
    actionEntry,
    fakeRequest({
      host: '127.0.0.1:61240',
      method: 'POST',
      url: `${ACTION_PATH}?action=settings`,
      body: '{ 不是 JSON',
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0]?.body, {});
});

test('超过 64 KiB 的 body 被截断，不抛也不挂住', async () => {
  const { actionEntry } = setup();
  const huge = JSON.stringify({ padding: 'x'.repeat(200_000) });
  const response = await call(
    actionEntry,
    fakeRequest({ host: '127.0.0.1:61240', method: 'POST', url: `${ACTION_PATH}?action=settings`, body: huge }),
  );
  // 截断后的 body 不是合法 JSON → 当空对象 → 仍然 200（回调自己判字段是否为空）。
  assert.equal(response.status, 200);
});

test('回调抛错 → 500 且不带堆栈', async () => {
  const { statusEntry, actionEntry } = setup(
    async () => {
      throw new Error('上游炸了');
    },
    async () => {
      throw new Error('领取失败');
    },
  );
  const statusResponse = await call(statusEntry, fakeRequest({ host: '127.0.0.1:61240', method: 'GET' }));
  assert.equal(statusResponse.status, 500);
  assert.equal(JSON.parse(statusResponse.body).error, '上游炸了');
  assert.equal(/at\s|\.ts:/.test(statusResponse.body), false, '不该泄露堆栈');

  const actionResponse = await call(
    actionEntry,
    fakeRequest({ host: '127.0.0.1:61240', method: 'POST', url: `${ACTION_PATH}?action=claim-checkin` }),
  );
  assert.equal(actionResponse.status, 500);
  assert.equal(JSON.parse(actionResponse.body).error, '领取失败');
});

test('isLoopbackHost 认整个 127/8 网段与 localhost / ::1', () => {
  for (const host of ['127.0.0.1', '127.0.0.1:61240', '127.1.2.3:80', 'localhost', 'localhost:61240', '[::1]', '[::1]:61240', '::1']) {
    assert.equal(isLoopbackHost(host), true, `${host} 应算本机`);
  }
  for (const host of ['10.0.0.5', '192.168.1.1:3000', '8.8.8.8', 'example.com', '0.0.0.0', '128.0.0.1', undefined, '']) {
    assert.equal(isLoopbackHost(host), false, `${host} 不该算本机`);
  }
});

test('effect 返回的 disposer 能摘掉路由', async () => {
  const fake = fakeWebServer();
  const ctx = {
    inject: (_services: readonly string[], callback: (webCtx: unknown) => void) => {
      callback({ effect: (fn: () => () => void) => fake.effects.push(fn), webServer: fake.webServer });
    },
  };
  registerRoutes(ctx, {
    status: async () => ({}),
    action: async () => ({}),
  });
  const disposers = fake.effects.map((effect) => effect());
  assert.equal(fake.entries.length, 2);
  for (const dispose of disposers) dispose();
  assert.equal(fake.entries.length, 0);
});
