/**
 * 凭据自动探测的现场报告。
 *
 * 跑它就能知道「这台机器上插件能不能自己拿到登录态」，以及拿不到时卡在哪一步。
 * 只读，不写任何配置、不打日志泄露 cookie 明文（只报长度与来源）。
 *
 * 用法：`node scripts/probe-credential.mjs`
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  cookieDatabases,
  desktopDataDirs,
  findBrowser,
  looksLikeProfile,
  readBrowserCookies,
  readCookiesFromProfile,
  readDesktopCookies,
} from '../src/credentials/sources.ts';

const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');

console.log('# 浏览器可执行文件');
console.log(`  ${findBrowser() ?? '（没找到 Chromium 系浏览器）'}`);

console.log('\n# 灵犀客户端数据目录候选');
for (const dir of desktopDataDirs()) {
  const exists = existsSync(dir);
  const profile = exists ? looksLikeProfile(dir) : false;
  const dbs = exists ? cookieDatabases(dir) : [];
  console.log(`  ${exists ? '✓' : '·'} ${dir}${profile ? '  [像 profile]' : ''}${dbs.length > 0 ? `  库=${String(dbs.length)}` : ''}`);
}

console.log('\n# 日常浏览器 profile');
const browserRoots = [
  join(local, 'Google', 'Chrome', 'User Data'),
  join(local, 'Microsoft', 'Edge', 'User Data'),
  join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
  join(local, 'Chromium', 'User Data'),
  join(roaming, '360se6', 'User Data'),
];
for (const root of browserRoots) {
  console.log(`  ${existsSync(root) ? '✓' : '·'} ${root}`);
}

console.log('\n# 探测结果（只报长度，不打印 cookie 明文）');
const desktop = await readDesktopCookies();
console.log(
  desktop.credential !== undefined
    ? `  本机客户端：找到（cookie 长度 ${String(desktop.credential.cookie.length)}）`
    : `  本机客户端：未找到登录态${desktop.busy ? '（库被运行中的客户端独占锁定）' : ''}`,
);
const browser = await readBrowserCookies();
console.log(
  browser.credential !== undefined
    ? `  日常浏览器：找到（cookie 长度 ${String(browser.credential.cookie.length)}）`
    : `  日常浏览器：未找到灵犀登录态${browser.busy ? '（库被运行中的浏览器独占锁定）' : ''}`,
);

if (process.argv.includes('--detail')) {
  console.log('\n# 每个库的扫描结果');
  for (const dir of desktopDataDirs()) {
    for (const db of cookieDatabases(dir)) {
      const hit = readCookiesFromProfile(dir);
      console.log(
        `  ${db} → ${hit.cookie === undefined ? (hit.busy ? '被锁定' : '无') : `命中长度 ${String(hit.cookie.length)}`}`,
      );
      break;
    }
  }
}
