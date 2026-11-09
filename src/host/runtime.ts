/**
 * 宿主运行时：把「上游协议」「插件状态」「状态文档」三者缝在一起。
 *
 * 为什么要单独一层：`index.ts` 是装配清单（注册什么、什么时候释放），
 * 而这里的职责是**一个会话级的事实源**——余额、任务、目录各自多久刷新、
 * 刷新失败时保留什么、动作（签到 / 领取 / 改设置）执行后谁先失效。
 * 把它独立出来才能用假 client 单测整条链路，而不必起 Cordis。
 *
 * 一条硬规则：**网络失败不得清空上一次的好数据**。卡片上宁可是三分钟前的读数，
 * 也不要因为一次 502 变成「未登录」。因此每个缓存段都带 `at` 时间戳，
 * 失败时只记录 `lastError` 并保留旧值。
 *
 * @module dsh-connect-lingxi/host/runtime
 */

import type { LingxiClient } from '../protocol/client.ts';
import { parseBalance, type CreditSummary } from '../protocol/balance.ts';
import {
  beijingDate,
  claimableOneTime,
  dailyTask,
  parseClaimResponse,
  parseTasks,
  claimDateOf,
  type LingxiTask,
} from '../protocol/tasks.ts';
import { needsFor, performOneTimeTasks } from '../protocol/onetime.ts';
import { BASE } from '../constants.ts';
import type { LingxiModel } from '../protocol/catalog.ts';
import { POLL_INTERVAL_CHOICES, type LingxiPluginState } from '../state.ts';
import type {
  StatusCredits,
  StatusDocument,
  StatusModel,
  StatusTask,
} from './status.ts';
import type { LingxiAction } from './routes.ts';

/** cookie 解析结果。 */
export interface ResolvedCredential {
  value: string;
  /** `client` 本机客户端；`browser` 日常浏览器 / 主动登录；`manual` 手填；`none` 无。 */
  source: 'manual' | 'client' | 'browser' | 'none';
}

/** 运行时的外部依赖。全部以函数形式注入，是为了让每处都读最新配置。 */
export interface RuntimeOptions {
  client: LingxiClient;
  /** 当前插件状态（UI 开关）。 */
  state: () => Promise<LingxiPluginState>;
  /** 合并写入插件状态并返回新值。 */
  saveState: (patch: Partial<LingxiPluginState>) => Promise<LingxiPluginState>;
  /** 解析登录态。 */
  credential: () => Promise<ResolvedCredential>;
  /** 静态兜底目录（动态目录还没拉到时用）。 */
  fallbackCatalog: () => readonly LingxiModel[];
  /** 插件版本号，写进状态文档供卡片显示。 */
  version: string;
  /** 诊断日志。 */
  warn: (message: string) => void;
  /** 时钟（测试可替换）。 */
  now?: () => number;
  /** 上游基址（`verify` 会自己挑，这里给一个缺省）。 */
  base?: string;
  /** 取消信号（插件卸载时中断在途的一次性任务动作）。 */
  signal?: AbortSignal;
  /** 主动登录的实现（拉起浏览器）。不提供时 `login` 动作报「未配置」。 */
  login?: () => Promise<{ ok: boolean; message: string }>;
}

/** 一段带时间戳的缓存。 */
interface Segment<T> {
  value: T;
  at: number;
}

/** 上游失败时的统一措辞：原文照留，便于用户整段贴进问题反馈。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 灵犀运行时。
 *
 * 生命周期：`index.ts` 在装配时构造一个，卸载时调用 {@link dispose}。
 * 定时器只在**至少有一个界面在读**的时候转（`retain` / `release`），
 * 因为每次轮询是一次真实的上游请求，没有界面时没有理由花它。
 */
