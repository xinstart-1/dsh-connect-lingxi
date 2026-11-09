/**
 * 灵犀上游客户端：三步握手 + SSE 流。协议见 `docs/PROTOCOL.md` §3、§4。
 *
 * 这个模块**不依赖 DSH**，只吃一个 cookie 字符串，方便单测与复用。
 *
 * @module dsh-connect-lingxi/protocol/client
 */

import { randomUUID } from 'node:crypto';
import { tmpdir, userInfo } from 'node:os';
import {
  AGENT_CHAT_PATH,
  AGENT_RUNS_PATH,
  AGENT_SESSIONS_PATH,
  BALANCE_PATH,
  BASE,
  DEVICE_ID,
  KDOCS_BASE,
  PLANS_PATH,
  PROFILE_PATH,
  REQUEST_TIMEOUT_MS,
  RUN_TTL_MS,
  TASKS_PATH,
} from '../constants.ts';
import { fitAgentBody } from './budget.ts';
import { normalizeModelId, parsePlans, type LingxiModel } from './catalog.ts';
import { classifyUpstreamError, LingxiError, looksLikeStaleRun } from './errors.ts';
import { agentHeaders, basicHeaders, normalizeUserCookie } from './headers.ts';

/** 建会话的响应（只取用得到的字段）。 */
interface SessionPayload {
  data?: { session_id?: unknown };
}

/** 领 run 的响应。 */
interface RunPayload {
  data?: { run_id?: unknown; group_id?: unknown };
}

/** 一个已领取的 run，可在 TTL 内复用。 */
interface CachedRun {
  sessionId: string;
  runId: string;
  base: string;
  at: number;
}

/** 一次性任务对话用的模型：固定 plan_pro（与网页端建群/专家任务一致）。 */
const DEFAULT_MODEL_FOR_TASKS = 'plan_pro';

/** 发给上游的一条消息（OpenAI 风味，字段宽松）。 */
export type WireMessage = Record<string, unknown>;

/** 一次对话请求的输入。 */
export interface ChatRequest {
  /** 用户 cookie（可含或不含指纹，内部会补齐）。 */
  cookie: string;
  /** 客户端要求的上游模型 key。 */
  model: string;
  /** OpenAI messages。 */
  messages: readonly WireMessage[];
  /** tool 定义，可选。 */
  tools?: readonly unknown[];
  /** 工具选择策略，可选。 */
  toolChoice?: unknown;
  /** 采样温度。 */
  temperature?: number;
  /** 输出上限。 */
  maxTokens?: number;
  /** 思考档位。 */
  reasoningEffort?: string;
  /** 取消信号。 */
  signal?: AbortSignal;
  /** 诊断日志出口；缺省丢弃。 */
  onWarn?: (message: string) => void;
}

/** 一条上游 SSE 数据行（已去掉 `data:` 前缀）。 */
export type RawSseLine = string;

/** 灵犀上游客户端。按 cookie 区分身份，run 缓存按 (身份, 模型) 分组。 */
export class LingxiClient {
  private readonly runs = new Map<string, CachedRun>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** 清空 run 缓存（cookie 变更或登出时用）。 */
  clearRuns(): void {
    this.runs.clear();
  }

