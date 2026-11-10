/**
 * 请求体归一的单测。约束来源见 `docs/PROTOCOL.md` §3.3（真机实测）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAgentBody, describeShape } from '../src/protocol/client.ts';
import {
  flattenContent,
  normalizeMessages,
  normalizeToolChoice,
} from '../src/protocol/normalize.ts';

/** 构造一个最小 ChatRequest。 */
function req(overrides: Record<string, unknown>): Parameters<typeof buildAgentBody>[0] {
  return { cookie: 'c', model: 'deepseek-v4.1-flash', messages: [], ...overrides } as never;
}

test('字符串 content 原样保留', () => {
  assert.deepEqual(flattenContent('嗨'), { text: '嗨', dropped: 0 });
});

test('分段 content 展平成字符串', () => {
  const result = flattenContent([
    { type: 'text', text: '第一段' },
    { type: 'text', text: '第二段' },
  ]);
  assert.equal(result.text, '第一段\n第二段');
  assert.equal(result.dropped, 0);
});

test('非文本分段被丢弃并计数', () => {
  const result = flattenContent([
    { type: 'text', text: '看图' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
  ]);
  assert.equal(result.text, '看图');
  assert.equal(result.dropped, 1);
});

test('tool 结果的分段也展平（上游同样拒数组）', () => {
  const { messages } = normalizeMessages([
    { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: '12:00' }] },
  ]);
  assert.equal(messages[0].content, '12:00');
  assert.equal(messages[0].tool_call_id, 'call_1');
});

test('tool_calls 与其余键不受影响', () => {
  const { messages } = normalizeMessages([
    {
      role: 'assistant',
      content: [{ type: 'text', text: '查一下' }],
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{}' } }],
    },
  ]);
  assert.equal(messages[0].content, '查一下');
  assert.ok(Array.isArray(messages[0].tool_calls), 'tool_calls 应保留');
});

test('tool_choice 字符串原样透传', () => {
  for (const choice of ['auto', 'none', 'required']) {
    assert.equal(normalizeToolChoice(choice), choice);
  }
});

test('对象 tool_choice 降级为 required', () => {
  assert.equal(normalizeToolChoice({ type: 'function', function: { name: 'get_time' } }), 'required');
  assert.equal(normalizeToolChoice({ type: 'auto' }), 'auto');
  assert.equal(normalizeToolChoice({ type: 'none' }), 'none');
  assert.equal(normalizeToolChoice(undefined), undefined);
});

test('buildAgentBody 不再把分段 content 发给上游', () => {
  const body = buildAgentBody(
    req({
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: [{ type: 'text', text: '现在几点？' }] },
      ],
      tools: [{ type: 'function', function: { name: 'get_time', parameters: {} } }],
      toolChoice: { type: 'function', function: { name: 'get_time' } },
    }),
    'deepseek-v4.1-flash',
  );
  const messages = body.messages as Array<Record<string, unknown>>;
  assert.equal(typeof messages[1].content, 'string');
  assert.equal(messages[1].content, '现在几点？');
  assert.equal(body.tool_choice, 'required');
});

test('丢弃非文本分段时给出 warning', () => {
  const warnings: string[] = [];
  buildAgentBody(
    req({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image_url', image_url: { url: 'x' } },
          ],
        },
      ],
      onWarn: (message: string) => warnings.push(message),
    }),
    'deepseek-v4.1-flash',
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /分段 content/);
});

test('报错里的形状摘要不带正文，只报角色与 content 类型', () => {
  const shape = describeShape([
    { role: 'system', content: '你是一个助手' },
    { role: 'user', content: [{ type: 'text', text: '机密原文' }, { type: 'image', data: 'x' }] },
    { role: 'assistant', content: '' },
  ]);
  assert.equal(shape, 'system:str,user:array(2),assistant:str');
  assert.doesNotMatch(shape, /机密原文/, '摘要里不能出现用户正文');
  assert.equal(describeShape(undefined), 'messages:非数组');
});

test('content 为 null 或缺省时发空串，角色 developer 改写成 system', () => {
  const result = normalizeMessages([
    { role: 'developer', content: '系统提示' },
    { role: 'assistant', content: null },
    { role: 'user', content: [{ type: 'text', text: '在' }] },
  ]);
  assert.deepEqual(
    result.messages.map((message) => [message.role, message.content]),
    [
      ['system', '系统提示'],
      ['assistant', ''],
      ['user', '在'],
    ],
  );
});
