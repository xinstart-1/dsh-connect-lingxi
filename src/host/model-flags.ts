/**
 * 逐模型开关的**唯一判定处**：图片输入到底开不开。
 *
 * 为什么单独一个模块：同一个问题在三处被问（DSH 模型选择器、`/status` 文档、
 * 卡片上的勾选框），三处各写一遍 `??` 就是三次机会让它们互相矛盾 ——
 * 卡片显示「图片开着」而选择器认为这个模型只收文本，是那种「看起来像事实的
 * 错误陈述」。所以规则只写一份，谁要都来问这里。
 *
 * 规则本身刻意做成「相对上游默认」的**两份名单**（`imageOnModels` /
 * `imageOffModels`），而不是一份绝对名单：
 * 上游以后给某个模型加上多模态，默认值会自动跟上，不会卡在旧快照里。
 *
 * @module dsh-connect-lingxi/host/model-flags
 */

import type { LingxiModel } from '../protocol/catalog.ts';
import type { LingxiPluginState } from '../state.ts';

/**
 * 这个模型实际接不接图片。
 *
 * 优先级：用户**明确关** > 用户**明确开** > 上游声明。
 * @param model - 目录条目（`vision` 是上游声明的能力）。
 * @param state - 插件状态；未读到状态时按上游声明。
 * @returns 是否把 `image` 加进 input modalities。
 */
export function imageEnabled(
  model: Pick<LingxiModel, 'id' | 'vision'>,
  state: LingxiPluginState | undefined,
): boolean {
  if (state === undefined) return model.vision;
  if (state.imageOffModels.includes(model.id)) return false;
  if (state.imageOnModels.includes(model.id)) return true;
  return model.vision;
}

/**
 * 把一个目录条目按用户开关归一。
 *
 * 只在真的变了的时候造新对象：调用方（adapter 的 provider 快照）按身份判断
 * 「配置有没有变」，每次返回新对象会让它以为一直在变。
 * @param model - 目录条目。
 * @param state - 插件状态。
 * @returns 生效后的目录条目（可能与入参同一引用）。
 */
export function withImageFlag(
  model: LingxiModel,
  state: LingxiPluginState | undefined,
): LingxiModel {
  const vision = imageEnabled(model, state);
  return vision === model.vision ? model : { ...model, vision };
}

/**
 * 过滤禁用模型，并把图片开关落到 `vision` 上。
 *
 * 这是「目录出口」：DSH 的选择器、`/status` 文档、adapter 的模型表都从这里拿，
 * 所以关掉的模型不可能出现在任何一处，勾掉的图片能力也不会只在一处生效。
 * @param models - 上游目录（或静态兜底）。
 * @param state - 插件状态。
 * @returns 用户视角的目录。
 */
export function visibleModels(
  models: readonly LingxiModel[],
  state: LingxiPluginState | undefined,
): LingxiModel[] {
  const disabled = state?.disabledModels ?? [];
  const out: LingxiModel[] = [];
  for (const model of models) {
    if (disabled.includes(model.id)) continue;
    out.push(withImageFlag(model, state));
  }
  return out;
}
