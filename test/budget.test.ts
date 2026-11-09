/**
 * 提示词预算的单测。裁剪策略见 `docs/PROTOCOL.md` §9。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitAgentBody } from '../src/protocol/budget.ts';

/** 造一条指定大小（约）的消息。 */
function big(role: string, bytes: number): Record<string, unknown> {
  return { role, content: 'x'.repeat(bytes) };
}

test('预算内不动', () => {
  const body = { messages: [{ role: 'user', content: 'hi' }] };
  const before = JSON.stringify(body);
  const result = fitAgentBody(body);
  assert.deepEqual(result, { dropped: 0, elided: 0 });
  assert.equal(JSON.stringify(body), before);
});

test('单条超长被掐头去尾，而不是整条丢', () => {
  const body = { messages: [{ role: 'user', content: 'y'.repeat(200_000) }] };
  const result = fitAgentBody(body);
  assert.equal(result.elided, 1);
  assert.equal(result.dropped, 0);
  const content = (body.messages[0] as { content: string }).content;
  assert.ok(content.length < 200_000, '内容应被截断');
  assert.match(content, /已截断/);
});

test('整体超预算时从最老的一端丢，system 保留', () => {
  const messages = [
    { role: 'system', content: 'S'.repeat(1000) },
    ...Array.from({ length: 40 }, () => big('user', 20_000)),
    { role: 'user', content: '最后一条' },
  ];
  const body = { messages: [...messages] };
  const result = fitAgentBody(body);
  assert.ok(result.dropped > 0, '应丢掉一些历史');
  const after = body.messages as Record<string, unknown>[];
  assert.equal(after[0]?.role, 'system', 'system 必须保留');
  assert.equal(after[0]?.content, 'S'.repeat(1000), 'system 内容不能改');
  assert.equal(after.at(-1)?.content, '最后一条', '最后一条必须保留');
});

test('丢完后开头不能是孤儿 tool 结果', () => {
  const messages = [
    { role: 'system', content: 'S'.repeat(500) },
    big('user', 100_000),
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'R'.repeat(100_000) },
    { role: 'user', content: '继续' },
  ];
  const body = { messages: [...messages] };
  fitAgentBody(body);
  const after = body.messages as Record<string, unknown>[];
  const firstNonSystem = after.find((message) => message.role !== 'system');
  assert.notEqual(firstNonSystem?.role, 'tool', '孤儿 tool 结果会被上游拒');
});

test('裁剪后的体积确实在预算内', () => {
  const body = {
    messages: [
      { role: 'system', content: 'S'.repeat(1000) },
      ...Array.from({ length: 60 }, () => big('user', 10_000)),
    ],
  };
  fitAgentBody(body);
  const size = Buffer.byteLength(JSON.stringify(body));
  assert.ok(size <= 320 * 1024, `裁剪后仍超预算：${size} 字节`);
});

test('messages 缺失或为空时不动', () => {
  assert.deepEqual(fitAgentBody({}), { dropped: 0, elided: 0 });
  assert.deepEqual(fitAgentBody({ messages: [] }), { dropped: 0, elided: 0 });
});

test('只有一条超长消息时掐头去尾（不整轮 400）', () => {
  const body = { messages: [big('user', 500_000)] };
  const result = fitAgentBody(body);
  assert.equal(result.elided, 1);
  assert.equal(result.dropped, 0);
  const size = Buffer.byteLength(JSON.stringify(body));
  assert.ok(size <= 320 * 1024, `单条消息裁剪后仍超预算：${size} 字节`);
});
