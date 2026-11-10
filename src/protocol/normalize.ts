/**
 * 请求体归一：把 DSH 发来的「分段 content / 对象 tool_choice」改成上游能吃的形状。
 *
 * 两条都是实测出来的硬约束（`docs/PROTOCOL.md` §3.3，2026-11-10 真机验证）：
 *
 * 1. **`content` 只能是字符串。** 传 `[{type:'text',text}]` 这种分段数组，
 *    无论 `user` / `assistant` / `tool` 角色一律 `400 InvalidArgument 参数错误`；
 *    同一份内容展平成字符串就是 `200`。
 * 2. **`tool_choice` 只能是字符串。** `'auto'` / `'none'` / `'required'` 都收，
 *    但 `{type:'function',function:{name}}` 会 `400 InvalidArgument`。
 *    （`tools[].function.strict` 倒是收的，不需要处理。）
 *
 * @module dsh-connect-lingxi/protocol/normalize
 */

/** 一条消息（字段宽松，原样透传其余键）。 */
type LooseMessage = Record<string, unknown>;

/** 归一统计，给上层打日志用。 */
export interface NormalizeResult {
  /** 归一后的消息数组。 */
  messages: LooseMessage[];
  /** 被丢弃的非文本分段数（图片等 —— 上游不接受分段，只能丢）。 */
  droppedParts: number;
  /** tool_choice 是否从对象被降级成字符串。 */
  coercedToolChoice: boolean;
}

/** 把一个分段里能当文本用的内容取出来；取不到返回 `null`。 */
function partText(part: unknown): string | null {
  if (typeof part === 'string') return part;
  if (typeof part !== 'object' || part === null) return null;
  const record = part as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  return null;
}

/**
 * 把 `content` 展平成字符串。
 * @param content - 原始 content（字符串 / 分段数组 / 其它）。
 * @returns 展平后的字符串，以及被丢掉的非文本分段数。
 */
export function flattenContent(content: unknown): { text: string; dropped: number } {
  if (typeof content === 'string') return { text: content, dropped: 0 };
  // `null` / `undefined` / 对象都会 400（实测：`content:null` → InvalidArgument），
  // 上游只认字符串，缺内容就发空串。
  if (!Array.isArray(content)) return { text: '', dropped: 0 };
  const texts: string[] = [];
  let dropped = 0;
  for (const part of content) {
    const text = partText(part);
    if (text === null) {
      dropped += 1;
      continue;
    }
    texts.push(text);
  }
  return { text: texts.join('\n'), dropped };
}

/**
 * 逐条把消息的 `content` 展平；其余键（`tool_calls` / `tool_call_id`）原样保留。
 * @param messages - DSH 传来的 messages。
 * @returns 归一后的消息与统计。
 */
export function normalizeMessages(messages: readonly LooseMessage[]): NormalizeResult {
  let droppedParts = 0;
  const normalized = messages.map((message) => {
    const content = message.content;
    const role = message.role === 'developer' ? 'system' : message.role;
    if (!Array.isArray(content) && content !== null && content !== undefined) {
      // 字符串内容也会带着 `developer` 这种别名过来，角色同样要换。
      return role === message.role ? message : { ...message, role };
    }
    const { text, dropped } = flattenContent(content);
    if (Array.isArray(content)) droppedParts += dropped;
    return { ...message, role, content: text };
  });
  return { messages: normalized, droppedParts, coercedToolChoice: false };
}

/**
 * 把 `tool_choice` 降级成上游接受的字符串。
 *
 * 指定具体函数时降级为 `'required'`（只有一个可选工具时语义等价），
 * 其余情况 `'auto'` —— 上游没有更细的表达方式。
 * @param choice - DSH 传来的 tool_choice。
 * @returns 上游可接受的字符串；`undefined` 表示不必发送。
 */
export function normalizeToolChoice(choice: unknown): string | undefined {
  if (choice === undefined || choice === null) return undefined;
  if (typeof choice === 'string') return choice;
  if (typeof choice !== 'object') return 'auto';
  const record = choice as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  if (type === 'none' || type === 'auto' || type === 'required') return type;
  if (type === 'function') return 'required';
  return 'auto';
}
