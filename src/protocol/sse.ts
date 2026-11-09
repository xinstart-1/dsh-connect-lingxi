/**
 * 上游 SSE 帧 → 标准 OpenAI SSE 的翻译器。
 *
 * 灵犀的形状与 OpenAI 有三处本质差异（见 `docs/PROTOCOL.md` §4）：
 * 1. 正文在 `choices[].text`，不在 `choices[].delta.content`；
 * 2. 没有 `[DONE]` 结束帧，靠 `choices[].finish_reason` 收尾；
 * 3. `usage` 字段名不同，需要归一。
 *
 * 另外 `code !== "Success"` 与审核标记是**流内错误**，必须以异常形式抛给上层，
 * 不能当作正常帧吞掉。
 *
 * @module dsh-connect-lingxi/protocol/sse
 */

import { isAuditPayload, isSuccessCode, textOfPayload } from './errors.ts';

/** 归一后的用量；字段名对齐 OpenAI 的 `usage`。 */
export interface NormalizedUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
  completion_tokens_details?: { reasoning_tokens: number };
}

/** 上游一个 `choices[]` 条目（字段全部可缺）。 */
interface RawChoice {
  text?: unknown;
  reasoning_content?: unknown;
  finish_reason?: unknown;
  tool_calls?: unknown;
}

/** 上游一个 SSE 帧。 */
interface RawFrame {
  code?: unknown;
  usage?: unknown;
  choices?: unknown;
}

function numberField(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** 上游用量归一：兼顾 OpenAI 风味与灵犀自己的字段名。 */
function normalizeUsage(raw: unknown): NormalizedUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const usage = raw as Record<string, unknown>;
  const prompt = numberField(usage.prompt_tokens ?? usage.input_tokens);
  const completion = numberField(usage.completion_tokens ?? usage.output_tokens);
  // 上游的 total_tokens 不是本轮用量，而是「当前上下文大小」（实测 42240+1097+226=43563）。
  // 原样透传会让客户端拿它当每轮用量累加，会话总量虚高几十倍。一律自己算。
  const total = prompt + completion;

  const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const cached =
    promptDetails?.cached_tokens !== undefined
      ? numberField(promptDetails.cached_tokens)
      : usage.cached_tokens !== undefined
        ? numberField(usage.cached_tokens)
        : undefined;

  const completionDetails = usage.completion_tokens_details as Record<string, unknown> | undefined;
  const reasoning =
    completionDetails?.reasoning_tokens !== undefined
      ? numberField(completionDetails.reasoning_tokens)
      : usage.reasoning_tokens !== undefined
        ? numberField(usage.reasoning_tokens)
        : undefined;

  if (prompt === 0 && completion === 0 && total === 0) return undefined;

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    ...(cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: cached } }),
    ...(reasoning === undefined
      ? {}
      : { completion_tokens_details: { reasoning_tokens: reasoning } }),
  };
}

/** 一个可增量喂入的上游 SSE 翻译器。 */
export class LingxiSseTranslator {
  private readonly model: string;
  private readonly created: number;
  private readonly id: string;
  private buffer = '';
  private started = false;
  private sawFinish = false;
  private finished = false;
  private finishReason = '';
  private usage: NormalizedUsage | undefined;

  constructor(model: string) {
    this.model = model;
    this.created = Math.floor(Date.now() / 1000);
    this.id = `chatcmpl-lingxi-${this.created.toString(36)}-${this.created}`;
  }

  /** 是否已经吐过 `[DONE]`。 */
  get done(): boolean {
    return this.finished;
  }

  /** 是否已经见过 `finish_reason`（用于判断截断）。 */
  get sawFinishReason(): boolean {
    return this.sawFinish;
  }

  private frame(value: unknown): string {
    return `data: ${JSON.stringify(value)}\n\n`;
  }

