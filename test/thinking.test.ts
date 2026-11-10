/**
 * 思考档位翻译的单测。
 *
 * 要钉住的性质：**上游声明几档就露几档**，没声明的档位必须显式是 `null`
 * （不提供），而不是靠 pi-ai 的默认规则 —— 它对基础档和 `xhigh`/`max`
 * 的缺键语义是相反的，靠默认值一定会错。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { thinkingLevelMapFor } from '../src/llm/thinking.ts';
import type { LingxiModel } from '../src/protocol/catalog.ts';

/** 造一个最小目录条目。 */
function model(overrides: Partial<LingxiModel> = {}): LingxiModel {
  return {
    id: 'm',
    name: 'M',
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    multiplier: '1x',
    reasoning: true,
    vision: false,
    ...overrides,
  };
}

test('官网三档：低/高/超高 → 只开 low/high/max，其余为 null', () => {
  const map = thinkingLevelMapFor(model({ reasoningEfforts: ['low', 'high', 'max'] }));
  assert.ok(map !== undefined);
  assert.equal(map.low, 'low');
  assert.equal(map.high, 'high');
  assert.equal(map.max, 'max');
  // 官网没有这两档，必须显式不提供（不是「靠默认」）。
  assert.equal(map.medium, null);
  assert.equal(map.xhigh, null);
  // off 不在上游声明里，也不提供 —— 免得界面上出现一个点了不生效的关。
  assert.equal(map.off, null);
});

test('非思考模型不给档位（不写这个字段，界面就不显示思考控件）', () => {
  assert.equal(thinkingLevelMapFor(model({ reasoning: false, reasoningEfforts: ['low'] })), undefined);
});

test('上游没声明档位时回退到七档映射（保守，登录后会被真实目录覆盖）', () => {
  const map = thinkingLevelMapFor(model());
  assert.ok(map !== undefined);
  assert.equal(map.low, 'low');
  assert.equal(map.high, 'high');
  assert.equal(map.max, 'max');
});

test('中文档位名也认（超高 = max）', () => {
  const map = thinkingLevelMapFor(model({ reasoningEfforts: ['低', '高', '超高'] }));
  assert.ok(map !== undefined);
  assert.equal(map.low, 'low');
  assert.equal(map.high, 'high');
  assert.equal(map.max, 'max');
});

test('认不出的拼法被忽略，不会伪造出一个档位', () => {
  const map = thinkingLevelMapFor(model({ reasoningEfforts: ['low', '不存在的档'] }));
  assert.ok(map !== undefined);
  assert.equal(map.low, 'low');
  assert.equal(map.high, null);
  assert.equal(map.max, null);
});

test('只有 off 的上游声明视为「没有思考能力」', () => {
  // 否则界面会留一个只有 Off 的假开关。
  assert.equal(thinkingLevelMapFor(model({ reasoningEfforts: ['off'] })), undefined);
});

test('空数组按「没声明」处理，回退七档', () => {
  const map = thinkingLevelMapFor(model({ reasoningEfforts: [] }));
  assert.ok(map !== undefined);
  assert.equal(map.max, 'max');
});

test('绝不出现「选了中档实际发高档」的静默替换', () => {
  // 上游没声明 medium 时它就是 null；声明了才映射成它自己。
  const withoutMedium = thinkingLevelMapFor(model({ reasoningEfforts: ['low', 'high'] }));
  assert.equal(withoutMedium?.medium, null);

  const withMedium = thinkingLevelMapFor(model({ reasoningEfforts: ['low', 'medium', 'high'] }));
  assert.equal(withMedium?.medium, 'medium');
});
