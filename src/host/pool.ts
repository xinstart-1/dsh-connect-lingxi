/**
 * 账号池的挑选逻辑（纯函数，不碰磁盘、不发请求）。
 *
 * ## 挑账号的规则，以及为什么这么定
 *
 * 1. **池开关关着 → 永远用「当前选用」那个**。用户手动选谁是明确的意图，
 *    自动挑不能盖过它。
 * 2. **池开关开着 → 只在「勾选了参与」的账号里挑**，优先余额高的。
 *    没勾的账号即使余额更多也不碰 —— 那是用户明确说「别动这个」。
 * 3. **勾选名单是空的 → 什么都不挑**，退回当前选用。
 *    不把「空名单」当成「全选」：用户取消勾选全部之后反而全被启用，
 *    是最容易被当成 bug 的行为。
 * 4. **余额未知不算 0**。读不到余额（接口失败）时保留它在候选里，
 *    但排在「已知余额」之后 —— 「不知道」不等于「没有」，
 *    直接排除会让一次网络抖动把好账号踢出池子。
 *
 * ## 为什么单独成文件
 *
 * 挑选规则是最容易写错、也最难在集成测试里覆盖的部分（要造多个账号、
 * 多个余额、多种失败）。把它抽成纯函数，就能用一个小表把边界情况全钉住。
 *
 * @module dsh-connect-lingxi/host/pool
 */

/** 挑选用的一个候选账号。 */
export interface PoolCandidate {
  /** 账号稳定 id。 */
  id: string;
  /** 剩余智点；`undefined` 表示**读不到**（不是 0）。 */
  credits: number | undefined;
  /** 用户是否勾选它参与自动挑选。 */
  enabled: boolean;
}

/** 挑选结果，带一句给用户看的原因（诊断页与日志都用它）。 */
export interface PoolChoice {
  /** 选中的账号 id，或 `undefined`（没有可挑的）。 */
  id: string | undefined;
  /** 为什么选它 / 为什么不选。 */
  reason: string;
}

/**
 * 从候选里挑一个账号。
 *
 * @param input.poolEnabled - 账号池总开关。
 * @param input.currentId - 用户手动选定的账号 id（可能已被删除）。
 * @param input.candidates - 池里全部账号（顺序不影响结果）。
 * @returns 选中的 id 与原因。
 */
export function pickAccount(input: {
  poolEnabled: boolean;
  currentId: string | undefined;
  candidates: readonly PoolCandidate[];
}): PoolChoice {
  const { poolEnabled, currentId, candidates } = input;

  if (candidates.length === 0) {
    return { id: undefined, reason: '账号池是空的' };
  }

  // 池开关关着：用户的显式选择就是唯一答案。
  if (!poolEnabled) {
    const current = candidates.find((candidate) => candidate.id === currentId);
    if (current !== undefined) {
      return { id: current.id, reason: '账号池未启用，使用当前选用的账号' };
    }
    // 当前选用指向一个已经不存在的账号：不静默换人，让调用方按「未登录」处理。
    return {
      id: undefined,
      reason: currentId === undefined ? '还没有选定账号' : '选定的账号已不在本机',
    };
  }

  const enabled = candidates.filter((candidate) => candidate.enabled);
  if (enabled.length === 0) {
    // 池开着但一个都没勾：不把「空」当「全选」。
    return { id: undefined, reason: '账号池已启用，但没有勾选任何账号' };
  }

  // 余额已知的优先，余额高的优先；余额未知的排在已知之后但仍在候选里。
  const ranked = [...enabled].sort((left, right) => {
    const leftKnown = left.credits !== undefined;
    const rightKnown = right.credits !== undefined;
    if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
    if (leftKnown && rightKnown) return (right.credits ?? 0) - (left.credits ?? 0);
    return 0;
  });

  const best = ranked[0];
  if (best === undefined) {
    return { id: undefined, reason: '没有可用账号' };
  }
  const credits = best.credits;
  return {
    id: best.id,
    reason:
      credits === undefined
        ? '余额读不到，保留在候选里'
        : `余额 ${credits}，在已勾选的 ${enabled.length} 个账号里最高`,
  };
}

/**
 * 给每个账号算一次「它是否会被选中」，供界面标注。
 *
 * 单独一个函数而不是在界面里重算：界面与 shim 必须用同一份判断，
 * 否则卡片上标着「此刻在用 A」而请求其实发给了 B。
 * @param input - 与 {@link pickAccount} 相同。
 * @returns 每个账号 id 是否是本次选中的那个。
 */
export function chosenFlags(input: {
  poolEnabled: boolean;
  currentId: string | undefined;
  candidates: readonly PoolCandidate[];
}): Record<string, boolean> {
  const choice = pickAccount(input);
  const flags: Record<string, boolean> = {};
  for (const candidate of input.candidates) flags[candidate.id] = candidate.id === choice.id;
  return flags;
}
