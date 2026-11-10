/**
 * 账号池挑选规则的单测。
 *
 * 这些用例覆盖的都是**不写单测就一定会写错**的边界：
 * 空勾选名单、余额读不到、当前账号已被删除、池开关关着。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chosenFlags, pickAccount, type PoolCandidate } from '../src/host/pool.ts';

/** 造一个候选。 */
function candidate(
  id: string,
  credits: number | undefined,
  enabled = true,
): PoolCandidate {
  return { id, credits, enabled };
}

test('池是空的：不挑任何人', () => {
  const choice = pickAccount({ poolEnabled: true, currentId: undefined, candidates: [] });
  assert.equal(choice.id, undefined);
  assert.match(choice.reason, /空/);
});

test('池开关关着时用当前选用的，不看余额', () => {
  const choice = pickAccount({
    poolEnabled: false,
    currentId: 'a',
    candidates: [candidate('a', 10), candidate('b', 9999)],
  });
  assert.equal(choice.id, 'a', 'b 余额更高也不该被挑中');
});

test('池开关关着 + 当前选用已不存在：不静默换人', () => {
  const choice = pickAccount({
    poolEnabled: false,
    currentId: 'gone',
    candidates: [candidate('a', 10)],
  });
  assert.equal(choice.id, undefined, '换成 a 会让用户以为还在用原来那个');
  assert.match(choice.reason, /不在本机/);
});

test('池开关关着 + 从未选定：不挑人', () => {
  const choice = pickAccount({
    poolEnabled: false,
    currentId: undefined,
    candidates: [candidate('a', 10)],
  });
  assert.equal(choice.id, undefined);
});

test('池开着时挑勾选里余额最高的', () => {
  const choice = pickAccount({
    poolEnabled: true,
    currentId: 'a',
    candidates: [candidate('a', 10), candidate('b', 500), candidate('c', 100)],
  });
  assert.equal(choice.id, 'b');
  assert.match(choice.reason, /500/);
});

test('没勾选的账号余额再高也不碰', () => {
  const choice = pickAccount({
    poolEnabled: true,
    currentId: 'a',
    candidates: [candidate('a', 10, true), candidate('b', 99999, false)],
  });
  assert.equal(choice.id, 'a', 'b 没勾选，用户明确说别动它');
});

test('勾选名单是空的：什么都不挑（空 ≠ 全选）', () => {
  const choice = pickAccount({
    poolEnabled: true,
    currentId: 'a',
    candidates: [candidate('a', 10, false), candidate('b', 20, false)],
  });
  assert.equal(choice.id, undefined, '把空名单当全选，会让「取消勾选全部」反而全部启用');
  assert.match(choice.reason, /没有勾选/);
});

test('余额读不到不等于 0：仍留在候选里，但排在已知余额之后', () => {
  // 一次网络抖动不该把好账号踢出池子。
  const choice = pickAccount({
    poolEnabled: true,
    currentId: undefined,
    candidates: [candidate('unknown', undefined), candidate('known', 1)],
  });
  assert.equal(choice.id, 'known', '已知余额的优先');

  // 但如果只有余额未知的，仍然要挑它 —— 有账号可用比「不敢用」强。
  const onlyUnknown = pickAccount({
    poolEnabled: true,
    currentId: undefined,
    candidates: [candidate('unknown', undefined)],
  });
  assert.equal(onlyUnknown.id, 'unknown');
  assert.match(onlyUnknown.reason, /读不到/);
});

test('全部余额未知时按原顺序取第一个（结果稳定，不随机）', () => {
  const candidates = [candidate('x', undefined), candidate('y', undefined)];
  const first = pickAccount({ poolEnabled: true, currentId: undefined, candidates });
  const second = pickAccount({ poolEnabled: true, currentId: undefined, candidates });
  assert.equal(first.id, second.id, '同样输入必须给同样答案');
});

test('余额为 0 的账号仍然可用（0 是真的余额，不是读不到）', () => {
  const choice = pickAccount({
    poolEnabled: true,
    currentId: undefined,
    candidates: [candidate('zero', 0)],
  });
  assert.equal(choice.id, 'zero', '余额 0 与读不到是两件事');
});

test('chosenFlags 每个账号都有条目，且只有一个 true', () => {
  const flags = chosenFlags({
    poolEnabled: true,
    currentId: undefined,
    candidates: [candidate('a', 1), candidate('b', 2), candidate('c', 3, false)],
  });
  assert.deepEqual(Object.keys(flags).sort(), ['a', 'b', 'c']);
  assert.equal(flags.b, true);
  assert.equal(flags.a, false);
  assert.equal(flags.c, false);
});

test('没挑中任何人时 chosenFlags 全 false（界面不能凭空标一个「在用」）', () => {
  const flags = chosenFlags({
    poolEnabled: true,
    currentId: undefined,
    candidates: [candidate('a', 1, false)],
  });
  assert.equal(flags.a, false);
});
