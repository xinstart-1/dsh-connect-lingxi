/**
 * 灵犀 GUI 静态模型表的类型。动态目录（`/sessions/plans`）未登录时用它兜底。
 * @module dsh-connect-lingxi/protocol/catalog
 */

/** 一个可用模型（或模式）。 */
export interface LingxiModel {
  /** 上游模型 key，直接作为 `model_id` 发送。 */
  id: string;
  /** 显示名。 */
  name: string;
  /** 上下文窗口（token）。 */
  contextWindow: number;
  /** 单次输出上限（token）。 */
  maxTokens: number;
  /** 计费倍率（仅展示）。 */
  multiplier: string;
  /** 是否支持思考档。 */
  reasoning: boolean;
  /** 是否支持图片输入。 */
  vision: boolean;
  /** 支持时，可选思考档位。 */
  reasoningEfforts?: readonly string[];
  /**
   * 官网徽标文案（`NEW` / `正式版` / `首发接入` 这类）。
   *
   * 这是**展示**字段：它不影响请求，只影响用户在列表里怎么认这个模型。
   * 上游给了就用上游的；没给时静态兜底表里带着官网当前的值。
   */
  badge?: string;
  /** 一句话说明（官网在模式列表里给出的那句）。 */
  description?: string;
}

/**
 * 静态兜底目录：**逐字段抄自一次真实的 `/sessions/plans` 响应**（2026-11-10 抓取）。
 *
 * 只在两种情况下被用到：未登录、或 `/sessions/plans` 读不到。登录后一律以上游
 * 动态目录为准。抓取脚本见 `scripts/capture-plans.mjs`，核对报告见
 * `docs/CHANGELOG-0.0.10.md`。
 *
 * 五个必须照抄、不要「顺手修正」的字段：
 *
 * 1. **顺序**：上游先给 `plans`（Pro/Max 模式）再给 `models`，这里保持一致 ——
 *    否则兜底目录和登录后的目录顺序会不一样。
 * 2. **`maxTokens`**：上游是 `max_new_tokens`，各模型差别极大
 *    （kimi-k3 是 1048576，qwen 是 131072，deepseek-v4.1-flash 是 393216）。
 *    旧表一律写 65536，是把输出上限砍到了实际值的 1/6。
 * 3. **`reasoning`**：只有上游给了 `reasoning_efforts` 才算思考模型。
 *    实测 `mimo-v2.6-pro` / `minimax_m3` / 两个 `plan_*` **没有**档位声明，
 *    它们不该有思考开关。
 * 4. **倍率**：`~` 是上游原文（折扣价），且上游混用 ASCII `~` 与全角 `～`，
 *    解析时会归一成 ASCII。不要自己算成确定值。
 * 5. **徽标**：上游字段名是 `tag`，原样透传（`NEW` / `正式版` / `首发接入`）。
 *
 * 官网「内置模型」列表里**没有** `auto` 与 `deepseek-v4-flash-0731`，
 * 上游接口同样不返回，所以这里也不放 —— 兜底表里留着用户看不到的模型，
 * 会让人以为插件在瞎编。
 */
