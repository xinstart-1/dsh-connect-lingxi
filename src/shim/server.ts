/**
 * 本地 OpenAI 兼容 shim。
 *
 * 为什么要有它：`PiAiAdapter` 只会按 OpenAI 语义发请求，而灵犀要三步握手 +
 * 私有 SSE 形状。把翻译层放在一个本地 HTTP 端点里，DSH 侧 adapter 就是纯配置，
 * 复杂度全集中在这个只用 Node 标准库的模块里（可单测、不依赖 pi-ai）。
 *
 * 安全：`listen(0, "127.0.0.1")` —— 内核随机端口、只连回环；每次启动生成一个
 * 共享密钥，adapter 用 `Authorization: Bearer <key>` 传入，未带正确密钥的请求
 * 一律 401。这样即使别的进程扫到端口也调不动它。
 *
 * @module dsh-connect-lingxi/shim/server
 */

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SHIM_PREFIX } from '../constants.ts';
import { LingxiClient, type WireMessage } from '../protocol/client.ts';
import { foldFrames, LingxiSseTranslator } from '../protocol/sse.ts';

/** shim 启动后的句柄。 */
export interface ShimHandle {
  /** `http://127.0.0.1:<port>`，作为 pi-ai provider 的 baseURL。 */
  readonly baseUrl: string;
  /** 共享密钥，adapter 用它当 apiKey。 */
  readonly token: string;
  /** 关闭监听并释放端口。 */
  close(): Promise<void>;
}

/** 构造 shim 需要的依赖。 */
export interface ShimOptions {
  /** cookie 读取器；每次请求调用一次，返回空串表示未配置。 */
  cookie: () => Promise<string>;
  /** 客户端实例（注入以便单测替换）。 */
  client?: LingxiClient;
  /** 诊断日志。 */
  onWarn?: (message: string) => void;
}

/** 请求体里用得上的字段（OpenAI 风味，字段宽松）。 */
interface ChatBody {
  model?: unknown;
  messages?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  temperature?: unknown;
  max_tokens?: unknown;
  reasoning_effort?: unknown;
  stream?: unknown;
}

const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** 读完整请求体；超过上限直接 413。 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 写一个 JSON 错误响应。 */
function writeError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: { message, type: 'upstream_error' } }));
}

/** 把上游错误映射成对下游的 HTTP 状态与文案。 */
function statusOf(error: unknown): number {
  const status = (error as { status?: unknown })?.status;
  return typeof status === 'number' && status >= 400 && status <= 599 ? status : 502;
}

/**
 * 启动 shim。
 * @param options - 依赖注入。
 * @returns 句柄；`baseUrl` 与 `token` 交给 adapter。
 */
export async function startShim(options: ShimOptions): Promise<ShimHandle> {
  const client = options.client ?? new LingxiClient();
  const token = randomBytes(32).toString('base64url');
  const warn = options.onWarn ?? ((): void => {});

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== SHIM_PREFIX) {
        writeError(res, 404, 'not found');
        return;
      }
      if (req.method !== 'POST') {
        writeError(res, 405, 'method not allowed');
        return;
      }
      const authorization = req.headers.authorization ?? '';
      const presented = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim() ?? '';
      if (presented !== token) {
        writeError(res, 401, 'unauthorized');
        return;
      }

      const raw = await readBody(req);
      let parsed: ChatBody;
      try {
        parsed = JSON.parse(raw) as ChatBody;
      } catch {
        writeError(res, 400, '请求体不是合法 JSON');
        return;
      }

      const cookie = await options.cookie();
      if (cookie.trim() === '') {
        writeError(res, 401, '未配置 WPS 灵犀 cookie');
        return;
      }

      const messages = Array.isArray(parsed.messages) ? (parsed.messages as WireMessage[]) : [];
      const model = typeof parsed.model === 'string' ? parsed.model : '';
      const wantsStream = parsed.stream !== false;

      const upstream = await client.openChat({
        cookie,
        model,
        messages,
        ...(Array.isArray(parsed.tools) ? { tools: parsed.tools } : {}),
        ...(parsed.tool_choice === undefined ? {} : { toolChoice: parsed.tool_choice }),
        ...(typeof parsed.temperature === 'number' ? { temperature: parsed.temperature } : {}),
        ...(typeof parsed.max_tokens === 'number' ? { maxTokens: parsed.max_tokens } : {}),
        ...(typeof parsed.reasoning_effort === 'string'
          ? { reasoningEffort: parsed.reasoning_effort }
          : {}),
        onWarn: warn,
      });

      const translator = new LingxiSseTranslator(model);
      const decoder = new TextDecoder();

      if (!wantsStream) {
        const frames: string[] = [];
        const reader = upstream.body!.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          frames.push(...translator.push(decoder.decode(value, { stream: true })));
        }
        frames.push(...translator.push(decoder.decode()));
        frames.push(...translator.finish());
        const folded = foldFrames(frames, model);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(folded));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      let sawError = false;
      const fail = (error: unknown): void => {
        if (sawError) return;
        sawError = true;
        const message = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: unknown })?.code;
        res.write(
          `data: ${JSON.stringify({
            error: {
              message,
              type: 'upstream_error',
              ...(typeof code === 'string' ? { code } : {}),
            },
          })}\n\n`,
        );
        res.end();
      };

      const reader = upstream.body!.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const frame of translator.push(decoder.decode(value, { stream: true }))) {
            res.write(frame);
          }
          if (translator.done) break;
        }
        if (!translator.done) {
          for (const frame of translator.push(decoder.decode())) res.write(frame);
        }
        if (!translator.done) {
          for (const frame of translator.finish()) res.write(frame);
        }
        res.end();
      } catch (error) {
        fail(error);
      }
    } catch (error) {
      writeError(res, statusOf(error), error instanceof Error ? error.message : '灵犀请求失败');
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (address === null) {
    server.close();
    throw new Error('shim 未能取得监听端口');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