  /**
   * 校验 cookie 是否可用：`/account/profile` 返回 200 且不是 `UserUnauthorized`。
   * @param rawCookie - 用户粘的 cookie。
   * @param signal - 取消信号。
   * @returns 账号名（拿不到时为 `undefined`）与生效基址；失败抛 {@link LingxiError}。
   */
  async verify(
    rawCookie: string,
    signal?: AbortSignal,
  ): Promise<{ name: string | undefined; base: string }> {
    const cookie = normalizeUserCookie(rawCookie);
    if (cookie === '') throw new LingxiError('cookie 为空', 401);

    let lastError: unknown;
    for (const base of [BASE, KDOCS_BASE]) {
      try {
        const response = await this.request(`${base}${PROFILE_PATH}`, {
          headers: basicHeaders(cookie, base),
          signal,
        });
        const body = await this.parseJson(response);
        if (!response.ok) throw classifyUpstreamError(response.status, body, '校验 cookie 失败');
        const result = (body as { result?: unknown } | null)?.result;
        if (result === 'UserUnauthorized') {
          throw new LingxiError('cookie 无效或已过期', 401, { code: 'auth_expired' });
        }
        const name = (body as { data?: { name?: unknown } } | null)?.data?.name;
        return {
          name: typeof name === 'string' && name.trim() !== '' ? name.trim() : undefined,
          base,
        };
      } catch (error) {
        lastError = error;
        if (error instanceof LingxiError && error.status === 401) throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new LingxiError('校验 cookie 失败', 502, { cause: lastError });
  }

  /**
   * 拉模型目录。失败返回空数组（调用方回退到静态表）。
   * @param rawCookie - 用户 cookie。
   * @param signal - 取消信号。
   * @returns 目录条目；空表示不可用。
   */
  async listModels(rawCookie: string, signal?: AbortSignal): Promise<LingxiModel[]> {
    const cookie = normalizeUserCookie(rawCookie);
    if (cookie === '') return [];
    for (const base of [BASE, KDOCS_BASE]) {
      try {
        const response = await this.request(`${base}${PLANS_PATH}`, {
          headers: basicHeaders(cookie, base),
          signal,
        });
        if (!response.ok) continue;
        const body = await this.parseJson(response);
        const models = parsePlans(body);
        if (models.length > 0) return models;
      } catch {
        // 换下一个基址再试。
      }
    }
    return [];
  }

  /**
   * 读智点余额。失败返回 `undefined`（余额只是展示，不该阻断对话）。
   * @param rawCookie - 用户 cookie。
   * @param signal - 取消信号。
   * @returns 剩余额度，读不到为 `undefined`。
   */
  async balance(rawCookie: string, signal?: AbortSignal): Promise<number | undefined> {
    const cookie = normalizeUserCookie(rawCookie);
    if (cookie === '') return undefined;
    for (const base of [BASE, KDOCS_BASE]) {
      try {
        const response = await this.request(`${base}${BALANCE_PATH}`, {
          headers: basicHeaders(cookie, base),
          signal,
        });
        if (!response.ok) continue;
        const body = (await this.parseJson(response)) as {
          data?: { total_balance?: unknown; balance?: unknown };
        } | null;
        const raw = body?.data?.total_balance ?? body?.data?.balance;
        const value = typeof raw === 'number' ? raw : Number(raw);
        if (Number.isFinite(value)) return value;
      } catch {
        // 换下一个基址再试。
      }
    }
    return undefined;
  }

  /**
   * 读智点余额的**原始响应体**（解析在 `protocol/balance.ts`）。
   *
   * 与 {@link balance} 的区别：那个只回答「还剩多少」，这里连赠送批次一起交给调用方，
   * 因为设置卡片要显示「哪些积分快到期」。失败返回 `undefined`，永不抛——
   * 余额只是展示，不该让整张卡片变成错误页。
   * @param rawCookie - 用户 cookie。
   * @param signal - 取消信号。
   * @returns 上游 JSON（未解析），或 `undefined`。
   */
  async balancePayload(rawCookie: string, signal?: AbortSignal): Promise<unknown> {
    const cookie = normalizeUserCookie(rawCookie);
    if (cookie === '') return undefined;
    for (const base of [BASE, KDOCS_BASE]) {
      try {
        const response = await this.request(`${base}${BALANCE_PATH}`, {
          headers: basicHeaders(cookie, base),
          signal,
        });
        if (!response.ok) continue;
        return await this.parseJson(response);
      } catch {
        // 换下一个基址再试。
      }
    }
    return undefined;
  }

  /**
   * 读任务中心的**原始响应体**（解析在 `protocol/tasks.ts`）。
   *
   * 401/403 直接抛 {@link LingxiError}(401)：签到是**写**操作的前置读，
   * 登录态不对必须让用户看到「要重新登录」，而不是一句「没有任务」。
   * @param rawCookie - 用户 cookie。
   * @param signal - 取消信号。
   * @returns 上游 JSON（未解析）。
   * @throws {LingxiError} 登录失效或两个基址都失败时。
   */
  async tasksPayload(rawCookie: string, signal?: AbortSignal): Promise<unknown> {
    const cookie = normalizeUserCookie(rawCookie);
    if (cookie === '') throw new LingxiError('未配置 WPS 灵犀 cookie', 401, { code: 'auth_expired' });
    let lastError: unknown;
    for (const base of [BASE, KDOCS_BASE]) {
      try {
        const response = await this.request(`${base}${TASKS_PATH}`, {
          headers: basicHeaders(cookie, base),
          signal,
        });
        const body = await this.parseJson(response);
        if (!response.ok) throw classifyUpstreamError(response.status, body, '读取任务中心失败');
        if ((body as { result?: unknown } | null)?.result === 'UserUnauthorized') {
          throw new LingxiError('WPS 登录凭据失效，请重新登录', 401, { code: 'auth_expired' });
        }
        return body;
      } catch (error) {
        lastError = error;
        if (error instanceof LingxiError && error.status === 401) throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new LingxiError('无法连接 WPS 灵犀任务中心', 502, { cause: lastError });
  }

  /**
   * 领取一个任务（每日签到或一次性任务）。
   *
   * 这是本插件里**唯一会改变账号状态**的调用：领到就是真领到，不能重试着玩。
   * 因此这里**不做自动重试**、不换基址（领取带幂等标记，换基址可能变成另一个语义）。
   * @param rawCookie - 用户 cookie。
   * @param key - 上游 `task_key`。
   * @param date - 签到要带的日期（`YYYY-MM-DD`）；一次性任务传空串。
   * @param signal - 取消信号。
   * @returns 上游 JSON（解析在 `protocol/tasks.ts` 的 `parseClaimResponse`）。
   * @throws {LingxiError} 登录失效（401）或领取失败（非 2xx）时。
   */
  async claimTask(
    rawCookie: string,
    key: string,
    date: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const cookie = normalizeUserCookie(rawCookie);
    if (cookie === '') throw new LingxiError('未配置 WPS 灵犀 cookie', 401, { code: 'auth_expired' });
    if (key.trim() === '') throw new LingxiError('缺少 task_key', 400);
    const suffix = date === '' ? '' : `?date=${encodeURIComponent(date)}`;
    const path = `${TASKS_PATH}/${encodeURIComponent(key)}/claim${suffix}`;

    let lastError: unknown;
    for (const base of [BASE, KDOCS_BASE]) {
      try {
        const response = await this.request(`${base}${path}`, {
          method: 'POST',
          headers: { ...basicHeaders(cookie, base), 'Content-Type': 'application/json' },
          body: '{}',
          signal,
        });
        const body = await this.parseJson(response);
        if (!response.ok) throw classifyUpstreamError(response.status, body, '领取任务失败');
        if ((body as { result?: unknown } | null)?.result === 'UserUnauthorized') {
          throw new LingxiError('WPS 登录凭据失效，请重新登录', 401, { code: 'auth_expired' });
        }
        return body;
      } catch (error) {
        lastError = error;
        if (error instanceof LingxiError && error.status === 401) throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new LingxiError('无法连接 WPS 灵犀任务中心', 502, { cause: lastError });
  }

  /**
   * 打开一次对话的 SSE 流。内部完成三步握手，返回上游响应体。
   * @param request - 对话请求。
   * @returns 上游 `Response`（`body` 是 SSE 字节流）。
   * @throws {LingxiError} 握手或请求失败时。
   */
  async openChat(request: ChatRequest): Promise<Response> {
    const cookie = normalizeUserCookie(request.cookie);
    if (cookie === '') throw new LingxiError('未配置 WPS 灵犀 cookie', 401);
    const model = normalizeModelId(request.model);

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const run = await this.ensureRun(cookie, model, request);
      try {
        return await this.send(request, cookie, run);
      } catch (error) {
        lastError = error;
        const stale =
          error instanceof LingxiError &&
          error.status === 404 &&
          looksLikeStaleRun(error.message);
        if (attempt === 0 && stale) {
          this.runs.delete(this.runKey(cookie, model));
          continue;
        }
        throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new LingxiError('灵犀对话失败', 502, { cause: lastError });
  }

  private runKey(cookie: string, model: string): string {
    return `${cookie.slice(-24)}|${model}`;
  }

  private lastUserText(messages: readonly WireMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role !== 'user') continue;
      const content = message.content;
      if (typeof content === 'string') return content.slice(0, 4000);
      if (Array.isArray(content)) {
        const text = content
          .map((part) =>
            typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string'
              ? ((part as { text: string }).text)
              : '',
          )
          .join('\n');
        if (text.trim() !== '') return text.slice(0, 4000);
      }
    }
    return '';
  }

  private async ensureRun(
    cookie: string,
    model: string,
    request: ChatRequest,
  ): Promise<CachedRun> {
    const key = this.runKey(cookie, model);
    const hit = this.runs.get(key);
    if (hit !== undefined && this.now() - hit.at < RUN_TTL_MS) return hit;

    let lastError: unknown;
    for (const base of [BASE, KDOCS_BASE]) {
      try {
        const sessionId = await this.createSession(cookie, base, request.signal);
        const runId = await this.createRun(
          cookie,
          base,
          sessionId,
          model,
          this.lastUserText(request.messages),
          request.signal,
        );
        const run: CachedRun = { sessionId, runId, base, at: this.now() };
        this.runs.set(key, run);
        return run;
      } catch (error) {
        lastError = error;
        if (error instanceof LingxiError && error.status === 401) throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new LingxiError('无法建立灵犀会话', 502, { cause: lastError });
  }

  private async createSession(
    cookie: string,
    base: string,
    signal?: AbortSignal,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const response = await this.request(`${base}${AGENT_SESSIONS_PATH}`, {
      method: 'POST',
      headers: { ...basicHeaders(cookie, base), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_type: 'cowork_client',
        agent_version: 2,
        env: {
          device_id: DEVICE_ID,
          device_name: safeUserName(),
          work_space_dir: tmpdir(),
        },
        // 一次性任务要带 `client_type` / `session_mode`（见 `ensureTaskRun`）。
        ...extra,
      }),
      signal,
    });
    const body = await this.parseJson(response);
    if (!response.ok) throw classifyUpstreamError(response.status, body, '建会话失败');
    const id = (body as SessionPayload | null)?.data?.session_id;
    if (typeof id !== 'string' || id.trim() === '') {
      throw new LingxiError('灵犀未返回 session_id', 502);
    }
    return id.trim();
  }

  private async createRun(
    cookie: string,
    base: string,
    sessionId: string,
    model: string,
    title: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const created = await this.createRunFor(cookie, base, sessionId, model, title, signal, {});
    return created.runId;
  }

  /**
   * 领 run 的完整版本：同时返回 `run_id` 与 `group_id`。
   *
   * 为什么需要 `group_id`：一次性任务要 `PUT .../execution_status` 上报状态，
   * 那一步的 `run_token` 用的是 `group_id`。主对话不需要它，所以旧的
   * {@link createRun} 保持不变，这里另开一个返回完整信息的。
   */
  private async createRunFor(
    cookie: string,
    base: string,
    sessionId: string,
    model: string,
    title: string,
    signal: AbortSignal | undefined,
    extra: { clientType?: string; currentMode?: string } = {},
  ): Promise<{ runId: string; groupId: string }> {
    const response = await this.request(`${base}${AGENT_RUNS_PATH}`, {
      method: 'POST',
      headers: { ...basicHeaders(cookie, base), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_request_id: `${this.now()}`,
        session_id: sessionId,
        model_provider: 'lingxi',
        model_id: model,
        agent_input: {
          text: title,
          files: [],
          file_ids: [],
          expect_model: model,
          refs: [],
          permission_mode: 'default',
          current_mode: extra.currentMode ?? 'agent',
          browser_plugin_enabled: false,
        },
      }),
      signal,
    });
    const body = await this.parseJson(response);
    if (!response.ok) throw classifyUpstreamError(response.status, body, '领取 run 失败');
    const payload = body as RunPayload | null;
    const id = payload?.data?.run_id;
    if (typeof id !== 'string' || id.trim() === '') {
      throw new LingxiError('灵犀未返回 run_id', 502);
    }
    const groupId = typeof payload?.data?.group_id === 'string' ? payload.data.group_id : id;
    return { runId: id.trim(), groupId: groupId.trim() === '' ? id.trim() : groupId.trim() };
  }

  private async send(
    request: ChatRequest,
    cookie: string,
    run: CachedRun,
  ): Promise<Response> {
    const model = normalizeModelId(request.model);
    const body = buildAgentBody(request, model);
    const response = await this.request(`${run.base}${AGENT_CHAT_PATH}`, {
      method: 'POST',
      headers: agentHeaders(cookie, run.base, { sessionId: run.sessionId, runId: run.runId }),
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // 保持纯文本。
      }
      throw classifyUpstreamError(response.status, parsed, '灵犀对话失败');
    }
    if (response.body === null) throw new LingxiError('灵犀上游没有返回响应体', 502);
    return response;
  }

  /**
   * 为一次性任务建一次「带使用信号」的 run。
   *
   * 与主对话的 run 有三处差别（缺一处任务就不会被上游计数）：
   * 1. `client_type` 让上游把这次算成客户端使用（`use_lingxi_client` 任务的判据）；
   * 2. `session_mode` / `current_mode` 为 `expert` 时才计入专家模式任务；
   * 3. 会话与 run **不缓存**（`fresh: true` 时强制新建）——任务判定要看的是
   *    「刚刚发生的一次使用」，复用 1 小时前的会话可能已经被算过了。
   *
   * @param options - 任务对话的参数。
   * @returns `session_id` 与 `group_id`（`execution_status` 上报要用 group_id）。
   */
  async ensureTaskRun(options: {
    cookie: string;
    base: string;
    text: string;
    clientType?: string;
    sessionMode?: string;
    currentMode?: string;
    signal?: AbortSignal;
    fresh?: boolean;
  }): Promise<{ sessionId: string; groupId: string; base: string }> {
    const cookie = normalizeUserCookie(options.cookie);
    if (cookie === '') throw new LingxiError('未配置 WPS 灵犀 cookie', 401);

    const sessionId = await this.createSession(cookie, options.base, options.signal, {
      ...(options.clientType === undefined ? {} : { client_type: options.clientType }),
      ...(options.sessionMode === undefined ? {} : { session_mode: options.sessionMode }),
    });
    const created = await this.createRunFor(
      cookie,
      options.base,
      sessionId,
      DEFAULT_MODEL_FOR_TASKS,
      options.text,
      options.signal,
      {
        ...(options.clientType === undefined ? {} : { clientType: options.clientType }),
        ...(options.currentMode === undefined ? {} : { currentMode: options.currentMode }),
      },
    );
    return { sessionId, groupId: created.groupId, base: options.base };
  }

  /**
   * 发一次任务对话（**非流式**：只需要一个真实使用信号，不需要正文）。
   *
   * 为什么非流式：任务判据是「会话在 completions 通道上收到过真实输入」，
   * 正文没人看；流式要多维护一条连接与一次解析，收益为零。
   *
   * @param options - run 与文本。
   * @returns 上游是否成功（正文丢弃）。
   */
  async sendTaskChat(options: {
    cookie: string;
    base: string;
    run: { sessionId: string; groupId: string };
    text: string;
    clientType?: string;
    signal?: AbortSignal;
  }): Promise<{ ok: boolean; status: number }> {
    const cookie = normalizeUserCookie(options.cookie);
    const body = {
      stream: false,
      model: DEFAULT_MODEL_FOR_TASKS,
      messages: [{ role: 'user', content: options.text }],
      // 上游按用量扣智点（整数余额）：回答太短可能凑不够 1 智点而不产生计费记录。
      base_llm_arguments: { max_tokens: 4096 },
    };
    const response = await this.request(`${options.base}${AGENT_CHAT_PATH}`, {
      method: 'POST',
      headers: agentHeaders(
        cookie,
        options.base,
        { sessionId: options.run.sessionId, runId: options.run.groupId },
        options.clientType,
      ),
      body: JSON.stringify(body),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    // 先把 body 读掉，避免连接挂着。
    await response.text().catch(() => '');
    return { ok: response.ok, status: response.status };
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal =
      init.signal === undefined || init.signal === null
        ? timeout
        : AbortSignal.any([init.signal, timeout]);
    try {
      return await fetch(url, { ...init, signal });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new LingxiError(`无法连接 WPS 灵犀：${message}`, 502, { cause: error });
    }
  }

  private async parseJson(response: Response): Promise<unknown> {
    const text = await response.text().catch(() => '');
    if (text === '') return {};
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

/** `os.userInfo()` 在极端环境下会抛，包一层。 */
function safeUserName(): string {
  try {
    return userInfo().username || 'dsh';
  } catch {
    return 'dsh';
  }
}

/**
 * OpenAI 请求 → 灵犀请求体。字段映射见 `docs/PROTOCOL.md` §3.3。
 * @param request - 本地请求。
 * @param model - 已归一的上游模型 key。
 * @returns 上游请求体（已按预算裁剪）。
 */
export function buildAgentBody(
  request: ChatRequest,
  model: string,
): Record<string, unknown> {
  const messages = [...request.messages];
  const body: Record<string, unknown> = {
    stream: true,
    model,
    messages,
  };

  if (Array.isArray(request.tools) && request.tools.length > 0) {
    body.tools = request.tools;
    if (request.toolChoice !== undefined && request.toolChoice !== null) {
      body.tool_choice = request.toolChoice;
    }
  }
  if (typeof request.temperature === 'number') body.temperature = request.temperature;

  const maxTokens = request.maxTokens;
  if (typeof maxTokens === 'number' && Number.isInteger(maxTokens) && maxTokens > 0) {
    body.base_llm_arguments = { max_tokens: maxTokens };
  }

  const effort = typeof request.reasoningEffort === 'string' ? request.reasoningEffort.trim() : '';
  if (effort !== '') {
    body.reasoning_effort = effort;
    body.llm_arguments = { reasoning_effort: effort };
  }

  const fitted = fitAgentBody(body);
  if ((fitted.dropped > 0 || fitted.elided > 0) && request.onWarn !== undefined) {
    request.onWarn(
      `提示词超过预算，已省略 ${fitted.dropped} 条历史、截断 ${fitted.elided} 条长消息`,
    );
  }
  return body;
}

/** 生成一个唯一的请求 id（导出给 shim 与测试用）。 */
export function requestId(): string {
  return randomUUID();
}
