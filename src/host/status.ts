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
/**
 * 账号池里的一个账号（脱敏视图）。
 *
 * 刻意**没有** cookie / cookie 摘要 / 任何可以反推 cookie 的字段：
 * 这份结构会跨到浏览器半边，登进去的东西不该跟着出去。
 */
export interface StatusAccount {
  /** 账号稳定 id（由 cookie 的 uid 派生）。 */
  id: string;
  /** 显示名；拿不到时退回 id 的短形式。 */
  name: string;
  /** 来源（决定界面上那句「本机客户端 / 浏览器 / 手动」）。 */
  source: 'manual' | 'client' | 'browser' | 'login';
  /** 保存时刻（epoch ms）。 */
  savedAtMs: number;
  /** 当前**实际会用**的账号（与 `login` 一致）。 */
  current: boolean;
  /** 用户显式选中的那个。 */
  selected: boolean;
  /**
   * 是否勾选它参与账号池（轮换 / 批量签到 / 测试）。
   *
   * 与 {@link current} 是两件事：`current` 是「此刻在用」，
   * `enabled` 是「有资格被自动挑中」。一个账号可以是 current 但没勾选
   * （用户手动选的），也可以勾选了但不是 current（这次没挑到它）。
   */
  enabled: boolean;
  /**
   * 剩余智点。
   *
   * `undefined` 表示**没读到**（未登录 / 接口失败 / 还没查过），不是 0。
   * 界面上「读不到」显示成破折号，「0」显示成 0 —— 这两件事必须能分开。
   */
  credits?: number;
  /** 今日是否已签到；`undefined` 表示没查到。 */
  checkedInToday?: boolean;
  /** 读这个账号余额时的失败原因（有就说明它是「读不到」而不是「0」）。 */
  creditsError?: string;
}

/** 账号池的开关状态（界面上那几个控件）。 */
export interface StatusAccountPool {
  /** 是否允许插件在账号之间自动挑选。 */
  enabled: boolean;
  /** 共几个账号。 */
  total: number;
  /** 勾选了几个。 */
  selected: number;
  /**
   * 本机客户端检测到的设备头策略。
   *
   * 灵犀按「设备」限流，同一台机器上多个账号共用一个设备指纹容易被判成
   * 同一台设备刷量。WorkBuddy 的做法是给每个账号一个虚拟设备头。
   * 这里只做展示与开关，具体值由 `deviceMode` 决定。
   */
  deviceMode: 'virtual' | 'real';
}

export interface StatusModel {
  id: string;
  name: string;
  multiplier: string;
  contextWindow: number;
  maxTokens: number;
  /** 是否支持思考档。 */
  reasoning: boolean;
  /** **生效后**的图片输入：已把用户的逐模型开关算进去（见 `model-flags.ts`）。 */
  vision: boolean;
  /** 上游原本声明的图片能力；卡片用它区分「本来就不支持」与「你自己关的」。 */
  visionNative: boolean;
  /** 用户是否把这一行从选择器里关掉了（`enabled` 是它的反义，保留旧字段兼容）。 */
  enabled: boolean;
  /** 官网徽标（`NEW` / `正式版` / `首发接入`）；没有就不带这个键。 */
  badge?: string;
  /** 一句话说明（模式列表里官网给的那句）。 */
  description?: string;
}

/** 界面开关视图（渲染当前值，改动走动作路由）。 */
export interface StatusSettings {
  autoCheckin: boolean;
  pollIntervalMs: number;
  composerPill: boolean;
  sidebarPanel: boolean;
  /** 被关掉的模型 id，供模型列表判断「已关闭」。 */
  disabledModels: string[];
  /** 用户强制关掉图片的模型 id。 */
  imageOffModels: string[];
  /** 用户强制打开图片的模型 id。 */
  imageOnModels: string[];
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
  /**
   * 账号池视图（脱敏：只有 id / 名字 / 来源 / 保存时刻，**绝不含 cookie**）。
   *
   * 顺序是「最近保存的在前」，与 `listAccounts()` 一致。`current` 标记当前实际
   * 会用的那个 —— 它与 `login` 一致，而不是与「用户上次保存的选择」一致，
   * 这样可以一眼看出「我选的」和「真在用的」是不是同一个。
   */
  accounts: StatusAccount[];
  /** 账号池的开关状态（常驻，即使只有一个账号也返回）。 */
  accountPool: StatusAccountPool;
  /** 用户显式选中的账号已不存在，但池里还有别的账号（卡片要能说明这件事）。 */
  selectionLost: boolean;
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
  /** 账号池（脱敏）。不提供时为空数组。 */
  accounts?: StatusAccount[];
  /** 账号池开关状态。不提供时给「未启用、0 个账号」。 */
  accountPool?: StatusAccountPool;
  /** 显式选择的账号已不存在。不提供时按「未失效」处理。 */
  selectionLost?: boolean;
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
  imageOffModels: [],
  imageOnModels: [],
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
    // 旧行为（没有账号池的宿主插件版本）下这两项是空/否，页面据此不渲染账号列表。
    accounts: input.accounts ?? [],
    accountPool: input.accountPool ?? {
      enabled: false,
      total: (input.accounts ?? []).length,
      selected: 0,
      deviceMode: 'virtual',
    },
    selectionLost: input.selectionLost === true,
    settings: input.settings ?? {
      ...DEFAULT_SETTINGS,
      disabledModels: [],
      imageOffModels: [],
      imageOnModels: [],
    },
    readAtMs: now,
    ...(input.lastError === undefined || input.lastError === ''
      ? {}
      : { lastError: input.lastError }),
  };
}
