/**
 * 登录态仓库（账号池）的单测。
 *
 * 要钉住的性质有三条，每一条都对应一类真实故障：
 *
 * 1. **跨重载存在**：登录态必须跨重载、跨插件更新活着（文件在 `$DSH_HOME` 下）。
 * 2. **一个账号一个文件**：两个账号轮流登录不能互相覆盖 —— 覆盖了账号池就永远
 *    只有一个成员。
 * 3. **删一个不动别的**：删账号 / 登出只碰目标那个。
 *
 * 还有一个「不做的事」被专门测了：**显式选择指向不存在的账号时不静默回退**到
 * 别的账号。回退会让 shim 用用户没选过的账号发请求。
 *
 * 全部用例跑在临时 `DSH_HOME` 里：这个模块写 `$DSH_HOME/lingxi-vault/`，
 * 跑测试绝不该碰到用户真实的那份（真实教训：`apply()` 的测试曾经冲掉过用户状态）。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  VAULT_DIRNAME,
  accountIdOf,
  clearAll,
  clearCredential,
  dshHome,
  legacyVaultPath,
  listAccounts,
  normalizeCredential,
  readAccount,
  readCredential,
  readSelection,
  removeAccount,
  selectAccount,
  selectionLost,
  writeCredential,
} from '../src/credentials/vault.ts';

/** 每个用例一个临时 DSH_HOME。 */
const dirs: string[] = [];

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lingxi-vault-'));
  dirs.push(dir);
  return { ...process.env, DSH_HOME: dir };
}

/** 账号池目录（测试里要直接看文件）。 */
function accountsDirOf(env: NodeJS.ProcessEnv): string {
  return join(env.DSH_HOME as string, VAULT_DIRNAME, 'accounts');
}

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

test('仓库位置在 $DSH_HOME 根下，不属于插件包目录', () => {
  // 这一条就是「更新插件不丢登录态」的根据：文件不在 node_modules 里。
  assert.equal(dshHome({ DSH_HOME: 'C:/x/dsh' } as NodeJS.ProcessEnv), 'C:/x/dsh');
  assert.ok(
    legacyVaultPath({ DSH_HOME: 'C:/x/dsh' } as NodeJS.ProcessEnv).includes(VAULT_DIRNAME),
  );
});

test('DSH_HOME 未设或为空时回落到 ~/.dsh', () => {
  const fallback = dshHome({} as NodeJS.ProcessEnv);
  assert.ok(fallback.endsWith('.dsh'), `应回落到 ~/.dsh，实际 ${fallback}`);
  assert.equal(dshHome({ DSH_HOME: '   ' } as NodeJS.ProcessEnv), fallback);
});

test('账号 id 由 cookie 派生：同一个账号重复登录不会变成两个成员', () => {
  const a = 'wps_sid=abc; uid=42';
  const b = 'uid=42; wps_sid=zzz';
  // uid 相同就是同一个账号，哪怕 sid 变了（重新登录会换 sid）。
  assert.equal(accountIdOf(a), accountIdOf(b));
  assert.equal(accountIdOf(a), 'uid-42');

  // 没有 uid 时退回 cookie 哈希：同样的 cookie 得同样的 id。
  const noUid = 'wps_sid=abc';
  assert.equal(accountIdOf(noUid), accountIdOf(noUid));
  assert.ok(accountIdOf(noUid).startsWith('h-'));
});

test('写进去能读回来（模拟「重载插件」：重新读盘）', async () => {
  const env = await tempEnv();
  await writeCredential({ cookie: 'wps_sid=abc123; uid=42', source: 'login' }, env);

  const restored = await readCredential(env);
  assert.equal(restored?.cookie, 'wps_sid=abc123; uid=42');
  assert.equal(restored?.source, 'login');
  assert.equal(restored?.accountId, 'uid-42');
  assert.ok((restored?.savedAtMs ?? 0) > 0);
});

test('两个账号各存一份，互不覆盖', async () => {
  const env = await tempEnv();
  await writeCredential({ cookie: 'wps_sid=a; uid=1', source: 'login' }, env);
  await writeCredential({ cookie: 'wps_sid=b; uid=2', source: 'login' }, env);

  const accounts = await listAccounts(env);
  assert.equal(accounts.length, 2, '两个账号应当都在池里');
  assert.deepEqual(
    accounts.map((a) => a.accountId).sort(),
    ['uid-1', 'uid-2'],
  );
  // 一个账号一个文件。
  const files = (await readdir(accountsDirOf(env))).filter((n) => n.endsWith('.json'));
  assert.equal(files.length, 2);
});

