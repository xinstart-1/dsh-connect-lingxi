/**
 * 确认 npm registry 上真的有这个版本（带重试，绕 CDN 缓存）。
 *
 * 为什么需要重试：`registry.npmjs.org/<pkg>` 的整包文档走 Cloudflare，
 * 刚发布后短时间内可能返回旧内容 —— 只看它会误判成「发布失败」。
 * 单版本端点 `/<pkg>/<version>` 才是准确的。
 *
 * 用法：`node scripts/verify-published.mjs [version]`
 */

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const want = process.argv[2] ?? pkg.version;
const base = 'https://registry.npmjs.org';
const attempts = 5;

async function get(url) {
  const response = await fetch(url, {
    headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

let single;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  single = await get(`${base}/${pkg.name}/${want}`);
  if (single.status === 200) break;
  // 刚发布时单版本端点也可能短暂 404，等几秒再试。
  if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 3000));
}

console.log(`包名：${pkg.name}    目标版本：${want}\n`);

if (single.status === 200 && single.body !== undefined) {
  console.log(`✓ ${want} 已在 registry 上`);
  console.log(`  tarball ：${single.body.dist?.tarball ?? '(无)'}`);
  console.log(`  shasum  ：${single.body.dist?.shasum ?? '(无)'}`);
  console.log(`  unpacked：${String(single.body.dist?.unpackedSize ?? '?')} 字节`);
  const files = Object.keys(single.body.dist?.fileCount !== undefined ? {} : {});
  void files;

  const all = await get(`${base}/${pkg.name}`);
  if (all.status === 200 && all.body !== undefined) {
    console.log(`\n全部版本：${Object.keys(all.body.versions ?? {}).join(', ')}`);
    console.log(`dist-tags：${JSON.stringify(all.body['dist-tags'] ?? {})}`);
    const isLatest = all.body['dist-tags']?.latest === want;
    console.log(isLatest ? `✓ latest 指向 ${want}` : `! latest 不是 ${want}`);
  }
} else {
  console.error(`✗ ${want} 不在 registry 上（HTTP ${single.status}）`);
  process.exitCode = 1;
}
