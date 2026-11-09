/**
 * 对比探测：把本插件与两个「已经在跑」的同类插件的路由放在一起看。
 *
 * 目的是区分两种 404：
 * - 别人 200、我 404 → 我的路由没注册（插件代码没被加载）；
 * - 大家 404 → 这条路本身不该这么问。
 */

const port = process.argv[2] ?? '61240';
const base = `http://127.0.0.1:${port}`;

const cases = [
  ['minimax status', '/plugins/dsh-connect-minimaxcode/status', 'GET'],
  ['lingxi status', '/plugins/dsh-connect-lingxi/status', 'GET'],
  ['lingxi action(GET)', '/plugins/dsh-connect-lingxi/action?action=refresh', 'GET'],
  ['lingxi action(POST)', '/plugins/dsh-connect-lingxi/action?action=refresh', 'POST'],
  ['workbuddy client', '/plugins/dsh-connect-workbuddy/client.js', 'GET'],
  ['lingxi client', '/plugins/dsh-connect-lingxi/client.js', 'GET'],
  ['random', '/definitely-not-here', 'GET'],
];

for (const [label, path, method] of cases) {
  const init = method === 'POST' ? { method: 'POST', body: '{}' } : { method };
  let status = 0;
  let note = '';
  try {
    const response = await fetch(`${base}${path}`, init);
    status = response.status;
    const text = await response.text();
    note = text.replace(/\s+/g, ' ').slice(0, 160);
  } catch (error) {
    note = `ERROR ${error instanceof Error ? error.message : String(error)}`;
  }
  console.log(`${String(status).padEnd(4)} ${method.padEnd(5)} ${label.padEnd(20)} ${note}`);
}
