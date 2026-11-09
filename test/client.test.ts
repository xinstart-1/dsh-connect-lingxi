/**
 * 浏览器半边的契约测试。
 *
 * `lib/client.js` 是**手写的经典脚本**、从不进打包器（进了会引入第二份 React，
 * hooks 立刻炸）。没有打包器就没人为它做静态检查，所以这里把最要紧的几条钉死：
 * 不能有模块语法、两个字典必须同键、`t()` 引用的键必须存在、bundle id 必须是包名。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/client/bundle.js', import.meta.url), 'utf8');
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string };

/** 抓一张字典的键。 */
function dictKeys(name: string): Set<string> {
  const start = source.indexOf(`var ${name} = {`);
  assert.notEqual(start, -1, `找不到字典 ${name}`);
  const end = source.indexOf('\n  };', start);
  assert.notEqual(end, -1, `找不到字典 ${name} 的结尾`);
  const keys = new Set<string>();
  for (const match of source.slice(start, end).matchAll(/^\s{4}([A-Za-z_]\w*):/gm)) {
    keys.add(match[1]);
  }
  return keys;
}

test('客户端 bundle 能被引擎解析（没有语法错误）', () => {
  assert.doesNotThrow(() => {
    // 只解析不执行：`new Function` 抛错就是语法错。
    new Function(source);
  }, 'bundle.js 有语法错误');
});

test('客户端 bundle 里没有 import / export（必须是经典脚本）', () => {
  const offenders: string[] = [];
  source.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (/^(import|export)\s/.test(trimmed)) offenders.push(`${String(index + 1)}: ${trimmed}`);
  });
  assert.deepEqual(offenders, [], '出现模块语法会让它加载即失败');
});

test('客户端 bundle 用 __ModuleLoader__.load 注册，且 id 是包名', () => {
  assert.match(source, /__ModuleLoader__\.load\(/, '缺少注册调用');
  assert.ok(source.includes(`'${pkg.name}'`), `没有出现包名 ${pkg.name}`);
  assert.match(source, /var BUNDLE_NAME = '[^']+';/, '缺少 BUNDLE_NAME');
  assert.ok(
    source.includes(`var BUNDLE_NAME = '${pkg.name}'`),
    'BUNDLE_NAME 必须等于包名',
  );
});

test('zh 与 en 字典键一致（切语言不能露原始键名）', () => {
  const zh = dictKeys('zh');
  const en = dictKeys('en');
  assert.ok(zh.size > 20, `zh 键太少（${String(zh.size)}）`);
  assert.deepEqual(
    [...zh].filter((key) => !en.has(key)),
    [],
    '只有 zh 有的键',
  );
  assert.deepEqual(
    [...en].filter((key) => !zh.has(key)),
    [],
    '只有 en 有的键',
  );
});

test('所有 t() 引用的键都在字典里', () => {
  const zh = dictKeys('zh');
  const used = new Set<string>();
  for (const match of source.matchAll(/\bt\('([A-Za-z_]\w*)'/g)) used.add(match[1]);
  assert.ok(used.size > 20, `t() 引用太少（${String(used.size)}）`);
  assert.deepEqual(
    [...used].filter((key) => !zh.has(key)),
    [],
    '这些键被引用但不存在',
  );
});

test('登录相关文案齐全（未登录时界面要能说清楚怎么登录）', () => {
  const zh = dictKeys('zh');
  for (const key of ['loginNow', 'loginHint', 'signedOutHint', 'sourceBrowser', 'sourceClient']) {
    assert.ok(zh.has(key), `缺少文案键 ${key}`);
  }
});
