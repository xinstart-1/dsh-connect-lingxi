/**
 * 任务中心（每日签到 + 一次性任务）的解析。见 `docs/PROTOCOL.md` §12。
 *
 * 这里只做**纯数据整形**：不发请求、不做决定。领取策略（要不要自动化、
 * 哪些任务能纯 HTTP 做完）属于 `host/runtime.ts`，因为那涉及账号状态。
 *
 * 一条原则贯穿全文件：**上游说什么就是什么**。`status` 原样保留，不翻译成
 * 本地枚举——上游可能新增状态，翻译表会把它悄悄压成「未知」，而「未知」
 * 在界面上的表现就是「看起来没事」。
 *
 * @module dsh-connect-lingxi/protocol/tasks
 */

/** 签到档位里的一天。 */
export interface CheckInDay {
  /** `YYYY-MM-DD`。 */
  date: string;
  /** 上游 `claimed` / `locked` / `available`。 */
  status: string;
}

/** 一个任务。 */
export interface LingxiTask {
  /** 上游 `task_key`（领取时原样回传）。 */
  key: string;
  /** `daily` / `one_time`。 */
  type: string;
  /** 展示名（上游没给中文名时按 task_key 兜底）。 */
  title: string;
  /** 上游 `status` 原样：`claimed` / `claimable` / `incomplete` / `locked`。 */
  status: string;
  /** 奖励智点；认不出来时为 0。 */
  reward: number;
  /** 上游给的动作标识（`expert_mode` / `group_chat` / `download_client`）；没有就不带。 */
  action?: string;
  /** 连签天数（仅每日签到有）。 */
  streak?: number;
  /** 签到档位（仅每日签到有）。 */
  days: CheckInDay[];
}

/**
 * 做一次性任务时发的那句话。
 *
 * 为什么不能更短：上游按用量扣智点（整数余额），回答太短可能凑不够 1 智点
 * 而不产生计费记录；同时 cowork 平面的风控会拒绝「hi」这类裸词。
 * 这句是取证实现里实测可用的话术，改它要先在真机上验过。
 */
export const DEFAULT_TASK_TEXT = '请用两三句话介绍一下你自己，包括你擅长的任务类型';

/** 任务 key → 中文名兜底表（上游不给 title 时用）。 */
const TASK_TITLES: Record<string, string> = {
  daily_check_in: '每日签到',
  try_expert_mode: '体验灵犀专家模式',
  try_group_chat: '体验群聊功能',
  use_lingxi_client: '使用灵犀客户端',
};

function finiteOrZero(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 解析签到档位数组。 */
function parseDays(raw: unknown): CheckInDay[] {
  if (!Array.isArray(raw)) return [];
  const out: CheckInDay[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const date = stringOf(record.date);
    if (date === '') continue;
    out.push({ date, status: stringOf(record.status) });
  }
  return out;
}

/** 解析一个任务条目。 */
function parseTask(raw: unknown): LingxiTask | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const item = raw as Record<string, unknown>;
  const key = stringOf(item.task_key);
  if (key === '') return undefined;

  const extra =
    typeof item.extra === 'object' && item.extra !== null
      ? (item.extra as Record<string, unknown>)
      : undefined;
  const streak = extra === undefined ? undefined : Number(extra.consecutive_days);
  const title = stringOf(item.title) || stringOf(item.name) || TASK_TITLES[key] || key;
  // 上游用 `action` 说明「这个任务要做什么」，与 task_key 可能不同名（两者都见过）。
  const action = stringOf(item.action);

  return {
    key,
    type: stringOf(item.type) || 'one_time',
    title,
    status: stringOf(item.status),
    reward: finiteOrZero(item.reward_amount),
    ...(action === '' ? {} : { action }),
    ...(Number.isFinite(streak) && (streak as number) > 0 ? { streak: streak as number } : {}),
    days: parseDays(extra?.check_in_days),
  };
}

/**
 * 解析任务中心响应。
 *
 * @param payload - 上游 JSON（`{ data: { tasks: [...] } }`）。
 * @returns 任务列表；形状认不出来时为空数组（永不抛）。
 */
export function parseTasks(payload: unknown): LingxiTask[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return [];
  const list = (data as Record<string, unknown>).tasks;
  if (!Array.isArray(list)) return [];
  const out: LingxiTask[] = [];
  for (const raw of list) {
    const task = parseTask(raw);
    if (task !== undefined) out.push(task);
  }
  return out;
}

