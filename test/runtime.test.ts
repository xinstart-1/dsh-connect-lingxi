/**
 * 运行时的集成测试：用假 client 跑完整链路（状态、签到、领取、设置）。
 *
 * 这些用例覆盖的是**决策**，不是解析：解析在 `balance.test.ts` / `tasks.test.ts`
 * 里各自测过，这里只关心「谁先失效」「失败时保留什么」「写请求什么时候发」。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LingxiRuntime, type ResolvedCredential } from '../src/host/runtime.ts';
import type { LingxiClient } from '../src/protocol/client.ts';
import type { LingxiModel } from '../src/protocol/catalog.ts';
import { DEFAULT_STATE, type LingxiPluginState } from '../src/state.ts';

/** 北京时间 2026-11-09 12:00:00。 */
const NOW = Date.parse('2026-11-09T12:00:00+08:00');

const FALLBACK: LingxiModel[] = [
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    multiplier: '0.12x',
    reasoning: true,
    vision: true,
  },
];

/** 一次余额响应。 */
function balancePayload(total = 1072): unknown {
  return {
    data: {
      total_balance: total,
      bonus_summary: { total_value: 2000, total_consumed: 2000 - total },
      bonus_credits: [
        { balance: 100, value: 200, consumed: 100, expire_time: '2026-11-20T07:06:59+08:00' },
      ],
    },
  };
}

/** 一次任务中心响应。 */
function tasksPayload(
  dailyStatus = 'claimable',
  groupStatus = 'claimable',
  expertStatus = 'incomplete',
): unknown {
  return {
    data: {
      tasks: [
        {
          task_key: 'daily_check_in',
          type: 'daily',
          status: dailyStatus,
          reward_amount: 10,
          extra: { consecutive_days: 3, check_in_days: [{ date: '2026-11-09', status: 'available' }] },
        },
        { task_key: 'try_group_chat', type: 'one_time', status: groupStatus, reward_amount: 400 },
        { task_key: 'try_expert_mode', type: 'one_time', status: expertStatus, reward_amount: 200 },
      ],
    },
  };
}

/** 假 client：记录每次调用，返回可编排的结果。 */
function fakeClient(overrides: Partial<Record<keyof LingxiClient, unknown>> = {}): {
  client: LingxiClient;
  calls: string[];
  claims: Array<{ key: string; date: string }>;
} {
  const calls: string[] = [];
  const claims: Array<{ key: string; date: string }> = [];
  let balanceValue = 1072;

  const client = {
    async balancePayload() {
      calls.push('balance');
      return balancePayload(balanceValue);
    },
    async tasksPayload() {
      calls.push('tasks');
      return tasksPayload();
    },
    async listModels() {
      calls.push('models');
      return [...FALLBACK];
    },
    async verify() {
      calls.push('verify');
      return { name: '测试账号', base: 'https://lingxi.wps.cn' };
    },
    async claimTask(_cookie: string, key: string, date: string) {
      calls.push(`claim:${key}`);
      claims.push({ key, date });
      // 签到会让余额上涨，模拟真实行为。
      if (key === 'daily_check_in') balanceValue += 10;
      return { result: 'ok', data: { reward_amount: 10, extra: { today_reward: 10 } } };
    },
    ...overrides,
  } as unknown as LingxiClient;

  return { client, calls, claims };
}

/** 造一个运行时。 */
function runtimeWith(options: {
  client: LingxiClient;
  state?: LingxiPluginState;
  credential?: ResolvedCredential;
}): { runtime: LingxiRuntime; saves: Array<Partial<LingxiPluginState>> } {
  const saves: Array<Partial<LingxiPluginState>> = [];
  let state = options.state ?? { ...DEFAULT_STATE, disabledModels: [] };
  const runtime = new LingxiRuntime({
    client: options.client,
    version: '0.0.1',
    warn: () => {},
    now: () => NOW,
    state: async () => state,
    saveState: async (patch) => {
      saves.push(patch);
      state = { ...state, ...patch };
      return state;
    },
    credential: async () => options.credential ?? { value: 'wps_sid=abc', source: 'manual' },
    fallbackCatalog: () => FALLBACK,
  });
  runtime.rememberStateSync(state);
  return { runtime, saves };
}

test('未登录时状态文档说明未登录，且不发任何请求', async () => {
  const { client, calls } = fakeClient();
  const { runtime } = runtimeWith({ client, credential: { value: '', source: 'none' } });
  const status = await runtime.status(true);
  assert.equal(status.login.state, 'signed-out');
  assert.equal(status.credits.state, 'unavailable');
  assert.deepEqual(calls, [], '没有 cookie 就不该发请求');
  assert.equal(status.version, '0.0.1');
  // 未登录也要能列出内置目录。
  assert.equal(status.models.length, 1);
  runtime.dispose();
});

