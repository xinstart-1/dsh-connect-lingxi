/**
 * DSH LLM 接入层：把本地 shim 包成一个 pi-ai provider。
 *
 * 这一层刻意做得很薄——真正的工作（三步握手、SSE 翻译、提示词预算）都在
 * `src/protocol/` 与 `src/shim/`。这里只负责：
 * 1. 把模型目录映射成 pi-ai 的 `Model`；
 * 2. 构造 `PiAiAdapterOptions`（profiles / auth / resolveApiKey）；
 * 3. 每次请求给一个不同的 `ApiKeyAuth.resolve`，让 pi-ai 用 shim 的共享密钥。
 *
 * @module dsh-connect-lingxi/llm/adapter
 */

import { PiAiAdapter, type PiAiAdapterOptions, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai';
import { resolveRetryPolicy, type LlmModelInfo, type LlmProviderInfo } from '@deepseek-ai/dsh-llm';
import { createProvider, type Model, type Provider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import {
  PROVIDER,
  REQUEST_IMAGE_BUDGETS,
  STREAM_IDLE_TIMEOUT_MS,
} from '../constants.ts';
import type { LingxiModel } from '../protocol/catalog.ts';
import { INERT_AUTH } from '../credentials/inert-auth.ts';

/** 灵犀没有可得的按 token 计价：订阅配额，报 0。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** 思考档位到 pi 思考档的映射；灵犀只认 low/high/max。 */
const THINKING_LEVELS = {
  off: 'off',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
} as const;

/** 把一个目录条目变成 pi-ai 的 chat model。 */
function toPiModel(info: LingxiModel, baseUrl: string): Model<'openai-completions'> {
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: PROVIDER,
    baseUrl,
    input: info.vision ? ['text', 'image'] : ['text'],
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    reasoning: info.reasoning,
    ...(info.reasoning === true
      ? {
          thinkingLevelMap: { ...THINKING_LEVELS },
          compat: { supportsReasoningEffort: true },
        }
      : {}),
  };
}

/** adapter 与目录的绑定关系。 */
export interface LingxiAdapterOptions {
  /** 当前模型目录；每次构造 profile 时读一次。 */
  catalog: () => readonly LingxiModel[];
  /** shim 的 baseURL（含端口）。 */
  baseUrl: () => string;
  /** shim 的共享密钥。 */
  token: () => string;
}

/** 一次装配的结果，调用方持有 `adapter` 与 `invalidate`。 */
export interface LingxiAdapter {
  adapter: PiAiAdapter;
  /** 目录变化后调用；下一次请求会重建 profiles。 */
  invalidate: () => void;
}

/**
 * 构造 pi-ai provider + PiAiAdapter。
 * @param options - 目录与 shim 身份的读取器。
 * @returns 可直接交给 `ctx.llm.registerAdapter` 的 adapter。
 */
export function createLingxiAdapter(options: LingxiAdapterOptions): LingxiAdapter {
  const buildModels = (): Model<'openai-completions'>[] => {
    const baseUrl = `${options.baseUrl()}/v1`;
    return options.catalog().map((info) => toPiModel(info, baseUrl));
  };

  const provider: Provider<'openai-completions'> = createProvider({
    id: PROVIDER,
    name: 'WPS 灵犀',
    auth: {
      apiKey: {
        name: 'WPS 灵犀（本地 shim）',
        async resolve({ credential }) {
          const key = credential?.key;
          return key === undefined || key.length === 0
            ? undefined
            : { auth: { apiKey: key }, source: 'WPS 灵犀' };
        },
      },
    },
    models: buildModels(),
    api: openAICompletionsApi(),
  });

  const profileFor = (providerKey: string): ResolvedPiAiProviderProfile => ({
    provider: providerKey,
    displayName: 'WPS 灵犀',
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-connect-lingxi retryPolicy'),
    configuredMaxTokens: new Map<string, number>(),
    modelErrors: new Map<string, string>(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider:
      providerKey === PROVIDER
        ? provider
        : {
            ...provider,
            id: providerKey,
          },
  });

  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[PROVIDER, profileFor(PROVIDER)]]);

  const config: PiAiAdapterOptions = {
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => options.token(),
  };

  const adapter = new PiAiAdapter(config);

  return {
    adapter,
    invalidate: () => {
      // pi-ai 的 provider 模型列表是快照；目录变了要重建 provider。
      const models = buildModels();
      const rebuilt = createProvider({
        id: PROVIDER,
        name: 'WPS 灵犀',
        auth: provider.auth,
        models,
        api: openAICompletionsApi(),
      });
      const next = new Map<string, ResolvedPiAiProviderProfile>();
      next.set(PROVIDER, { ...profileFor(PROVIDER), piProvider: rebuilt });
      profiles = next;
    },
  };
}

/**
 * 把目录条目转成 DSH 的 `LlmModelInfo`（模型发现接口要用）。
 * @param models - 目录。
 * @returns DSH 侧的模型描述。
 */
export function toLlmModelInfos(models: readonly LingxiModel[]): LlmModelInfo[] {
  return models.map((model) => ({
    provider: PROVIDER,
    id: model.id,
    name: model.name,
    description: model.multiplier === '' ? undefined : `倍率 ${model.multiplier}`,
    inputModalities: model.vision ? ['text', 'image'] : ['text'],
  }));
}

/** provider 的展示信息。 */
export const PROVIDER_INFO: LlmProviderInfo = { id: PROVIDER, name: 'WPS 灵犀' };