/**
 * 找每日签到任务。
 * @param tasks - 任务列表。
 * @returns 每日签到，没有则 `undefined`。
 */
export function dailyTask(tasks: readonly LingxiTask[]): LingxiTask | undefined {
  return tasks.find((task) => task.key === 'daily_check_in');
}

/**
 * 上游已判 `claimable` 的一次性任务。
 *
 * **只挑 claimable**：`incomplete` 需要真实客户端行为才能翻转，
 * 假装去领只会换来一次失败写请求。
 * @param tasks - 任务列表。
 * @returns 可领取的任务。
 */
export function claimableOneTime(tasks: readonly LingxiTask[]): LingxiTask[] {
  return tasks.filter(
    (task) => task.type !== 'daily' && task.key !== 'daily_check_in' && task.status === 'claimable',
  );
}

/**
 * 领取签到时要带的日期。
 *
 * 上游的档位只有 `claimed` / `locked` 两种状态，没有 `available`；
 * 所以优先按**今天**匹配。匹配不到（例如跨零点）再看有没有显式 `available` 的档位，
 * 都没有就把今天原样发上去——让上游自己判断，比本地猜一个日期安全。
 *
 * @param daily - 每日签到任务。
 * @param today - 今天的 `YYYY-MM-DD`（北京时间口径）。
 * @returns 要带上的日期。
 */
export function claimDateOf(daily: LingxiTask | undefined, today: string): string {
  if (daily === undefined) return today;
  const hit = daily.days.find((day) => day.date === today);
  if (hit !== undefined) return hit.date;
  const available = daily.days.find((day) => day.status === 'available');
  return available?.date ?? today;
}

/** 一次领取的结果。 */
export interface ClaimOutcome {
  /** 上游明确成功。 */
  ok: boolean;
  /** 本次奖励智点。 */
  reward: number;
  /** 上游说「已经领过」（幂等假成功）时为 true。 */
  alreadyDone: boolean;
  /** 失败时可展示的文案（上游原文优先）。 */
  message?: string;
}

/**
 * 解析领取响应。
 *
 * 上游成功时 `result === "ok"`；失败时 `result` 是别的值、`hint` 里是给用户的话。
 * `result` 缺失按成功处理（HTTP 200 已经是成功信号，参考实现也这么判）。
 *
 * @param payload - 上游 JSON。
 * @param fallbackReward - 响应里没给奖励时用任务本身声明的数。
 * @returns 归一后的结果。
 */
export function parseClaimResponse(payload: unknown, fallbackReward: number): ClaimOutcome {
  if (typeof payload !== 'object' || payload === null) {
    return { ok: true, reward: fallbackReward, alreadyDone: false };
  }
  const body = payload as Record<string, unknown>;
  const result = body.result;
  const hint = stringOf(body.hint);

  if (typeof result === 'string' && result !== '' && result !== 'ok' && result !== 'Success') {
    // 上游把「今天已经领过」也表达成非 ok 的 result；这种情况不是错误，
    // 只是没有新奖励 —— 报成失败会让用户以为签到坏了。
    const done = /已(?:经)?(?:领取|签到)|already/i.test(hint) || /done|claimed/i.test(result);
    return {
      ok: done,
      reward: 0,
      alreadyDone: done,
      message: hint === '' ? `领取失败：${result}` : hint,
    };
  }

  const data =
    typeof body.data === 'object' && body.data !== null
      ? (body.data as Record<string, unknown>)
      : undefined;
  const extra =
    data !== undefined && typeof data.extra === 'object' && data.extra !== null
      ? (data.extra as Record<string, unknown>)
      : undefined;
  const reward = finiteOrZero(extra?.today_reward) || finiteOrZero(data?.reward_amount) || fallbackReward;

  return { ok: true, reward, alreadyDone: false };
}

/**
 * 按北京时间取 `YYYY-MM-DD`。
 *
 * 为什么不用本机时区：签到是**上游按北京时间**判定的，本机时间偏一天会让
 * 「今天能不能领」在界面上和上游不一致。
 * @param nowMs - 「现在」；默认 `Date.now()`。
 * @returns `YYYY-MM-DD`。
 */
export function beijingDate(nowMs?: number): string {
  const now = nowMs ?? Date.now();
  const shifted = new Date(now + 8 * 60 * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${String(year)}-${month}-${day}`;
}
