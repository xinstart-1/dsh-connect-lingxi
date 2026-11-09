/**
 * SSE 翻译器的单测。fixture 全部来自真实上游帧形状（见 `docs/PROTOCOL.md` §4）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foldFrames, LingxiSseTranslator } from '../src/protocol/sse.ts';

/** 把上游帧拼成一段 SSE 文本。 */
function sse(...frames: unknown[]): string {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
}

/** 从一个翻译结果里取出所有 data 行（已解析）。 */
function parse(frames: readonly string[]): Record<string, unknown>[] {
  return frames
    .map((raw) => raw.replace(/^data:\s*/, '').trim())
    .filter((text) => text !== '' && text !== '[DONE]')
    .map((text) => JSON.parse(text) as Record<string, unknown>);
}

test('正文取自 choices[].text，不是 delta.content', () => {
  const translator = new LingxiSseTranslator('deepseek-v4.1-flash');
  const out = translator.push(
    sse({ code: 'Success', choices: [{ text: '你好' }, { text: '，世界' }] }),
  );
  translator.push(sse({ code: 'Success', choices: [{ text: '', finish_reason: 'stop' }] }));
  out.push(...translator.finish());

  const parsed = parse(out);
  const contents = parsed
    .flatMap((chunk) => (chunk.choices as Record<string, unknown>[]) ?? [])
    .map((choice) => (choice.delta as Record<string, unknown> | undefined)?.content)
    .filter((value): value is string => typeof value === 'string' && value !== '');
  assert.deepEqual(contents, ['你好', '，世界']);
});

test('思考内容走 reasoning_content 独立通道', () => {
  const translator = new LingxiSseTranslator('m');
  const out = translator.push(
    sse({ code: 'Success', choices: [{ reasoning_content: '先想一下' }] }),
  );
  out.push(...translator.push(sse({ code: 'Success', choices: [{ text: '答案' }] })));
  out.push(...translator.push(sse({ code: 'Success', choices: [{ finish_reason: 'stop' }] })));
  out.push(...translator.finish());

  const deltas = parse(out)
    .flatMap((chunk) => (chunk.choices as Record<string, unknown>[]) ?? [])
    .map((choice) => (choice.delta as Record<string, unknown>) ?? {});
  assert.equal(deltas[1]?.reasoning_content, '先想一下');
  assert.equal(deltas[2]?.content, '答案');
  // 正文与思考不混在一起
  assert.equal(deltas[1]?.content, undefined);
});

test('tool_calls 按 index 透传，保留 id/name/arguments 分片', () => {
  const translator = new LingxiSseTranslator('m');
  const out = translator.push(
    sse({
      code: 'Success',
      choices: [
        {
          tool_calls: [
            { index: 0, id: 'call_1', function: { name: 'read', arguments: '{"pa' } },
          ],
        },
      ],
    }),
  );
  out.push(
    ...translator.push(
      sse({
        code: 'Success',
        choices: [{ tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] }],
      }),
    ),
  );
  out.push(...translator.push(sse({ code: 'Success', choices: [{ finish_reason: 'tool_calls' }] })));
  out.push(...translator.finish());

  const folded = foldFrames(out, 'm');
  const calls = folded.choices[0]?.message.tool_calls ?? [];
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.id, 'call_1');
  assert.equal(calls[0]?.function.name, 'read');
  assert.equal(calls[0]?.function.arguments, '{"path":"a"}');
  assert.equal(folded.choices[0]?.finish_reason, 'tool_calls');
});

test('没有 [DONE]，靠 finish_reason 收尾；finish 后补 usage 与 [DONE]', () => {
  const translator = new LingxiSseTranslator('m');
  const out = translator.push(
    sse({
      code: 'Success',
      usage: { prompt_tokens: 100, completion_tokens: 20 },
      choices: [{ text: 'ok', finish_reason: 'stop' }],
    }),
  );
  const tail = translator.finish();

  const all = [...out, ...tail];
  assert.equal(all.at(-1), 'data: [DONE]\n\n');
  const usageChunk = parse(all).find((chunk) => Array.isArray(chunk.choices) && chunk.choices.length === 0);
  assert.ok(usageChunk !== undefined, '应有一个纯 usage 帧');
  assert.deepEqual(usageChunk.usage, {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
  });
});

