/**
 * 一次性任务的「做出来」流程。见 `docs/PROTOCOL.md` §13。
 *
 * 三个一次性任务里有两个需要**真实使用信号**才能被上游判定完成，纯读接口做不到。
 * 但「做不到」不等于「不实现」—— 灵犀客户端自己也是走 HTTP 上报的，照它的形状
 * 复刻就行。取证来源：`.reference/magpie-wps-lingxi-index.mjs`（已在真机跑通
 * 三个任务同时翻转）。
 *
 * 关键事实（三条，缺一条任务就不翻）：
 * 1. **会话执行状态要客户端自己上报**：`PUT /api/public/v1/sessions/{id}/execution_status`，
 *    run 创建后报 `running`（带 `lease_seconds: 90`），对话完成后报 `completed`
 *    （带 `terminal_reason: "completed"`）。不报的话服务端永远认为会话还在跑。
 * 2. **专家模式**要 `session_mode: "expert"` + `current_mode: "expert"` 建会话与领 run。
 * 3. **群聊任务**要求会话先在 WS `completions/ws` 上收到过一次 `user.input`，
 *    然后才能 `POST /api/imchat/v1/channels` 建群（建完立刻解散，不留垃圾群）。
 *
 * 一条纪律：**不伪造结果**。这些动作只是「给上游一个真实使用信号」，是否算完成由
 * 服务端判定；调用方必须在动作后**重拉任务**看状态，而不是假设成功。
 *
 * @module dsh-connect-lingxi/protocol/onetime
 */

import { CLIENT_TYPE, USER_AGENT } from '../constants.ts';
import type { LingxiClient } from './client.ts';
import { DEFAULT_TASK_TEXT } from './tasks.ts';

/** 上报会话执行状态的结果；失败不抛，只回报给诊断。 */
export interface ExecutionStatusResult {
  ok: boolean;
  detail?: string;
}

/** 一次「把任务做出来」的结果。 */
export interface OneTimeActions {
  /** 专家模式对话是否成功发出并上报完成。 */
  expert: ExecutionStatusResult;
  /** 客户端身份对话。 */
  client: ExecutionStatusResult;
  /** 群聊任务（WS 使用信号 + 建群 + 解散）。 */
  group: ExecutionStatusResult;
  /** 过程中给用户看的说明（原样可展示，不翻译上游错误）。 */
  notes: string[];
}

/** 需要哪些动作。 */
export interface OneTimeNeeds {
  expert: boolean;
  client: boolean;
  group: boolean;
}

/**
 * 造一个 WebSocket。
 *
 * 为什么需要这层间接：Node 内置的 `WebSocket` **不支持自定义请求头**，而灵犀的
 * WS 握手要带 `Cookie`。所以生产路径允许注入一个能带头的构造器（测试也用它），
 * 注入点缺失时退化成全局 `WebSocket` —— 那种情况下 Cookie 会被丢掉、握手 401，
 * 于是调用方要能区分「没配置」和「被拒绝」。
 */
export type WebSocketFactory = (
  url: string,
  init?: { headers?: Record<string, string> },
) => WebSocket;

/** 取一个可用的 WS 工厂；运行时根本没有 WebSocket 时返回 `undefined`。 */
export function resolveWebSocketFactory(
  injected?: WebSocketFactory,
): WebSocketFactory | undefined {
  if (injected !== undefined) return injected;
  const bag = globalThis as {
    WebSocket?: new (url: string | URL, protocols?: string | string[]) => WebSocket;
  };
  const Ctor = bag.WebSocket;
  if (Ctor === undefined) return undefined;
  return (url) => new Ctor(url);
}

/** 一次动作需要的依赖。 */
export interface OneTimeDeps {
  client: LingxiClient;
  /** 用户 cookie。 */
  cookie: string;
  /** 当前基址（`https://lingxi.wps.cn` 或 kdocs 侧）。 */
  base: string;
  /** 找一个已完成的历史会话（群聊任务的建群前置）。 */
  completedSession?: () => Promise<string | undefined>;
  /** WS 构造函数（测试注入；生产用全局 WebSocket）。 */
  webSocket?: WebSocketFactory;
  /** 取消信号。 */
  signal?: AbortSignal;
  /** 诊断日志。 */
  warn?: (message: string) => void;
}