export const STATIC_CATALOG: readonly LingxiModel[] = Object.freeze([
  {
    id: 'plan_pro',
    name: 'Pro 模式',
    contextWindow: 1048576,
    maxTokens: 131072,
    multiplier: '',
    reasoning: false,
    vision: true,
    description: '适用于日常任务，智点消耗较少',
  },
  {
    id: 'plan_max',
    name: 'Max 模式',
    contextWindow: 1048576,
    maxTokens: 131072,
    multiplier: '',
    reasoning: false,
    vision: true,
    description: '为复杂任务设计，智点消耗较多',
  },
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    contextWindow: 1048576,
    maxTokens: 393216,
    multiplier: '~0.12x',
    reasoning: true,
    vision: true,
    badge: 'NEW',
    reasoningEfforts: ['low', 'high', 'max'],
  },
  {
    id: 'deepseek-v4-pro-0813',
    name: 'DeepSeek V4 Pro',
    contextWindow: 1048576,
    maxTokens: 393216,
    multiplier: '0.40x',
    reasoning: true,
    vision: false,
    badge: '正式版',
    reasoningEfforts: ['low', 'high', 'max'],
  },
  {
    id: 'qwen3.8_flash',
    name: 'Qwen3.8-Flash',
    contextWindow: 1048576,
    maxTokens: 131072,
    multiplier: '~0.08x',
    reasoning: true,
    vision: true,
    reasoningEfforts: ['low', 'high', 'max'],
  },
  {
    id: 'qwen3.8_max',
    name: 'Qwen3.8-Max',
    contextWindow: 1048576,
    maxTokens: 131072,
    multiplier: '~0.80x',
    reasoning: true,
    vision: true,
    reasoningEfforts: ['low', 'high', 'max'],
  },
  {
    id: 'mimo-v2.6-pro',
    name: 'Xiaomi MiMo-V2.6 Pro',
    contextWindow: 1048576,
    maxTokens: 131072,
    multiplier: '0.10x',
    reasoning: false,
    vision: true,
  },
  {
    id: 'GLM-5.3-Flash',
    name: 'GLM-5.3-Flash',
    contextWindow: 1048576,
    maxTokens: 131072,
    multiplier: '~0.11x',
    reasoning: true,
    vision: true,
    badge: '首发接入',
    reasoningEfforts: ['low', 'high', 'max'],
  },
  {
    id: 'GLM-5.3',
    name: 'GLM-5.3',
    contextWindow: 1048576,
    maxTokens: 131072,
    multiplier: '~0.75x',
    reasoning: true,
    vision: false,
    badge: '首发接入',
    reasoningEfforts: ['low', 'high', 'max'],
  },
  {
    id: 'minimax_m3',
    name: 'MiniMax-M3',
    contextWindow: 1048576,
    maxTokens: 524288,
    multiplier: '0.20x',
    reasoning: false,
    vision: true,
  },
  {
    id: 'doubao_seed_2_1_pro_260628',
    name: 'Doubao-Seed-2.1 Pro',
    contextWindow: 262144,
    maxTokens: 262144,
    multiplier: '~0.50x',
    reasoning: true,
    vision: true,
    reasoningEfforts: ['low', 'high', 'max'],
  },
  {
    id: 'kimi-k3',
    name: 'Kimi-K3',
    contextWindow: 1048576,
    maxTokens: 1048576,
    multiplier: '1.60x',
    reasoning: true,
    vision: true,
    reasoningEfforts: ['low', 'high', 'max'],
  },
  {
    id: 'kimi-k3.1-pro',
    name: 'Kimi-K3.1 Pro',
    contextWindow: 1048576,
    maxTokens: 1048576,
    multiplier: '~1.10x',
    reasoning: true,
    vision: true,
    badge: 'NEW',
    reasoningEfforts: ['low', 'high', 'max'],
  },
]);

/** 上游 `plans` 接口里一个条目（字段可缺）。 */
export interface RawPlanEntry {
  key?: unknown;
  name?: unknown;
  desc?: unknown;
  intro?: unknown;
  multiplier?: unknown;
  max_context_tokens?: unknown;
  max_new_tokens?: unknown;
  support_multimodal?: unknown;
  reasoning_efforts?: unknown;
  /** 徽标文案。上游可能叫 `badge` / `tag` / `label`，三个都认。 */
  badge?: unknown;
  tag?: unknown;
  label?: unknown;
}

/** `/sessions/plans` 的响应包络。 */
export interface RawPlansPayload {
  data?: {
    plans?: unknown;
    models?: unknown;
  };
}

/** 目录为空时的默认模型 key。 */
const DEFAULT_MODEL_FALLBACK = 'deepseek-v4.1-flash';

/**
 * 去掉客户端的 provider 前缀，返回上游真正认的 model key。
 * `default` 与空串都落到默认模型。
 * @param raw - 客户端传来的模型 id。
 * @returns 可直接作为 `model_id` 发送的 key。
 */
export function normalizeModelId(raw: unknown): string {
  let id = typeof raw === 'string' ? raw.trim() : '';
  id = id.replace(/^wps-lingxi\//, '').replace(/^lingxi[/-]/, '');
  if (id === '' || id === 'default') return DEFAULT_MODEL_FALLBACK;
  return id;
}

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function effortList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  return list.length === 0 ? undefined : list;
}

