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
import { badgeText, modelDescription, toLlmModelInfos } from '../src/llm/adapter.ts';

test('静态兜底与官网清单一致：11 个模型 + 2 个模式，id 唯一', () => {
  // 这张表是「模型展示与官网同步」的唯一事实来源，条数变化必须是有意的。
  assert.equal(STATIC_CATALOG.length, 13);
  const ids = new Set(STATIC_CATALOG.map((model) => model.id));
  assert.equal(ids.size, 13);
});

test('官网的徽标与模式说明都在静态兜底里', () => {
  const byId = new Map(STATIC_CATALOG.map((model) => [model.id, model]));
  // 官网截图上的三个徽标：NEW / 正式版 / 首发接入。
  assert.equal(byId.get('deepseek-v4.1-flash')?.badge, 'NEW');
  assert.equal(byId.get('deepseek-v4-pro-0813')?.badge, '正式版');
  assert.equal(byId.get('GLM-5.3-Flash')?.badge, '首发接入');
  assert.equal(byId.get('GLM-5.3')?.badge, '首发接入');
  assert.equal(byId.get('kimi-k3.1-pro')?.badge, 'NEW');
  // 两个模式的说明就是官网那两句。
  assert.match(byId.get('plan_pro')?.description ?? '', /日常任务/);
  assert.match(byId.get('plan_max')?.description ?? '', /复杂任务/);
});

test('官网列表里没有的模型不该出现在兜底表（否则用户以为插件在瞎编）', () => {
  const ids = STATIC_CATALOG.map((model) => model.id);
  assert.equal(ids.includes('auto'), false, '官网没有「自动推荐」');
  assert.equal(ids.includes('deepseek-v4-flash-0731'), false, '官网没有 V4 Flash');
  assert.ok(ids.includes('kimi-k3.1-pro'), '官网有 Kimi-K3.1 Pro，兜底表也必须补上');
});

test('倍率照抄官网原文：带 ~ 的是折扣价，不许自己算成确定值', () => {
  const byId = new Map(STATIC_CATALOG.map((model) => [model.id, model]));
  assert.equal(byId.get('deepseek-v4.1-flash')?.multiplier, '~0.12x');
  assert.equal(byId.get('deepseek-v4-pro-0813')?.multiplier, '0.40x');
  assert.equal(byId.get('kimi-k3')?.multiplier, '1.60x');
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
  // 兜底值跟着上游实测值走：上游 max_new_tokens 的常见值是 131072。
  assert.equal(models[0]?.maxTokens, 131_072);
});

test('fromRawEntry：非法数值回落，没有倍率就是空串（不是把名字当倍率）', () => {
  const plan = fromRawEntry({ key: 'p', max_context_tokens: 'abc', max_new_tokens: -1 }, 'plan');
  assert.equal(plan?.contextWindow, 1_048_576);
  assert.equal(plan?.maxTokens, 131_072);
  // 0.0.12 及以前这里回落成「模式」，界面于是渲染「倍率 模式」。
  assert.equal(plan?.multiplier, '');
  assert.equal(fromRawEntry({}, 'model'), undefined);
});

test('倍率为空串的上游条目不会渲染出「倍率」字样', () => {
  const plan = fromRawEntry({ key: 'plan_pro', name: 'Pro 模式', multiplier: '' }, 'plan');
  assert.equal(plan?.multiplier, '');
});

test('思考能力以上游声明为准：没有 reasoning_efforts 就没有思考开关', () => {
  // 实测 mimo-v2.6-pro / minimax_m3 / plan_* 都不给 reasoning_efforts。
  const plain = fromRawEntry({ key: 'mimo-v2.6-pro', name: 'MiMo' }, 'model');
  assert.equal(plain?.reasoning, false);
  assert.equal(plain?.reasoningEfforts, undefined);

  const thinking = fromRawEntry(
    { key: 'kimi-k3', name: 'Kimi', reasoning_efforts: ['low', 'high', 'max'] },
    'model',
  );
  assert.equal(thinking?.reasoning, true);
  assert.deepEqual(thinking?.reasoningEfforts, ['low', 'high', 'max']);
});