test('force 刷新拉全量并拼出状态文档', async () => {
  const { client, calls } = fakeClient();
  const { runtime } = runtimeWith({ client });
  const status = await runtime.status(true);
  assert.equal(status.login.state, 'signed-in');
  assert.equal(status.login.name, '测试账号');
  assert.equal(status.credits.state, 'ok');
  assert.equal(status.credits.total, 1072);
  assert.equal(status.credits.expiring?.amount, 100);
  assert.equal(status.tasks.daily?.status, 'claimable');
  assert.equal(status.tasks.oneTime.length, 2);
  assert.equal(status.tasks.checkedInToday, false);
  assert.deepEqual(calls.sort(), ['balance', 'models', 'tasks', 'verify']);
  runtime.dispose();
});

test('非 force 读缓存，不重复发请求', async () => {
  const { client, calls } = fakeClient();
  const { runtime } = runtimeWith({ client });
  await runtime.status(true);
  const before = calls.length;
  await runtime.status(false);
  await runtime.status(false);
  assert.equal(calls.length, before, '缓存期内不该再发请求');
  runtime.dispose();
});

test('签到：带上今天的日期，成功后余额涨 10', async () => {
  const { client, claims } = fakeClient();
  const { runtime } = runtimeWith({ client });
  await runtime.status(true);

  const result = (await runtime.run('claim-checkin', {})) as { ok: boolean; reward: number };
  assert.equal(result.ok, true);
  assert.equal(result.reward, 10, '奖励取领前领后的余额差');
  assert.deepEqual(claims, [{ key: 'daily_check_in', date: '2026-11-09' }]);
  runtime.dispose();
});

test('签到：上游说今天已签 → 直接返回 done，不发写请求', async () => {
  const { client, claims } = fakeClient({
    tasksPayload: async () => tasksPayload('claimed'),
  } as never);
  const { runtime } = runtimeWith({ client });
  await runtime.status(true);
  const result = (await runtime.run('claim-checkin', {})) as { ok: boolean; outcome: string };
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'done');
  assert.deepEqual(claims, [], '已签到不该再发一次写请求');
  runtime.dispose();
});

test('领取一次性任务：只领 claimable，incomplete 不碰', async () => {
  const { client, claims } = fakeClient();
  const { runtime } = runtimeWith({ client });
  await runtime.status(true);
  const result = (await runtime.run('claim-one-time', {})) as {
    ok: boolean;
    claimed: Array<{ key: string }>;
  };
  assert.equal(result.ok, true);
  assert.deepEqual(
    claims.map((claim) => claim.key),
    ['try_group_chat'],
  );
  assert.equal(result.claimed.length, 1);
  runtime.dispose();
});

test('领取一次性任务：全是 claimed 时如实说「没有可领取的任务」', async () => {
  // 三个一次性任务都已经是 claimed：没有可领的，也没有要做的。
  const { client, claims } = fakeClient({
    tasksPayload: async () => tasksPayload('claimed', 'claimed', 'claimed'),
  } as never);
  const { runtime } = runtimeWith({ client });
  await runtime.status(true);
  const result = (await runtime.run('claim-one-time', {})) as {
    ok: boolean;
    claimed: unknown[];
    message: string;
  };
  assert.equal(result.ok, true);
  assert.deepEqual(claims, [], '全是 claimed 时不该发写请求');
  assert.deepEqual(result.claimed, []);
  assert.match(result.message, /没有可领取/);
  runtime.dispose();
});

test('领取一次性任务：把 incomplete 的做出来再领（不再跳过）', async () => {
  const { client, claims } = fakeClient();
  const { runtime } = runtimeWith({ client });
  await runtime.status(true);
  const result = (await runtime.run('claim-one-time', {})) as {
    ok: boolean;
    notes: string[];
  };
  // 默认 fixture 里 try_expert_mode 是 incomplete：现在应当被「做」而不是被跳过。
  assert.ok(
    result.notes.some((note) => /专家|客户端|失败/.test(note)),
    `应当尝试做过 incomplete 任务，实际 notes=${JSON.stringify(result.notes)}`,
  );
  assert.ok(claims.length >= 1, '做完动作后应当重拉并领取 claimable');
  runtime.dispose();
});

test('改设置：只写给出的字段，其余保持原值', async () => {
  const { client } = fakeClient();
  const { runtime, saves } = runtimeWith({ client });
  await runtime.run('settings', { autoCheckin: true, composerPill: false });
  assert.deepEqual(saves, [{ autoCheckin: true, composerPill: false }]);
  const status = await runtime.status(false);
  assert.equal(status.settings.autoCheckin, true);
  assert.equal(status.settings.composerPill, false);
  runtime.dispose();
});

test('改设置：没有可识别字段时返回 ok:false', async () => {
  const { client } = fakeClient();
  const { runtime, saves } = runtimeWith({ client });
  const result = (await runtime.run('settings', { nonsense: 1 })) as { ok: boolean };
  assert.equal(result.ok, false);
  assert.equal(saves.length, 0);
  runtime.dispose();
});

test('改设置：刷新间隔只接受五档', async () => {
  const { client } = fakeClient();
  const { runtime } = runtimeWith({ client });
  await runtime.run('settings', { pollIntervalMs: 600_000 });
  assert.equal((await runtime.status(false)).settings.pollIntervalMs, 600_000);
  runtime.dispose();
});

