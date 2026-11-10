/**
 * 插件自己的登录态仓库（支持多账号账号池）。
 *
 * 为什么不用 DSH 的 `ctx.credentials`：那条路要求把 cookie 存进一个**记录格式**
 * （`{ kind, payload }`），而灵犀的登录态是一串 `wps_sid=...; uid=...` 的 cookie，
 * 它既不是 API key 也不是授权 grant，塞进任何一类都是在骗那个 seam。更要紧的是
 * 存哪儿：`ctx.credentials` 由宿主实现，宿主换版本/换 profile 时它的落盘位置是
 * 宿主的事，不是本插件能保证的。
 *
 * 所以照 `dsh-connect-workbuddy` 的做法自建一个目录，并采用同样的**一个账号一个
 * 文件**布局（workbuddy 的 `workbuddy-vault/<region>/<accountId>.json`）：
 *
 * ```
 * $DSH_HOME/lingxi-vault/accounts/<accountId>.json   每个账号一份
 * $DSH_HOME/lingxi-vault/selected.json               用户显式选中的账号 id
 * $DSH_HOME/lingxi-vault/credential.json             旧版单账号文件，只读作迁移源
 * ```
 *
 * 关键性质（这正是「重载 / 更新插件不丢登录态」的原因）：
 * - 位置在 **`$DSH_HOME` 根下**，不属于任何插件包目录，`npm uninstall` / 升级
 *   重装都不碰它；
 * - 写盘走「临时文件 + rename」，读到半份 JSON 不会被当成有效登录态；
 * - 权限 0o600，Windows 上再尽力收紧一次 ACL（失败不阻塞——为了 ACL 失败而
 *   拒绝保存登录态，等于把安全问题变成可用性事故）。
 *
 * **一个账号一个文件**不只是为了整齐：两个账号轮流登录时，写成同一个文件会互相
 * 覆盖，账号池就永远只有一个成员。分开存还让「删掉一个账号」不会动到别的账号。
 *
 * **cookie 绝不进浏览器半边**：这些文件只被宿主读，`/status` 只回脱敏字段。
 *
 * @module dsh-connect-lingxi/credentials/vault
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { normalizeUserCookie } from '../protocol/headers.ts';

/** 仓库目录名（`$DSH_HOME` 下，与 `workbuddy-vault` 同级）。 */
export const VAULT_DIRNAME = 'lingxi-vault';

/** 旧版单账号文件名。 */
const LEGACY_FILENAME = 'credential.json';

/** 账号池目录名。 */
const ACCOUNTS_DIRNAME = 'accounts';

/** 选中标记文件名。 */
const SELECTED_FILENAME = 'selected.json';

/** 当前磁盘格式版本。 */
const VAULT_VERSION = 2;

/** 旧版单账号格式版本，仍读（升级插件后旧文件还在，读不到等于把人踢下线）。 */
const LEGACY_VERSION = 1;

/** 登录来源。 */
export type CredentialSource = 'manual' | 'client' | 'browser' | 'login';

/** 一份持久化的登录态。 */
export interface StoredCredential {
  /**
   * 账号稳定 id。
   *
   * 由 cookie 里的 `uid` 派生；没有 `uid` 时用 cookie 的哈希。**不能用序号**：
   * 删掉中间一个账号，后面所有账号的序号都会变，用户「当前选用」的那份就指向了
   * 别人 —— 那是最难查的一类 bug。
   */
  accountId: string;
  /** 可直接用于请求的 cookie 串（含 `wps_sid`）。 */
  cookie: string;
  /** 登录来源；只作诊断，不影响用法。 */
  source: CredentialSource;
  /** 写入时刻（epoch ms）。 */
  savedAtMs: number;
  /** 账号名（能拿到时才有）。 */
  name?: string;
}

/** 磁盘上的账号文档。 */
interface AccountDocument {
  version: number;
  accountId: string;
  cookie: string;
  source: string;
  savedAtMs: number;
  name?: string;
}

/** 允许的来源值；其余一律当成 `manual`（旧文件/手改文件不该让读端抛）。 */
const SOURCES: readonly CredentialSource[] = ['manual', 'client', 'browser', 'login'];

/**
 * 解析 DSH home：`$DSH_HOME` 优先，否则 `~/.dsh`。
 * @param env - 环境变量（测试注入）。
 * @returns 绝对路径。
 */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME;
  return typeof configured === 'string' && configured.trim() !== ''
    ? configured.trim()
    : join(homedir(), '.dsh');
}

/** 仓库根目录。 */
function vaultRoot(env: NodeJS.ProcessEnv): string {
  return join(dshHome(env), VAULT_DIRNAME);
}

