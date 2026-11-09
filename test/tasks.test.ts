/**
 * 任务中心解析的单元测试。
 *
 * 状态值、`check_in_days` 档位与领取响应形状都取自
 * `.reference/magpie-wps-lingxi-index.mjs`（1395-1440、1810-1850、2100-2160 行）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  beijingDate,
  claimDateOf,
  claimableOneTime,
  dailyTask,
  parseClaimResponse,
  parseTasks,
} from '../src/protocol/tasks.ts';

/** 一份真实形状的任务中心响应。 */
function payload(): unknown {
  return {
    code: 'Success',
    data: {
      tasks: [
        {
          task_key: 'daily_check_in',
          type: 'daily',
          status: 'claimable',
          reward_amount: 10,
          extra: {
            consecutive_days: 3,
            today_reward: 10,
            check_in_days: [
              { date: '2026-11-08', status: 'claimed' },
              { date: '2026-11-09', status: 'available' },
            ],
          },
        },
        { task_key: 'try_expert_mode', type: 'one_time', status: 'incomplete', reward_amount: 200 },
        { task_key: 'try_group_chat', type: 'one_time', status: 'claimable', reward_amount: 400 },
        { task_key: 'use_lingxi_client', type: 'one_time', status: 'claimed', reward_amount: 800 },
      ],
    },
  };
}

test('解析任务列表：数量、status 原样、奖励与连签', () => {
  const tasks = parseTasks(payload());
  assert.equal(tasks.length, 4);
  assert.equal(tasks[0]?.key, 'daily_check_in');
  assert.equal(tasks[0]?.status, 'claimable');
  assert.equal(tasks[0]?.reward, 10);
  assert.equal(tasks[0]?.streak, 3);
  assert.equal(tasks[0]?.days.length, 2);
  assert.equal(tasks[0]?.days[1]?.date, '2026-11-09');
  assert.equal(tasks[0]?.days[1]?.status, 'available');
});

test('title 兜底：上游没给时按 task_key 给中文名', () => {
  const tasks = parseTasks(payload());
  assert.equal(tasks[0]?.title, '每日签到');
  assert.equal(tasks[1]?.title, '体验灵犀专家模式');
  assert.equal(tasks[2]?.title, '体验群聊功能');
  assert.equal(tasks[3]?.title, '使用灵犀客户端');
  // 表外的 key 原样返回。
  assert.equal(parseTasks({ data: { tasks: [{ task_key: 'mystery' }] } })[0]?.title, 'mystery');
});

test('上游给了 title 就用上游的', () => {
  const tasks = parseTasks({ data: { tasks: [{ task_key: 'daily_check_in', title: '签到' }] } });
  assert.equal(tasks[0]?.title, '签到');
});

test('dailyTask 找每日签到', () => {
  const tasks = parseTasks(payload());
  assert.equal(dailyTask(tasks)?.key, 'daily_check_in');
  assert.equal(dailyTask([]), undefined);
});

test('claimableOneTime 只挑 claimable 的一次性任务', () => {
  const tasks = parseTasks(payload());
  const pending = claimableOneTime(tasks);
  assert.equal(pending.length, 1);
  // incomplete 与 claimed 都不算；每日签到也不算。
  assert.equal(pending[0]?.key, 'try_group_chat');
});

test('claimDateOf：优先今天，其次 available，最后原样发今天', () => {
  const tasks = parseTasks(payload());
  const daily = dailyTask(tasks);
  // 档位里没有今天 → 用第一个 available 的日期。
  assert.equal(claimDateOf(daily, '2026-11-20'), '2026-11-09');
  // 档位里有今天 → 用今天。
  assert.equal(claimDateOf(daily, '2026-11-09'), '2026-11-09');
  // 没有档位 → 原样。
  assert.equal(claimDateOf(undefined, '2026-11-09'), '2026-11-09');
  assert.equal(
    claimDateOf({ key: 'daily_check_in', type: 'daily', title: '', status: '', reward: 0, days: [] }, '2026-11-09'),
    '2026-11-09',
  );
});

test('parseClaimResponse：成功取 today_reward', () => {
  const outcome = parseClaimResponse(
    { result: 'ok', data: { reward_amount: 10, extra: { today_reward: 12 } } },
    10,
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.reward, 12);
  assert.equal(outcome.alreadyDone, false);
});

test('parseClaimResponse：成功但没有奖励时回落到任务声明的数', () => {
  assert.equal(parseClaimResponse({ result: 'ok' }, 55).reward, 55);
  assert.equal(parseClaimResponse({ result: 'ok', data: { reward_amount: 30 } }, 55).reward, 30);
});

test('parseClaimResponse：result 缺失按成功（HTTP 200 已是成功信号）', () => {
  const outcome = parseClaimResponse({ data: { reward_amount: 7 } }, 1);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.reward, 7);
});

test('parseClaimResponse：上游说已领过 → alreadyDone，不算失败', () => {
  const outcome = parseClaimResponse({ result: 'claimed', hint: '今日已签到' }, 10);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.alreadyDone, true);
  assert.equal(outcome.reward, 0);
  assert.equal(outcome.message, '今日已签到');
});

test('parseClaimResponse：真失败带原文 hint', () => {
  const outcome = parseClaimResponse({ result: 'forbidden', hint: '活动已结束' }, 10);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.message, '活动已结束');
  // 没有 hint 时用 result 拼一句。
  assert.equal(parseClaimResponse({ result: 'forbidden' }, 0).message, '领取失败：forbidden');
});

test('parseTasks 对任意坏输入不抛且返回空数组', () => {
  for (const bad of [null, undefined, 'garbage', 42, [], {}, { data: null }, { data: { tasks: 'x' } }]) {
    assert.doesNotThrow(() => parseTasks(bad));
    assert.deepEqual(parseTasks(bad), []);
  }
});

test('坏任务条目被跳过，好条目保留', () => {
  const tasks = parseTasks({
    data: { tasks: [null, {}, { task_key: '' }, { task_key: 'ok', status: 'claimable' }] },
  });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.key, 'ok');
});

test('parseClaimResponse 对任意坏输入按成功处理（不误报失败）', () => {
  assert.equal(parseClaimResponse(null, 3).ok, true);
  assert.equal(parseClaimResponse('garbage', 3).reward, 3);
});

test('beijingDate 按北京时间取日期（跨零点不串天）', () => {
  // 北京时间 2026-11-09 00:30 → UTC 还是 11-08，必须是 11-09。
  assert.equal(beijingDate(Date.parse('2026-11-09T00:30:00+08:00')), '2026-11-09');
  // 北京时间 2026-11-09 23:30 → UTC 是 11-09 15:30，仍是 11-09。
  assert.equal(beijingDate(Date.parse('2026-11-09T23:30:00+08:00')), '2026-11-09');
  // 北京时间 2026-01-01 00:00 → 跨年也对。
  assert.equal(beijingDate(Date.parse('2026-01-01T00:00:00+08:00')), '2026-01-01');
});
