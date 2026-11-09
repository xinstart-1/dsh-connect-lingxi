/**
 * 禁止「上游限制」式结论 + 项目记忆完整性的守门检查。
 *
 * 背景：这个项目两次把「我没实现」写成「上游限制」——
 * 客户端目录找错（`kdesk` 而非 `WPS 灵犀`）、`execution_status` 没实现。
 * 教训是：**没有上游错误码支撑的「做不到」都是借口**。
 *
 * 这个脚本做两件事：
 * 1. 扫本仓库文档，凡是出现「上游限制 / 做不到 / 无法翻转」这类断言，
 *    所在行必须同时带上「已被推翻 / 历史记录 / 引用」的标记，否则判失败。
 * 2. 确认**总项目记忆**（上级目录的 `AGENTS.md`）存在且仍带着核心规则 ——
 *    规则只写一份，子项目指向它，不能让它在某次改动里悄悄消失。
 *
 * 允许的写法：
 *   - ~~旧结论~~ → 0.0.x 推翻 ...        （划掉 + 注明推翻）
 *   - 「上游限制」实际是我没实现 ...      （用引号表明在引用）
 *   - 见 docs/CHANGELOG-0.0.2.md 的修正   （指向修正记录）
 *
 * 用法：`node scripts/check-claims.mjs`
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 被禁止的断言措辞。 */
const FORBIDDEN = /上游(?:限制|不支持|做不到)|协议做不到|无法翻转|只能手粘/;

/** 同一行出现这些标记时，说明是在「引用旧结论」或「记录推翻」，允许通过。 */
const EXEMPT = /~~|推翻|修正|已修|不是|删除|历史|当时|「|」|“|”/;

/** 总项目记忆的位置（本仓库的上一级）。 */
const PARENT_MEMORY = join('..', 'AGENTS.md');

/** 总项目记忆里必须一直存在的内容（每条 = 一个标记 + 人话说明）。 */
const REQUIRED_RULES = [
  ['参考项目', '必须写明「参考项目不能照搬」这个前提'],
  ['上游限制', '必须写明「不许说上游限制」这条硬规则'],
  ['取证', '必须写明「换方向取证」而不是继承参考项目的理念'],
];

/** 要扫的文档。 */
function markdownFiles(root = '.', acc = []) {
  for (const name of readdirSync(root)) {
    if (name === 'node_modules' || name === '.git' || name === '.reference') continue;
    const full = join(root, name);
    const stat = statSync(full);
    if (stat.isDirectory()) markdownFiles(full, acc);
    else if (name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

const problems = [];

// 1. 本仓库文档不许有无依据的「限制」断言。
let scanned = 0;
for (const file of markdownFiles()) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  scanned += 1;
  lines.forEach((line, index) => {
    if (!FORBIDDEN.test(line)) return;
    if (EXEMPT.test(line)) return;
    problems.push(`${file}:${String(index + 1)}  ${line.trim().slice(0, 100)}`);
  });
}

// 2. 修正记录必须存在：光删掉旧说法不够，要留下为什么错。
try {
  readFileSync('docs/CHANGELOG-0.0.2.md', 'utf8');
} catch {
  problems.push('docs/CHANGELOG-0.0.2.md 缺失（应记录「上游限制」两次误判的修正）');
}

// 3. 总项目记忆必须在，且核心规则没被删掉。
if (!existsSync(PARENT_MEMORY)) {
  problems.push(
    `${PARENT_MEMORY} 缺失：通用规则（参考项目不能照搬 / 不许说上游限制）应写在总项目里`,
  );
} else {
  const memory = readFileSync(PARENT_MEMORY, 'utf8');
  for (const [marker, why] of REQUIRED_RULES) {
    if (!memory.includes(marker)) problems.push(`${PARENT_MEMORY} 里找不到「${marker}」—— ${why}`);
  }
}

if (problems.length === 0) {
  console.log(`ok   ${String(scanned)} 个 md 文件里没有无依据的「上游限制」式结论`);
  console.log('ok   修正记录 docs/CHANGELOG-0.0.2.md 存在');
  console.log(`ok   总项目记忆 ${PARENT_MEMORY} 存在且含 ${String(REQUIRED_RULES.length)} 条核心规则`);
} else {
  console.error('项目记忆检查未通过：');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\n允许的写法：划掉旧结论并注明推翻，或用引号表明在引用旧说法。');
  process.exitCode = 1;
}
