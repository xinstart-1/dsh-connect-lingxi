/**
 * 思考档位：把上游 `reasoning_efforts` 翻译成 pi-ai 的 `thinkingLevelMap`。
 *
 * ## 为什么需要这一层
 *
 * pi-ai 的档位集合是固定的七档（off / minimal / low / medium / high / xhigh / max），
 * 而灵犀官网给每个模型的档位是**上游自己的**（例如 DeepSeek V4.1 Flash 只有
 * 低 / 高 / 超高 三档）。如果直接把七档全开给用户，用户能选到官网没有的档位；
 * 更糟的是「选了中档实际发高档」这类静默替换 —— 那是在骗用户。
 *
 * ## 关键语义：`null` 表示「不提供」
 *
 * pi-ai 的 `thinkingLevelMap` 里，**缺键**与 **`null`** 含义不同：
 * - 缺键：对五个基础档意味着「支持」，对 `xhigh`/`max` 却意味着「不支持」——
 *   这个不对称正是必须显式写 `null` 的原因；
 * - `null`：明确「不提供这一档」，任何档位都一致。
 *
 * 所以这里对上游没声明的档位一律写 `null`，而不是省略。
 *
 * ## 上游没声明时
 *
 * 保持原来的七档映射。理由：没声明不等于「只有一档」，把档位砍到零会让用户
 * 失去官网明明有的能力。这是一个已知的保守回退，登录后抓到真实目录就会被覆盖。
 *
 * @module dsh-connect-lingxi/llm/thinking
 */

import type { ThinkingLevelMap } from '@earendil-works/pi-ai';
import type { LingxiModel } from '../protocol/catalog.ts';

/** pi-ai 的全部档位，升序。 */
const ALL_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** pi 档位（也是上游 `reasoning_effort` 的取值集合）。 */
type PiLevel = (typeof ALL_LEVELS)[number];

/**
 * 上游档位名的别名表。
 *
 * 上游给的是 `low` / `high` / `max` 这类英文；这里额外认几个常见别名，
 * 免得上游换个拼法就整档消失。`超高` 就是 `max`（官网截图里那一档）。
 */
const ALIASES: Readonly<Record<string, PiLevel>> = {
  off: 'off',
  none: 'off',
  minimal: 'minimal',
  min: 'minimal',
  low: 'low',
  medium: 'medium',
  mid: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  低: 'low',
  中: 'medium',
  高: 'high',
  超高: 'max',
};

/** 上游没声明档位时的回退：维持原有的七档映射（灵犀只认 low/high/max）。 */
const FALLBACK_MAP: ThinkingLevelMap = {
  off: 'off',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
};

/**
 * 把一个模型的上游档位声明翻译成 pi-ai 的 `thinkingLevelMap`。
 *
 * @param model - 目录条目（读 `reasoning` 与 `reasoningEfforts`）。
 * @returns 思考档映射；非思考模型返回 `undefined`（不写这个字段）。
 */
export function thinkingLevelMapFor(model: LingxiModel): ThinkingLevelMap | undefined {
  if (model.reasoning !== true) return undefined;
  const efforts = model.reasoningEfforts;
  if (efforts === undefined || efforts.length === 0) return { ...FALLBACK_MAP };

  // 先全部钉成 null（不提供），再把上游声明的档位逐个打开。
  const map: Record<string, string | null> = {};
  for (const level of ALL_LEVELS) map[level] = null;

  for (const raw of efforts) {
    const key = ALIASES[String(raw).trim().toLowerCase()];
    if (key === undefined) continue;
    // 线上取值与档位同名：shim 把档位名原样放进 `reasoning_effort`。
    map[key] = key;
  }

  // 上游只声明了 `off`（或全是不认识的拼法）：那是「没有思考能力」，
  // 不是「思考能力未知」。返回 undefined 让调用方按非思考模型处理，
  // 免得界面上留一个只有 Off 的假开关。
  const usable = ALL_LEVELS.some((level) => level !== 'off' && map[level] !== null);
  if (!usable) return undefined;

  return map as ThinkingLevelMap;
}