/** 从任务列表推出「需要做哪些动作」。 */
export function needsFor(
  tasks: ReadonlyArray<{ key: string; status: string; type: string; action?: string }>,
): OneTimeNeeds {
  const needs: OneTimeNeeds = { expert: false, client: false, group: false };
  for (const task of tasks) {
    if (task.type !== 'one_time' || task.status !== 'incomplete') continue;
    // 优先用上游给的 action；没有就按 task_key 推（两者都见过）。
    const action = task.action ?? task.key;
    if (/expert/i.test(action)) needs.expert = true;
    else if (/group/i.test(action)) needs.group = true;
    else if (/client/i.test(action)) needs.client = true;
  }
  // 专家模式本身就是客户端对话，所以「要专家」必然「要客户端」。
  if (needs.expert) needs.client = true;
  return needs;
}

/** 简洁的 cookie 头：把指纹拼上（与 `protocol/headers.ts` 同一语义）。 */
function cookieHeader(cookie: string): string {
  return cookie;
}

/** 让 LingxiClient 内部逻辑可复用的最小请求器。 */
async function requestJson(
  url: string,
  init: RequestInit,
  timeoutMs = 30_000,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal =
    init.signal === undefined || init.signal === null
      ? timeout
      : AbortSignal.any([init.signal, timeout]);
  try {
    const response = await fetch(url, { ...init, signal });
    const text = await response.text().catch(() => '');
    let body: unknown = text;
    try {
      body = text === '' ? {} : JSON.parse(text);
    } catch {
      // 保持纯文本。
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 上报会话执行状态。
 *
 * 这是「客户端自己上报」的那一步：真实客户端在内核里就是这么做的，
 * 少了它服务端不知道会话结束，任务永远不翻。
 */
export async function putExecutionStatus(
  deps: OneTimeDeps,
  run: { sessionId: string; groupId: string },
  status: 'running' | 'completed',
): Promise<ExecutionStatusResult> {
  const body: Record<string, unknown> = {
    group_id: run.groupId,
    status,
    run_token: run.groupId,
  };
  if (status === 'running') body.lease_seconds = 90;
  else body.terminal_reason = 'completed';

  const result = await requestJson(
    `${deps.base}/api/public/v1/sessions/${encodeURIComponent(run.sessionId)}/execution_status`,
    {
      method: 'PUT',
      headers: {
        Cookie: cookieHeader(deps.cookie),
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(body),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    },
    15_000,
  );
  if (!result.ok) {
    return { ok: false, detail: `execution_status(${status}) HTTP ${String(result.status)}` };
  }
  return { ok: true };
}

/**
 * 跑一次「带使用信号」的任务对话。
 *
 * 与普通对话的区别只有三处：`client_type`（让上游把这次算成客户端使用）、
 * `session_mode` / `current_mode`（专家模式），以及**两次 execution_status 上报**。
 *
 * @returns 会话 id 与是否成功（失败也回报 sessionId，便于诊断）。
 */
export async function runTaskConversation(
  deps: OneTimeDeps,
  options: { expert: boolean; text?: string },
): Promise<{ ok: boolean; sessionId: string; detail: string }> {
  const text = options.text ?? DEFAULT_TASK_TEXT;
  try {
    const run = await deps.client.ensureTaskRun({
      cookie: deps.cookie,
      base: deps.base,
      text,
      clientType: CLIENT_TYPE,
      ...(options.expert ? { sessionMode: 'expert', currentMode: 'expert' } : {}),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });

    await putExecutionStatus(deps, run, 'running');

    let response;
    try {
      response = await deps.client.sendTaskChat({
        cookie: deps.cookie,
        base: deps.base,
        run,
        text,
        clientType: CLIENT_TYPE,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      });
    } catch (error) {
      // run 过期：重建一次再试（与主对话路径同一策略，只重试一次）。
      deps.warn?.(`任务对话失败，重建 run 重试：${error instanceof Error ? error.message : String(error)}`);
      const retry = await deps.client.ensureTaskRun({
        cookie: deps.cookie,
        base: deps.base,
        text,
        clientType: CLIENT_TYPE,
        ...(options.expert ? { sessionMode: 'expert', currentMode: 'expert' } : {}),
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        fresh: true,
      });
      response = await deps.client.sendTaskChat({
        cookie: deps.cookie,
        base: deps.base,
        run: retry,
        text,
        clientType: CLIENT_TYPE,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      });
      await putExecutionStatus(deps, retry, 'completed');
      return response.ok
        ? { ok: true, sessionId: retry.sessionId, detail: '对话完成' }
        : { ok: false, sessionId: retry.sessionId, detail: `HTTP ${String(response.status)}` };
    }

    await putExecutionStatus(deps, run, 'completed');
    return response.ok
      ? { ok: true, sessionId: run.sessionId, detail: '对话完成' }
      : { ok: false, sessionId: run.sessionId, detail: `HTTP ${String(response.status)}` };
  } catch (error) {
    return {
      ok: false,
      sessionId: '',
      detail: error instanceof Error ? error.message.slice(0, 140) : String(error).slice(0, 140),
    };
  }
}

/**
 * 群聊任务：一次性把「使用信号 + 建群 + 解散」走完。
 *
 * 顺序不能改：服务端要求会话先在 WS 上收到过 `user.input`（真实使用信号），
 * 之后 `POST /api/imchat/v1/channels` 才会成功。
 */
export async function runGroupTask(
  deps: OneTimeDeps,
): Promise<{ ok: boolean; detail: string }> {
  const WebSocketImpl = resolveWebSocketFactory(deps.webSocket);
  if (WebSocketImpl === undefined) return { ok: false, detail: '当前运行时没有 WebSocket' };

  // 1. 建 cowork_web 会话（网页端建群用的就是这种会话）。
  const created = await requestJson(
    `${deps.base}/api/aioffice/v1/cowork/sessions`,
    {
      method: 'POST',
      headers: {
        Cookie: cookieHeader(deps.cookie),
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        'User-Agent': USER_AGENT,
        Origin: deps.base,
        Referer: `${deps.base}/advanced/chat`,
      },
      body: JSON.stringify({ session_type: 'cowork_web' }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    },
    30_000,
  );
  const sessionId =
    typeof created.body === 'object' && created.body !== null
      ? String((created.body as { data?: { session_id?: unknown } }).data?.session_id ?? '')
      : '';
  if (sessionId === '') return { ok: false, detail: `cowork_web 会话 HTTP ${String(created.status)}` };

  // 2. WS 上发一次 user.input，等 run.end。
  const wsBase = deps.base.replace(/^http/, 'ws');
  const wsUrl = `${wsBase}/api/aioffice/v1/sessions/${encodeURIComponent(sessionId)}/completions/ws`;
  const signalled = await sendUsageSignal(WebSocketImpl, wsUrl, deps);
  if (!signalled) return { ok: false, detail: 'WS 对话未完成' };

  // 3. 建群 → 立刻解散（任务判定是「创建或加入任意一个群聊」，留群没意义）。
  const channel = await requestJson(
    `${deps.base}/api/imchat/v1/channels`,
    {
      method: 'POST',
      headers: {
        Cookie: cookieHeader(deps.cookie),
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ session_id: sessionId, expect_model: 'plan_pro' }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    },
    20_000,
  );
  if (!channel.ok) return { ok: false, detail: `建群 HTTP ${String(channel.status)}` };
  const channelId =
    typeof channel.body === 'object' && channel.body !== null
      ? String((channel.body as { data?: { channel_id?: unknown } }).data?.channel_id ?? '')
      : '';
  if (channelId === '') return { ok: false, detail: '建群没有返回 channel_id' };

  // 解散失败不影响任务判定（群已经建了），只记一句。
  const deleted = await requestJson(
    `${deps.base}/api/imchat/v1/channels/${encodeURIComponent(channelId)}`,
    {
      method: 'DELETE',
      headers: { Cookie: cookieHeader(deps.cookie), 'User-Agent': USER_AGENT },
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    },
    15_000,
  );
  return {
    ok: true,
    detail: deleted.ok ? '建群并解散 ✓' : `建群 ✓（解散失败 HTTP ${String(deleted.status)}）`,
  };
}

/** 在 WS 上发一次 `user.input` 并等结束事件。 */
function sendUsageSignal(
  WebSocketImpl: WebSocketFactory,
  url: string,
  deps: OneTimeDeps,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // 已经关了。
      }
      resolve(value);
    };

    let socket: WebSocket;
    try {
      // 工厂签名是调用式的（不是 `new`）：注入方自己决定用哪种构造器，
      // 这样才能给 Node 内置 WebSocket 之外、支持自定义头的实现留出位置。
      socket = WebSocketImpl(url, {
        headers: { Cookie: cookieHeader(deps.cookie), 'User-Agent': USER_AGENT, Origin: deps.base },
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      finish(false);
    }, 60_000);

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          event: 'user.input',
          data: {
            agent_input: {
              text: DEFAULT_TASK_TEXT,
              files: [],
              refs: [],
              expect_model: 'plan_pro',
              reasoning_effort: 'low',
              permission_mode: 'default',
              current_mode: 'agent',
              browser_plugin_enabled: false,
            },
            headers: { client_type: CLIENT_TYPE, open_position: 'clawapp' },
          },
        }),
      );
    };
    socket.onmessage = (event) => {
      let parsed: { event?: unknown };
      try {
        parsed = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      const name = String(parsed.event ?? '');
      if (name === 'run.end' || name === 'stream.end' || name === 'done') finish(true);
      else if (name === 'error' || name === 'force.stop') finish(false);
    };
    socket.onerror = () => {
      finish(false);
    };
    socket.onclose = () => {
      finish(false);
    };
  });
}

