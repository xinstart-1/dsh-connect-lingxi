/**
 * 极简 asar 读取器：只读不写，用于在开发机上查 DSH 内置包的文档与类型。
 *
 * 用法：
 *   node scripts/asar-read.mjs list <asar> <前缀>
 *   node scripts/asar-read.mjs cat <asar> <文件路径> [字节上限]
 */
import { createReadStream, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';

const [, , cmd, asarPath, arg, limitArg] = process.argv;

async function readHeader(handle) {
  const head = Buffer.alloc(16);
  await handle.read(head, 0, 16, 0);
  const payloadSize = head.readUInt32LE(4);
  const jsonSize = head.readUInt32LE(12);
  const buf = Buffer.alloc(jsonSize);
  await handle.read(buf, 0, jsonSize, 16);
  return { header: JSON.parse(buf.toString('utf8')), base: 8 + payloadSize };
}

function walk(node, prefix, out) {
  if (node === null || typeof node !== 'object') return;
  if (node.files !== undefined) {
    for (const [name, child] of Object.entries(node.files)) walk(child, `${prefix}/${name}`, out);
    return;
  }
  out.push({ path: prefix, size: node.size ?? 0, offset: node.offset });
}

const handle = await open(asarPath, 'r');
const { header, base } = await readHeader(handle);
const entries = [];
walk(header, '', entries);

if (cmd === 'list') {
  const needle = arg ?? '';
  for (const entry of entries) if (entry.path.includes(needle)) console.log(`${entry.size}\t${entry.path}`);
} else if (cmd === 'cat') {
  const target = entries.find((entry) => entry.path === arg);
  if (target === undefined) {
    console.error(`未找到：${arg}`);
    process.exit(1);
  }
  const limit = Number(limitArg ?? 0) || target.size;
  const size = Math.min(limit, target.size);
  const buf = Buffer.alloc(size);
  await handle.read(buf, 0, size, base + Number(target.offset));
  process.stdout.write(buf.toString('utf8'));
} else {
  console.error('用法：asar-read.mjs list|cat <asar> <参数>');
  process.exit(1);
}
await handle.close();
