/**
 * 插件自己的状态文件。
 *
 * 为什么不用 DSH 的 settings：这些是**界面偏好**（要不要显示胶囊、侧栏入口、
 * 刷新间隔），不是模型路由配置。写进 settings 意味着每次调亮度都要过一遍
 * 「改配置 → 重载插件」，而这些开关的要求是「点一下立即生效、不经过保存」。
 * 所以它们落在一个自己的 JSON 文件里，读写都只碰这一个文件。
 *
 * 位置：`$DSH_HOME/dsh-connect-lingxi-state.json`（`DSH_HOME` 未设时为 `~/.dsh`）。
 * 写盘走「临时文件 + rename」，权限 0o600——半个文件被读到会被当成默认值，
 * 那不会有害；但读到半个 JSON 会让用户以为设置丢了。
 *
 * @module dsh-connect-lingxi/state
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 状态文件名（放在 DSH home 根下，与其它插件的约定一致）。 */
const STATE_FILENAME = 'dsh-connect-lingxi-state.json';

/** 刷新间隔的五档（1 / 5 / 10 / 30 / 60 分钟）。 */
export const POLL_INTERVAL_CHOICES: readonly number[] = Object.freeze([
  60_000,
  300_000,
  600_000,
  1_800_000,
  3_600_000,
]);

/** 插件状态。 */
export interface LingxiPluginState {
  schemaVersion: 1;
  /**
   * 被用户关掉的模型 id。
   *
   * 存禁用名单而不是启用名单：上游随时上下架模型，启用名单会让新上架的模型
   * 默认不可见，用户得先知道它存在才可能勾上。
   */
  disabledModels: string[];
  /**
   * 用户手动**关掉**图片输入的模型 id（上游声明支持图片，但用户不要）。
   *
   * 与 {@link imageOnModels} 成对：两张名单都只记录**与上游默认不同**的那一侧，
   * 这样上游以后给某个模型加上/去掉多模态，默认值会自动跟着变，不会卡在旧快照上。
   */
  imageOffModels: string[];
  /**
   * 用户手动**打开**图片输入的模型 id（上游没声明支持图片，用户自己确认过能用）。
   */
  imageOnModels: string[];
  /** 每天自动签到（**默认关**：这是会自动改变账号状态的写操作）。 */
  autoCheckin: boolean;
  /** 状态刷新间隔；只能是 {@link POLL_INTERVAL_CHOICES} 之一。 */
  pollIntervalMs: number;
  /** 输入框左侧的智点读数。 */
  composerPill: boolean;
  /** 侧边栏入口（占全局座位，默认关）。 */
  sidebarPanel: boolean;
  /**
   * 账号池总开关：是否允许插件在账号之间自动挑一个。
   *
   * **默认关**。开着时每次对话由账号池挑账号（见 `pickAccount`）；
   * 关着时永远用「当前选用」的那一个，别的账号只作为手动切换的备选。
   *
   * 为什么默认关：这是会改变「哪份配额被消耗」的行为，用户应该自己决定要不要。
   */
  accountPoolEnabled: boolean;
  /**
   * 参**与轮换 / 签到 / 测试**的账号 id。
   *
   * 与 {@link accountPoolEnabled} 分工明确：那个开关管「要不要自动挑」，
   * 这张名单管「哪些账号有资格被挑中」。不在名单里的账号仍然保存在池里、
   * 仍然可以在列表里看到余额，只是不会被自动用到。
   *
   * 空数组合法的含义是「一个都没勾」，不是「全都勾」—— 后者会让用户
   * 取消勾选全部之后反而全被启用。
   */
  enabledAccounts: string[];
  /**
   * 设备头策略：`virtual` 给每个账号派生的虚拟设备指纹，`real` 用本机真实指纹。
   *
   * 灵犀按设备限流。同一台机器上多个账号共用一份真实指纹，容易被判成
   * 同一台设备刷量；虚拟指纹能让每个账号看起来是不同设备。
   *
   * **默认 `virtual`**，与 WorkBuddy 一致：多账号场景下这是更安全的默认。
   */
  deviceHeaderMode: 'virtual' | 'real';
}

/** 默认状态。 */
export const DEFAULT_STATE: LingxiPluginState = Object.freeze({
  schemaVersion: 1,
  disabledModels: [],
  imageOffModels: [],
  imageOnModels: [],
  autoCheckin: false,
  pollIntervalMs: 300_000,
  composerPill: true,
  sidebarPanel: false,
  accountPoolEnabled: false,
  enabledAccounts: [],
  deviceHeaderMode: 'virtual',
}) as LingxiPluginState;

