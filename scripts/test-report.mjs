/**
 * 测试汇总：跑全部测试并把结论写进 `test-report.txt`。
 *
 * 为什么需要它：`node --test "test/*.test.ts"` 的输出在 Windows 终端里被截断/串行，
 * 而失败信息恰好在中段。这里用 `spawnSync` 拿完整 stdout，再只抽取结论行，
 * 于是「通过/失败」不依赖终端窗口大小。
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const files = readdirSync('test')
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => join('test', name))
  .sort();

const report = [];
/**
 * 有任何一个文件不通过就置位。
 *
 * 以前这份脚本只写报告、从不动退出码，于是 `gate.mjs` 的 `tests` 一步**永远**
 * 打印 ok —— 一条真的失败的测试被汇编写成了「全部通过」。这正是它必须自己
 * 决定退出码的原因：报告是给人看的，退出码是给流水线看的，两者都得对。
 */
let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', file], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const pass = /^ℹ pass (\d+)/m.exec(output)?.[1] ?? '?';
  const fail = /^ℹ fail (\d+)/m.exec(output)?.[1] ?? '?';
  const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM';
  // `pass=?` 说明连结论行都没打印出来（解释器崩了、参数写错），那也是失败。
  if (timedOut || result.status !== 0 || fail !== '0' || pass === '?') failed = true;
  report.push(`${file}\tpass=${pass}\tfail=${fail}\tstatus=${String(result.status)}${timedOut ? '\tTIMEOUT' : ''}`);
  if (timedOut || result.status !== 0) {
    const failing = output
      .split('\n')
      .filter((line) => line.startsWith('✖') || line.includes('AssertionError'))
      .slice(0, 12);
    report.push(...failing.map((line) => `  ${line.trim()}`));
  }
}

writeFileSync('test-report.txt', `${report.join('\n')}\n`, 'utf8');
console.log(report.join('\n'));
if (failed) {
  console.error('有测试未通过（详见上方 ✖ 行与 test-report.txt）');
  process.exitCode = 1;
}