/** 账号池目录。 */
function accountsDir(env: NodeJS.ProcessEnv): string {
  return join(vaultRoot(env), ACCOUNTS_DIRNAME);
}

/** 旧版单账号文件路径（只读作迁移源）。 */
export function legacyVaultPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(vaultRoot(env), LEGACY_FILENAME);
}

/** 一个账号的文件路径。 */
function accountPath(accountId: string, env: NodeJS.ProcessEnv): string {
  // 只允许安全字符：accountId 是我们自己派生的，但仍然不把它直接拼进路径 ——
  // 万一哪天有人从设置里传进来一个带 `../` 的 id，就能写到目录外。
  const safe = accountId.replace(/[^A-Za-z0-9_-]/g, '_');
  return join(accountsDir(env), `${safe}.json`);
}

/**
 * 从 cookie 派生稳定的账号 id。
 *
 * 优先用 `uid`（灵犀每个账号的稳定数字 id）；没有时退回 cookie 的哈希。
 * 两者都对同样的输入给同样的输出，所以同一个账号重复登录不会变成两个成员。
 * @param cookie - 归一后的 cookie。
 * @returns 账号 id。
 */
export function accountIdOf(cookie: string): string {
  const match = /(?:^|;\s*)uid=([^;]+)/.exec(cookie);
  const uid = match?.[1]?.trim();
  if (uid !== undefined && uid !== '') return `uid-${uid.replace(/[^A-Za-z0-9]/g, '')}`;
  return `h-${createHash('sha256').update(cookie).digest('hex').slice(0, 16)}`;
}

/**
 * 归一化任意读到的值；不合法就返回 `undefined`（= 没有登录态）。
 *
 * 只接受「有非空 cookie」的文档：空 cookie 当成没登录，而不是当成一份坏数据 ——
 * 否则调用方会拿着空串去发请求，得到 401 后再去猜是不是账号过期。
 * @param raw - 解析后的 JSON（任意形状）。
 * @returns 登录态，或 `undefined`。
 */
export function normalizeCredential(raw: unknown): StoredCredential | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const version = record.version;
  if (version !== VAULT_VERSION && version !== LEGACY_VERSION) return undefined;
  const cookie = normalizeUserCookie(
    typeof record.cookie === 'string' ? record.cookie : '',
  );
  if (cookie === '') return undefined;
  const source = SOURCES.find((value) => value === record.source) ?? 'manual';
  const savedAtMs = typeof record.savedAtMs === 'number' ? record.savedAtMs : 0;
  const name =
    typeof record.name === 'string' && record.name.trim() !== ''
      ? record.name.trim()
      : undefined;
  // 旧格式没有 accountId：现派生一个，迁移后与新格式等价。
  const declared =
    typeof record.accountId === 'string' ? record.accountId.trim() : '';
  return {
    accountId: declared !== '' ? declared : accountIdOf(cookie),
    cookie,
    source,
    savedAtMs,
    ...(name === undefined ? {} : { name }),
  };
}

/** 读一个 JSON 文件并归一；不存在/坏 JSON 都返回 undefined。 */
async function readDocument(path: string): Promise<StoredCredential | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return normalizeCredential(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * 列出账号池里的全部账号，最近保存的在前。
 *
 * 旧版单账号文件也并进来（作为迁移源）：用户升级插件后第一次读，账号池是空的，
 * 但旧文件里还有一份有效登录态 —— 不并进来等于把人踢下线。
 * @param env - 环境变量（测试注入）。
 * @returns 账号列表（同一 id 只留最新那份）。
 */
export async function listAccounts(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredCredential[]> {
  const byId = new Map<string, StoredCredential>();

  let names: string[] = [];
  try {
    names = await readdir(accountsDir(env));
  } catch {
    // 目录还不存在：正常（第一次登录之前）。
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const credential = await readDocument(join(accountsDir(env), name));
    if (credential === undefined) continue;
    const existing = byId.get(credential.accountId);
    if (existing === undefined || credential.savedAtMs > existing.savedAtMs) {
      byId.set(credential.accountId, credential);
    }
  }

  // 旧版单账号文件：只在账号池里还没有它时才加。
  const legacy = await readDocument(legacyVaultPath(env));
  if (legacy !== undefined && !byId.has(legacy.accountId)) {
    byId.set(legacy.accountId, legacy);
  }

  return [...byId.values()].sort((a, b) => b.savedAtMs - a.savedAtMs);
}

/**
 * 读用户显式选中的账号 id。
 * @param env - 环境变量（测试注入）。
 * @returns 账号 id，或 `undefined`（没有显式选择）。
 */
export async function readSelection(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(join(vaultRoot(env), SELECTED_FILENAME), 'utf8'),
    ) as { accountId?: unknown };
    const id = typeof parsed.accountId === 'string' ? parsed.accountId.trim() : '';
    return id === '' ? undefined : id;
  } catch {
    return undefined;
  }
}

