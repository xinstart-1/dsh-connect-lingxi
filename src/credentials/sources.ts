/**
 * 零粘贴登录：三种「用户什么都不用填」的取凭据路径。
 *
 * 为什么要有这一层：让用户从 DevTools 里复制 `wps_sid` 是**本插件自己的失败**，
 * 不是灵犀的限制。灵犀桌面端就是 Electron，cookie 存在本机；灵犀网页版用
 * Chromium，cookie 也存在本机。既然 Magpie 已经证明这两条路都能读通，这里就没有
 * 任何理由要求手粘。
 *
 * 三条路径，按「用户成本」从低到高：
 * 1. {@link readDesktopCookies} —— 本机灵犀客户端已登录，直接读它的 Chromium cookie 库
 *    （DPAPI 解 key + AES-256-GCM 解值）。零交互。
 * 2. {@link loginWithBrowser} —— 拉起一个**临时 profile** 的 Chromium（Chrome / Edge /
 *    Brave / 360 极速…），打开灵犀登录页，通过 CDP 轮询读 `wps_sid`。
 *    用户只在自己的浏览器里扫码/登录一次，插件从不接触密码。
 * 3. 手粘 cookie —— 只是最终兜底，不是主路径。
 *
 * 它还能**复用用户日常浏览器的现有登录态**（{@link readBrowserCookies}）：如果用户
 * 平时就在 Chrome / Edge 里用灵犀网页版，那登录态已经在那份 cookie 库里了，
 * 连打开浏览器都不用。这条最舒服，所以排在第一条试。
 *
 * @module dsh-connect-lingxi/credentials/sources
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 一次取到的登录态。 */
export interface LingxiCredential {
  /** 可直接用于请求的 cookie 串（至少含 `wps_sid`）。 */
  cookie: string;
  /** 来源，用于卡片显示与诊断。 */
  source: 'desktop' | 'browser' | 'browser-login' | 'manual';
  /** 账号名（`uid` cookie 或 profile 接口给的名字）；拿不到时不带。 */
  name?: string;
}

/** 灵犀客户端的进程名（用于判断它是否在跑；cookie 库被锁时也能给出一句有用的提示）。 */
const DESKTOP_PROCESS_NAMES = ['WPS 灵犀', 'WPS Lingxi', 'lingxi', 'kdesk'];

/**
 * 灵犀客户端可能的数据目录。
 *
 * 事实修正：客户端在国内装出来是 `%APPDATA%\\kdesk`（本机实测存在），
 * 而协议文档里写的 `WPS 灵犀` 是**产品名**不是目录名。两个都试，
 * 另外把「任何名字里带 lingxi / kdesk 的 Roaming 目录」也纳入候选，
 * 因为客户端换过名（`kdesk` → `kdesk_yyb` 就是这个痕迹）。
 */
export function desktopDataDirs(override?: string): string[] {
  const explicit = typeof override === 'string' ? override.trim() : '';
  if (explicit !== '') return [explicit];
  const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  const dirs: string[] = [];
  for (const name of [...DESKTOP_PROCESS_NAMES, 'kdesk_yyb']) {
    dirs.push(join(roaming, name));
  }
  // 兜底：扫 Roaming 下名字像灵犀的目录（换名/多版本时仍然能找到）。
  try {
    for (const name of readdirSync(roaming)) {
      if (!/lingxi|kdesk|wps/i.test(name)) continue;
      const dir = join(roaming, name);
      if (!dirs.includes(dir)) dirs.push(dir);
    }
  } catch {
    // 读不到 Roaming 就只用上面的固定候选。
  }
  return dirs;
}