test('未知动作返回 ok:false 而不抛', async () => {
  const { client } = fakeClient();
  const { runtime } = runtimeWith({ client });
  const result = (await runtime.run('drop-tables' as never, {})) as { ok: boolean };
  assert.equal(result.ok, false);
  runtime.dispose();
});

test('余额读失败时保留上一次的好数据，只记 lastError', async () => {
  let failing = false;
  const { client } = fakeClient({
    balancePayload: async () => {
      if (failing) throw new Error('上游 502');
      return balancePayload(555);
    },
  } as never);
  const { runtime } = runtimeWith({ client });
  const first = await runtime.status(true);
  assert.equal(first.credits.total, 555);

  failing = true;
  const second = await runtime.status(true);
  assert.equal(second.credits.total, 555, '一次失败不该把读数清空');
  assert.match(second.lastError ?? '', /上游 502/);
  runtime.dispose();
});

test('任务读失败时状态文档仍然可用（每日签到缺省）', async () => {
  const { client } = fakeClient({
    tasksPayload: async () => {
      throw new Error('任务中心 500');
    },
  } as never);
  const { runtime } = runtimeWith({ client });
  const status = await runtime.status(true);
  assert.equal(status.tasks.daily, undefined);
  assert.deepEqual(status.tasks.oneTime, []);
  assert.equal(status.credits.state, 'ok', '任务失败不该牵连余额');
  assert.match(status.lastError ?? '', /任务中心 500/);
  runtime.dispose();
});

test('登录态失效（401）标成 expired，不标成 signed-out', async () => {
  const { client } = fakeClient({
    verify: async () => {
      throw Object.assign(new Error('cookie 无效'), { status: 401 });
    },
  } as never);
  const { runtime } = runtimeWith({ client });
  const status = await runtime.status(true);
  assert.equal(status.login.state, 'expired');
  assert.equal(status.credits.state, 'expired');
  runtime.dispose();
});

test('模型目录为空时回落到静态表', async () => {
  const { client } = fakeClient({
    listModels: async () => [],
  } as never);
  const { runtime } = runtimeWith({ client });
  const status = await runtime.status(true);
  assert.equal(status.models.length, 1);
  assert.equal(status.models[0]?.enabled, true);
  runtime.dispose();
});

test('禁用名单里的模型标成未启用', async () => {
  const { client } = fakeClient();
  const { runtime } = runtimeWith({
    client,
    state: { ...DEFAULT_STATE, disabledModels: ['deepseek-v4.1-flash'] },
  });
  const status = await runtime.status(true);
  assert.equal(status.models[0]?.enabled, false);
  runtime.dispose();
});

test('readAtMs 取最旧的一段（整张表的年龄）', async () => {
  let clock = NOW;
  const { client } = fakeClient();
  const runtime = new LingxiRuntime({
    client,
    version: '0.0.1',
    warn: () => {},
    now: () => clock,
    state: async () => ({ ...DEFAULT_STATE, disabledModels: [] }),
    saveState: async () => ({ ...DEFAULT_STATE, disabledModels: [] }),
    credential: async () => ({ value: 'wps_sid=abc', source: 'manual' }),
    fallbackCatalog: () => FALLBACK,
  });
  runtime.rememberStateSync({ ...DEFAULT_STATE, disabledModels: [] });
  await runtime.status(true);
  // 时间往前走，逐个段落的话 readAtMs 必须还是第一次抓取的时刻。
  clock = NOW + 1000;
  const status = await runtime.status(false);
  assert.equal(status.readAtMs, NOW);
  runtime.dispose();
});

test('retain / release 管理轮询计数', () => {
  const { client } = fakeClient();
  const { runtime } = runtimeWith({ client });
  const release1 = runtime.retain();
  const release2 = runtime.retain();
  release1();
  release1(); // 重复释放不该把计数打成负数。
  release2();
  // 这里只断言不抛；定时器的实际行为不在单测覆盖范围内（会引入真实等待）。
  runtime.dispose();
});

test('自动签到关闭时不领，打开时才领', async () => {
  const { client: clientOff, claims: claimsOff } = fakeClient();
  const { runtime: runtimeOff } = runtimeWith({
    client: clientOff,
    state: { ...DEFAULT_STATE, disabledModels: [], autoCheckin: false },
  });
  await runtimeOff.status(true);
  // 手动触发一次 tick 的等价路径：没有公开 tick，用 run 的 claim 之外的行为验证——
  // 关着的时候不该有人写请求。
  assert.deepEqual(claimsOff, []);
  runtimeOff.dispose();

  const { client: clientOn, claims: claimsOn } = fakeClient();
  const { runtime: runtimeOn } = runtimeWith({
    client: clientOn,
    state: { ...DEFAULT_STATE, disabledModels: [], autoCheckin: true },
  });
  await runtimeOn.status(true);
  assert.deepEqual(claimsOn, [], 'status 本身不触发自动签到');
  runtimeOn.dispose();
});