test('同一个账号再登录只更新那一份，不新增成员', async () => {
  const env = await tempEnv();
  await writeCredential({ cookie: 'wps_sid=old; uid=7', source: 'login' }, env);
  await writeCredential({ cookie: 'wps_sid=new; uid=7', source: 'browser' }, env);

  const accounts = await listAccounts(env);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.cookie, 'wps_sid=new; uid=7');
  assert.equal(accounts[0]?.source, 'browser');
});

test('没选择时用最近保存的；显式选择覆盖它', async () => {
  const env = await tempEnv();
  await writeCredential(
    { cookie: 'wps_sid=a; uid=1', source: 'login', savedAtMs: 1000 },
    env,
  );
  await writeCredential(
    { cookie: 'wps_sid=b; uid=2', source: 'login', savedAtMs: 2000 },
    env,
  );

  // 没选择：最近保存的那份（uid=2）。
  assert.equal((await readCredential(env))?.accountId, 'uid-2');

  await selectAccount('uid-1', env);
  assert.equal((await readCredential(env))?.accountId, 'uid-1');
  assert.equal(await readSelection(env), 'uid-1');

  await selectAccount(undefined, env);
  assert.equal((await readCredential(env))?.accountId, 'uid-2', '清除选择后回到默认');
});

test('选择指向不存在的账号时不静默回退（那会让 shim 用别的账号）', async () => {
  const env = await tempEnv();
  await writeCredential({ cookie: 'wps_sid=a; uid=1', source: 'login' }, env);
  await selectAccount('uid-999', env);

  assert.equal(await readCredential(env), undefined, '不能回退到 uid-1');
  assert.equal(await selectionLost(env), true, '卡片要能说明「选择失效」');
});

test('selectionLost：没有选择 / 池是空的 / 选择有效 都不算失效', async () => {
  const env = await tempEnv();
  // 池空 + 无选择。
  assert.equal(await selectionLost(env), false);
  await writeCredential({ cookie: 'wps_sid=a; uid=1', source: 'login' }, env);
  assert.equal(await selectionLost(env), false, '没有显式选择就不算失效');
  await selectAccount('uid-1', env);
  assert.equal(await selectionLost(env), false, '选择有效');
});

test('删一个账号不动别的', async () => {
  const env = await tempEnv();
  await writeCredential({ cookie: 'wps_sid=a; uid=1', source: 'login' }, env);
  await writeCredential({ cookie: 'wps_sid=b; uid=2', source: 'login' }, env);

  await removeAccount('uid-1', env);
  const accounts = await listAccounts(env);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.accountId, 'uid-2');
});

test('删掉当前选中的账号时，选择标记也一起清掉（不留孤儿 id）', async () => {
  const env = await tempEnv();
  await writeCredential({ cookie: 'wps_sid=a; uid=1', source: 'login' }, env);
  await writeCredential({ cookie: 'wps_sid=b; uid=2', source: 'login' }, env);
  await selectAccount('uid-1', env);

  await removeAccount('uid-1', env);
  assert.equal(await readSelection(env), undefined, '选择不能指向已删的账号');
  assert.equal(await selectionLost(env), false, '清除后就不该报「失效」');
  // 剩下的那个成为当前。
  assert.equal((await readCredential(env))?.accountId, 'uid-2');
});

test('登出只删当前那一个；重复登出不抛', async () => {
  const env = await tempEnv();
  await writeCredential({ cookie: 'wps_sid=a; uid=1', source: 'login' }, env);
  await writeCredential({ cookie: 'wps_sid=b; uid=2', source: 'login' }, env);

  await clearCredential(env);
  const accounts = await listAccounts(env);
  assert.equal(accounts.length, 1, '只该删掉当前那个');
  assert.equal(accounts[0]?.accountId, 'uid-1', '当前是最近保存的那份（uid=1 更新）');

  // 再登出一次（此时还有 uid-2 是当前）。
  await clearCredential(env);
  assert.equal((await listAccounts(env)).length, 0);
  // 池空后再登出：no-op，不抛。
  await assert.doesNotReject(() => clearCredential(env));
});

