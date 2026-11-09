/**
 * 智点余额的解析。上游 `GET /api/public/v1/credits/balance`（见 `docs/PROTOCOL.md` §11）。
 *
 * 这个模块**只做数据整形，永不抛异常**：余额是展示数据，一次形状变化不该让整张
 * 设置卡片变成错误页。形状认不出来就回答 `undefined`，由上层显示「读不到」。
 *
 * 上游给的时间是 `"YYYY-MM-DD HH:mm:ss"`（北京时间，**不带时区标记**）。
 * 直接用 `Date.parse` 会按本机时区解释 —— 用户在东八区以外时「3 天后到期」会算成
 * 「3 天前已过期」。所以这里显式按 +08:00 解析。
 *
 * @module dsh-connect-lingxi/protocol/balance
 */

/**
 * 「临时积分」窗口：15 天内到期的赠送批次。
 *
 * 与 Magpie / jet 两个实现同一判据：上游的赠送批次会过期，而总额里看不出
 * 「有多少是马上要作废的」，用户真正想知道的是这个数。
 */
export const EXPIRING_WINDOW_MS = 15 * 24 * 60 * 60 * 1000;

/** 上游时区偏移：北京时间，无夏令时。 */
const UPSTREAM_OFFSET = '+08:00';

/** 一个赠送批次。 */
export interface CreditBatch {
  /** 这个批次还剩多少。 */
  balance: number;
  /** 这个批次原本给了多少。 */
  value: number;
  /** 已用掉多少。 */
  consumed: number;
  /** 上游原始时间串；认不出来时为空串。 */
  expireTime: string;
  /** `expireTime` 的毫秒时间戳；缺失或非法时没有这个字段。 */
  expireAtMs?: number;
}

/** 一次余额读取的结果。 */
export interface CreditSummary {
  /** 主余额（智点）。 */
  total: number;
  /** 赠送总额；钱包型账号没有这个数，为 0。 */
  totalValue: number;
  /** 已用总量；上游没给时没有这个字段（区别于「给了 0」）。 */
  consumed?: number;
  /** 每个合法赠送批次。 */
  batches: CreditBatch[];
  /** 15 天内会过期的余额；没有时没有这个字段。 */
  expiring?: {
    /** 会过期的余额合计。 */
    amount: number;
    /** 最早到期时间（上游原串）。 */
    earliest: string;
    /** 最早到期的毫秒时间戳。 */
    earliestAtMs: number;
  };
  /** 这次读数抓取的时刻。 */
  updatedAtMs: number;
}

/** 有限非负数；否则 `undefined`。 */
function finiteOr(value: unknown, fallback?: number): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * 上游时间串 → 毫秒时间戳。
 *
 * 接受三种形状：
 * - `"2026-11-30 07:06:59"` / `"2026-11-30 07:06"`（无时区，按 +08:00）
 * - `"2026-11-30T07:06:59+08:00"`（ISO，按自带时区）
 * - `"2026-11-30"`（只到日，按 +08:00 当天 00:00）
 *
 * @param value - 上游给的任意值。
 * @returns 毫秒时间戳；认不出来时 `undefined`。
 */
export function parseUpstreamTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === '') return undefined;

  // 已带时区（Z 或 ±hh:mm）就交给 Date.parse，它按自带时区解释。
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : undefined;
  }

  // 只到日：补当天零点。
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnly !== null) {
    const ms = Date.parse(`${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}T00:00:00${UPSTREAM_OFFSET}`);
    return Number.isFinite(ms) ? ms : undefined;
  }

  // 日期 + 时间，可能缺秒：显式补 +08:00，不依赖本机时区。
  const withTime = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(text);
  if (withTime !== null) {
    const time = withTime[2] ?? '';
    const padded = time.length === 5 ? `${time}:00` : time;
    const ms = Date.parse(`${withTime[1] ?? ''}T${padded}${UPSTREAM_OFFSET}`);
    return Number.isFinite(ms) ? ms : undefined;
  }

  return undefined;
}

/**
 * `"2026-11-30T07:06:59+08:00"` → `"11-30"`；无法识别时原样返回。
 * @param value - 上游时间串。
 * @returns 月-日短标签。
 */
export function creditDateLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  return match === null ? value : `${match[2] ?? ''}-${match[3] ?? ''}`;
}

/** 解析一个批次条目；任一带不出合法数就整体丢掉（部分字段猜不出来）。 */
function parseBatch(raw: unknown): CreditBatch | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const item = raw as Record<string, unknown>;
  const balance = finiteOr(item.balance);
  if (balance === undefined) return undefined;
  const value = finiteOr(item.value, balance) ?? balance;
  const consumed = finiteOr(item.consumed, Math.max(0, value - balance));
  if (consumed === undefined) return undefined;

  const expireTime = typeof item.expire_time === 'string' ? item.expire_time.trim() : '';
  const expireAtMs = parseUpstreamTime(expireTime);
  return {
    balance,
    value,
    consumed,
    expireTime,
    ...(expireAtMs === undefined ? {} : { expireAtMs }),
  };
}

/**
 * 解析余额响应。
 *
 * 读取顺序照参考实现的取证：`total_balance` 优先于 `balance`；
 * 赠送批次取 `bonus_credits`，没有再取 `bonus_summary.items`
 * （两个字段在不同账号 / 不同版本上都出现过）。
 *
 * @param payload - 上游 JSON（任意形状）。
 * @param nowMs - 「现在」，决定 15 天窗口与「已过期」；默认 `Date.now()`。
 * @returns 归一后的余额；认不出来时 `undefined`。
 */
export function parseBalance(payload: unknown, nowMs?: number): CreditSummary | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return undefined;
  const body = data as Record<string, unknown>;

  const total = finiteOr(body.total_balance) ?? finiteOr(body.balance);
  if (total === undefined) return undefined;

  const summary = body.bonus_summary;
  const summaryRecord =
    typeof summary === 'object' && summary !== null ? (summary as Record<string, unknown>) : undefined;
  const totalValue = finiteOr(summaryRecord?.total_value) ?? 0;
  const consumed = finiteOr(summaryRecord?.total_consumed);

  const rawBatches = Array.isArray(body.bonus_credits)
    ? body.bonus_credits
    : Array.isArray(summaryRecord?.items)
      ? summaryRecord.items
      : [];
  const batches: CreditBatch[] = [];
  for (const raw of rawBatches) {
    const batch = parseBatch(raw);
    if (batch !== undefined) batches.push(batch);
  }

  const now = nowMs ?? Date.now();
  let amount = 0;
  let earliest = '';
  let earliestAtMs = Number.POSITIVE_INFINITY;
  for (const batch of batches) {
    const at = batch.expireAtMs;
    if (at === undefined || at <= now) continue;
    if (at - now > EXPIRING_WINDOW_MS) continue;
    amount += batch.balance;
    if (at < earliestAtMs) {
      earliestAtMs = at;
      earliest = batch.expireTime;
    }
  }

  return {
    total,
    totalValue,
    ...(consumed === undefined ? {} : { consumed }),
    batches,
    ...(amount > 0 && Number.isFinite(earliestAtMs)
      ? { expiring: { amount, earliest, earliestAtMs } }
      : {}),
    updatedAtMs: now,
  };
}
