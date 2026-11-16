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
import {
  resolveImageAttachmentAccess,
  resolveRetryPolicy,
  type LlmModelBadge,
  type LlmModelInfo,
  type LlmProviderInfo,
} from '@deepseek-ai/dsh-llm';
/**
 * 宿主附件服务的最小形状。
 *
 * `@deepseek-ai/dsh-attachment` 不是本插件的依赖（宿主通过 `ctx.get('attachments')`
 * 在运行时提供它），所以这里按 `resolveImageAttachmentAccess` 的参数位置反推
 * 出我们用得到的那部分，而不是新增一个 peer dependency —— 只是转手传递，
 * 不需要它的实现类型。
 */
export type AttachmentStore = Parameters<typeof resolveImageAttachmentAccess>[0];
import { createProvider, type Model, type Provider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import {
  PROVIDER,
  REQUEST_IMAGE_BUDGETS,
  STREAM_IDLE_TIMEOUT_MS,
} from '../constants.ts';
import type { LingxiModel } from '../protocol/catalog.ts';
import { thinkingLevelMapFor } from './thinking.ts';
import { INERT_AUTH } from '../credentials/inert-auth.ts';

/** 灵犀没有可得的按 token 计价：订阅配额，报 0。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** 把一个目录条目变成 pi-ai 的 chat model。 */
function toPiModel(info: LingxiModel, baseUrl: string): Model<'openai-completions'> {
  const thinkingLevelMap = thinkingLevelMapFor(info);
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
    // 档位由上游声明决定：官网给三档就只露三档，没声明的档位钉成 null。
    // 写死七档会让用户选到官网没有的档位（见 `thinking.ts` 的说明）。
    ...(thinkingLevelMap === undefined
      ? {}
      : {
          thinkingLevelMap,
          compat: { supportsReasoningEffort: true },
        }),
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
  /**
   * 宿主的持久附件服务（`ctx.get('attachments')`）。
   *
   * 不提供时模型仍会声明图片能力，但**用户一发图就报
   * `pi-ai image input requires the durable attachment service`** ——
   * 所以插件在有这个服务时必须接上。
   * @returns 附件服务，或 `undefined`（宿主没有装配）。
   */
  attachments?: () => AttachmentStore | undefined;
  /**
   * 把宿主路径映射成当前执行世界可读的路径（`ctx.get('fs')?.processPathFromHostPath`）。
   *
   * 不提供时退回宿主路径本身 —— 本机同进程场景下两者相同，
   * 只有跨沙箱/容器时才需要映射。
   */
  processPath?: (hostPath: string) => string | undefined;
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
    // 图片输入必须接上宿主的附件库，否则 pi-ai 会直接拒绝：
    // `pi-ai image input requires the durable attachment service`（UNSUPPORTED_CONTENT）。
    //
    // 这不是可选项：我们把模型标成支持图片（`input: ['text','image']`），
    // 用户就会真的发图片进来；没有这个服务，第一次发图就报错。
    //
    // 注意判断的是「服务此刻在不在」而不是「有没有传这个函数」：
    // 插件总是传函数（服务可能晚于 apply 装配），但宿主真的没有这个服务时
    // 不该挂一个永远返回 undefined 的钩子 —— 那等于假装接上了。
    ...(options.attachments === undefined
      ? {}
      : {
          resolveAttachments: () => options.attachments?.(),
          resolveImageAccess: (attachments: AttachmentStore, ref: Parameters<NonNullable<PiAiAdapterOptions['resolveImageAccess']>>[1]) =>
            resolveImageAttachmentAccess(
              attachments,
              (hostPath) => options.processPath?.(hostPath),
              ref,
            ),
        }),
  };

  const adapter = new PiAiAdapter(config);
  // 选择器读的那条路（`llm.listModels`）由 pi-ai 实现，它不知道倍率与徽标；
  // 在这里包一层补进去，而不是另开一条宿主不读的目录通道。
  const listModels = adapter.listModels.bind(adapter);
  adapter.listModels = (provider: string) =>
    listModels(provider).then((models) => withCatalogDetails(models, options.catalog()));

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
 *
 * `name` 带倍率（`DeepSeek V4.1 Flash · ~0.12x`，见 {@link catalogName}）：
 * 选择器里那一行只有一个名字字段，倍率不并进去就永远不会出现。
 * `badge` 是名字旁边那个小标签，官网用它标 `NEW` / `正式版` / `首发接入`，
 * 这里原样透传 —— 用户在选择器里看到的区分，应当与他在官网看到的一致。
 *
 * 运行时真正给选择器供数的是 {@link withCatalogDetails}（pi-ai 的 `listModels`）；
 * 这个函数与它保持同一套字段，供单测和还没有 adapter 的调用方使用。
 * @param models - 目录。
 * @returns DSH 侧的模型描述。
 */
export function toLlmModelInfos(models: readonly LingxiModel[]): LlmModelInfo[] {
  return models.map((model) => {
    const badge = modelBadge(model);
    return {
      provider: PROVIDER,
      id: model.id,
      name: catalogName(model),
      description: modelDescription(model),
      inputModalities: model.vision ? ['text', 'image'] : ['text'],
      ...(badge === undefined ? {} : { badge }),
    };
  });
}

/**
 * 一行模型在下拉里的第二行说明：只有上游文案。
 *
 * 倍率**不在这里**：它已经并进名字（{@link catalogName}）。说明再写一遍，
 * 同一个下拉里就会一行两份「倍率」。
 *
 * 没有文案就返回 `undefined`，让宿主自己省略这一行，而不是塞空串占位。
 * @param model - 目录条目。
 * @returns 说明文本，或 `undefined`。
 */
export function modelDescription(model: LingxiModel): string | undefined {
  const text = model.description;
  return text === undefined || text === '' ? undefined : text;
}

/**
 * 选择器里那一行的模型名：`名字 · 倍率`（`DeepSeek V4.1 Flash · ~0.12x`）。
 *
 * 倍率必须并进名字字符串：宿主选择器的名字只认 `LlmModelInfo.name`（见
 * {@link withCatalogDetails} 的说明），没有第二个字段可以挂「倍率」。
 * 贴的是上游原文 —— `~` 是官网标折扣价的写法，不替它改成确定值。
 *
 * 模式（`plan_pro` / `plan_max`）没有倍率，名字保持原样。
 * @param model - 目录条目。
 * @returns 选择器里显示的名字。
 */
export function catalogName(model: LingxiModel): string {
  return model.multiplier === '' ? model.name : `${model.name} · ${model.multiplier}`;
}

/**
 * 目录徽标 → 宿主徽标；上游没给就是 `undefined`（不凭空造一个）。
 * @param model - 目录条目。
 * @returns 宿主可渲染的徽标，或 `undefined`。
 */
export function modelBadge(model: LingxiModel): LlmModelBadge | undefined {
  return model.badge === undefined
    ? undefined
    : { text: badgeText(model.badge), tone: badgeTone(model.badge) };
}

/**
 * 把目录里的倍率与徽标补进 `listModels` 的结果。
 *
 * 宿主选择器的名字与徽标**只从这条路读**：`ctx.llm.listModels(provider)` →
 * `buildModelCatalog()`（`dsh-api-session-controller`）。pi-ai 的 `listModels`
 * 只回 `provider/id/name/inputModalities`（它的模型类型里根本没有倍率和徽标），
 * 所以不补这一步，选择器里就只剩一个干名字 —— 卡片里有倍率、下拉里没有。
 *
 * 另一条 `registerModelDiscovery` 是「从接口读模型」的候选清单，宿主会把它
 * 白名单成 `id/name/contextWindow/maxTokens/inputModalities`，徽标到不了界面，
 * 所以别把这里当成可有可无的复制。
 * @param models - `listModels` 原样返回的条目。
 * @param catalog - 当前目录（可见模型）。
 * @returns 补上倍率与徽标的条目。
 */
export function withCatalogDetails(
  models: readonly LlmModelInfo[],
  catalog: readonly LingxiModel[],
): LlmModelInfo[] {
  const byId = new Map(catalog.map((model) => [model.id, model]));
  return models.map((info) => {
    const entry = byId.get(info.id);
    if (entry === undefined) return info;
    const badge = modelBadge(entry);
    const description = modelDescription(entry);
    return {
      ...info,
      name: catalogName(entry),
      ...(description === undefined ? {} : { description }),
      ...(badge === undefined ? {} : { badge }),
    };
  });
}

/**
 * 徽标文案：中文界面照抄上游原文，英文界面给一个英文说法。
 *
 * 上游给的是中文标签（`正式版` / `首发接入`），而宿主的徽标字段是
 * `LocalizedText`（一个字符串，或按语言 id 分开的翻译，英文必需）。
 * 以前这里直接传中文串，英文界面就只好原样显示「正式版」——
 * 那在英文用户眼里是一个乱码词，而不是一个标签。
 *
 * 认不出的文案原样透传：我们不知道它的含义，翻译它就是在编。
 * @param text - 上游徽标原文。
 * @returns 宿主可渲染的文案。
 */
export function badgeText(text: string): string | { en: string; zh: string } {
  if (text === '正式版') return { en: 'GA', zh: '正式版' };
  if (text === '首发接入') return { en: 'Launch', zh: '首发接入' };
  return text;
}

/**
 * 徽标语气：官网那三个橙色标签都是「提示性」的，不是警告。
 *
 * `NEW` / `首发接入` 是「新上架，值得试」，用 `info`；`正式版` 是「这个可以放心用」，
 * 用 `success`。其余上游自定义文案一律 `neutral` —— 我们不知道它的含义，
 * 用中性的灰比猜一个颜色诚实。
 * @param text - 徽标文案。
 * @returns 语气。
 */
export function badgeTone(text: string): 'neutral' | 'info' | 'success' | 'warning' {
  if (text === '正式版') return 'success';
  if (text === 'NEW' || text === '首发接入' || text === '新') return 'info';
  return 'neutral';
}

/** provider 的展示信息。 */
export const PROVIDER_INFO: LlmProviderInfo = { id: PROVIDER, name: 'WPS 灵犀' };
