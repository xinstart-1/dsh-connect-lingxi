/**
 * 灵犀的错误语义：审核拦截、登录失效、模型不存在、服务端错误。
 * 见 `docs/PROTOCOL.md` §5。
 * @module dsh-connect-lingxi/protocol/errors
 */

/** 审核拦截：请求级 400，**不是**登录失效。 */
export const AUDIT_BLOCKED = 'audit_blocked' as const;
/** 登录失效：只有明确的鉴权失败才用它。 */
export const AUTH_EXPIRED = 'auth_expired' as const;

/** 灵犀上游失败，带可映射的 HTTP 状态与内部 code。 */
export class LingxiError extends Error {
  /** 建议对下游返回的 HTTP 状态。 */
  readonly status: number;
  /** 内部错误码（`audit_blocked` / `auth_expired`），没有则不带。 */
  readonly code?: string;
  /** 上游原始状态，仅用于诊断。 */
  readonly upstreamStatus?: number;

  constructor(
    message: string,
    status: number,
    options: { code?: string; upstreamStatus?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LingxiError';
    this.status = status;
    if (options.code !== undefined) this.code = options.code;
    if (options.upstreamStatus !== undefined) this.upstreamStatus = options.upstreamStatus;
  }
}

/** 审核拦截的判定：上游 body 里出现的几个标记。 */
const AUDIT_MARKERS = [
  'auditfailed',
  'audit_failed',
  'audit failed',
  '内容被审核',
  '内容审核',
  'sensitive',
] as const;

/** 登录失效的文案标记（只在 401/403 时参与判定）。 */
const AUTH_MARKERS = /unauthor|登录|凭据|credential|cookie|sid|expired/i;

/** 把任意 JSON 压成可诊断的一小段文本。 */
export function textOfPayload(value: unknown): string {
  try {
    if (typeof value === 'string') return value.slice(0, 400);
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json.slice(0, 400) : '';
  } catch {
    return '';
  }
}

/**
 * 判断一个响应体是不是审核拦截。`code`、`message`、`data` 任一命中即算。
 * @param value - 上游 JSON 或纯文本。
 * @returns 是审核拦截时为 true。
 */
export function isAuditPayload(value: unknown): boolean {
  const text = textOfPayload(value).toLowerCase();
  if (text === '') return false;
  return AUDIT_MARKERS.some((marker) => text.includes(marker));
}

/** 一个可能的 run 失效（`run_id` 过期 / 会话过期），值得重建一次再试。 */
export function looksLikeStaleRun(message: string): boolean {
  return /run|会话|session|过期|expired|not\s*found|不存在/i.test(message);
}

/**
 * 把上游失败映射成带 HTTP 语义的 {@link LingxiError}。
 *
 * 关键规则：**只有明确的鉴权失败才报 401**，否则会把账号误标成未登录并从
 * provider 列表里摘掉；其余 4xx 一律 404（模型或参数不对），5xx 原样，兜底 502。
 *
 * @param status - 上游 HTTP 状态。
 * @param body - 已解析的 body（JSON 或纯文本）。
 * @param fallback - 没有可用文案时的默认描述。
 * @returns 归一化后的错误。
 */
export function classifyUpstreamError(
  status: number,
  body: unknown,
  fallback: string,
): LingxiError {
  const detail = textOfPayload(body);
  const message = detail === '' ? fallback : `${fallback}：${detail}`;

  if (isAuditPayload(body)) {
    return new LingxiError(message, 400, { code: AUDIT_BLOCKED, upstreamStatus: status });
  }

  if (status === 401 || status === 403) {
    if (AUTH_MARKERS.test(detail) || detail === '') {
      return new LingxiError(message, 401, { code: AUTH_EXPIRED, upstreamStatus: status });
    }
    return new LingxiError(message, 404, { upstreamStatus: status });
  }

  if (status === 400 || status === 404 || status === 422) {
    return new LingxiError(message, 404, { upstreamStatus: status });
  }

  if (status >= 500) {
    return new LingxiError(message, status, { upstreamStatus: status });
  }

  return new LingxiError(message, 502, { upstreamStatus: status });
}

/**
 * 上游帧里的业务错误码（`code !== "Success"`）。
 * @param code - 帧里的 `code` 字段。
 * @returns 值是成功码（或缺失）时为 true。
 */
export function isSuccessCode(code: unknown): boolean {
  if (code === undefined || code === null || code === '') return true;
  return typeof code === 'string' && code.toLowerCase() === 'success';
}