  private deltaFrame(delta: Record<string, unknown>): string {
    return this.frame({
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: null }],
    });
  }

  private usageFrame(): string {
    return this.frame({
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [],
      usage: this.usage,
    });
  }

  private startRole(out: string[]): void {
    if (this.started) return;
    this.started = true;
    out.push(this.deltaFrame({ role: 'assistant', content: '' }));
  }

  /**
   * 喂一段上游字节（已解码为文本）。可以任意切分，翻译器自己缓冲不完整的行。
   * @param text - 解码后的片段。
   * @returns 要发给下游的 SSE 文本片段。
   */
  push(text: string): string[] {
    const out: string[] = [];
    if (this.finished) return out;
    this.buffer += text;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      this.consumeLine(line, out);
      if (this.finished) break;
      newline = this.buffer.indexOf('\n');
    }
    return out;
  }

  /**
   * 上游流结束。转发残留行，并补 `finish` 与 `[DONE]`。
   * @returns 收尾的 SSE 文本片段。
   * @throws {Error} 上游在 `finish_reason` 之前断开（响应被截断）。
   */
  finish(): string[] {
    if (this.finished) return [];
    const out: string[] = [];
    const rest = this.buffer.replace(/\r$/, '').trim();
    this.buffer = '';
    if (rest !== '') this.consumeLine(rest, out);
    if (this.finished) return out;

    this.finished = true;
    if (!this.sawFinish) throw new Error('灵犀上游流在完成事件之前结束（响应被截断）');
    if (this.usage !== undefined) out.push(this.usageFrame());
    out.push('data: [DONE]\n\n');
    return out;
  }

  private consumeLine(raw: string, out: string[]): void {
    if (this.finished) return;
    const line = raw.trim();
    if (line === '' || line.startsWith(':') || line.startsWith('event:')) return;
    const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
    if (payload === '') return;
    if (payload === '[DONE]') {
      this.sawFinish = true;
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(payload);
    } catch {
      return;
    }
    this.consumeFrame(frame, out);
  }

  private consumeFrame(raw: unknown, out: string[]): void {
    if (typeof raw !== 'object' || raw === null) return;
    const frame = raw as RawFrame;

    if (isAuditPayload(frame)) {
      this.finished = true;
      const detail = textOfPayload(frame) || '内容被审核拦截';
      const error = new Error(`灵犀上游返回 AuditFailed：${detail}`);
      (error as Error & { code?: string }).code = 'audit_blocked';
      throw error;
    }

    if (!isSuccessCode(frame.code)) {
      this.finished = true;
      throw new Error(`灵犀上游返回 ${String(frame.code)}：${textOfPayload(frame) || '上游错误'}`);
    }

    const usage = normalizeUsage(frame.usage);
    if (usage !== undefined) this.usage = usage;

    const choices = Array.isArray(frame.choices) ? (frame.choices as RawChoice[]) : [];
    for (const choice of choices) {
      const text = typeof choice?.text === 'string' ? choice.text : '';
      const reasoning =
        typeof choice?.reasoning_content === 'string' ? choice.reasoning_content : '';
      const calls = Array.isArray(choice?.tool_calls)
        ? (choice.tool_calls as Record<string, unknown>[])
        : [];

      if (text !== '' || reasoning !== '' || calls.length > 0) {
        this.startRole(out);
        const delta: Record<string, unknown> = {};
        if (text !== '') delta.content = text;
        if (reasoning !== '') delta.reasoning_content = reasoning;
        if (calls.length > 0) {
          delta.tool_calls = calls.map((call, index) => {
            const fn = (call?.function ?? {}) as Record<string, unknown>;
            const item: Record<string, unknown> = {
              index: Number.isInteger(call?.index) ? (call.index as number) : index,
            };
            if (typeof call?.id === 'string' && call.id !== '') {
              item.id = call.id;
              item.type = 'function';
            }
            const outFn: Record<string, unknown> = {};
            if (typeof fn.name === 'string' && fn.name !== '') outFn.name = fn.name;
            if (typeof fn.arguments === 'string' && fn.arguments !== '') {
              outFn.arguments = fn.arguments;
            }
            item.function = outFn;
            return item;
          });
        }
        out.push(this.deltaFrame(delta));
      }

      const reason = typeof choice?.finish_reason === 'string' ? choice.finish_reason.trim() : '';
      if (reason !== '') {
        this.sawFinish = true;
        this.finishReason = reason;
      }
    }

    if (this.sawFinish && !this.finished) {
      this.finished = true;
      out.push(
        this.frame({
          id: this.id,
          object: 'chat.completion.chunk',
          created: this.created,
          model: this.model,
          choices: [
            { index: 0, delta: {}, finish_reason: this.finishReason === '' ? 'stop' : this.finishReason },
          ],
        }),
      );
      if (this.usage !== undefined) out.push(this.usageFrame());
      out.push('data: [DONE]\n\n');
    }
  }
}

/** 非流式聚合后的标准 `chat.completion`。 */
export interface FoldedCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    message: {
      role: 'assistant';
      content: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: NormalizedUsage;
}

/**
 * 把翻译器产出的 SSE 片段折叠成一个完整响应（`stream:false` 路径）。
 * @param frames - 翻译器吐出的所有片段。
 * @param model - 模型 id，写进响应体。
 * @returns 标准 `chat.completion`。
 */
export function foldFrames(frames: readonly string[], model: string): FoldedCompletion {
  let content = '';
  let reasoning = '';
  let finishReason = 'stop';
  let usage: NormalizedUsage | undefined;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();

  for (const raw of frames) {
    const text = raw.replace(/^data:\s*/, '').trim();
    if (text === '' || text === '[DONE]') continue;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }
    const error = value.error as { message?: unknown } | undefined;
    if (error !== undefined) {
      throw new Error(typeof error.message === 'string' ? error.message : '灵犀上游错误');
    }
    if (value.usage !== undefined) usage = value.usage as NormalizedUsage;
    const choices = Array.isArray(value.choices)
      ? (value.choices as Record<string, unknown>[])
      : [];
    for (const choice of choices) {
      const delta = (choice.delta ?? {}) as Record<string, unknown>;
      if (typeof delta.content === 'string') content += delta.content;
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
      const deltas = Array.isArray(delta.tool_calls)
        ? (delta.tool_calls as Record<string, unknown>[])
        : [];
      for (const call of deltas) {
        const index = Number.isInteger(call.index) ? (call.index as number) : 0;
        const current = calls.get(index) ?? { id: '', name: '', arguments: '' };
        if (typeof call.id === 'string' && call.id !== '') current.id = call.id;
        const fn = (call.function ?? {}) as Record<string, unknown>;
        if (typeof fn.name === 'string' && fn.name !== '') current.name = fn.name;
        if (typeof fn.arguments === 'string') current.arguments += fn.arguments;
        calls.set(index, current);
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
        finishReason = choice.finish_reason;
      }
    }
  }

  const message: FoldedCompletion['choices'][number]['message'] = {
    role: 'assistant',
    content,
  };
  if (reasoning !== '') message.reasoning_content = reasoning;
  if (calls.size > 0) {
    message.tool_calls = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => ({
        id: call.id === '' ? `call_lingxi_${Math.random().toString(36).slice(2, 10)}` : call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments },
      }));
  }

  const created = Math.floor(Date.now() / 1000);
  return {
    id: `chatcmpl-lingxi-${created}`,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage === undefined ? {} : { usage }),
  };
}