test('clearAll 清空整个池（含旧版单账号文件）', async () => {
  const env = await tempEnv();
  await writeCredential({ cookie: 'wps_sid=a; uid=1', source: 'login' }, env);
  await writeCredential({ cookie: 'wps_sid=b; uid=2', source: 'login' }, env);
  // 手造一个旧版文件。
  await mkdir(join(env.DSH_HOME as string, VAULT_DIRNAME), { recursive: true });
  await writeFile(
    legacyVaultPath(env),
    JSON.stringify({ version: 1, cookie: 'wps_sid=legacy; uid=3', source: 'login' }),
    'utf8',
  );
  assert.equal((await listAccounts(env)).length, 3, '旧版文件也算一个账号');

  await clearAll(env);
  assert.equal((await listAccounts(env)).length, 0);
});

test('旧版单账号文件被读成账号池成员（升级插件不把用户踢下线）', async () => {
  const env = await tempEnv();
  await mkdir(join(env.DSH_HOME as string, VAULT_DIRNAME), { recursive: true });
  await writeFile(
    legacyVaultPath(env),
    JSON.stringify({
      version: 1,
      cookie: 'wps_sid=legacy; uid=3',
      source: 'login',
      savedAtMs: 5000,
    }),
    'utf8',
  );

  const accounts = await listAccounts(env);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.accountId, 'uid-3');
  // 没有 accountId 字段的旧文档要现派生一个，而不是丢弃。
  assert.equal((await readCredential(env))?.cookie, 'wps_sid=legacy; uid=3');
});

test('坏 JSON / 版本不符 / 空 cookie 都当成不存在', () => {
  for (const raw of [
    null,
    [],
    'not an object',
    { version: 99, cookie: 'wps_sid=abc' },
    { version: 2, cookie: '' },
    { version: 2, cookie: '   ' },
    { version: 2 },
  ]) {
    assert.equal(normalizeCredential(raw), undefined, `不该被当成登录态：${JSON.stringify(raw)}`);
  }
});

test('未知 source 回落到 manual，不让手改的文件把读端搞崩', () => {
  assert.equal(
    normalizeCredential({ version: 2, cookie: 'wps_sid=a; uid=1', source: 'hacker' })?.source,
    'manual',
  );
});

test('空 cookie 拒绝写入', async () => {
  const env = await tempEnv();
  await assert.rejects(() => writeCredential({ cookie: '   ', source: 'login' }, env), /空 cookie/);
});

test('写入是原子的：没有残留 .tmp，权限 0600', async () => {
  const env = await tempEnv();
  await writeCredential({ cookie: 'wps_sid=abc; uid=1', source: 'login' }, env);
  const files = await readdir(accountsDirOf(env));
  assert.equal(files.some((name) => name.endsWith('.tmp')), false, '临时文件不该残留');
  const path = join(accountsDirOf(env), files[0] as string);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600, 'cookie 文件只该给当前用户读');
  }
  assert.doesNotThrow(() => JSON.parse(readFileSyncSafe(path)));
});

/** 同步读一个文件（只为让上面的断言读起来短一点）。 */
function readFileSyncSafe(path: string): string {
  // 用异步 API 的结果拼不出来，这里用 require 的同步版本。
  return globalThis.process.getBuiltinModule('node:fs').readFileSync(path, 'utf8') as string;
}

test('readAccount 按 id 读，不看选择', async () => {
  const env = await tempEnv();
  await writeCredential({ cookie: 'wps_sid=a; uid=1', source: 'login', savedAtMs: 1000 }, env);
  await writeCredential({ cookie: 'wps_sid=b; uid=2', source: 'login', savedAtMs: 2000 }, env);
  await selectAccount('uid-2', env);

  assert.equal((await readAccount('uid-1', env))?.cookie, 'wps_sid=a; uid=1');
  assert.equal((await readAccount('nope', env)), undefined);
});

test('不同 DSH_HOME 之间互不影响（测试隔离的根据）', async () => {
  const first = await tempEnv();
  const second = await tempEnv();
  await writeCredential({ cookie: 'wps_sid=first; uid=1', source: 'login' }, first);
  assert.equal(await readCredential(second), undefined);
  assert.equal((await readCredential(first))?.cookie, 'wps_sid=first; uid=1');
});

test('账号 id 里的危险字符不会写到目录外', async () => {
  const env = await tempEnv();
  await writeCredential(
    { cookie: 'wps_sid=x; uid=1', source: 'login', accountId: '../../evil' },
    env,
  );
  // 文件必须落在 accounts/ 里面。
  const files = await readdir(accountsDirOf(env));
  assert.equal(files.length, 1);
  assert.equal(files[0]?.includes('..'), false);
});
