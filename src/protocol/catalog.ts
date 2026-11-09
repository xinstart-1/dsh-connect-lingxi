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
}

/**
 * 静态兜底目录，与灵犀客户端 1.3.31 对齐。
 * 见 `docs/PROTOCOL.md` §6.2。
 */
export const STATIC_CATALOG: readonly LingxiModel[] = Object.freeze([
  { id: 'auto', name: '自动推荐 (Auto)', contextWindow: 1_048_576, maxTokens: 65_536, multiplier: '1.0x', reasoning: true, vision: false },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1_048_576, maxTokens: 65_536, multiplier: '0.12x', reasoning: true, vision: true },
  { id: 'deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash', contextWindow: 1_048_576, maxTokens: 65_536, multiplier: '0.09x', reasoning: true, vision: false },
  { id: 'deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro', contextWindow: 1_048_576, maxTokens: 65_536, multiplier: '0.40x', reasoning: true, vision: false },
  { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 1_048_576, maxTokens: 65_536, multiplier: '1.60x', reasoning: true, vision: true },
  { id: 'GLM-5.3', name: 'GLM-5.3', contextWindow: 1_048_576, maxTokens: 65_536, multiplier: '0.75x', reasoning: true, vision: false },
  { id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash', contextWindow: 1_048_576, maxTokens: 65_536, multiplier: '0.11x', reasoning: true, vision: true },
  { id: 'qwen3.8_max', name: 'Qwen3.8-Max', contextWindow: 1_048_576, maxTokens: 65_536, multiplier: '0.80x', reasoning: true, vision: true },
  { id: 'qwen3.8_flash', name: 'Qwen3.8-Flash', contextWindow: 1_048_576, maxTokens: 65_536, multiplier: '0.08x', reasoning: true, vision: true },
  { id: 'minimax_m3', name: 'MiniMax-M3', contextWindow: 1_048_576, maxTokens: 65_536, multiplier: '0.20x', reasoning: false, vision: true },
  { id: 'doubao_seed_2_1_pro_260628', name: 'Doubao-Seed-2.1 Pro', contextWindow: 262_144, maxTokens: 32_768, multiplier: '0.50x', reasoning: true, vision: true },
  { id: 'mimo-v2.6-pro', name: 'Xiaomi MiMo-V2.6 Pro', contextWindow: 1_048_576, maxTokens: 65_536, multiplier: '0.10x', reasoning: false, vision: true },
  { id: 'plan_pro', name: 'Pro 模式 (深度推理)', contextWindow: 1_048_576, maxTokens: 65_536, multiplier: '1.0x', reasoning: true, vision: false },
  { id: 'plan_max', name: 'Max 模式 (复杂任务)', contextWindow: 1_048_576, maxTokens: 65_536, multiplier: '1.0x', reasoning: true, vision: false },
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
 * 把上游目录条目转成本地模型描述。缺字段用兜底值，`key` 缺失或非法直接丢弃。
 * @param raw - 上游 `plans[]` / `models[]` 的一项。
 * @param kind - `plan` 模式项还是 `model` 模型项，只影响倍率文案缺省。
 * @returns 模型描述，或 `undefined`（条目不可用）。
 */
export function fromRawEntry(
  raw: RawPlanEntry,
  kind: 'plan' | 'model',
): LingxiModel | undefined {
  const id = typeof raw.key === 'string' ? raw.key.trim() : '';
  if (id === '') return undefined;
  return {
    id,
    name: stringOr(raw.name, id),
    contextWindow: numberOr(raw.max_context_tokens, 1_048_576),
    maxTokens: numberOr(raw.max_new_tokens, 65_536),
    multiplier: stringOr(raw.multiplier, kind === 'plan' ? '模式' : ''),
    reasoning: kind === 'plan' ? true : true,
    vision: raw.support_multimodal === true,
    ...(effortList(raw.reasoning_efforts) === undefined
      ? {}
      : { reasoningEfforts: effortList(raw.reasoning_efforts) }),
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