test('usage 的 total_tokens 自己算，不透传上游的「当前上下文大小」', () => {
  const translator = new LingxiSseTranslator('m');
  // 带 finish_reason 的帧会在 push 里就走完收尾路径（finish + usage + [DONE]）。
  const frames = translator.push(
    sse({
      code: 'Success',
      usage: { prompt_tokens: 1097, completion_tokens: 226, total_tokens: 43563 },
      choices: [{ text: 'x', finish_reason: 'stop' }],
    }),
  );
  frames.push(...translator.finish());
  const folded = foldFrames(frames, 'm');
  assert.equal(folded.usage?.total_tokens, 1323);
});

test('usage 缓存与推理字段归一到 OpenAI 形状', () => {
  const translator = new LingxiSseTranslator('m');
  const frames = translator.push(
    sse({
      code: 'Success',
      usage: {
        prompt_tokens: 500,
        completion_tokens: 50,
        cached_tokens: 300,
        reasoning_tokens: 40,
      },
      choices: [{ text: 'x', finish_reason: 'stop' }],
    }),
  );
  frames.push(...translator.finish());
  const folded = foldFrames(frames, 'm');
  assert.equal(folded.usage?.prompt_tokens_details?.cached_tokens, 300);
  assert.equal(folded.usage?.completion_tokens_details?.reasoning_tokens, 40);
});

test('审核拦截抛错而不是当正常帧吞掉', () => {
  const translator = new LingxiSseTranslator('m');
  assert.throws(
    () => translator.push(sse({ code: 'AuditFailed', message: '内容被审核拦截' })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /AuditFailed/);
      assert.equal((error as Error & { code?: string }).code, 'audit_blocked');
      return true;
    },
  );
});

test('非 Success 业务码抛错', () => {
  const translator = new LingxiSseTranslator('m');
  assert.throws(
    () => translator.push(sse({ code: 'ModelNotFound', message: '模型不存在' })),
    /ModelNotFound/,
  );
});

test('流在 finish_reason 之前断开要报截断，不能静默结束', () => {
  const translator = new LingxiSseTranslator('m');
  translator.push(sse({ code: 'Success', choices: [{ text: '半句' }] }));
  assert.throws(() => translator.finish(), /截断/);
});

test('任意切分的字节流都能正确重组（跨 chunk 的行）', () => {
  const whole = sse(
    { code: 'Success', choices: [{ text: 'A' }] },
    { code: 'Success', choices: [{ text: 'B', finish_reason: 'stop' }] },
  );
  const translator = new LingxiSseTranslator('m');
  const out: string[] = [];
  for (let i = 0; i < whole.length; i += 7) {
    out.push(...translator.push(whole.slice(i, i + 7)));
  }
  out.push(...translator.finish());
  const texts = parse(out)
    .flatMap((chunk) => (chunk.choices as Record<string, unknown>[]) ?? [])
    .map((choice) => (choice.delta as Record<string, unknown>)?.content)
    .filter((value): value is string => typeof value === 'string' && value !== '');
  assert.deepEqual(texts, ['A', 'B']);
});

test('非流式折叠产出标准 chat.completion', () => {
  const translator = new LingxiSseTranslator('deepseek-v4.1-flash');
  const frames = translator.push(
    sse(
      { code: 'Success', choices: [{ reasoning_content: '想' }] },
      { code: 'Success', choices: [{ text: '你好' }] },
      {
        code: 'Success',
        usage: { prompt_tokens: 10, completion_tokens: 2 },
        choices: [{ finish_reason: 'stop' }],
      },
    ),
  );
  frames.push(...translator.finish());
  const folded = foldFrames(frames, 'deepseek-v4.1-flash');

  assert.equal(folded.object, 'chat.completion');
  assert.equal(folded.model, 'deepseek-v4.1-flash');
  assert.equal(folded.choices[0]?.message.content, '你好');
  assert.equal(folded.choices[0]?.message.reasoning_content, '想');
  assert.equal(folded.choices[0]?.finish_reason, 'stop');
  assert.equal(folded.usage?.total_tokens, 12);
});

test('忽略注释行与 event 行', () => {
  const translator = new LingxiSseTranslator('m');
  const out = translator.push(': heartbeat\n\nevent: ping\n\n');
  out.push(...translator.push(sse({ code: 'Success', choices: [{ text: 'x', finish_reason: 'stop' }] })));
  out.push(...translator.finish());
  const folded = foldFrames(out, 'm');
  assert.equal(folded.choices[0]?.message.content, 'x');
});