export class LingxiRuntime {
  private readonly options: RuntimeOptions;
  private readonly now: () => number;
  /** 上游基址；`status()` 里的 `verify` 会回报真实生效的那一个。 */
  private base: string | undefined;
  private credits?: Segment<CreditSummary | undefined>;
  private tasks?: Segment<LingxiTask[]>;
  private models?: Segment<LingxiModel[]>;
  private identity?: Segment<{ name?: string; expired: boolean }>;
  private lastError?: string;
  /** 签到 / 领取进行中，防止两次轮询同时发起领取。 */
  private claiming = false;
  /** 登录窗口已打开（避免用户连点两次拉起两个浏览器）。 */
  private loggingIn = false;
  /** 主动动作触发的强制刷新，避免与轮询并发跑同一份请求。 */
  private refreshing?: Promise<StatusDocument>;
  private timer?: NodeJS.Timeout;
  private readers = 0;

  constructor(options: RuntimeOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.base = options.base;
  }

  /**
   * 声明有界面在读：第一个读者到达时开始轮询。
   *
   * 返回释放函数；重复调用必须先释放再 retain，否则计数会漂。
   */
  retain(): () => void {
    this.readers += 1;
    if (this.readers === 1) this.schedule();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.readers = Math.max(0, this.readers - 1);
      if (this.readers === 0) this.unschedule();
    };
  }

  /** 停掉定时器与在途动作。 */
  dispose(): void {
    this.unschedule();
  }

  /**
   * 构建状态文档。
   * @param force - 为 true 时忽略缓存，全部重拉（卡片上的刷新按钮）。
   */
  async status(force = false): Promise<StatusDocument> {
    if (force && this.refreshing !== undefined) return this.refreshing;
    if (!force) return this.snapshot();
    const promise = (async (): Promise<StatusDocument> => {
      const credential = await this.options.credential();
      if (credential.value !== '') await this.refreshAll(credential);
      return this.snapshot();
    })().finally(() => {
      this.refreshing = undefined;
    });
    this.refreshing = promise;
    return promise;
  }

  /**
   * 执行一个动作。
   *
   * 每个动作结束时都强制刷新一次：界面显示的是**动作之后的**上游读数，
   * 不做乐观更新——签到这种事，「以为领到了但其实没领到」比慢两秒更糟。
   */
  async run(action: LingxiAction, body: Record<string, unknown>): Promise<unknown> {
    switch (action) {
      case 'refresh':
        return { ok: true, status: await this.status(true) };
      case 'login':
        return this.login();
      case 'claim-checkin':
        return this.claimCheckin();
      case 'claim-one-time':
        return this.claimOneTime();
      case 'settings':
        return this.applySettings(body);
      default:
        return { ok: false, error: `未知操作: ${String(action)}` };
    }
  }

  /**
   * 主动登录：拉起浏览器让用户自己登录，插件只读 cookie。
   *
   * 这条动作会**弹出一个浏览器窗口**，只在用户点按钮时执行。登录成功后
   * 所有缓存失效（账号可能换了），下一次读到的就是新身份。
   */
  private async login(): Promise<unknown> {
    if (this.options.login === undefined) {
      return { ok: false, error: '未配置登录实现' };
    }
    if (this.loggingIn) return { ok: false, error: '登录窗口已打开，请在其中完成登录' };
    this.loggingIn = true;
    try {
      const result = await this.options.login();
      if (result.ok) {
        this.invalidate();
      }
      return { ...result, status: await this.status(false) };
    } catch (error) {
      this.lastError = messageOf(error);
      return { ok: false, error: messageOf(error) };
    } finally {
      this.loggingIn = false;
    }
  }

  // ── 动作 ──────────────────────────────────────────────────────────────

  /** 领每日签到。已签到的账号不再发写请求（上游对重复领取是幂等假成功，看不出真假）。 */
  private async claimCheckin(): Promise<unknown> {
    if (this.claiming) return { ok: false, error: '正在领取中，请稍候' };
    this.claiming = true;
    try {
      const credential = await this.options.credential();
      if (credential.value === '') return { ok: false, error: '未配置 WPS 灵犀 cookie' };
      const cookie = credential.value;
      const before = await this.readCredits(credential);

      // 领之前重读任务：缓存里的 status 可能是几分钟前的。
      const tasks = await this.readTasks(credential);
      const daily = dailyTask(tasks);
      if (daily === undefined) return { ok: false, error: '上游任务中心里没有每日签到' };
      if (daily.status === 'claimed') {
        return { ok: true, outcome: 'done', message: '今日已签到', streak: daily.streak };
      }

      const date = claimDateOf(daily, beijingDate(this.now()));
      const payload = await this.options.client.claimTask(cookie, daily.key, date);
      const outcome = parseClaimResponse(payload, daily.reward);
      if (!outcome.ok) {
        this.lastError = outcome.message ?? '签到失败';
        return { ok: false, error: outcome.message ?? '签到失败' };
      }

      // 奖励读数：上游幂等时余额不变，此时如实报「已领过」，不编造 +N。
      const after = await this.readCredits(credential, true);
      const delta =
        before?.total !== undefined && after?.total !== undefined ? after.total - before.total : 0;
      const reward = delta > 0 ? delta : outcome.reward;
      await this.options.client.tasksPayload(cookie).then(
        (payload) => this.storeTasks(payload),
        () => {},
      );
      return {
        ok: true,
        outcome: reward > 0 ? 'claimed' : 'done',
        reward,
        streak: daily.streak,
        message:
          reward > 0 ? `签到成功 +${String(reward)} 智点` : '今日已签到（上游幂等，余额未变化）',
        status: await this.status(true),
      };
    } catch (error) {
      this.lastError = messageOf(error);
      this.options.warn(`签到失败：${messageOf(error)}`);
      return { ok: false, error: messageOf(error) };
    } finally {
      this.claiming = false;
    }
  }

  /**
   * 领取所有上游已判 `claimable` 的一次性任务；**顺手把 `incomplete` 的做出来**。
   *
   * 这里不再有「做不到」的分支：三个一次性任务都能靠 HTTP 走通
   * （`protocol/onetime.ts`，含 `execution_status` 生命周期与建群流程），
   * 取证来源是已在真机跑通的实现。
   *
   * 顺序不能反：先做动作 → 重拉任务 → 领 claimable。反过来会领到空。
   */
  private async claimOneTime(): Promise<unknown> {
    if (this.claiming) return { ok: false, error: '正在领取中，请稍候' };
    this.claiming = true;
    try {
      const credential = await this.options.credential();
      if (credential.value === '') return { ok: false, error: '未配置 WPS 灵犀 cookie' };
      const cookie = credential.value;

      // 1. 读任务与余额（余额为 0 时不做消耗性动作——一次对话会扣智点）。
      const tasks = await this.readTasks(credential);
      const needs = needsFor(
        tasks.map((task) => ({
          key: task.key,
          status: task.status,
          type: task.type,
          ...(task.action === undefined ? {} : { action: task.action }),
        })),
      );
      const balance = (await this.readCredits(credential))?.total;
      const notes: string[] = [];

      // 2. 把 incomplete 的做出来（专家模式 / 客户端 / 群聊）。
      if (needs.expert || needs.client || needs.group) {
        const actions = await performOneTimeTasks(
          {
            client: this.options.client,
            cookie,
            base: this.base ?? BASE,
            ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
            warn: this.options.warn,
          },
          needs,
          balance === undefined ? {} : { balance },
        );
        notes.push(...actions.notes);
      }

      // 3. 重拉任务，领所有 claimable（含刚被动作带出来的）。
      const refreshed = await this.readTasks(credential, true);
      const pending = claimableOneTime(refreshed);
      const claimed: Array<{ key: string; reward: number }> = [];
      const failed: Array<{ key: string; message: string }> = [];
      for (const task of pending) {
        try {
          const payload = await this.options.client.claimTask(cookie, task.key, '');
          const outcome = parseClaimResponse(payload, task.reward);
          if (outcome.ok) claimed.push({ key: task.key, reward: outcome.reward });
          else failed.push({ key: task.key, message: outcome.message ?? '领取失败' });
        } catch (error) {
          failed.push({ key: task.key, message: messageOf(error) });
        }
      }

      const bonus = claimed.reduce((sum, item) => sum + item.reward, 0);
      if (claimed.length > 0) await this.readTasks(credential, true);
      // 「没有可领取」只在**确实什么都没发生**时说：没做动作、也没领到。
      // 用 notes 判断会错 —— 上游失败也会留一条 note，那说明「试过但没成」，
      // 不是「本来就没有」。
      const didSomething = claimed.length > 0 || needs.expert || needs.client || needs.group;
      return {
        // 「没有可做/可领的」不是失败：一次什么都没发生的点击应当安静地成功。
        ok: claimed.length > 0 || notes.length > 0 || !didSomething,
        claimed,
        failed,
        reward: bonus,
        notes,
        message: [
          ...(bonus > 0 ? [`一次性任务 +${String(bonus)} 智点`] : []),
          ...notes,
          ...(pending.length === 0 && !didSomething ? ['没有可领取的任务'] : []),
        ].join('；'),
        status: await this.status(true),
      };
    } catch (error) {
      this.lastError = messageOf(error);
      return { ok: false, error: messageOf(error) };
    } finally {
      this.claiming = false;
    }
  }

  /** 改插件状态（浏览器半侧的开关都走这里）。 */
  private async applySettings(body: Record<string, unknown>): Promise<unknown> {
    const patch: Partial<LingxiPluginState> = {};
    if (typeof body.autoCheckin === 'boolean') patch.autoCheckin = body.autoCheckin;
    if (typeof body.composerPill === 'boolean') patch.composerPill = body.composerPill;
    if (typeof body.sidebarPanel === 'boolean') patch.sidebarPanel = body.sidebarPanel;
    if (typeof body.pollIntervalMs === 'number') patch.pollIntervalMs = body.pollIntervalMs;
    if (Array.isArray(body.disabledModels)) {
      patch.disabledModels = body.disabledModels.filter(
        (id): id is string => typeof id === 'string' && id.trim() !== '',
      );
    }
    if (Object.keys(patch).length === 0) return { ok: false, error: '没有可更新的字段' };
    const next = await this.options.saveState(patch);
    // 刷新间隔变了，轮询节奏必须跟着变；否则要等下一次重启才生效。
    if (patch.pollIntervalMs !== undefined) {
      this.unschedule();
      if (this.readers > 0) this.schedule();
    }
    return { ok: true, state: next, status: await this.status(false) };
  }

  // ── 轮询 ──────────────────────────────────────────────────────────────

  private schedule(): void {
    void this.loadState().then((state) => {
      // 读状态是异步的，读完必须重新确认「还有人在看」：`retain()` 后立刻
      // `release()`（测试与快速关闭界面都会这样）会让 unschedule 先跑一遍，
      // 然后这里再装一个没人管的定时器 —— 进程因此退不出去。
      if (this.readers === 0) return;
      const interval = POLL_INTERVAL_CHOICES.includes(state.pollIntervalMs)
        ? state.pollIntervalMs
        : POLL_INTERVAL_CHOICES[1]!;
      this.unschedule();
      this.timer = setInterval(() => {
        void this.tick();
      }, interval);
      // 定时器不该把进程钉住；DSH 退出时由 dispose 收尾。
      this.timer.unref?.();
      void this.tick();
    });
  }

  private unschedule(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 一次轮询：登录态 → 余额 + 任务（同一份凭据只解析一次）→ 自动签到。 */
  private async tick(): Promise<void> {
    try {
      const credential = await this.options.credential();
      if (credential.value === '') return;
      await this.refreshAll(credential);
      await this.maybeAutoCheckin(credential);
    } catch (error) {
      this.lastError = messageOf(error);
      this.options.warn(`刷新灵犀状态失败：${messageOf(error)}`);
    }
  }

  private async state(): Promise<LingxiPluginState> {
    return this.options.state();
  }

  /** 自动签到：只在开关打开、且上游说今天还没签的时候发写请求。 */
  private async maybeAutoCheckin(credential: ResolvedCredential): Promise<void> {
    const state = await this.state();
    if (!state.autoCheckin || this.claiming) return;
    const tasks = this.tasks?.value;
    if (tasks === undefined) return;
    const daily = dailyTask(tasks);
    if (daily === undefined || daily.status === 'claimed') return;
    await this.claimCheckin();
  }

  // ── 数据段 ────────────────────────────────────────────────────────────

  /**
   * 全量刷新。各段独立失败：余额读不到不影响任务，任务读不到不影响目录。
   * @param known - 已经解析过的凭据，省一次解析。
   */
  private async refreshAll(known?: ResolvedCredential): Promise<void> {
    const credential = known ?? (await this.options.credential());
    if (credential.value === '') return;
    const results = await Promise.allSettled([
      this.readCredits(credential, true).then(() => undefined),
      this.readTasks(credential, true).then(() => undefined),
      this.readModels(credential, true).then(() => undefined),
      this.readIdentity(credential, true).then(() => undefined),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        this.lastError = messageOf(result.reason);
        this.options.warn(`刷新灵犀状态失败：${messageOf(result.reason)}`);
      }
    }
  }

  private async readCredits(
    credential: ResolvedCredential,
    force = false,
  ): Promise<CreditSummary | undefined> {
    const cached = this.credits;
    if (!force && cached !== undefined && this.fresh(cached.at)) return cached.value;
    try {
      const payload = await this.options.client.balancePayload(credential.value);
      const summary = parseBalance(payload, this.now());
      this.credits = { value: summary, at: this.now() };
      return summary;
    } catch (error) {
      this.lastError = messageOf(error);
      this.credits = { value: cached?.value, at: this.now() };
      return cached?.value;
    }
  }

  private async readTasks(credential: ResolvedCredential, force = false): Promise<LingxiTask[]> {
    const cached = this.tasks;
    if (!force && cached !== undefined && this.fresh(cached.at)) return cached.value;
    const payload = await this.options.client.tasksPayload(credential.value);
    const tasks = parseTasks(payload);
    this.tasks = { value: tasks, at: this.now() };
    return tasks;
  }

  private storeTasks(payload: unknown): void {
    this.tasks = { value: parseTasks(payload), at: this.now() };
  }

  private async readModels(credential: ResolvedCredential, force = false): Promise<LingxiModel[]> {
    const cached = this.models;
    if (!force && cached !== undefined && this.fresh(cached.at)) return cached.value;
    const models = await this.options.client.listModels(credential.value);
    const value = models.length === 0 ? [...this.options.fallbackCatalog()] : models;
    this.models = { value, at: this.now() };
    return value;
  }

  private async readIdentity(
    credential: ResolvedCredential,
    force = false,
  ): Promise<{ name?: string; expired: boolean }> {
    const cached = this.identity;
    if (!force && cached !== undefined && this.fresh(cached.at)) return cached.value;
    try {
      const { name, base } = await this.options.client.verify(credential.value);
      // 记住真正生效的基址（kdocs 侧的账号只有在那一侧才通）。
      if (typeof base === 'string' && base !== '') this.base = base;
      const value = { name, expired: false };
      this.identity = { value, at: this.now() };
      return value;
    } catch (error) {
      if (error instanceof Error && (error as { status?: number }).status === 401) {
        const value = { expired: true };
        this.identity = { value, at: this.now() };
        return value;
      }
      throw error;
    }
  }

  /** 最近一次读到的插件状态（同步副本，供 `fresh` 这种同步判断用）。 */
  private stateSync?: LingxiPluginState;
  /** 最后一次解析到的凭据；换账号时用它判断要不要清缓存。 */
  private lastCredential?: ResolvedCredential;

  private async loadState(): Promise<LingxiPluginState> {
    const state = await this.options.state();
    this.stateSync = state;
    return state;
  }

  /** 缓存是否还新鲜：跟随用户设的刷新间隔，但不超过 15 分钟。 */
  private fresh(at: number): boolean {
    const configured = this.stateSync?.pollIntervalMs;
    const interval =
      configured !== undefined && POLL_INTERVAL_CHOICES.includes(configured)
        ? configured
        : POLL_INTERVAL_CHOICES[1]!;
    return this.now() - at < Math.min(interval, 15 * 60 * 1000);
  }

  /**
   * 把缓存段拼成状态文档。
   *
   * 每个段落都从「最后一次成功」来，缺的段落给安全缺省；`readAtMs` 取最旧的一段，
   * 因为那张卡片说明的是「整张表有多旧」，不是「最常刷新的那一项有多新」。
   */
  private async snapshot(): Promise<StatusDocument> {
    const [credential, state] = await Promise.all([this.options.credential(), this.loadState()]);
    const total = this.credits?.value;
    const tasks = this.tasks?.value ?? [];
    const daily = dailyTask(tasks);
    const identity = this.identity?.value;
    const models = this.models?.value ?? [...this.options.fallbackCatalog()];
    const signedOut = credential.value === '';

    const credits: StatusCredits =
      total === undefined
        ? { state: 'unavailable', batches: [] }
        : {
            state: identity?.expired === true ? 'expired' : 'ok',
            total: total.total,
            totalValue: total.totalValue,
            ...(total.consumed === undefined ? {} : { consumed: total.consumed }),
            ...(total.expiring === undefined
              ? {}
              : { expiring: { amount: total.expiring.amount, earliest: total.expiring.earliest } }),
            batches: total.batches.map((batch) => ({
              balance: batch.balance,
              value: batch.value,
              consumed: batch.consumed,
              expireTime: batch.expireTime,
            })),
            updatedAtMs: this.credits?.at,
          };

    const times = [this.credits?.at, this.tasks?.at, this.models?.at, this.identity?.at].filter(
      (value): value is number => typeof value === 'number',
    );

    return {
      version: this.options.version,
      login: signedOut
        ? {
            state: 'signed-out',
            source: 'none',
            ...(this.options.login === undefined ? {} : { canLogin: true }),
          }
        : identity?.expired === true
          ? {
              state: 'expired',
              source: credential.source,
              ...(this.options.login === undefined ? {} : { canLogin: true }),
            }
          : {
              state: 'signed-in',
              source: credential.source,
              ...(identity?.name === undefined ? {} : { name: identity.name }),
            },
      credits,
      tasks: {
        ...(daily === undefined ? {} : { daily: toStatusTask(daily) }),
        oneTime: tasks.filter((task) => task.type !== 'daily').map(toStatusTask),
        checkedInToday: daily?.status === 'claimed',
      },
      models: models.map((model) => toStatusModel(model, state)),
      settings: {
        autoCheckin: state?.autoCheckin === true,
        pollIntervalMs:
          state !== undefined && POLL_INTERVAL_CHOICES.includes(state.pollIntervalMs)
            ? state.pollIntervalMs
            : POLL_INTERVAL_CHOICES[1]!,
        composerPill: state?.composerPill !== false,
        sidebarPanel: state?.sidebarPanel === true,
        disabledModels: state?.disabledModels ?? [],
      },
      readAtMs: times.length === 0 ? this.now() : Math.min(...times),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    };
  }

  /** 显式清缓存（配置变化 / 登出）。 */
  invalidate(): void {
    this.credits = undefined;
    this.tasks = undefined;
    this.models = undefined;
    this.identity = undefined;
    this.lastError = undefined;
  }

  /**
   * 同步设置最新状态。
   *
   * 为什么需要同步入口：`fresh()` 是同步判断（每次读缓存都要问一次），
   * 而状态是异步读的。让 `index.ts` 在写完状态后同步覆盖，比让 `fresh()`
   * 变成 async 更简单，也不会让缓存判断多一次 await。
   */
  rememberStateSync(state: LingxiPluginState): void {
    this.stateSync = state;
  }

  /** 刷新间隔变了：重建定时器，让新值立刻生效（不必等重启）。 */
  restartPolling(): void {
    if (this.readers === 0) return;
    this.unschedule();
    this.schedule();
  }
}

/** 任务条目 → 状态文档。 */
function toStatusTask(task: LingxiTask): StatusTask {
  return {
    key: task.key,
    type: task.type,
    title: task.title,
    status: task.status,
    reward: task.reward,
    ...(task.streak === undefined ? {} : { streak: task.streak }),
  };
}

/** 目录条目 → 状态文档（启用状态来自插件状态的禁用名单）。 */
function toStatusModel(model: LingxiModel, state: LingxiPluginState | undefined): StatusModel {
  const disabled = state?.disabledModels ?? [];
  return {
    id: model.id,
    name: model.name,
    multiplier: model.multiplier,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    vision: model.vision,
    enabled: !disabled.includes(model.id),
  };
}
