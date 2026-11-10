/**
 * 抓一次真实的 `/sessions/plans`，把每个模型的全部字段打成可核对的报告。
 *
 * 用途：**核对 `STATIC_CATALOG` 与上游是否一致**。上游加了模型、改了倍率、
 * 换了思考档位，跑这个脚本就能看见差异，而不是靠官网截图猜。
 *
 * 只读：只拉套餐目录，不建会话、不对话。
 *
 * 前置：插件已登录（`$DSH_HOME/lingxi-vault/credential.json` 存在）。
 *
 * ```bash
 * node scripts/capture-plans.mjs
 * ```
 *
 * @module dsh-connect-lingxi/scripts/capture-plans
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 两个基址都试（与客户端一致）。 */
const BASES = ['https://lingxi.wps.cn', 'https://kdocs.cn'];
const PLANS_PATH = '/api/aioffice/v1/sessions/plans';

/** 与 `src/constants.ts` 同源的设备指纹。 */
const DEVICE_ID = createHash('sha256').update('dsh-connect-lingxi-device').digest('hex');
const KSO = [
  'x-kso-app-name=win-lingxi-desktop',
  'x-kso-app-version=1.3.31',
  `x-kso-device-id=${DEVICE_ID}`,
];

/** 读插件仓库里的登录态。 */
function readCookie() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const path = join(home, 'lingxi-vault', 'credential.json');
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed.cookie === 'string' ? parsed.cookie : '';
  } catch {
    return '';
  }
}

const cookie = readCookie();
if (cookie === '') {
  console.error('仓库里没有登录态。先在插件卡片点「登录灵犀」，再跑这个脚本。');
  process.exit(2);
}

let saved = false;
for (const base of BASES) {
  let res;
  try {
    res = await fetch(`${base}${PLANS_PATH}`, {
      headers: {
        Cookie: `${cookie}; ${KSO.join('; ')}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: `${base}/`,
        Accept: 'application/json',
      },
    });
  } catch (error) {
    console.log(`${base} 请求失败：${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  if (!res.ok) {
    console.log(`${base} HTTP ${res.status}`);
    continue;
  }
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    console.log(`${base} 返回的不是 JSON：${text.slice(0, 200)}`);
    continue;
  }
  const data = payload?.data ?? {};
  const plans = Array.isArray(data.plans) ? data.plans : [];
  const models = Array.isArray(data.models) ? data.models : [];
  console.log(`\n${base}  HTTP ${res.status}  plans=${plans.length}  models=${models.length}\n`);

  const rows = [];
  for (const [kind, list] of [
    ['plan', plans],
    ['model', models],
  ]) {
    for (const entry of list) {
      const row = {
        kind,
        id: entry.key,
        name: entry.name,
        contextWindow: entry.max_context_tokens,
        maxTokens: entry.max_new_tokens,
        multiplier: String(entry.multiplier ?? '').replace(/[\uFF5E\u301C\u223C]/g, '~'),
        vision: entry.support_multimodal === true,
        reasoning: Array.isArray(entry.reasoning_efforts) && entry.reasoning_efforts.length > 0,
        badge: entry.tag || '',
        description: entry.desc || '',
      };
      rows.push(row);
      console.log(
        [
          kind.padEnd(5),
          String(row.id).padEnd(30),
          `ctx=${row.contextWindow}`,
          `out=${row.maxTokens}`,
          `mult=${row.multiplier || '(空)'}`,
          `vision=${row.vision}`,
          `reasoning=${row.reasoning}`,
          row.badge ? `badge=${row.badge}` : '',
          Array.isArray(entry.reasoning_efforts) ? `efforts=${JSON.stringify(entry.reasoning_efforts)}` : '',
        ]
          .filter(Boolean)
          .join('  '),
      );
    }
  }

  const outPath = join(process.cwd(), '.scratch', 'plans-normalized.json');
  try {
    writeFileSync(outPath, `${JSON.stringify(rows, null, 2)}\n`);
    console.log(`\n归一化结果已写入 ${outPath}`);
    saved = true;
  } catch {
    // 写不了就只打印，不影响核对。
  }
  break;
}

if (!saved) {
  console.error('\n两个基址都没拿到目录。可能是登录态过期了 —— 重新登录一次。');
  process.exit(1);
}