/**
 * 一份全新的默认状态（数组也各自新建）。
 *
 * `DEFAULT_STATE` 是冻结对象，但里面的数组不是冻结的；直接把它的引用交出去，
 * 任何一处就地 `push` 都会污染「默认值」本身。所有返回默认值的地方都走这里。
 * @returns 独立的默认状态副本。
 */
export function defaultState(): LingxiPluginState {
  return {
    ...DEFAULT_STATE,
    disabledModels: [],
    imageOffModels: [],
    imageOnModels: [],
    enabledAccounts: [],
  };
}

/**
 * 归一化任意读到的值。
 *
 * 逐字段回落而不是整份丢弃：一份里 `pollIntervalMs` 被写坏，不该顺带把
 * 用户的 `disabledModels` 也清掉。
 * @param raw - 读到的 JSON（任意形状）。
 * @returns 合法状态。
 */
export function normalizeState(raw: unknown): LingxiPluginState {
  if (typeof raw !== 'object' || raw === null) return defaultState();
  const record = raw as Record<string, unknown>;

  /** 一张 id 名单：非字符串、空串一律丢掉。 */
  const ids = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
      : [];

  const disabled = ids(record.disabledModels);
  // 同一个模型不能同时出现在「强制开」与「强制关」两张名单里：后者胜出，
  // 否则勾选框会显示成「开」，而实际生效的是「关」。
  const imageOff = ids(record.imageOffModels);
  const imageOn = ids(record.imageOnModels).filter((id) => !imageOff.includes(id));

  const interval = record.pollIntervalMs;

  return {
    schemaVersion: 1,
    disabledModels: disabled,
    imageOffModels: imageOff,
    imageOnModels: imageOn,
    autoCheckin:
      typeof record.autoCheckin === 'boolean' ? record.autoCheckin : DEFAULT_STATE.autoCheckin,
    // 封闭的五档，且**只认数字**：手写的 `0`、`'600000'` 一律回落。
    // 「不刷新」和「疯狂刷新」都不是用户想要的，而这个数字直接驱动 setInterval；
    // 字符串也不接受，因为隐式转换意味着配置文件里写错一个引号会静默生效。
    pollIntervalMs:
      typeof interval === 'number' && POLL_INTERVAL_CHOICES.includes(interval)
        ? interval
        : DEFAULT_STATE.pollIntervalMs,
    composerPill:
      typeof record.composerPill === 'boolean' ? record.composerPill : DEFAULT_STATE.composerPill,
    sidebarPanel:
      typeof record.sidebarPanel === 'boolean' ? record.sidebarPanel : DEFAULT_STATE.sidebarPanel,
    accountPoolEnabled:
      typeof record.accountPoolEnabled === 'boolean'
        ? record.accountPoolEnabled
        : DEFAULT_STATE.accountPoolEnabled,
    enabledAccounts: ids(record.enabledAccounts),
    deviceHeaderMode:
      record.deviceHeaderMode === 'real' || record.deviceHeaderMode === 'virtual'
        ? record.deviceHeaderMode
        : DEFAULT_STATE.deviceHeaderMode,
  };
}

/**
 * 状态文件路径。
 * @param env - 环境变量（测试注入）。
 * @returns 绝对路径。
 */
export function statePath(env: NodeJS.ProcessEnv = process.env): string {
  const home =
    typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0
      ? env.DSH_HOME
      : join(homedir(), '.dsh');
  return join(home, STATE_FILENAME);
}

/**
 * 读状态。文件不存在、坏 JSON、字段非法都回落到默认值（永不抛）。
 * @param env - 环境变量（测试注入）。
 * @returns 合法状态。
 */
export async function readState(env: NodeJS.ProcessEnv = process.env): Promise<LingxiPluginState> {
  let text: string;
  try {
    text = await readFile(statePath(env), 'utf8');
  } catch {
    return defaultState();
  }
  try {
    return normalizeState(JSON.parse(text));
  } catch {
    return defaultState();
  }
}

/**
 * 合并写入。`patch` 里未出现的键保持原值；返回写后的完整状态。
 * @param patch - 要改的字段。
 * @param env - 环境变量（测试注入）。
 * @returns 写后的状态。
 */
export async function writeState(
  patch: Partial<LingxiPluginState>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LingxiPluginState> {
  const current = await readState(env);
  const next = normalizeState({
    ...current,
    ...Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ),
  });

  const path = statePath(env);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return next;
}
