/**
 * 冒烟探测：宿主起来没有、插件的两条路由通不通。
 *
 * 用法：`node scripts/probe.mjs [port]`
 * 说明：只读探测，不触发任何写操作（签到/领取）。`/action` 那条只发 `refresh`。
 */

const port = process.argv[2] ?? '61240';
const base = `http://127.0.0.1:${port}`;

async function probe(path, init) {
  try {
    const response = await fetch(`${base}${path}`, init);
    const text = await response.text();
    return { path, status: response.status, body: text.slice(0, 600) };
  } catch (error) {
    return { path, status: 0, body: `ERROR ${error instanceof Error ? error.message : String(error)}` };
  }
}

const results = [];
results.push(await probe('/plugins/dsh-connect-lingxi/status'));
results.push(await probe('/plugins/dsh-connect-lingxi/action?action=refresh', { method: 'POST', body: '{}' }));
results.push(await probe('/plugins/dsh-connect-lingxi/action?action=nope', { method: 'POST', body: '{}' }));
results.push(await probe(`/plugins/dsh-connect-lingxi/client.js`));

for (const result of results) {
  console.log(`\n=== ${result.path} → ${result.status}`);
  console.log(result.body);
}
