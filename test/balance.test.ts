/**
 * 余额解析的单元测试。
 *
 * 样例值取自 `.reference/magpie-wps-lingxi-index.mjs` 的取证代码（2205-2250 行），
 * 那是唯一跑过真机的余额解析来源。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EXPIRING_WINDOW_MS,
  creditDateLabel,
  parseBalance,
  parseUpstreamTime,
} from '../src/protocol/balance.ts';

/** 北京时间 2026-11-09 12:00:00。 */
const NOW = Date.parse('2026-11-09T12:00:00+08:00');

/** 一份真实形状的余额响应（额度型账号：赠送批次 + 汇总）。 */
function payload(): unknown {
  return {
    code: 'Success',
    data: {
      total_balance: 1072,
      balance: 1072,
      bonus_summary: { total_value: 2000, total_consumed: 928 },
      bonus_credits: [
        { balance: 100, value: 200, consumed: 100, expire_time: '2026-11-20T07:06:59+08:00' },
        { balance: 972, value: 1800, consumed: 828, expire_time: '2026-12-31 23:59:59' },
      ],
    },
  };
}

test('解析完整余额：总额、已用、批次', () => {
  const summary = parseBalance(payload(), NOW);
  assert.ok(summary !== undefined);
  assert.equal(summary.total, 1072);
  assert.equal(summary.totalValue, 2000);
  assert.equal(summary.consumed, 928);
  assert.equal(summary.batches.length, 2);
  assert.equal(summary.batches[0]?.balance, 100);
  assert.equal(summary.batches[1]?.value, 1800);
  assert.equal(summary.updatedAtMs, NOW);
});

test('15 天窗口只算即将到期的那一批，最早到期时间正确', () => {
  const summary = parseBalance(payload(), NOW);
  assert.ok(summary?.expiring !== undefined);
  // 11-20 距 11-09 只有 11 天，在窗口内；12-31 在窗口外。
  assert.equal(summary.expiring.amount, 100);
  assert.equal(summary.expiring.earliest, '2026-11-20T07:06:59+08:00');
});

test('窗口边界：正好 14 天算、16 天不算、已过期不算', () => {
  const make = (expire: string, balance: number): unknown => ({
    data: {
      total_balance: balance,
      bonus_credits: [{ balance, value: balance, consumed: 0, expire_time: expire }],
    },
  });
  const at = (days: number): string =>
    new Date(NOW + days * 24 * 60 * 60 * 1000).toISOString();

  assert.equal(parseBalance(make(at(14), 50), NOW)?.expiring?.amount, 50);
  assert.equal(parseBalance(make(at(16), 50), NOW)?.expiring, undefined);
  assert.equal(parseBalance(make(at(-1), 50), NOW)?.expiring, undefined);
});

test('EXPIRING_WINDOW_MS 是 15 天', () => {
  assert.equal(EXPIRING_WINDOW_MS, 15 * 24 * 60 * 60 * 1000);
});

test('total_balance 缺失时回退 balance；两者都缺则 undefined', () => {
  assert.equal(parseBalance({ data: { balance: 88 } }, NOW)?.total, 88);
  assert.equal(parseBalance({ data: { total_balance: 99 } }, NOW)?.total, 99);
  assert.equal(parseBalance({ data: {} }, NOW), undefined);
});

test('批次来源：bonus_credits 优先于 bonus_summary.items', () => {
  const both: unknown = {
    data: {
      total_balance: 10,
      bonus_credits: [{ balance: 7, value: 7, consumed: 0 }],
      bonus_summary: { total_value: 20, total_consumed: 13, items: [{ balance: 999 }] },
    },
  };
  const summary = parseBalance(both, NOW);
  assert.equal(summary?.batches.length, 1);
  assert.equal(summary?.batches[0]?.balance, 7);
});

test('bonus_credits 缺失时用 bonus_summary.items', () => {
  const only: unknown = {
    data: { total_balance: 10, bonus_summary: { total_value: 30, items: [{ balance: 5, value: 30 }] } },
  };
  const summary = parseBalance(only, NOW);
  assert.equal(summary?.batches.length, 1);
  assert.equal(summary?.batches[0]?.balance, 5);
  // consumed 缺失按 max(0, value - balance) 补。
  assert.equal(summary?.batches[0]?.consumed, 25);
});

test('非法批次被整条丢掉（NaN / 负数 / 非对象）', () => {
  const dirty: unknown = {
    data: {
      total_balance: 100,
      bonus_credits: [
        { balance: Number.NaN },
        { balance: -5 },
        null,
        'garbage',
        { balance: 30, value: 30, consumed: 0, expire_time: 'nonsense' },
      ],
    },
  };
  const summary = parseBalance(dirty, NOW);
  assert.equal(summary?.batches.length, 1);
  assert.equal(summary?.batches[0]?.balance, 30);
  // expire_time 认不出来：批次留着，但没有 expireAtMs，也不进 expiring。
  assert.equal(summary?.batches[0]?.expireAtMs, undefined);
  assert.equal(summary?.expiring, undefined);
});

test('任意坏输入都不抛，返回 undefined', () => {
  for (const bad of [null, undefined, 'garbage', 42, [], {}, { data: null }, { data: 'x' }]) {
    assert.doesNotThrow(() => parseBalance(bad, NOW));
    assert.equal(parseBalance(bad, NOW), undefined);
  }
});

test('parseUpstreamTime：无时区的上游时间按 +08:00 解释', () => {
  const ms = parseUpstreamTime('2026-11-30 07:06:59');
  assert.equal(ms, Date.parse('2026-11-30T07:06:59+08:00'));
  // 同一个串在 UTC 解释下会差 8 小时，确认没有走本机时区。
  assert.equal(ms! - Date.parse('2026-11-30T07:06:59Z'), -8 * 60 * 60 * 1000);
});

test('parseUpstreamTime：缺秒补 :00，只到日补零点', () => {
  assert.equal(parseUpstreamTime('2026-11-30 07:06'), Date.parse('2026-11-30T07:06:00+08:00'));
  assert.equal(parseUpstreamTime('2026-11-30'), Date.parse('2026-11-30T00:00:00+08:00'));
});

test('parseUpstreamTime：带时区的 ISO 按自带时区', () => {
  assert.equal(
    parseUpstreamTime('2026-11-30T07:06:59+08:00'),
    Date.parse('2026-11-30T07:06:59+08:00'),
  );
  assert.equal(parseUpstreamTime('2026-11-30T00:00:00Z'), Date.parse('2026-11-30T00:00:00Z'));
});

test('parseUpstreamTime：非法输入返回 undefined', () => {
  for (const bad of ['', '  ', 'nonsense', undefined, null, 42, '2026-13-99']) {
    assert.equal(parseUpstreamTime(bad), undefined);
  }
});

test('creditDateLabel 取月-日，认不出来原样返回', () => {
  assert.equal(creditDateLabel('2026-11-30T07:06:59+08:00'), '11-30');
  assert.equal(creditDateLabel('2026-01-02 03:04:05'), '01-02');
  assert.equal(creditDateLabel('soon'), 'soon');
});