/** 一个目录下的所有 Chromium cookie 库文件。 */
export function cookieDatabases(dir: string): string[] {
  const files: string[] = [];
  const add = (file: string): void => {
    try {
      if (statSync(file).isFile()) files.push(file);
    } catch {
      // 不存在就是不存在。
    }
  };
  add(join(dir, 'Network', 'Cookies'));
  add(join(dir, 'Cookies'));
  try {
    for (const name of readdirSync(join(dir, 'Partitions'))) {
      add(join(dir, 'Partitions', name, 'Network', 'Cookies'));
      add(join(dir, 'Partitions', name, 'Cookies'));
    }
  } catch {
    // 没有 Partitions 是常态（只有多账号/多会话才建）。
  }
  return files;
}

/**
 * 「像 Electron / Chromium profile」。
 *
 * 注意 `Network/Cookies` 这一条是必需的：Edge 的实际布局是
 * `User Data/Profile 1/Network/Cookies`，而 `Local State` 只在 `User Data` 根上。
 * 少了这条判断，`Profile 1` 会被当成「不是 profile」直接跳过 —— 这是本插件
 * 第一版真实踩到的坑（探测脚本报「没找到登录态」，其实只是没扫到库）。
 */
export function looksLikeProfile(dir: string): boolean {
  return (
    existsSync(join(dir, 'Local State')) ||
    existsSync(join(dir, 'Cookies')) ||
    existsSync(join(dir, 'Network', 'Cookies')) ||
    existsSync(join(dir, 'Partitions'))
  );
}

/**
 * 找这个 profile 用的 AES key。
 *
 * Chromium 把 `Local State` 放在**数据目录根**，所有 `Profile N` 共用同一个 key。
 * 所以取 key 时必须向上找，不能只看 profile 自己的目录：
 * `Profile 1` 里没有 `Local State`，但它的 cookie 就是用根上那个 key 加密的。
 * @param dir - profile 目录（可能是根，也可能是 `Profile N`）。
 * @returns AES key；找不到返回 `undefined`。
 */
function profileKey(dir: string): Buffer | undefined {
  for (const candidate of [dir, join(dir, '..')]) {
    const path = join(candidate, 'Local State');
    if (!existsSync(path)) continue;
    try {
      const state = JSON.parse(readFileSync(path, 'utf8')) as {
        os_crypt?: { encrypted_key?: unknown };
      };
      const encoded = state.os_crypt?.encrypted_key;
      if (typeof encoded !== 'string' || encoded === '') continue;
      const wrapped = Buffer.from(encoded, 'base64');
      if (wrapped.subarray(0, 5).toString() !== 'DPAPI') continue;
      return dpapiDecrypt(wrapped.subarray(5));
    } catch {
      // 换下一个候选（上一层）。
    }
  }
  return undefined;
}

/** 借 PowerShell 解一段 DPAPI(CurrentUser) 密文（不引入原生依赖）。 */
function dpapiDecrypt(cipher: Buffer): Buffer {
  if (process.platform !== 'win32') throw new Error('DPAPI 只在 Windows 上可用');
  const script =
    'Add-Type -AssemblyName System.Security; ' +
    '[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect(' +
    `[Convert]::FromBase64String('${cipher.toString('base64')}'), $null, 'CurrentUser'))`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });
  return Buffer.from(out.trim(), 'base64');
}

/**
 * 解一条 Chromium cookie 值。
 *
 * `v10` / `v11` 是 AES-256-GCM：`v10` + 12 字节 nonce + 密文 + 16 字节 tag；
 * 新版 Chrome（v20）在密文前多一段 host hash，这里一并处理 —— 解不开就返回
 * `undefined`，让上层去用别的路径，而不是抛一个看不懂的错。
 */