/**
 * 归一上游倍率里的波浪号。
 *
 * 实测上游混用三种：ASCII `~`（U+007E）、全角 `～`（U+FF5E）、日文 `〜`（U+301C）。
 * 不归一的话同一列里会出现两种字形，看起来像两个不同的字段。
 * @param text - 上游原文。
 * @returns 统一成 ASCII `~` 的文本。
 */
function normalizeTilde(text: string): string {
  return text.replace(/[\uFF5E\u301C\u223C]/g, '~');
}

/**
 * 把上游目录条目转成本地模型描述。缺字段用兜底值，`key` 缺失或非法直接丢弃。
 *
 * **思考能力以上游声明为准**：`reasoning_efforts` 非空才是思考模型。实测上游对
 * `mimo-v2.6-pro` / `minimax_m3` / 两个 `plan_*` 都**不给** `reasoning_efforts`，
 * 它们确实没有思考档 —— 旧代码写死 `reasoning: true` 会给它们凭空造出一个
 * 点了没用的思考开关。
 * @param raw - 上游 `plans[]` / `models[]` 的一项。
 * @param kind - `plan` 模式项还是 `model` 模型项（保留参数以兼容调用方，两者解析规则一致）。
 * @returns 模型描述，或 `undefined`（条目不可用）。
 */
export function fromRawEntry(
  raw: RawPlanEntry,
  kind: 'plan' | 'model',
): LingxiModel | undefined {
  const id = typeof raw.key === 'string' ? raw.key.trim() : '';
  if (id === '') return undefined;
  // 上游的说明字段有两种叫法（`desc` / `intro`），先 desc 后 intro；
  // 徽标同理，三种叫法都认。取不到就不带这个键，让界面自然不渲染。
  const description = stringOr(raw.desc, stringOr(raw.intro, ''));
  const badge = stringOr(
    typeof raw.badge === 'string' ? raw.badge : '',
    stringOr(typeof raw.tag === 'string' ? raw.tag : '', typeof raw.label === 'string' ? raw.label : ''),
  );
  const efforts = effortList(raw.reasoning_efforts);
  return {
    id,
    name: stringOr(raw.name, id),
    contextWindow: numberOr(raw.max_context_tokens, 1_048_576),
    // 实测上游给的是 `max_new_tokens`（输出上限），不是历史里的 8192/65536。
    maxTokens: numberOr(raw.max_new_tokens, 131_072),
    // 倍率缺失就是「没有倍率」，不是「倍率叫某个字」。
    // 0.0.12 及以前这里写的是 `kind === 'plan' ? '模式' : ''`，于是 Pro/Max 模式
    // 的倍率被解析成字符串「模式」，界面上渲染出「倍率 模式」—— 那是把
    // 名称里的字误当成了数值。两个 kind 都用空串。
    multiplier: normalizeTilde(stringOr(raw.multiplier, '')),
    // 有档位声明才是思考模型；没声明就没有思考能力（不是「未知」）。
    reasoning: efforts !== undefined,
    vision: raw.support_multimodal === true,
    ...(efforts === undefined ? {} : { reasoningEfforts: efforts }),
    ...(badge === '' ? {} : { badge }),
    ...(description === '' ? {} : { description }),
  };
}

/**
 * 解析 `/sessions/plans` 的响应。先列模式（`plans`），再列模型（`models`）。
 * @param payload - 上游 JSON。
 * @returns 模型列表；空列表表示目录不可用，调用方应回退到静态表。
 */
export function parsePlans(payload: unknown): LingxiModel[] {
  const envelope = payload as RawPlansPayload | null;
  const data = envelope?.data;
  if (data === undefined || data === null) return [];
  const out: LingxiModel[] = [];
  for (const [field, kind] of [
    ['plans', 'plan'],
    ['models', 'model'],
  ] as const) {
    const list = (data as Record<string, unknown>)[field];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue;
      const model = fromRawEntry(item as RawPlanEntry, kind);
      if (model !== undefined) out.push(model);
    }
  }
  return out;
}

/** 按 id 去重，先出现的胜出（模式优先于同名模型）。 */
export function dedupeModels(models: readonly LingxiModel[]): LingxiModel[] {
  const seen = new Set<string>();
  const out: LingxiModel[] = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}
