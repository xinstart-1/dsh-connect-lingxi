/**
 * 提示词预算：上游按 token 限量，超了整轮 400。这里按字节保守裁剪。
 *
 * 策略（照已验证实现的顺序，见 `docs/PROTOCOL.md` §9）：
 * 1. 先掐长条：单条超 `MAX_MESSAGE_BYTES` 的掐头去尾，而不是整条丢——
 *    一次 533KB 的粘贴会导致「整条丢」把其余历史一起牺牲掉；
 * 2. 还超就从最老的一端整条丢，但开头的 `system` 消息一律保留（工具协议和
 *    agent 指令在里面）；
 * 3. 丢完如果头一条是 `tool` 结果，继续丢 —— `tool_calls` 与它的结果必须成对，
 *    孤儿结果会被上游拒。
 *
 * @module dsh-connect-lingxi/protocol/budget
 */

import { MAX_PROMPT_KB } from '../constants.ts';

const MAX_PROMPT_BYTES = MAX_PROMPT_KB * 1024;
const MAX_MESSAGE_BYTES = 48 * 1024;

/** 一条消息的最小形状（OpenAI 风味，字段宽松）。 */
type LooseMessage = Record<string, unknown>;

const encoder = new TextEncoder();

/** UTF-8 字节数。 */
function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** 掐头去尾，保留两端标志位，中间插省略标记。 */
function headTailBytes(text: string, limit: number): string {
  if (byteLength(text) <= limit) return text;
  // 按字符近似切分：UTF-8 中文 3 字节，用 limit/2 的字符数做上界更保守。
  const half = Math.max(1, Math.floor(limit / 2 / 3));
  const head = text.slice(0, half);
  const tail = text.slice(-half);
  return `${head}\n\n…[已截断 ${byteLength(text) - limit} 字节]…\n\n${tail}`;
}

/** 单条消息超限时截断它的文本内容（字符串或 content 数组里的 text 部件）。 */
function elideMessage(message: LooseMessage): LooseMessage {
  const content = message.content;
  if (typeof content === 'string') {
    return byteLength(content) > MAX_MESSAGE_BYTES
      ? { ...message, content: headTailBytes(content, MAX_MESSAGE_BYTES) }
      : message;
  }
  if (Array.isArray(content)) {
    let changed = false;
    const parts = content.map((part) => {
      if (typeof part !== 'object' || part === null) return part;
      const record = part as Record<string, unknown>;
      if (typeof record.text === 'string' && byteLength(record.text) > MAX_MESSAGE_BYTES) {
        changed = true;
        return { ...record, text: headTailBytes(record.text, MAX_MESSAGE_BYTES) };
      }
      return part;
    });
    return changed ? { ...message, content: parts } : message;
  }
  return message;
}

/** 裁剪结果，用于上层打日志（静默截断会让用户以为上下文完整）。 */
export interface FitResult {
  /** 被整条丢掉的消息数。 */
  dropped: number;
  /** 被截断内容的消息数。 */
  elided: number;
}

/**
 * 把请求体裁到预算内。**原地修改** `body.messages`，并返回裁剪统计。
 * @param body - 已构造好的上游请求体（必须有 `messages` 数组）。
 * @returns 裁剪统计；调用方在 `dropped`/`elided` 非零时应打一行 warning。
 */
export function fitAgentBody(body: { messages?: unknown }): FitResult {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return { dropped: 0, elided: 0 };

  const fixed = byteLength(JSON.stringify({ ...body, messages: [] }));
  const sizeOf = (list: readonly LooseMessage[]): number =>
    fixed + list.reduce((sum, m) => sum + byteLength(JSON.stringify(m)), 0);

  let list = messages as LooseMessage[];
  let elided = 0;

  // 先掐长条：单条超 MAX_MESSAGE_BYTES 就掐头去尾。即便只有一条消息也做——
  // 一次 500KB 的粘贴会让整轮 400，而它本来是可以救回来的。
  if (sizeOf(list) > MAX_PROMPT_BYTES || list.some((m) => byteLength(JSON.stringify(m)) > MAX_MESSAGE_BYTES)) {
    const next = list.map((m) => elideMessage(m));
    elided = next.reduce((n, m, i) => n + (m === list[i] ? 0 : 1), 0);
    if (elided > 0) {
      list = next;
      body.messages = list;
    }
  }
  // 只有一条消息时没有历史可丢。
  if (list.length <= 1) return { dropped: 0, elided };
  if (sizeOf(list) <= MAX_PROMPT_BYTES) return { dropped: 0, elided };

  const sizes = list.map((m) => byteLength(JSON.stringify(m)));
  let total = fixed + sizes.reduce((a, b) => a + b, 0);
  let head = 0;
  while (head < list.length - 1 && list[head]?.role === 'system') head += 1;

  let start = head;
  while (total > MAX_PROMPT_BYTES && start < list.length - 1) {
    total -= sizes[start] ?? 0;
    start += 1;
  }
  while (start < list.length - 1 && list[start]?.role === 'tool') {
    total -= sizes[start] ?? 0;
    start += 1;
  }

  // 标记本身也占字节，得算进去；不够就再多丢一条，直到真的装得下。
  const note = (count: number): LooseMessage => ({
    role: 'system',
    content: `[历史已压缩：更早的 ${count} 条消息被省略（上游单次请求长度上限 ${MAX_PROMPT_KB}KB）]`,
  });
  const fits = (candidate: readonly LooseMessage[]): boolean =>
    fixed + candidate.reduce((sum, m) => sum + byteLength(JSON.stringify(m)), 0) <=
    MAX_PROMPT_BYTES;

  while (start - head > 0) {
    const candidate = [...list.slice(0, head), note(start - head), ...list.slice(start)];
    if (fits(candidate)) {
      body.messages = candidate;
      return { dropped: start - head, elided };
    }
    if (start >= list.length - 1) break;
    total -= sizes[start] ?? 0;
    start += 1;
    while (start < list.length - 1 && list[start]?.role === 'tool') {
      total -= sizes[start] ?? 0;
      start += 1;
    }
  }

  // 实在装不下（单条 system 就超预算）：至少保住最后一条用户消息。
  body.messages = [...list.slice(0, head), note(list.length - head - 1), list[list.length - 1]!];
  return { dropped: Math.max(0, start - head), elided };
}