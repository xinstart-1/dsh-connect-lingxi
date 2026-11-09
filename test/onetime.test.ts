/**
 * 一次性任务编排的单元测试。
 *
 * 这些用例钉住的是**顺序与判据**，不是网络细节：
 * 先报 `running` 再发对话、发完报 `completed`、余额为 0 不发动消耗性动作。
 * 网络层用假的 `LingxiClient` 与假的 WebSocket 顶替。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  needsFor,
  performOneTimeTasks,
  putExecutionStatus,
  resolveWebSocketFactory,
  runGroupTask,
  runTaskConversation,
  type OneTimeDeps,
  type WebSocketFactory,
} from '../src/protocol/onetime.ts';
import type { LingxiClient } from '../src/protocol/client.ts';

/** 记录调用顺序的假依赖。 */
function harness(options: { chatOk?: boolean; statusOk?: boolean } = {}): {
  deps: OneTimeDeps;
  calls: string[];
  statuses: Array<{ status: string; groupId: string }>;
  chat: Array<{ sessionId: string; groupId: string }>;
  runs: number;
} {
  const calls: string[] = [];
  const statuses: Array<{ status: string; groupId: string }> = [];
  const chat: Array<{ sessionId: string; groupId: string }> = [];
  let runs = 0;

  const client = {
    async ensureTaskRun() {
      runs += 1;
      calls.push('ensureRun');
      return { sessionId: `session-${String(runs)}`, groupId: `group-${String(runs)}`, base: 'https://lingxi.wps.cn' };
    },
    async sendTaskChat(input: { run: { sessionId: string; groupId: string } }) {
      calls.push('chat');
      chat.push(input.run);
      return { ok: options.chatOk !== false, status: options.chatOk === false ? 500 : 200 };
    },
  } as unknown as LingxiClient;

  // 拦截 fetch：PUT execution_status 记录状态，其余按场景回应。
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const text = String(url instanceof Request ? url.url : url);
    if (text.includes('/execution_status')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { status?: string; group_id?: string };
      statuses.push({ status: String(body.status ?? ''), groupId: String(body.group_id ?? '') });
      calls.push(`status:${String(body.status ?? '')}`);
      return new Response('{}', { status: options.statusOk === false ? 500 : 200 });
    }
    if (text.includes('/cowork/sessions')) {
      calls.push('group:session');
      return new Response(JSON.stringify({ data: { session_id: 'group-session' } }), { status: 200 });
    }
    if (text.includes('/imchat/v1/channels')) {
      if (init?.method === 'DELETE') {
        calls.push('group:delete');
        return new Response('{}', { status: 200 });
      }
      calls.push('group:create');
      return new Response(JSON.stringify({ data: { channel_id: 'channel-1' } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  const deps: OneTimeDeps = {
    client,
    cookie: 'wps_sid=abc',
    base: 'https://lingxi.wps.cn',
    webSocket: fakeWebSocket(calls),
    warn: () => {},
  };

  return {
    deps,
    calls,
    statuses,
    chat,
    get runs() {
      return runs;
    },
  } as never;
}

/** 一个立刻成功的假 WebSocket。 */
function fakeWebSocket(calls: string[]): WebSocketFactory {
  return (() => {
    calls.push('ws');
    const socket = {
      onopen: undefined as undefined | (() => void),
      onmessage: undefined as undefined | ((event: { data: string }) => void),
      onerror: undefined as undefined | (() => void),
      onclose: undefined as undefined | (() => void),
      send() {
        calls.push('ws:send');
        // 收到 user.input 后立刻回一个 run.end。
        queueMicrotask(() => {
          socket.onmessage?.({ data: JSON.stringify({ event: 'run.end' }) });
        });
      },
      close() {
        calls.push('ws:close');
      },
    };
    queueMicrotask(() => {
      socket.onopen?.();
    });
    return socket as unknown as WebSocket;
  }) as WebSocketFactory;
}

test('needsFor：只挑 incomplete 且按 action / task_key 分类', () => {
  const needs = needsFor([
    { key: 'daily_check_in', status: 'claimable', type: 'daily' },
    { key: 'try_expert_mode', status: 'incomplete', type: 'one_time' },
    { key: 'try_group_chat', status: 'incomplete', type: 'one_time' },
    { key: 'use_lingxi_client', status: 'incomplete', type: 'one_time' },
    { key: 'try_expert_mode', status: 'claimed', type: 'one_time' },
  ]);
  assert.deepEqual(needs, { expert: true, client: true, group: true });
});

test('needsFor：上游给 action 时以 action 为准', () => {
  const needs = needsFor([
    { key: 'mystery', status: 'incomplete', type: 'one_time', action: 'group_chat' },
  ]);
  assert.deepEqual(needs, { expert: false, client: false, group: true });
});

test('needsFor：要专家必然要客户端（专家模式本身就是一次客户端对话）', () => {
  const needs = needsFor([
    { key: 'try_expert_mode', status: 'incomplete', type: 'one_time' },
  ]);
  assert.equal(needs.expert, true);
  assert.equal(needs.client, true);
  assert.equal(needs.group, false);
});

test('needsFor：全是 claimable 时什么都不用做', () => {
  assert.deepEqual(
    needsFor([
      { key: 'a', status: 'claimable', type: 'one_time' },
      { key: 'b', status: 'claimed', type: 'one_time' },
    ]),
    { expert: false, client: false, group: false },
  );
});

test('putExecutionStatus：running 带 lease_seconds，completed 带 terminal_reason', async () => {
  const h = harness();
  await putExecutionStatus(h.deps, { sessionId: 's1', groupId: 'g1' }, 'running');
  await putExecutionStatus(h.deps, { sessionId: 's1', groupId: 'g1' }, 'completed');
  assert.deepEqual(h.statuses, [
    { status: 'running', groupId: 'g1' },
    { status: 'completed', groupId: 'g1' },
  ]);

  const originalFetch = globalThis.fetch;
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  await putExecutionStatus(h.deps, { sessionId: 's1', groupId: 'g1' }, 'running');
  await putExecutionStatus(h.deps, { sessionId: 's1', groupId: 'g1' }, 'completed');
  globalThis.fetch = originalFetch;
  assert.equal((bodies[0] as { lease_seconds?: number }).lease_seconds, 90);
  assert.equal((bodies[1] as { terminal_reason?: string }).terminal_reason, 'completed');
});

test('putExecutionStatus：上报失败回报 ok:false 而不是抛', async () => {
  const h = harness({ statusOk: false });
  const result = await putExecutionStatus(h.deps, { sessionId: 's1', groupId: 'g1' }, 'running');
  assert.equal(result.ok, false);
  assert.match(result.detail ?? '', /execution_status/);
});

test('runTaskConversation：先报 running → 发对话 → 报 completed', async () => {
  const h = harness();
  const result = await runTaskConversation(h.deps, { expert: false });
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls, ['ensureRun', 'status:running', 'chat', 'status:completed']);
  assert.equal(result.sessionId, 'session-1');
});

test('runTaskConversation：对话失败也照样报 completed（会话必须收尾）', async () => {
  const h = harness({ chatOk: false });
  const result = await runTaskConversation(h.deps, { expert: false });
  assert.equal(result.ok, false);
  assert.match(result.detail, /HTTP 500/);
  assert.ok(h.calls.includes('status:completed'), '失败也要把会话标成 completed，否则它会一直挂着');
});

test('runGroupTask：会话 → WS 使用信号 → 建群 → 解散', async () => {
  const h = harness();
  const result = await runGroupTask(h.deps);
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls, [
    'group:session',
    'ws',
    'ws:send',
    'ws:close',
    'group:create',
    'group:delete',
  ]);
  assert.match(result.detail, /建群并解散/);
});

test('performOneTimeTasks：一次对话同时命中专家 + 客户端', async () => {
  const h = harness();
  const actions = await performOneTimeTasks(h.deps, { expert: true, client: true, group: false });
  assert.equal(h.runs, 1, '专家与客户端共用一次对话');
  assert.equal(actions.expert.ok, true);
  assert.equal(actions.client.ok, true);
  assert.equal(actions.group.ok, false);
  assert.ok(actions.notes.some((note) => note.includes('专家模式')));
});

test('performOneTimeTasks：余额为 0 时跳过所有消耗性动作', async () => {
  const h = harness();
  const actions = await performOneTimeTasks(
    h.deps,
    { expert: true, client: true, group: true },
    { balance: 0 },
  );
  assert.equal(h.runs, 0, '没钱时不发对话');
  assert.deepEqual(h.calls, [], '一个请求都不该发');
  assert.equal(actions.expert.ok, false);
  assert.ok(actions.notes.some((note) => note.includes('余额为 0')));
});

test('performOneTimeTasks：余额未知时不阻止（只是不知道，不是没钱）', async () => {
  const h = harness();
  await performOneTimeTasks(h.deps, { expert: false, client: true, group: false });
  assert.equal(h.runs, 1);
});

test('resolveWebSocketFactory：注入优先；运行时没有 WebSocket 时 undefined', () => {
  const injected = (() => ({}) as WebSocket) as WebSocketFactory;
  assert.equal(resolveWebSocketFactory(injected), injected);

  const holder = globalThis as { WebSocket?: unknown };
  const saved = holder.WebSocket;
  holder.WebSocket = undefined;
  assert.equal(resolveWebSocketFactory(), undefined);
  holder.WebSocket = saved;
});

test('runGroupTask：没有 WebSocket 时如实报错', async () => {
  const h = harness();
  const holder = globalThis as { WebSocket?: unknown };
  const saved = holder.WebSocket;
  holder.WebSocket = undefined;
  const result = await runGroupTask({ ...h.deps, webSocket: undefined });
  holder.WebSocket = saved;
  assert.equal(result.ok, false);
  assert.match(result.detail, /没有 WebSocket/);
});
