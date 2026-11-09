/**
 * 一条命令跑完全部校验。
 *
 * 存在的理由：在这个 Windows 终端里手敲多条 `|` / `&` 组合容易被 PowerShell
 * 与 cmd 的引号规则打架，写进脚本就只剩一次调用。
 *
 * 用法：`node scripts/gate.mjs`（任何一项失败即以非 0 退出）
 */

import { spawnSync } from 'node:child_process';

const steps = [
  ['typecheck', [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json']],
  ['build', [process.execPath, 'node_modules/tsdown/dist/run.mjs']],
  ['copy-client', [process.execPath, 'scripts/copy-client.mjs']],
  ['check-client', [process.execPath, 'scripts/check-client.mjs']],
  // 文档里不许出现没有上游错误码支撑的「做不到」。
  ['check-claims', [process.execPath, 'scripts/check-claims.mjs']],
  ['prepublish-check', [process.execPath, 'scripts/prepublish-check.mjs']],
  ['tests', [process.execPath, 'scripts/test-report.mjs']],
];

const failures = [];
for (const [name, command] of steps) {
  const result = spawnSync(command[0], command.slice(1), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const ok = result.status === 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) {
    failures.push(name);
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    if (output !== '') console.log(output.split(/\r?\n/).slice(-15).join('\n'));
  }
}

console.log('');
if (failures.length === 0) {
  console.log(`全部通过：${steps.map(([name]) => name).join(' / ')}`);
} else {
  console.error(`失败项：${failures.join(', ')}`);
  process.exitCode = 1;
}