/**
 * 持久化「当前选用哪个账号」。
 *
 * 与 `Credential.accountId` 分开存是刻意的：用户的**选择**是设置，账号的
 * **内容**是凭据。混在一个文件里，改选择就得重写凭据，多账号同时刷新时会互相覆盖。
 * @param accountId - 选中的账号 id；`undefined` 表示清除选择（回到默认）。
 * @param env - 环境变量（测试注入）。
 */
export async function selectAccount(
  accountId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = join(vaultRoot(env), SELECTED_FILENAME);
  if (accountId === undefined || accountId === '') {
    await rm(path, { force: true });
    return;
  }
  await mkdir(vaultRoot(env), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({ version: VAULT_VERSION, accountId }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await rename(temporary, path);
}

/**
 * 读「当前该用哪个账号」。
 *
 * 优先级：**显式选择 > 最近保存的那份**。
 *
 * 显式选择指向一个已经不存在的账号时**不做静默回退**到别的账号 —— 那会让 shim
 * 用一个用户没选过的账号发请求，而卡片上还标着另一个。这种情况返回 `undefined`，
 * 由调用方按「选择失效」处理（`selectionLost`）。
 * @param env - 环境变量（测试注入）。
 * @returns 当前账号，或 `undefined`。
 */
export async function readCredential(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredCredential | undefined> {
  const accounts = await listAccounts(env);
  if (accounts.length === 0) return undefined;
  const selected = await readSelection(env);
  if (selected === undefined) return accounts[0];
  return accounts.find((account) => account.accountId === selected);
}

/**
 * 读指定账号（不看当前选择）。
 * @param accountId - 账号 id。
 * @param env - 环境变量（测试注入）。
 * @returns 账号，或 `undefined`。
 */
export async function readAccount(
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredCredential | undefined> {
  return (await listAccounts(env)).find((account) => account.accountId === accountId);
}

/**
 * 保存选择指向的账号已不存在、但池里还有别的账号。
 *
 * 卡片用它说明「你保存的选择失效了」，而不是笼统地说「请重新登录」——
 * 后者会误导用户：他的凭据通常是好的，重新登录也修不好一个孤儿 id。
 * @param env - 环境变量（测试注入）。
 * @returns 是否是「选择失效但还有别的账号」。
 */
export async function selectionLost(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const selected = await readSelection(env);
  if (selected === undefined) return false;
  const accounts = await listAccounts(env);
  if (accounts.length === 0) return false;
  return !accounts.some((account) => account.accountId === selected);
}

/**
 * 尽力收紧目录 ACL（仅 Windows；失败只返回原因，不抛）。
 *
 * 为什么失败不阻塞：这是纵深防御，不是唯一的保护。为了一个 `icacls` 调用失败而
 * 拒绝保存登录态，会把安全措施变成「用户每次重载都要重新登录」的可用性事故。
 *
 * ## 只收紧到「仓库根」这一层就够，而且必须**先收紧再建子目录**
 *
 * 这本插件与 workbuddy 踩过同一个坑：`icacls /inheritance:r` 是把继承来的 ACE
 * 全部剥掉，再只留下显式授予的那几条。两个后果：
 *
 * - 对 `<DSH_HOME>` 本身做这件事会把**整个 home 树**里其它目录的权限也剥掉
 *   （workbuddy 的 issue #208：`attachments` 变得不可读，发图全失败）。
 *   所以绝不能碰 home，只碰 `<DSH_HOME>/lingxi-vault`。
 * - 顺序也重要：**先收紧根、再建 `accounts/`**，这样子目录会继承根上「只有当前
 *   用户可以访问」的 ACE。反过来（先建子目录、再收紧父目录并 `/T`）在某些
 *   Windows 版本上会把子目录已有的显式 ACE 留下、继承 ACE 剥掉，结果当前进程
 *   自己也写不进去 —— 实测表现就是 `EPERM`。
 * @param directory - 要收紧的目录（只应是仓库根，不是 home）。
 * @returns 是否成功（POSIX 上恒为 true：`mode` 已经表达了同样的意图）。
 */
async function hardenDirectory(directory: string): Promise<boolean> {
  if (process.platform !== 'win32') return true;
  // 绝不收紧 DSH home 本身或它的祖先：那会连带影响整个 home 树。
  const home = dshHome();
  const resolved = directory.replace(/[/\\]+$/, '');
  const resolvedHome = home.replace(/[/\\]+$/, '');
  if (
    resolved.toLowerCase() === resolvedHome.toLowerCase() ||
    resolvedHome.toLowerCase().startsWith(`${resolved.toLowerCase()}/`) ||
    resolvedHome.toLowerCase().startsWith(`${resolved.toLowerCase()}\\`)
  ) {
    return false;
  }
  try {
    const { execFile } = await import('node:child_process');
    const user = process.env.USERNAME ?? '';
    if (user === '') return false;
    await new Promise<void>((resolve, reject) => {
      // 授权串是 `${user}:(F)` + 独立的继承标记，**不是** `${user}:(OI)(CI)F`。
      //
      // 为什么：`(OI)(CI)` 是「对象继承 / 容器继承」，只对**子项**生效，
      // 目录自己拿不到任何权限。配合 `/inheritance:r` 把继承 ACE 全剥掉之后，
      // 这个目录的 ACL 就是空的 —— 连当前用户都进不去，`mkdir` 子目录会
      // `EPERM`，连测试清理都删不掉。实测踩过这个坑。
      // 所以必须显式给目录自己 `(F)`。
      execFile(
        'icacls',
        [directory, '/inheritance:r', '/grant:r', `${user}:(F)`, '/grant:r', `${user}:(OI)(CI)(IO)(F)`],
        { windowsHide: true },
        (error) => (error === null ? resolve() : reject(error)),
      );
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 把一个账号写进账号池（原子替换）。
 *
 * 同一个 cookie 重复登录写到同一个文件 —— 账号 id 由 cookie 派生，所以不会
 * 因为重复登录而多出一个成员。
 * @param credential - 要保存的登录态（`savedAtMs` 缺省用当前时刻）。
 * @param env - 环境变量（测试注入）。
 * @returns 实际写入的账号。
 */
export async function writeCredential(
  credential: Omit<StoredCredential, 'accountId' | 'savedAtMs'> & {
    accountId?: string;
    savedAtMs?: number;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredCredential> {
  const cookie = normalizeUserCookie(credential.cookie);
  if (cookie === '') throw new Error('拒绝保存空 cookie');
  const accountId = credential.accountId ?? accountIdOf(cookie);
  const document: AccountDocument = {
    version: VAULT_VERSION,
    accountId,
    cookie,
    source: credential.source,
    savedAtMs: credential.savedAtMs ?? Date.now(),
    ...(credential.name === undefined ? {} : { name: credential.name }),
  };
  const path = accountPath(accountId, env);
  // 顺序：建根 → 收紧根 → 建 accounts/ → 写文件 → rename。
  // 「收紧根」必须在「建 accounts/」之前，这样子目录继承到的是收紧后的 ACE；
  // 反过来会得到 EPERM（当前进程自己也写不进去），见 `hardenDirectory` 的说明。
  await mkdir(vaultRoot(env), { recursive: true, mode: 0o700 });
  await hardenDirectory(vaultRoot(env));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return normalizeCredential(document) as StoredCredential;
}

/**
 * 从账号池删掉一个账号（登出）。
 *
 * 只删这一个，别的账号原样保留 —— 这正是「一个账号一个文件」的用处。
 * 删掉的如果正是当前选择的那个，选择标记也一起清掉（否则会留下一个孤儿的
 * 选择，卡片上显示「选择失效」但池里其实还有别的账号）。
 * @param accountId - 要删的账号 id。
 * @param env - 环境变量（测试注入）。
 */
export async function removeAccount(
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await rm(accountPath(accountId, env), { force: true });
  if ((await readSelection(env)) === accountId) await selectAccount(undefined, env);
}

/**
 * 清空账号池（登出全部 / 迁移用）。
 *
 * `clearCredential` 只删当前选中的那个；这个函数删所有，包括旧版单账号文件。
 * @param env - 环境变量（测试注入）。
 */
export async function clearAll(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  for (const account of await listAccounts(env)) {
    await rm(accountPath(account.accountId, env), { force: true });
  }
  await rm(legacyVaultPath(env), { force: true });
  await selectAccount(undefined, env);
}

/**
 * 登出当前账号（只删插件保存的这一个）。
 *
 * 找不到当前账号时是 no-op：登出按钮点两下不该报错。
 * @param env - 环境变量（测试注入）。
 */
export async function clearCredential(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    const current = await readCredential(env);
    if (current === undefined) return;
    await removeAccount(current.accountId, env);
    // 旧版文件如果就是这一个，也一起删掉，否则下次读又被迁移回来。
    const legacy = await readDocument(legacyVaultPath(env));
    if (legacy?.accountId === current.accountId) {
      await rm(legacyVaultPath(env), { force: true });
    }
  } catch {
    // 删不掉也不该让登出失败：下次读到旧 cookie 顶多是「还登录着」。
  }
}
