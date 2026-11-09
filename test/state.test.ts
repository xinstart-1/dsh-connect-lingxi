/**
 * 插件状态文件的单元测试。
 *
 * 每个用例都把 `DSH_HOME` 指到一个临时目录，测完删掉——这个模块写的是
 * `$DSH_HOME/dsh-connect-lingxi-state.json`，跑测试绝不该碰到用户真实的那份。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  DEFAULT_STATE,
  POLL_INTERVAL_CHOICES,
  normalizeState,
  readState,
  statePath,
  writeState,
} from '../src/state.ts';

/** 每个用例一个临时 DSH_HOME。 */
const dirs: string[] = [];

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lingxi-state-'));
  dirs.push(dir);
  return { ...process.env, DSH_HOME: dir };
}

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

test('五档刷新间隔是 1/5/10/30/60 分钟', () => {
  assert.deepEqual([...POLL_INTERVAL_CHOICES], [60_000, 300_000, 600_000, 1_800_000, 3_600_000]);
});

test('默认状态：自动签到关、胶囊开、侧栏关、5 分钟', () => {
  assert.equal(DEFAULT_STATE.autoCheckin, false);
  assert.equal(DEFAULT_STATE.composerPill, true);
  assert.equal(DEFAULT_STATE.sidebarPanel, false);
  assert.equal(DEFAULT_STATE.pollIntervalMs, 300_000);
  assert.deepEqual(DEFAULT_STATE.disabledModels, []);
});

test('statePath 跟随 DSH_HOME', () => {
  assert.equal(
    statePath({ DSH_HOME: 'C:/x/dsh' } as NodeJS.ProcessEnv),
    join('C:/x/dsh', 'dsh-connect-lingxi-state.json'),
  );
});

test('文件不存在时读默认值', async () => {
  const env = await tempEnv();
  assert.deepEqual(await readState(env), { ...DEFAULT_STATE, disabledModels: [] });
});

test('坏 JSON 回落到默认值，不抛', async () => {
  const env = await tempEnv();
  await writeFile(statePath(env), '{ 这不是 JSON', 'utf8');
  assert.deepEqual(await readState(env), { ...DEFAULT_STATE, disabledModels: [] });
});

test('pollIntervalMs 只认五档，其余回落到默认', async () => {
  for (const bad of [0, 999, 1000, -1, Number.NaN]) {
    const env = await tempEnv();
    await writeFile(statePath(env), JSON.stringify({ pollIntervalMs: bad }), 'utf8');
    assert.equal((await readState(env)).pollIntervalMs, DEFAULT_STATE.pollIntervalMs);
  }
  // 字符串形式也不该被接受（上游是配置文件，不该靠隐式转换）。
  const env = await tempEnv();
  await writeFile(statePath(env), JSON.stringify({ pollIntervalMs: '600000' }), 'utf8');
  assert.equal((await readState(env)).pollIntervalMs, DEFAULT_STATE.pollIntervalMs);
});

test('归一化逐字段回落：一个字段坏掉不牵连其他字段', () => {
  const state = normalizeState({
    pollIntervalMs: 12345,
    autoCheckin: true,
    sidebarPanel: 'yes',
    disabledModels: ['kimi-k3', '', 42, null, 'GLM-5.3'],
  });
  assert.equal(state.pollIntervalMs, DEFAULT_STATE.pollIntervalMs);
  assert.equal(state.autoCheckin, true);
  assert.equal(state.sidebarPanel, DEFAULT_STATE.sidebarPanel);
  assert.deepEqual(state.disabledModels, ['kimi-k3', 'GLM-5.3']);
});

test('normalizeState 对任意坏输入返回默认值', () => {
  for (const bad of [null, undefined, 'garbage', 42, [], true]) {
    assert.doesNotThrow(() => normalizeState(bad));
    assert.deepEqual(normalizeState(bad), { ...DEFAULT_STATE, disabledModels: [] });
  }
});

test('写入后能读回，且只覆盖给出的字段', async () => {
  const env = await tempEnv();
  await writeState({ autoCheckin: true, pollIntervalMs: 600_000 }, env);
  const first = await readState(env);
  assert.equal(first.autoCheckin, true);
  assert.equal(first.pollIntervalMs, 600_000);
  // 未给的字段保留默认值。
  assert.equal(first.composerPill, true);

  const second = await writeState({ disabledModels: ['auto'] }, env);
  assert.equal(second.autoCheckin, true, 'patch 不应该把 autoCheckin 打回默认');
  assert.equal(second.pollIntervalMs, 600_000);
  assert.deepEqual(second.disabledModels, ['auto']);
});

test('写入是原子的：磁盘上不会留下半份 JSON', async () => {
  const env = await tempEnv();
  await writeState({ sidebarPanel: true }, env);
  const text = await readFile(statePath(env), 'utf8');
  assert.doesNotThrow(() => JSON.parse(text));
  assert.equal(JSON.parse(text).sidebarPanel, true);
  // 临时文件不该残留。
  const { readdir } = await import('node:fs/promises');
  const names = await readdir(join(statePath(env), '..'));
  assert.equal(
    names.some((name) => name.endsWith('.tmp')),
    false,
  );
});

test('写入非法的 pollIntervalMs 会被夹回默认值再落盘', async () => {
  const env = await tempEnv();
  const state = await writeState({ pollIntervalMs: 7 }, env);
  assert.equal(state.pollIntervalMs, DEFAULT_STATE.pollIntervalMs);
  assert.equal((await readState(env)).pollIntervalMs, DEFAULT_STATE.pollIntervalMs);
});
