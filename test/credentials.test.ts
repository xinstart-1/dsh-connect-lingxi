/**
 * 凭据自动探测的单元测试。
 *
 * 这里钉住的是**判断**，不是这台机器上装没装浏览器：
 * 目录识别、key 向上继承、库被锁时回报 `busy`、以及「三种来源的优先级」。
 * 需要真实 SQLite 的用例自己造一个最小 cookie 库。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import {
  cookieDatabases,
  desktopDataDirs,
  findBrowser,
  looksLikeProfile,
  readCookiesFromProfile,
  readDesktopCookies,
} from '../src/credentials/sources.ts';

/** 临时目录，测完清掉。 */
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 删不掉只是留临时文件。
    }
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lingxi-cred-'));
  dirs.push(dir);
  return dir;
}

/** 造一个最小 Chromium cookie 库（明文 value，不加密）。 */
function makeCookieDb(path: string, rows: Array<{ host: string; name: string; value: string }>): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    'CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, creation_utc INTEGER, last_access_utc INTEGER, has_expires INTEGER, is_persistent INTEGER, priority INTEGER, samesite INTEGER, source_scheme INTEGER, source_port INTEGER, last_update_utc INTEGER)',
  );
  const insert = db.prepare(
    'INSERT INTO cookies (host_key, name, value, encrypted_value) VALUES (?, ?, ?, x\'00\')',
  );
  for (const row of rows) insert.run(row.host, row.name, row.value);
  db.close();
}

test('looksLikeProfile 认 Network/Cookies（Edge 的 Profile 1 就是这种布局）', () => {
  const dir = tempDir();
  assert.equal(looksLikeProfile(dir), false, '空目录不算');
  mkdirSync(join(dir, 'Network'), { recursive: true });
  writeFileSync(join(dir, 'Network', 'Cookies'), '');
  assert.equal(looksLikeProfile(dir), true, '只有 Network/Cookies 也算 profile');
});

test('looksLikeProfile 认 Local State 与 Cookies 与 Partitions', () => {
  for (const layout of ['Local State', 'Cookies', 'Partitions']) {
    const dir = tempDir();
    if (layout === 'Partitions') mkdirSync(join(dir, layout), { recursive: true });
    else writeFileSync(join(dir, layout), '');
    assert.equal(looksLikeProfile(dir), true, `${layout} 应算 profile`);
  }
});

test('cookieDatabases 列出根与 Partitions 下的库', () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'Network'), { recursive: true });
  writeFileSync(join(dir, 'Network', 'Cookies'), '');
  mkdirSync(join(dir, 'Partitions', 'p1', 'Network'), { recursive: true });
  writeFileSync(join(dir, 'Partitions', 'p1', 'Network', 'Cookies'), '');
  const files = cookieDatabases(dir);
  assert.equal(files.length, 2);
  assert.ok(files.some((file) => file.includes('Partitions')));
});

test('readCookiesFromProfile 从明文库读出 wps_sid 与 uid', () => {
  const dir = tempDir();
  makeCookieDb(join(dir, 'Network', 'Cookies'), [
    { host: '.lingxi.wps.cn', name: 'wps_sid', value: 'V02SID123' },
    { host: '.lingxi.wps.cn', name: 'uid', value: '42' },
    { host: '.example.com', name: 'unrelated', value: 'x' },
  ]);
  const result = readCookiesFromProfile(dir);
  assert.equal(result.cookie, 'wps_sid=V02SID123; uid=42');
  assert.equal(result.busy, undefined);
});

test('readCookiesFromProfile 只认 WPS 相关域名的 cookie', () => {
  const dir = tempDir();
  makeCookieDb(join(dir, 'Network', 'Cookies'), [
    { host: '.example.com', name: 'wps_sid', value: 'not-ours' },
  ]);
  assert.equal(readCookiesFromProfile(dir).cookie, undefined, '别的域名的同名 cookie 不算');
});

test('readCookiesFromProfile 接受 kdocs 与 wps 域名', () => {
  for (const host of ['.lingxi.kdocs.cn', '.wps.cn', '.account.wps.cn']) {
    const dir = tempDir();
    makeCookieDb(join(dir, 'Network', 'Cookies'), [{ host, name: 'wps_sid', value: 'SID' }]);
    assert.equal(readCookiesFromProfile(dir).cookie, 'wps_sid=SID', `${host} 应被接受`);
  }
});

test('readCookiesFromProfile 对空库/坏库返回空对象而不是抛', () => {
  const empty = tempDir();
  assert.deepEqual(readCookiesFromProfile(empty), {}, '不是 profile 时直接返回空');
  const broken = tempDir();
  mkdirSync(join(broken, 'Network'), { recursive: true });
  writeFileSync(join(broken, 'Network', 'Cookies'), '这不是 SQLite');
  assert.doesNotThrow(() => readCookiesFromProfile(broken));
  assert.equal(readCookiesFromProfile(broken).cookie, undefined);
});

test('readDesktopCookies：显式目录优先，且返回结构带 busy 字段', async () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'Network'), { recursive: true });
  makeCookieDb(join(dir, 'Network', 'Cookies'), [
    { host: '.lingxi.wps.cn', name: 'wps_sid', value: 'DESKTOP' },
  ]);
  const result = await readDesktopCookies(dir);
  assert.equal(result.credential?.cookie, 'wps_sid=DESKTOP');
  assert.equal(result.credential?.source, 'desktop');
  assert.equal(result.busy, false);
});

test('readDesktopCookies：没有目录时不抛，只报没拿到', async () => {
  const result = await readDesktopCookies(join(tempDir(), 'nope'));
  assert.equal(result.credential, undefined);
  assert.equal(result.busy, false);
});

test('desktopDataDirs 把 kdesk 与 WPS 灵犀 都作为候选', () => {
  const dirs = desktopDataDirs();
  assert.ok(
    dirs.some((dir) => /kdesk/i.test(dir)),
    `应包含 kdesk（本机真实目录名），实际：${dirs.join(', ')}`,
  );
  assert.ok(dirs.some((dir) => dir.includes('WPS 灵犀')), '应包含产品名目录');
  // 显式 override 时只返回那一个。
  assert.deepEqual(desktopDataDirs('C:/custom'), ['C:/custom']);
});

test('findBrowser 在 Windows 上能找到 Edge 或显式 override', () => {
  const found = findBrowser();
  if (process.platform !== 'win32') {
    assert.equal(found, undefined, '非 Windows 不该瞎猜路径');
    return;
  }
  // 找不到也不算失败（CI 里可能没装浏览器），但找到就必须是文件路径。
  if (found !== undefined) assert.match(found, /\.exe$/i);
});
