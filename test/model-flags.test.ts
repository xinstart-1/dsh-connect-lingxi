/**
 * 逐模型开关（启用 / 图片）的判定规则。
 *
 * 规则只写一份、三处共用（DSH 选择器、`/status` 文档、卡片勾选框），
 * 所以这里钉的是「优先级」而不是某处界面的表现：
 * 用户明确关 > 用户明确开 > 上游声明。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageEnabled, visibleModels, withImageFlag } from '../src/host/model-flags.ts';
import type { LingxiModel } from '../src/protocol/catalog.ts';
import { defaultState } from '../src/state.ts';

function model(id: string, vision: boolean): LingxiModel {
  return {
    id,
    name: id,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    multiplier: '0.1x',
    reasoning: true,
    vision,
  };
}

test('没有用户意见时按上游声明', () => {
  const state = defaultState();
  assert.equal(imageEnabled(model('a', true), state), true);
  assert.equal(imageEnabled(model('b', false), state), false);
  assert.equal(imageEnabled(model('a', true), undefined), true);
});

test('用户明确关 > 上游声明', () => {
  const state = { ...defaultState(), imageOffModels: ['a'] };
  assert.equal(imageEnabled(model('a', true), state), false);
});

test('用户明确开 > 上游声明', () => {
  const state = { ...defaultState(), imageOnModels: ['b'] };
  assert.equal(imageEnabled(model('b', false), state), true);
});

test('两张名单冲突时「关」胜出（与 normalizeState 的去重一致）', () => {
  const state = { ...defaultState(), imageOffModels: ['a'], imageOnModels: ['a'] };
  assert.equal(imageEnabled(model('a', true), state), false);
});

test('withImageFlag 只在真的变了时造新对象（provider 快照按身份判变化）', () => {
  const state = defaultState();
  const same = model('a', true);
  assert.equal(withImageFlag(same, state), same, '没变化必须返回同一引用');
  const flipped = withImageFlag(model('a', true), { ...state, imageOffModels: ['a'] });
  assert.equal(flipped.vision, false);
});

test('visibleModels 同时过滤禁用名单并把图片开关落到 vision', () => {
  const state = {
    ...defaultState(),
    disabledModels: ['gone'],
    imageOffModels: ['a'],
    imageOnModels: ['c'],
  };
  const out = visibleModels([model('gone', true), model('a', true), model('b', false), model('c', false)], state);
  assert.deepEqual(
    out.map((item) => [item.id, item.vision]),
    [
      ['a', false],
      ['b', false],
      ['c', true],
    ],
  );
});

test('defaultState 每次返回独立数组，改一份不污染默认值', () => {
  const first = defaultState();
  first.disabledModels.push('x');
  first.imageOffModels.push('y');
  first.imageOnModels.push('z');
  const second = defaultState();
  assert.deepEqual(second.disabledModels, []);
  assert.deepEqual(second.imageOffModels, []);
  assert.deepEqual(second.imageOnModels, []);
});
