/**
 * 模型目录归一与静态兜底的单测。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dedupeModels,
  fromRawEntry,
  normalizeModelId,
  parsePlans,
  STATIC_CATALOG,
} from '../src/protocol/catalog.ts';

test('静态兜底是 14 个模型，id 唯一', () => {
  assert.equal(STATIC_CATALOG.length, 14);
  const ids = new Set(STATIC_CATALOG.map((model) => model.id));
  assert.equal(ids.size, 14);
});

test('模型 id 去前缀；default 与空串落到默认模型', () => {
  assert.equal(normalizeModelId('wps-lingxi/deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
  assert.equal(normalizeModelId('lingxi-kimi-k3'), 'kimi-k3');
  assert.equal(normalizeModelId('lingxi/kimi-k3'), 'kimi-k3');
  assert.equal(normalizeModelId('default'), 'deepseek-v4.1-flash');
  assert.equal(normalizeModelId(''), 'deepseek-v4.1-flash');
  assert.equal(normalizeModelId(undefined), 'deepseek-v4.1-flash');
  assert.equal(normalizeModelId('GLM-5.3'), 'GLM-5.3');
});

test('解析 /sessions/plans：先 plans 后 models，保留倍率与思考档', () => {
  const models = parsePlans({
    data: {
      plans: [
        { key: 'plan_pro', name: 'Pro 模式', max_context_tokens: 1048576, reasoning_efforts: ['low', 'high'] },
      ],
      models: [
        {
          key: 'deepseek-v4.1-flash',
          name: 'DeepSeek V4.1 Flash',
          multiplier: '0.12x',
          max_context_tokens: 1048576,
          max_new_tokens: 8192,
          support_multimodal: true,
        },
      ],
    },
  });
  assert.equal(models.length, 2);
  assert.equal(models[0]?.id, 'plan_pro');
  assert.deepEqual(models[0]?.reasoningEfforts, ['low', 'high']);
  assert.equal(models[1]?.id, 'deepseek-v4.1-flash');
  assert.equal(models[1]?.multiplier, '0.12x');
  assert.equal(models[1]?.maxTokens, 8192);
  assert.equal(models[1]?.vision, true);
});

test('解析失败或缺 data 时返回空数组（调用方回退静态表）', () => {
  assert.deepEqual(parsePlans(undefined), []);
  assert.deepEqual(parsePlans(null), []);
  assert.deepEqual(parsePlans({}), []);
  assert.deepEqual(parsePlans({ data: {} }), []);
  assert.deepEqual(parsePlans({ data: { plans: 'not-array' } }), []);
});

test('条目缺 key 被丢弃，其余字段缺省用兜底值', () => {
  const models = parsePlans({
    data: { models: [{} as Record<string, unknown>, { key: '  ', name: 'x' }, { key: 'a' }] },
  });
  assert.equal(models.length, 1);
  assert.equal(models[0]?.id, 'a');
  assert.equal(models[0]?.name, 'a');
  assert.equal(models[0]?.contextWindow, 1_048_576);
  assert.equal(models[0]?.maxTokens, 65_536);
});

test('fromRawEntry：非法数值回落，plan 的倍率缺省为「模式」', () => {
  const plan = fromRawEntry({ key: 'p', max_context_tokens: 'abc', max_new_tokens: -1 }, 'plan');
  assert.equal(plan?.contextWindow, 1_048_576);
  assert.equal(plan?.maxTokens, 65_536);
  assert.equal(plan?.multiplier, '模式');
  assert.equal(fromRawEntry({}, 'model'), undefined);
});

test('同名 id 去重，先出现者胜出', () => {
  const deduped = dedupeModels([
    { id: 'a', name: '一', contextWindow: 1, maxTokens: 1, multiplier: '', reasoning: true, vision: false },
    { id: 'a', name: '二', contextWindow: 2, maxTokens: 2, multiplier: '', reasoning: true, vision: false },
    { id: 'b', name: '三', contextWindow: 1, maxTokens: 1, multiplier: '', reasoning: true, vision: false },
  ]);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0]?.name, '一');
});