function decryptValue(encrypted: Buffer, key: Buffer | undefined): string | undefined {
  if (encrypted.length === 0) return undefined;
  const version = encrypted.subarray(0, 3).toString();
  if (version !== 'v10' && version !== 'v11' && version !== 'v20') {
    // 明文（macOS 上的旧布局）或无法识别：原样当字符串。
    return encrypted.toString('utf8');
  }
  if (key === undefined) return undefined;
  try {
    let payload = encrypted.subarray(3);
    // v20 的 32 字节 host hash 不参与解密，但要跳过。
    if (version === 'v20' && payload.length > 32) payload = payload.subarray(32);
    const nonce = payload.subarray(0, 12);
    const tag = payload.subarray(payload.length - 16);
    const body = payload.subarray(12, payload.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

/**
 * 把一份可能被浏览器独占锁着的文件复制出来。
 *
 * Windows 上 Chromium 用独占锁打开 `Cookies`，`copyFileSync` 直接 `EBUSY`。
 * 但**读**通常是允许的（共享读、独占写）：用 `readFileSync` 读进内存再写快照，
 * 避开 `CopyFile` 的锁语义。失败再退一步用文件流。
 * @param source - 原文件。
 * @param target - 目标路径。
 * @returns 是否复制成功。
 */
function copyLockedFile(source: string, target: string): boolean {
  try {
    writeFileSync(target, readFileSync(source));
    return true;
  } catch {
    // 退一步：分块读，尽量拿到能读的部分（SQLite 对截断的库会报错，但值得一试）。
    try {
      const fd = openSync(source, 'r');
      try {
        const chunks: Buffer[] = [];
        const buffer = Buffer.alloc(1 << 20);
        for (;;) {
          const read = readSync(fd, buffer, 0, buffer.length, null);
          if (read <= 0) break;
          chunks.push(Buffer.from(buffer.subarray(0, read)));
        }
        writeFileSync(target, Buffer.concat(chunks));
        return true;
      } finally {
        closeSync(fd);
      }
    } catch {
      return false;
    }
  }
}

/**
 * 从一份 cookie 库读出 `wps_sid`。
 *
 * 为什么先**复制到临时目录**再读：Chromium 在运行时用 WAL 模式，进程活着时
 * 直接 `open` 它的 `Cookies` 会得到 `unable to open database file`；某些 Edge
 * 版本甚至对库文件加独占锁（连读都 `EBUSY`）。复制快照能同时解决这两件事，
 * 而且不会锁住用户正在用的浏览器。
 *
 * 复制失败时**不静默返回 undefined**：调用方需要知道「是打不开」还是「没登录」，
 * 因为这两种情况给用户的建议完全不同（关掉浏览器 vs 去登录）。
 */
function readSidFromDatabase(
  file: string,
  key: Buffer | undefined,
): { cookie?: string; busy?: boolean } {
  let staging: string | undefined;
  let db: DatabaseSync | undefined;
  try {
    staging = join(tmpdir(), `dsh-lingxi-cookies-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`);
    mkdirSync(staging, { recursive: true });
    const copy = join(staging, 'Cookies');
    // 浏览器在跑时会独占锁住库；用「读进内存再写」而不是 CopyFile。
    if (!copyLockedFile(file, copy)) return { busy: true };
    // WAL 与 SHM 也要复制，否则快照可能缺少最新提交。
    for (const suffix of ['-wal', '-shm']) {
      const source = `${file}${suffix}`;
      if (existsSync(source)) copyLockedFile(source, `${copy}${suffix}`);
    }

    db = new DatabaseSync(copy, { readOnly: true });
    const rows = db
      .prepare(
        "SELECT name, encrypted_value, value, host_key FROM cookies WHERE name IN ('wps_sid','uid')",
      )
      .all() as Array<{
      name: string;
      encrypted_value?: Uint8Array;
      value?: string;
      host_key?: string;
    }>;
    let sid = '';
    let uid = '';
    for (const row of rows) {
      const host = String(row.host_key ?? '');
      // `wps_sid` 是 WPS 全站 cookie；灵犀登录会写到 lingxi / kdocs / wps 三个域之一。
      // 域名拿不到时也接受（有些库的 host_key 是空串）。
      const relevant = host === '' || /lingxi|kdocs|wps/i.test(host);
      if (!relevant) continue;
      const plain = typeof row.value === 'string' ? row.value.trim() : '';
      const value =
        plain !== ''
          ? plain
          : decryptValue(Buffer.from(row.encrypted_value ?? new Uint8Array()), key);
      if (value === undefined || value === '') continue;
      if (row.name === 'wps_sid' && sid === '') sid = value;
      if (row.name === 'uid' && uid === '') uid = value;
    }
    if (sid === '') return {};
    return { cookie: uid === '' ? `wps_sid=${sid}` : `wps_sid=${sid}; uid=${uid}` };
  } catch {
    return {};
  } finally {
    try {
      db?.close();
    } catch {
      // 关不掉也不影响。
    }
    if (staging !== undefined) {
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch {
        // 删不掉只留一份临时快照，下次探测会换名字。
      }
    }
  }
}

/**
 * 读一个 Chromium profile 目录里的灵犀登录态。
 * @param dir - profile 根目录（含 `Local State`，或 `Network/Cookies`）。
 * @returns 登录态；没有登录态时 `undefined`。库被锁住时 `busy: true`。
 */
export function readCookiesFromProfile(dir: string): { cookie?: string; busy?: boolean } {
  if (!looksLikeProfile(dir)) return {};
  const key = profileKey(dir);
  let busy = false;
  for (const file of cookieDatabases(dir)) {
    const result = readSidFromDatabase(file, key);
    if (result.cookie !== undefined) return { cookie: result.cookie };
    if (result.busy === true) busy = true;
  }
  return busy ? { busy: true } : {};
}

/** 一次探测的结果，比 `LingxiCredential | undefined` 多一个「为什么没拿到」。 */
export interface DiscoveryResult {
  /** 拿到了登录态。 */
  credential?: LingxiCredential;
  /** 找到了 profile，但库被运行中的浏览器独占锁住（关掉浏览器再试即可）。 */
  busy: boolean;
}

/**
 * 路径 1a：读**本机灵犀桌面客户端**的登录态。
 * @param override - 显式指定的数据目录。
 * @returns 登录态与「是否被锁」。
 */
export async function readDesktopCookies(override?: string): Promise<DiscoveryResult> {
  let busy = false;
  for (const dir of desktopDataDirs(override)) {
    const result = readCookiesFromProfile(dir);
    if (result.cookie !== undefined) return { credential: { cookie: result.cookie, source: 'desktop' }, busy };
    if (result.busy === true) busy = true;
  }
  return { busy };
}

/** 已知 Chromium 系浏览器的用户数据目录（相对 LOCALAPPDATA / APPDATA）。 */
function browserProfiles(): string[] {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  const candidates = [
    join(local, 'Google', 'Chrome', 'User Data'),
    join(local, 'Microsoft', 'Edge', 'User Data'),
    join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
    join(local, 'Chromium', 'User Data'),
    join(local, '360Chrome', 'Chrome', 'User Data'),
    join(local, '360ChromeX', 'Chrome', 'User Data'),
    join(roaming, '360se6', 'User Data'),
    join(local, 'Tencent', 'QQBrowser', 'User Data'),
  ];
  return candidates.filter((dir) => existsSync(dir));
}

/**
 * 一个浏览器数据目录下的所有 profile。
 *
 * 为什么要把根目录自己也当候选：Chromium 系的 cookie 库实际放在
 * `User Data/<Profile N>/Network/Cookies`，而 `Local State` 在 `User Data` 根上；
 * Edge 甚至可以不建 `Default`，只建 `Profile 1`。只扫 `Default` 会全盘错过。
 */
function profileDirs(root: string): string[] {
  const dirs: string[] = [];
  const consider = (dir: string): void => {
    if (looksLikeProfile(dir) && !dirs.includes(dir)) dirs.push(dir);
  };
  // 顺序有意义：先根（有些客户端就当 profile 用）、再 Default、再 Profile N。
  consider(root);
  consider(join(root, 'Default'));
  try {
    for (const name of readdirSync(root)) {
      // `Profile 1`、`Profile 2`…；也接受 `Guest Profile` 之外的任意 `<word> Profile`。
      if (/^(?:Profile|Person) \d+$/.test(name)) consider(join(root, name));
    }
  } catch {
    // 读不到就只用上面两个。
  }
  return dirs;
}

/**
 * 路径 1b：复用**用户日常浏览器**里已有的灵犀登录态。
 *
 * 这条比拉起浏览器更舒服：用户只要在 Chrome / Edge 里用过灵犀网页版，
 * 登录态就已经在那份 cookie 库里，插件直接读，零交互。
 *
 * @returns 登录态与「是否被锁」。
 */
export async function readBrowserCookies(): Promise<DiscoveryResult> {
  let busy = false;
  for (const root of browserProfiles()) {
    for (const dir of profileDirs(root)) {
      const result = readCookiesFromProfile(dir);
      if (result.cookie !== undefined) {
        return { credential: { cookie: result.cookie, source: 'browser' }, busy };
      }
      if (result.busy === true) busy = true;
    }
  }
  return { busy };
}

/** 找可用的 Chromium 系浏览器可执行文件。 */
export function findBrowser(): string | undefined {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  const programFiles = process.env.PROGRAMFILES ?? 'C:\\Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
  const candidates = [
    join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    join(local, '360ChromeX', 'Chrome', 'Application', '360ChromeX.exe'),
    join(local, '360Chrome', 'Chrome', 'Application', '360chrome.exe'),
  ];
  if (process.env.DSH_LINGXI_BROWSER !== undefined) {
    const explicit = process.env.DSH_LINGXI_BROWSER;
    if (existsSync(explicit)) return explicit;
  }
  return candidates.find((file) => existsSync(file));
}

/** 等一个文件出现。 */
async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/** 一个最小的 CDP 连接（只用到 send）。 */
interface CdpClient {
  send(method: string, params?: unknown): Promise<Record<string, unknown>>;
  close(): void;
}

/** 连 CDP 调试端口。 */
async function connectCdp(url: string): Promise<CdpClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
    let next = 1;
    socket.onopen = () => {
      resolve({
        send(method, params) {
          const id = next;
          next += 1;
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res as (v: never) => void, reject: rej });
            socket.send(JSON.stringify({ id, method, params: params ?? {} }));
          }) as Promise<Record<string, unknown>>;
        },
        close() {
          try {
            socket.close();
          } catch {
            // 已经关了。
          }
        },
      });
    };
    socket.onmessage = (event) => {
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      const waiter = message.id === undefined ? undefined : pending.get(message.id);
      if (waiter === undefined) return;
      pending.delete(message.id as number);
      if (message.error !== undefined) waiter.reject(new Error(message.error.message ?? 'CDP 错误'));
      else waiter.resolve(message.result as never);
    };
    socket.onerror = () => {
      reject(new Error('连不上浏览器的调试端口'));
    };
  });
}

