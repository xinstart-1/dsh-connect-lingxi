/**
 * shim 的端到端测试：用假的上游 fetch 验证「OpenAI 请求 → 灵犀三步握手 →
 * OpenAI SSE」整条链路，包含鉴权、流式与非流式两种模式。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startShim } from '../src/shim/server.ts';

/**
 * 真正的 fetch。测试里替换 `globalThis.fetch` 是为了伪造**上游**，但调用 shim
 * 必须走这个原始实现，否则本地请求也会被假上游吞掉。
 */
const realFetch = globalThis.fetch;

/** 一个把请求记录下来的假上游。 */
function fakeUpstream(options: { sseFrames: string[] }): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    if (url.includes('/cowork/sessions')) {
      return Response.json({ data: { session_id: 'sess-1' } });
    }
    if (url.includes('/credits/runs')) {
      return Response.json({ data: { run_id: 'run-1', group_id: 'g-1' } });
    }
    if (url.includes('/agent-runtime/chat/completions')) {
      const body = options.sseFrames.join('');
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

/** 造一段上游 SSE。 */
function upstreamFrames(...frames: unknown[]): string[] {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`);
}

test('shim：鉴权失败返回 401', async () => {
  const upstream = fakeUpstream({ sseFrames: [] });
  const original = globalThis.fetch;
  globalThis.fetch = upstream.fetch;
  const shim = await startShim({ cookie: async () => 'wps_sid=abc' });
  try {
    const response = await realFetch(`${shim.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [] }),
    });
    assert.equal(response.status, 401);
  } finally {
    await shim.close();
    globalThis.fetch = original;
  }
});

test('shim：没有 cookie 时 401', async () => {
  const upstream = fakeUpstream({ sseFrames: [] });
  const original = globalThis.fetch;
  globalThis.fetch = upstream.fetch;
  const shim = await startShim({ cookie: async () => '' });
  try {
    const response = await realFetch(`${shim.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${shim.token}`,
      },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    assert.equal(response.status, 401);
    assert.match(await response.text(), /cookie/);
  } finally {
    await shim.close();
    globalThis.fetch = original;
  }
});

test('shim：非 /v1/chat/completions 路径 404，GET 方法 405', async () => {
  const upstream = fakeUpstream({ sseFrames: [] });
  const original = globalThis.fetch;
  globalThis.fetch = upstream.fetch;
  const shim = await startShim({ cookie: async () => 'wps_sid=abc' });
  try {
    const notFound = await realFetch(`${shim.baseUrl}/other`, {
      headers: { Authorization: `Bearer ${shim.token}` },
    });
    assert.equal(notFound.status, 404);

    const wrongMethod = await realFetch(`${shim.baseUrl}/v1/chat/completions`, {
      headers: { Authorization: `Bearer ${shim.token}` },
    });
    assert.equal(wrongMethod.status, 405);
  } finally {
    await shim.close();
    globalThis.fetch = original;
  }
});

test('shim：流式把三步握手与 SSE 翻译串起来', async () => {
  const upstream = fakeUpstream({
    sseFrames: upstreamFrames(
      { code: 'Success', choices: [{ reasoning_content: '想' }] },
      { code: 'Success', choices: [{ text: '你好' }] },
      {
        code: 'Success',
        usage: { prompt_tokens: 5, completion_tokens: 1 },
        choices: [{ finish_reason: 'stop' }],
      },
    ),
  });
  const original = globalThis.fetch;
  globalThis.fetch = upstream.fetch;
  const shim = await startShim({ cookie: async () => 'wps_sid=abc' });
  try {
    const response = await realFetch(`${shim.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${shim.token}`,
      },
      body: JSON.stringify({
        model: 'deepseek-v4.1-flash',
        stream: true,
        messages: [{ role: 'user', content: '嗨' }],
      }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

    const text = await response.text();
    assert.match(text, /data: \[DONE\]/);
    assert.match(text, /你好/);
    assert.match(text, /reasoning_content/);

    // 三步握手都发生了，且带了正确的头
    assert.equal(upstream.calls.length, 3);
    const [session, run, chat] = upstream.calls;
    assert.match(session!.url, /cowork\/sessions$/);
    assert.match(run!.url, /credits\/runs$/);
    assert.match(chat!.url, /agent-runtime\/chat\/completions$/);

    const chatHeaders = chat!.init.headers as Record<string, string>;
    assert.equal(chatHeaders['X-Cc-Session-ID'], 'sess-1');
    assert.equal(chatHeaders['X-Cc-Run-ID'], 'run-1');
    assert.equal(chatHeaders['X-Client-Type'], 'lingxi_claw');
    assert.match(chatHeaders.Cookie, /wps_sid=abc/);
    assert.match(chatHeaders.Cookie, /x-kso-app-name/);

    // 发给上游的体是灵犀形状
    const sent = JSON.parse(String(chat!.init.body)) as Record<string, unknown>;
    assert.equal(sent.stream, true);
    assert.equal(sent.model, 'deepseek-v4.1-flash');
  } finally {
    await shim.close();
    globalThis.fetch = original;
  }
});

test('shim：非流式折叠成标准 chat.completion', async () => {
  const upstream = fakeUpstream({
    sseFrames: upstreamFrames(
      { code: 'Success', choices: [{ text: '答' }] },
      { code: 'Success', choices: [{ finish_reason: 'stop' }] },
    ),
  });
  const original = globalThis.fetch;
  globalThis.fetch = upstream.fetch;
  const shim = await startShim({ cookie: async () => 'wps_sid=abc' });
  try {
    const response = await realFetch(`${shim.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${shim.token}`,
      },
      body: JSON.stringify({
        model: 'deepseek-v4.1-flash',
        stream: false,
        messages: [{ role: 'user', content: '嗨' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      object: string;
      choices: Array<{ message: { content: string }; finish_reason: string }>;
    };
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0]?.message.content, '答');
    assert.equal(body.choices[0]?.finish_reason, 'stop');
  } finally {
    await shim.close();
    globalThis.fetch = original;
  }
});

test('shim：上游握手失败时把状态码透出来', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: 'UserUnauthorized: 登录已过期' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
  const shim = await startShim({ cookie: async () => 'wps_sid=abc' });
  try {
    const response = await realFetch(`${shim.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${shim.token}`,
      },
      body: JSON.stringify({ model: 'm', stream: false, messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal(response.status, 401);
  } finally {
    await shim.close();
    globalThis.fetch = original;
  }
});

test('shim：run 缓存命中时不重复建会话', async () => {
  const upstream = fakeUpstream({
    sseFrames: upstreamFrames({ code: 'Success', choices: [{ text: 'x', finish_reason: 'stop' }] }),
  });
  const original = globalThis.fetch;
  globalThis.fetch = upstream.fetch;
  const shim = await startShim({ cookie: async () => 'wps_sid=abc' });
  try {
    const call = async (): Promise<void> => {
      const response = await realFetch(`${shim.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${shim.token}`,
        },
        body: JSON.stringify({
          model: 'deepseek-v4.1-flash',
          stream: true,
          messages: [{ role: 'user', content: 'x' }],
        }),
      });
      await response.text();
    };
    await call();
    await call();
    // 第一次：sessions + runs + chat = 3；第二次复用 run，只有 chat = 1
    assert.equal(upstream.calls.length, 4);
  } finally {
    await shim.close();
    globalThis.fetch = original;
  }
});