test('倍率里的全角波浪号归一成 ASCII（上游混用三种字形）', () => {
  const full = fromRawEntry({ key: 'a', multiplier: '～0.12x' }, 'model');
  assert.equal(full?.multiplier, '~0.12x');
  const wave = fromRawEntry({ key: 'b', multiplier: '〜0.08x' }, 'model');
  assert.equal(wave?.multiplier, '~0.08x');
  // 本来就是对的不该被改动。
  const ascii = fromRawEntry({ key: 'c', multiplier: '~0.75x' }, 'model');
  assert.equal(ascii?.multiplier, '~0.75x');
});

test('上游的 tag 字段被当成徽标读出来', () => {
  assert.equal(fromRawEntry({ key: 'a', tag: 'NEW' }, 'model')?.badge, 'NEW');
  assert.equal(fromRawEntry({ key: 'b', tag: '正式版' }, 'model')?.badge, '正式版');
  // 空 tag 不带这个键，界面就不会渲染空胶囊。
  assert.equal(fromRawEntry({ key: 'c', tag: '' }, 'model')?.badge, undefined);
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

test('下拉说明只放上游文案，倍率交给模型名那块标签', () => {
  // 同一个下拉里两种格式并存时，倍率（选模型要比的那个数）会在部分行里消失。
  const withBoth = modelDescription({
    id: 'a',
    name: 'A',
    contextWindow: 1,
    maxTokens: 1,
    multiplier: '~0.12x',
    reasoning: false,
    vision: false,
    description: '适用于日常任务',
  });
  assert.equal(withBoth, '适用于日常任务', '倍率由模型名标签画，说明里不再重复');

  const onlyMultiplier = modelDescription({
    id: 'b',
    name: 'B',
    contextWindow: 1,
    maxTokens: 1,
    multiplier: '0.40x',
    reasoning: false,
    vision: false,
  });
  assert.equal(onlyMultiplier, undefined, '只有倍率的行没有说明，交给宿主省略这一行');

  const onlyText = modelDescription({
    id: 'c',
    name: 'C',
    contextWindow: 1,
    maxTokens: 1,
    multiplier: '',
    reasoning: false,
    vision: false,
    description: '适用于日常任务',
  });
  assert.equal(onlyText, '适用于日常任务');

  const neither = modelDescription({
    id: 'd',
    name: 'D',
    contextWindow: 1,
    maxTokens: 1,
    multiplier: '',
    reasoning: false,
    vision: false,
  });
  assert.equal(neither, undefined, '都没有就省略，不塞空串占位');
});

test('模式项的说明里不出现「倍率 模式」', () => {
  const plans = STATIC_CATALOG.filter((model) => model.id.startsWith('plan_'));
  assert.equal(plans.length, 2);
  for (const plan of plans) {
    const text = modelDescription(plan);
    assert.equal(plan.multiplier, '');
    assert.doesNotMatch(String(text), /倍率/, `${plan.id} 不该有倍率：${String(text)}`);
  }
});

test('徽标原样透传给选择器，且语气按文案分档', () => {
  const infos = toLlmModelInfos(STATIC_CATALOG);
  const flash = infos.find((info) => info.id === 'deepseek-v4.1-flash');
  assert.equal(flash?.badge?.text, 'NEW');
  assert.equal(flash?.badge?.tone, 'info');

  const pro = infos.find((info) => info.id === 'deepseek-v4-pro-0813');
  assert.deepEqual(pro?.badge?.text, { en: 'GA', zh: '正式版' });
  assert.equal(pro?.badge?.tone, 'success');

  const glm = infos.find((info) => info.id === 'GLM-5.3');
  assert.deepEqual(glm?.badge?.text, { en: 'Launch', zh: '首发接入' });
  assert.equal(glm?.badge?.tone, 'info');

  // 没有徽标的行不要凭空造一个：选择器里的标签是上游的事实。
  assert.equal(infos.find((info) => info.id === 'kimi-k3')?.badge, undefined);
});

test('徽标文案：中文标签给英文说法，认不出的原样透传', () => {
  assert.deepEqual(badgeText('正式版'), { en: 'GA', zh: '正式版' });
  assert.deepEqual(badgeText('首发接入'), { en: 'Launch', zh: '首发接入' });
  // NEW 本来就是英文，不需要翻译。
  assert.equal(badgeText('NEW'), 'NEW');
  // 上游自定义的文案：不知道含义就不翻译，原样给宿主。
  assert.equal(badgeText('限时五折'), '限时五折');
});