/** 从一个调试端口读出当前所有窗口的 cookie。 */
async function cookiesOfPort(port: number): Promise<Array<{ name: string; value: string }>> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`).catch(() => undefined);
  if (response === undefined || !response.ok) return [];
  const targets: unknown = await response.json().catch(() => []);
  const list = Array.isArray(targets) ? targets : [];
  const page = list.find(
    (target): target is { type: string; webSocketDebuggerUrl: string } =>
      typeof target === 'object' &&
      target !== null &&
      (target as { type?: unknown }).type === 'page' &&
      typeof (target as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl === 'string',
  );
  if (page === undefined) return [];
  const client = await connectCdp(page.webSocketDebuggerUrl).catch(() => undefined);
  if (client === undefined) return [];
  try {
    await client.send('Network.enable');
    const result = await client.send('Network.getAllCookies');
    const cookies = result.cookies;
    if (!Array.isArray(cookies)) return [];
    return cookies
      .filter(
        (cookie): cookie is { name: string; value: string } =>
          typeof cookie === 'object' &&
          cookie !== null &&
          typeof (cookie as { name?: unknown }).name === 'string' &&
          typeof (cookie as { value?: unknown }).value === 'string',
      )
      .map((cookie) => ({ name: cookie.name, value: cookie.value }));
  } finally {
    client.close();
  }
}

/** 拉起临时 profile 的浏览器并等 `wps_sid`。 */
async function loginWithChromium(
  browser: string,
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<LingxiCredential> {
  const profile = join(tmpdir(), `dsh-lingxi-login-${String(Date.now())}`);
  const child: ChildProcess = spawn(
    browser,
    [
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      url,
    ],
    { stdio: 'ignore', detached: false },
  );

  try {
    const portFile = join(profile, 'DevToolsActivePort');
    if (!(await waitForFile(portFile, 20_000))) {
      throw new Error('浏览器没有打开调试端口（可能被安全软件拦了）');
    }
    const port = Number(readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
    if (!Number.isFinite(port) || port <= 0) throw new Error('浏览器调试端口无效');

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted === true) throw new Error('已取消');
      const cookies = await cookiesOfPort(port).catch(() => []);
      const sid = cookies.find((cookie) => cookie.name === 'wps_sid' && cookie.value.trim() !== '');
      if (sid !== undefined) {
        const uid = cookies.find((cookie) => cookie.name === 'uid')?.value ?? '';
        return {
          cookie: uid === '' ? `wps_sid=${sid.value.trim()}` : `wps_sid=${sid.value.trim()}; uid=${uid}`,
          source: 'browser-login',
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error('等待登录超时（请在打开的浏览器窗口里完成灵犀登录）');
  } finally {
    try {
      child.kill();
    } catch {
      // 已经退了。
    }
    // 稍等一下再删：浏览器进程可能还在写。
    setTimeout(() => {
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        // 删不掉只是留一份临时数据，不影响功能。
      }
    }, 2000);
  }
}

/**
 * 路径 2：拉起浏览器让用户登录一次，再读 cookie。
 *
 * **不碰密码**：用户在真实浏览器里自己完成登录，插件只在登录完成后读 cookie。
 * 用**临时 profile**：不污染用户日常浏览器，也不会读到别的站点 cookie。
 *
 * @param options.url - 登录页地址。
 * @param options.timeoutMs - 等待上限。
 * @param options.signal - 取消信号。
 * @returns 登录态。
 * @throws {Error} 没有 Chromium 浏览器、端口打不开、或等待超时。
 */
export async function loginWithBrowser(options: {
  url: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<LingxiCredential> {
  const browser = findBrowser();
  if (browser === undefined) {
    throw new Error(
      '没有找到 Chromium 内核浏览器（Chrome / Edge / Brave / 360 极速）。' +
        '装一个即可，或用 DSH_LINGXI_BROWSER 指向它的 exe。',
    );
  }
  return loginWithChromium(browser, options.url, options.timeoutMs ?? 5 * 60 * 1000, options.signal);
}

/**
 * 自动探测：按「用户成本」从低到高试一遍。
 *
 * @param options.desktopDir - 显式指定的客户端数据目录。
 * @param options.allowBrowser - 是否复用日常浏览器的登录态（默认允许）。
 * @returns 第一个成功的来源；全都没有时 `credential` 为空。
 */
export async function discoverCredential(options?: {
  desktopDir?: string;
  allowBrowser?: boolean;
}): Promise<DiscoveryResult> {
  const desktop = await readDesktopCookies(options?.desktopDir);
  if (desktop.credential !== undefined) return desktop;
  if (options?.allowBrowser !== false) {
    const browser = await readBrowserCookies();
    if (browser.credential !== undefined) return browser;
    return { busy: desktop.busy || browser.busy };
  }
  return { busy: desktop.busy };
}
