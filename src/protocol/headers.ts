/**
 * 请求头与 cookie 拼装。见 `docs/PROTOCOL.md` §1、§2。
 * @module dsh-connect-lingxi/protocol/headers
 */

import { randomUUID } from 'node:crypto';
import {
  BASE,
  CLIENT_LANG,
  CLIENT_TYPE,
  KSO_COOKIE_PARTS,
  USER_AGENT,
} from '../constants.ts';

/**
 * 把用户 cookie 与客户端指纹 cookie 拼成一条 `Cookie` 值。
 * @param userCookie - 用户提供的 cookie（可能为空）。
 * @returns 完整的 Cookie 头值。
 */
export function clientCookie(userCookie: string): string {
  const own = userCookie.trim();
  const parts = KSO_COOKIE_PARTS.join('; ');
  return own === '' ? parts : `${own.replace(/;\s*$/, '')}; ${parts}`;
}

/**
 * 从 cookie 里读灰度区域标记；灵犀客户端靠它决定 `X-Cc-Region`。
 * @param userCookie - 用户 cookie。
 * @returns 区域值，没有则为空串。
 */
export function cookieRegion(userCookie: string): string {
  for (const part of userCookie.split(';')) {
    const item = part.trim();
    const prefix = 'copilot_server_branch=';
    if (item.startsWith(prefix)) return item.slice(prefix.length);
  }
  return '';
}

/**
 * 通用请求头（会话 / run / plans / balance / profile）。
 * @param userCookie - 用户 cookie。
 * @param base - 请求基址，决定 `Referer`。
 * @returns 可直接交给 `fetch` 的头对象。
 */
export function basicHeaders(
  userCookie: string,
  base: string = BASE,
): Record<string, string> {
  return {
    Cookie: clientCookie(userCookie),
    'User-Agent': USER_AGENT,
    Referer: `${base}/`,
    Accept: 'application/json',
  };
}

/**
 * 对话请求头：在基础头上加客户端指纹与 run 身份。
 * @param userCookie - 用户 cookie。
 * @param base - 请求基址。
 * @param run - `session_id` 与 `run_id`。
 * @param clientType - 覆盖 `X-Client-Type`（一次性任务要标成客户端身份才被上游计数）。
 * @returns 可直接交给 `fetch` 的头对象。
 */
export function agentHeaders(
  userCookie: string,
  base: string,
  run: { sessionId: string; runId: string },
  clientType: string = CLIENT_TYPE,
): Record<string, string> {
  const region = cookieRegion(userCookie);
  return {
    ...basicHeaders(userCookie, base),
    'Content-Type': 'application/json',
    'X-Client-Type': clientType,
    'X-Client-Lang': CLIENT_LANG,
    'X-Cc-Agent-Type': clientType,
    'X-Request-Id': randomUUID(),
    'X-Cc-Session-ID': run.sessionId,
    'X-Cc-Run-ID': run.runId,
    ...(region === '' ? {} : { 'X-Cc-Region': region }),
  };
}

/** `anthropic` 之类的多余空白容忍：把 `Cookie:` 前缀摘掉。 */
export function stripCookiePrefix(raw: string): string {
  return raw.trim().replace(/^cookie:\s*/i, '');
}

/** 粘 `wps_sid=xxx` 还是整段 cookie 都能用；只留 `wps_sid` 也补回键名。 */
export function normalizeUserCookie(raw: string): string {
  const value = stripCookiePrefix(raw);
  if (value === '') return '';
  if (value.includes('=')) return value;
  return `wps_sid=${value}`;
}
