/**
 * 状态文档：宿主算好、浏览器直接渲染的那份 JSON。
 *
 * 为什么不让浏览器自己算：余额、任务、模型目录都需要 cookie，cookie 不能进页面
 * （那是「凭据不传到页面」这条规则的底线）。所以宿主把**已经归一好的展示数据**
 * 放在 `/plugins/dsh-connect-lingxi/status` 上，页面只负责排版。
 *
 * 这份文档的形状是**契约**：浏览器半侧（`src/client/`）按字段名读它，
 * 改字段必须同步改 `src/client/bundle.js`。
 *
 * @module dsh-connect-lingxi/host/status
 */

/** 余额视图。 */
export interface StatusCredits {
  /** `ok` 有读数；`expired` 登录态失效；`unavailable` 读不到。 */
  state: 'ok' | 'unavailable' | 'expired';
  /** 主余额。 */
  total?: number;
  /** 赠送总额（额度型账号才有）。 */
  totalValue?: number;
  /** 已用总量。 */
  consumed?: number;
  /** 15 天内会过期的余额与最早到期时间。 */
  expiring?: { amount: number; earliest: string };
  /** 每个赠送批次。 */
  batches: Array<{ balance: number; value: number; consumed: number; expireTime: string }>;
  /** 这份读数抓取的时刻。 */
  updatedAtMs?: number;
}

/** 任务视图。 */
export interface StatusTask {
  key: string;
  type: string;
  title: string;
  status: string;
  reward: number;
  streak?: number;
}

/** 模型视图（含当前启用状态）。 */
export interface StatusModel {
  id: string;
  name: string;
  multiplier: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  vision: boolean;
  enabled: boolean;
}

/** 界面开关视图（渲染当前值，改动走动作路由）。 */
export interface StatusSettings {
  autoCheckin: boolean;
  pollIntervalMs: number;
  composerPill: boolean;
  sidebarPanel: boolean;
  /** 被关掉的模型 id，供模型列表判断「已关闭」。 */
  disabledModels: string[];
}

/** 完整状态文档。 */
export interface StatusDocument {
  /** 插件版本号（卡片上显示，便于报问题时报准版本）。 */
  version: string;
  /** 登录态。 */
  login: {
    state: 'signed-in' | 'signed-out' | 'expired';
    /** `client` 本机客户端；`browser` 日常浏览器或主动登录；`manual` 手填；`none` 无。 */
    source: 'manual' | 'client' | 'browser' | 'none';
    name?: string;
    /** 是否支持一键登录（拉起浏览器）。 */
    canLogin?: boolean;
  };
  credits: StatusCredits;
  tasks: {
    daily?: StatusTask;
    oneTime: StatusTask[];
    checkedInToday: boolean;
  };
  models: StatusModel[];
  /** 界面开关的当前值。 */
  settings: StatusSettings;
  /** 整份文档里**最旧**一段数据的时刻。 */
  readAtMs: number;
  /** 上游最近一次错误的原文（诊断用，不翻译、不概括）。 */
  lastError?: string;
}

/** 构建文档的输入。 */
export interface StatusInput {
  version: string;
  login: StatusDocument['login'];
  credits?: StatusCredits;
  tasks?: StatusDocument['tasks'];
  models: StatusModel[];
  settings?: StatusSettings;
  lastError?: string;
  nowMs?: number;
}

/** 默认界面开关（与 `state.ts` 的 DEFAULT_STATE 一致，这里不 import 以免循环依赖）。 */
const DEFAULT_SETTINGS: StatusSettings = {
  autoCheckin: false,
  pollIntervalMs: 300_000,
  composerPill: true,
  sidebarPanel: false,
  disabledModels: [],
};

/**
 * 组装状态文档；缺的段落给安全缺省，永不抛。
 *
 * 这个函数存在的意义是让**缺省**只有一个定义处：页面在三种宿主版本上
 * （老版本没有 status 路由、新版本有、有但读不到）都要能渲染出同一句话，
 * 而不是各自 `??` 一遍。
 * @param input - 已归一的数据。
 * @returns 完整文档。
 */
export function buildStatusDocument(input: StatusInput): StatusDocument {
  const now = input.nowMs ?? Date.now();
  return {
    version: input.version,
    login: input.login,
    credits: input.credits ?? { state: 'unavailable', batches: [] },
    tasks: input.tasks ?? { oneTime: [], checkedInToday: false },
    models: input.models,
    settings: input.settings ?? { ...DEFAULT_SETTINGS },
    readAtMs: now,
    ...(input.lastError === undefined || input.lastError === ''
      ? {}
      : { lastError: input.lastError }),
  };
}
