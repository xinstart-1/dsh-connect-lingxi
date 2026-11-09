/**
 * 错误分类与 cookie 处理的单测。语义见 `docs/PROTOCOL.md` §5。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUDIT_BLOCKED,
  AUTH_EXPIRED,
  classifyUpstreamError,
  isAuditPayload,
  isSuccessCode,
  looksLikeStaleRun,
} from '../src/protocol/errors.ts';
import { clientCookie, cookieRegion, normalizeUserCookie, stripCookiePrefix } from '../src/protocol/headers.ts';

test('审核拦截映射成 400 + audit_blocked，不当作登录失效', () => {
  const error = classifyUpstreamError(400, { code: 'AuditFailed', message: '内容被审核拦截' }, '失败');
  assert.equal(error.status, 400);
  assert.equal(error.code, AUDIT_BLOCKED);
});

test('401 且文案含鉴权标记才映射成 401；其余 401 降级为 404', () => {
  const auth = classifyUpstreamError(401, { message: 'UserUnauthorized: 登录已过期' }, '失败');
  assert.equal(auth.status, 401);
  assert.equal(auth.code, AUTH_EXPIRED);

  const other = classifyUpstreamError(401, { message: 'model not available' }, '失败');
  assert.equal(other.status, 404);
  assert.equal(other.code, undefined);
});

test('403 同上', () => {
  const auth = classifyUpstreamError(403, { message: 'cookie 无效' }, '失败');
  assert.equal(auth.status, 401);
});

test('400/404/422 一律 404，5xx 原样，兜底 502', () => {
  assert.equal(classifyUpstreamError(400, { message: 'bad' }, 'x').status, 404);
  assert.equal(classifyUpstreamError(404, { message: 'missing' }, 'x').status, 404);
  assert.equal(classifyUpstreamError(422, { message: 'bad' }, 'x').status, 404);
  assert.equal(classifyUpstreamError(503, { message: 'down' }, 'x').status, 503);
  assert.equal(classifyUpstreamError(418, { message: 'teapot' }, 'x').status, 502);
});

test('isAuditPayload 认得中英文标记', () => {
  assert.equal(isAuditPayload({ code: 'AuditFailed' }), true);
  assert.equal(isAuditPayload({ message: '内容审核未通过' }), true);
  assert.equal(isAuditPayload({ message: 'ok' }), false);
  assert.equal(isAuditPayload(undefined), false);
});

test('isSuccessCode：缺省与 Success 算成功', () => {
  assert.equal(isSuccessCode(undefined), true);
  assert.equal(isSuccessCode('Success'), true);
  assert.equal(isSuccessCode('success'), true);
  assert.equal(isSuccessCode('Failed'), false);
});

test('run 失效的识别', () => {
  assert.equal(looksLikeStaleRun('run not found'), true);
  assert.equal(looksLikeStaleRun('会话已过期'), true);
  assert.equal(looksLikeStaleRun('模型不存在'), true);
  assert.equal(looksLikeStaleRun('unknown model'), false);
});

test('cookie 拼接：用户 cookie 在前，客户端指纹在后', () => {
  const value = clientCookie('wps_sid=abc');
  assert.match(value, /^wps_sid=abc; x-kso-app-name=win-lingxi-desktop/);
  assert.match(value, /x-kso-device-id=/);
});

test('空用户 cookie 只给指纹', () => {
  const value = clientCookie('');
  assert.match(value, /^x-kso-app-name=win-lingxi-desktop/);
  assert.equal(value.includes(';  '), false);
});

test('区域头从 copilot_server_branch 读', () => {
  assert.equal(cookieRegion('a=1; copilot_server_branch=cn; b=2'), 'cn');
  assert.equal(cookieRegion('a=1'), '');
});

test('粘贴的 cookie 归一：去 Cookie: 前缀、裸 sid 补键名', () => {
  assert.equal(stripCookiePrefix('Cookie: wps_sid=abc'), 'wps_sid=abc');
  assert.equal(normalizeUserCookie('  wps_sid=abc  '), 'wps_sid=abc');
  assert.equal(normalizeUserCookie('abc123'), 'wps_sid=abc123');
  assert.equal(normalizeUserCookie(''), '');
});