/**
 * 把「需要做的任务」全部做一遍。
 *
 * 不动 `claimable` 的任务（那些已经能直接领了）；只处理 `incomplete`。
 * 余额为 0 时**跳过**消耗性动作——一次对话会扣智点，没钱时发动它只是白失败。
 */
export async function performOneTimeTasks(
  deps: OneTimeDeps,
  needs: OneTimeNeeds,
  options: { balance?: number } = {},
): Promise<OneTimeActions> {
  const actions: OneTimeActions = {
    expert: { ok: false },
    client: { ok: false },
    group: { ok: false },
    notes: [],
  };
  const poor = options.balance !== undefined && options.balance <= 0;
  const wantsConversation = needs.expert || needs.client;

  if (wantsConversation) {
    if (poor) {
      actions.notes.push('余额为 0，跳过需要消耗智点的任务');
    } else {
      // 一次对话同时命中「客户端」与「专家」两个任务（客户端身份 + expert 模式）。
      const result = await runTaskConversation(deps, { expert: needs.expert });
      if (needs.expert) {
        actions.expert = { ok: result.ok, detail: result.detail };
        actions.client = { ok: result.ok, detail: result.detail };
        actions.notes.push(result.ok ? '专家模式 + 客户端对话 ✓' : `专家对话失败(${result.detail})`);
      } else {
        actions.client = { ok: result.ok, detail: result.detail };
        actions.notes.push(result.ok ? '客户端对话 ✓' : `客户端对话失败(${result.detail})`);
      }
    }
  }

  if (needs.group) {
    if (poor) {
      actions.notes.push('余额为 0，跳过群聊任务');
    } else {
      const result = await runGroupTask(deps);
      actions.group = result;
      actions.notes.push(result.ok ? `建群 ✓(${result.detail})` : `建群失败(${result.detail})`);
    }
  }

  return actions;
}
