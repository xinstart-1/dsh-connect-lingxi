/**
 * “不自动裁剪/压缩”的契约测试。
 *
 * 用户要求：没有明确要求时，插件不得丢历史、不得截断长消息、不得做摘要。
 * 完整 messages 原样发给上游；只有上游真拒绝时，错误信息里带一句超限说明。
 * 规格见 `docs/PROTOCOL.md` §9。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildAgentBody,
  estimatePromptTokens,
  oversizeNote,
} from '../src/protocol/client.ts';

/** 造一条指定字节数的 user 消息。 */
function user(bytes: number): Record<string, unknown> {
  return { role: 'user', content: 'x'.repeat(bytes) };
}

/** 只取 messages。 */
function messagesOf(body: Record<string, unknown>): Record<string, unknown>[] {
  return body.messages as Record<string, unknown>[];
}

test('单条 500KB 的粘贴原样发出去，不掐头去尾', () => {
  const body = buildAgentBody({ cookie: 'c', model: 'deepseek-v4.1-flash', messages: [user(500_000)] }, 'deepseek-v4.1-flash');
  const messages = messagesOf(body);
  assert.equal(messages.length, 1);
  assert.equal((messages[0]?.content as string).length, 500_000, '内容不能变短');
  assert.doesNotMatch(JSON.stringify(body), /已截断|已压缩|已省略/);
});

test('超预算历史一条不丢，也不插“已省略”标记', () => {
  const history = Array.from({ length: 40 }, () => user(20_000));
  const body = buildAgentBody({ cookie: 'c', model: 'deepseek-v4.1-flash', messages: history }, 'deepseek-v4.1-flash');
  const messages = messagesOf(body);
  assert.equal(messages.length, 40, '历史条数必须与输入一致');
  assert.ok(messages.every((message, index) => message.content === history[index]?.content), '每条内容都不能改');
  assert.doesNotMatch(JSON.stringify(body), /历史已压缩|已省略/);
});

test('system / 最后一条 user 消息原样保留', () => {
  const history = [
    { role: 'system', content: 'S'.repeat(1000) },
    ...Array.from({ length: 30 }, () => user(20_000)),
    { role: 'user', content: '最后一条' },
  ];
  const body = buildAgentBody({ cookie: 'c', model: 'deepseek-v4.1-flash', messages: history }, 'deepseek-v4.1-flash');
  const messages = messagesOf(body);
  assert.deepEqual(messages[0], history[0]);
  assert.deepEqual(messages.at(-1), history.at(-1));
});

test('estimatePromptTokens：实测比例附近（英文 ≈4.5 字符/token、中文 ≈1.9）', () => {
  // 4,194,304 字节纯英文实测 prompt_tokens = 932,102（±10% 都算对）。
  const english = 'x'.repeat(4_194_304);
  const englishTokens = estimatePromptTokens([{ role: 'user', content: english }]);
  assert.ok(
    englishTokens > 932_102 * 0.9 && englishTokens < 932_102 * 1.1,
    `英文估计 ${englishTokens} 偏离实测 932102 太多`,
  );
  // 同样字节数的中文 1,398,101 字，实测 735,881。
  const chinese = '中'.repeat(1_398_101);
  const chineseTokens = estimatePromptTokens([{ role: 'user', content: chinese }]);
  assert.ok(
    chineseTokens > 735_881 * 0.9 && chineseTokens < 735_881 * 1.1,
    `中文估计 ${chineseTokens} 偏离实测 735881 太多`,
  );
});

test('oversizeNote：离上限远不打扰，接近 1M token 才提示', () => {
  assert.equal(oversizeNote(10_000), '');
  assert.equal(oversizeNote(800_000), '', '80 万 token 还不该提示');
  const note = oversizeNote(1_000_000);
  assert.match(note, /100 万 token/);
  assert.match(note, /不会自动裁剪或压缩/);
});
