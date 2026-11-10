/**
 * 模型页的**渲染级**测试：勾选框真的在，点了真的发出正确的写入。
 *
 * 为什么不能只测静态文本：模型页的核心行为是「点一下 → 算出整张名单 → POST
 * `/action?action=settings`」。这一段逻辑写在渲染函数里（禁用名单是绝对值，
 * 图片是两张相对名单），只有真的渲染一次、真的点一次才能证明它算对了。
 *
 * 这里给 bundle 一个**最小 hooks 运行时**（`useState` 会真的重渲染），
 * 而不是空壳 —— 空壳只能证明「组件能跑一次」，证明不了「点完界面会跟着变」。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/client/bundle.js', import.meta.url), 'utf8');

/** 一个元素（假 React 的 createElement 产物）。 */
interface Element {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown[] };
}

/** 当前正在渲染的组件实例；hooks 从这个上下文里分配槽位。 */
let rendering: {
  slots: Array<{ value?: unknown; ran?: boolean }>;
  index: number;
  rerender: () => void;
} | undefined;

/**
 * 最小 React：createElement **立即展开函数组件**，useState 真的会重渲染。
 *
 * 为什么不等遍历时再展开：模型页的勾选框住在 `ModelBlock` 这个子组件里，
 * 不展开就只能看到 `<ModelBlock/>` 这个元素本身，测试会误以为「一个勾选框都没有」。
 * 这些子组件都不用 hooks，所以同步展开是安全的。
 */
const React = {
  createElement: (type: unknown, raw: unknown, ...children: unknown[]): Element => {
    const props = { ...((raw as Record<string, unknown> | null) ?? {}), children };
    if (typeof type === 'function') {
      return (type as (props: Record<string, unknown>) => Element)(props);
    }
    return { type, props };
  },
  Fragment: Symbol('Fragment'),
  useState(initial: unknown): [unknown, (next: unknown) => void] {
    const context = rendering;
    assert.ok(context !== undefined, 'useState 只在渲染期间可用');
    const at = context.index++;
    if (context.slots[at] === undefined) context.slots[at] = { value: initial };
    const slot = context.slots[at]!;
    return [
      slot.value,
      (next: unknown) => {
        slot.value =
          typeof next === 'function' ? (next as (prev: unknown) => unknown)(slot.value) : next;
        context.rerender();
      },
    ];
  },
  useEffect(effect: () => unknown): void {
    const context = rendering;
    assert.ok(context !== undefined, 'useEffect 只在渲染期间可用');
    const at = context.index++;
    // 只在首次挂载跑一次（依赖数组这里都是空/固定，够用）。
    if (context.slots[at] === undefined) {
      context.slots[at] = { ran: true };
      effect();
    }
  },
};

interface Rendered {
  get element(): Element;
  /** 让 `load()` 的 promise 链跑完（状态更新是同步重渲染的）。 */
  flush: () => Promise<void>;
}

/** 把一个组件挂起来，返回当前渲染结果。 */
function mount(
  component: (props: Record<string, unknown>) => Element,
  props: Record<string, unknown>,
): Rendered {
  let element: Element | undefined;
  const slots: Array<{ value?: unknown; ran?: boolean }> = [];
  const context = {
    slots,
    index: 0,
    rerender: (): void => {
      context.index = 0;
      // 状态更新触发的重渲染也要有 hooks 上下文：否则第二次渲染起
      // `useState` 会找不到槽位，界面在第一次点击后就崩掉。
      rendering = context;
      try {
        element = component(props);
      } finally {
        rendering = undefined;
      }
    },
  };
  rendering = context;
  context.rerender();
  rendering = undefined;
  assert.ok(element !== undefined, '组件没有渲染出任何东西');
  return {
    get element() {
      return element!;
    },
    flush: async () => {
      for (let i = 0; i < 30; i += 1) await Promise.resolve();
    },
  };
}

/** 深度遍历，收集所有 `input[type=checkbox]`。 */
function checkboxes(node: unknown, acc: Element[] = []): Element[] {
  if (Array.isArray(node)) {
    for (const child of node) checkboxes(child, acc);
    return acc;
  }
  if (node === null || typeof node !== 'object') return acc;
  const element = node as Element;
  if (element.type === 'input' && element.props.type === 'checkbox') acc.push(element);
  checkboxes(element.props.children, acc);
  return acc;
}

/**
 * 找到某个分页（`role="tabpanel"` + `aria-label`）。
 *
 * 必须限定在模型页里找勾选框：设置页也渲染了三个勾选框（自动签到 / 胶囊 / 侧栏），
 * 它们只是被 `hidden` 藏着，仍在这棵树里。
 */
function findPanel(node: unknown, label: string): Element | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findPanel(child, label);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (node === null || typeof node !== 'object') return undefined;
  const element = node as Element;
  if (element.props.role === 'tabpanel' && element.props['aria-label'] === label) return element;
  return findPanel(element.props.children, label);
}

/** 收集所有文本节点。 */
function texts(node: unknown, acc: string[] = []): string[] {
  if (typeof node === 'string') {
    acc.push(node);
    return acc;
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, acc);
    return acc;
  }
  if (node === null || typeof node !== 'object') return acc;
  texts((node as Element).props.children, acc);
  return acc;
}

/** 按文本找 Tab 按钮。 */
function findTab(node: unknown, label: string): Element | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findTab(child, label);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (node === null || typeof node !== 'object') return undefined;
  const element = node as Element;
  if (element.type === 'button' && element.props.role === 'tab' && texts(element.props.children).includes(label)) {
    return element;
  }
  return findTab(element.props.children, label);
}

/** 一份状态文档：两个模型，一个上游支持图片，一个不支持。 */
function statusDoc(): unknown {
  return {
    version: '0.0.0-test',
    login: { state: 'signed-in', source: 'manual', name: 'tester' },
    credits: { state: 'ok', total: 100, batches: [] },
    tasks: { oneTime: [], checkedInToday: false },
    models: [
      {
        id: 'deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        multiplier: '0.12x',
        contextWindow: 1_048_576,
        maxTokens: 65_536,
        reasoning: true,
        vision: true,
        visionNative: true,
        enabled: true,
      },
      {
        id: 'deepseek-v4-pro-0813',
        name: 'DeepSeek V4 Pro',
        multiplier: '0.40x',
        contextWindow: 1_048_576,
        maxTokens: 65_536,
        reasoning: true,
        vision: false,
        visionNative: false,
        enabled: true,
      },
    ],
    // 账号池：两个账号，第一个是当前在用的。单账号时界面不渲染这一块，
    // 所以默认夹具给两个，专门测账号池的用例再用 `accountsDoc` 覆盖。
    accounts: [
      { id: 'uid-1', name: '主账号', source: 'login', savedAtMs: 2000, current: true, selected: false, enabled: true, credits: 3000 },
      { id: 'uid-2', name: '副账号', source: 'browser', savedAtMs: 1000, current: false, selected: false, enabled: true },
    ],
    accountPool: { enabled: true, total: 2, selected: 2, deviceMode: 'virtual' },
    selectionLost: false,
    settings: {
      autoCheckin: false,
      pollIntervalMs: 300_000,
      composerPill: true,
      sidebarPanel: false,
      disabledModels: [],
      imageOffModels: [],
      imageOnModels: [],
    },
    readAtMs: 0,
  };
}

interface Booted {
  /** 渲染 main 面板并切到模型页。 */
  renderModels: () => Promise<Rendered>;
  /** 只渲染 main 面板（不切 Tab，默认停在第一个 Tab）。 */
  renderMain: () => Promise<Rendered>;
  posts: Array<{ url: string; body: unknown }>;
  dispose: () => void;
}

/** 装载 bundle，返回「渲染 main 面板」的入口。 */
function boot(document: unknown): Booted {
  const posts: Array<{ url: string; body: unknown }> = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const previousLoader = g.__ModuleLoader__;
  const previousFetch = g.fetch;
  const previousSetInterval = g.setInterval;
  const previousClearInterval = g.clearInterval;

  // 组件挂载会调 `subscribe()` 装一个 60 秒的轮询定时器，那会把测试进程钉住。
  // 这里换成不触发、可 clear 的桩：本文件要测的是「点一下发什么」，不是轮询。
  g.setInterval = () => 0;
  g.clearInterval = () => undefined;

  g.fetch = (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(init.body ?? '{}') });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(document) });
  };

  let module: { apply: (ctx: unknown) => void } | undefined;
  let mainComponent: ((props: Record<string, unknown>) => Element) | undefined;
  let mainInject: (() => Record<string, unknown>) | undefined;

  g.__ModuleLoader__ = {
    load: ({ factory }: { factory: (require: (id: string) => unknown) => unknown }) => {
      module = factory((id: string) => {
        assert.equal(id, 'react', `bundle 只应该 require('react')，却要了 ${id}`);
        return React;
      }) as { apply: (ctx: unknown) => void };
    },
  };

  const ctx = {
    effect: (fn: () => unknown) => fn(),
    locale: { register: () => () => undefined, bind: () => (key: string) => key },
    slots: {
      inject: (_name: string, callback: () => unknown) => callback(),
      register: (options: Record<string, unknown>, component: unknown) => {
        if (options.name === 'main') {
          mainComponent = component as (props: Record<string, unknown>) => Element;
          mainInject = options.inject as (() => Record<string, unknown>) | undefined;
        }
        return () => undefined;
      },
    },
    get: () => undefined,
  };

  new Function(source)();
  assert.ok(module !== undefined, 'bundle 没有调用 __ModuleLoader__.load');
  (module as { apply: (ctx: unknown) => void }).apply(ctx);
  assert.ok(mainComponent !== undefined, 'main 面板没有注册');

  return {
    posts,
    renderMain: async () => {
      const props = { ...(mainInject?.() ?? {}), t: (key: string) => key };
      const view = mount(mainComponent as (props: Record<string, unknown>) => Element, props);
      // 首帧 status 还是 undefined（轮询还没回来），等它回来。
      await view.flush();
      return view;
    },
    renderModels: async () => {
      const props = { ...(mainInject?.() ?? {}), t: (key: string) => key };
      const view = mount(mainComponent as (props: Record<string, unknown>) => Element, props);
      // 首帧 status 还是 undefined（轮询还没回来），等它回来再切 Tab。
      await view.flush();
      const tab = findTab(view.element, 'tabModels');
      assert.ok(tab !== undefined, '找不到模型 Tab');
      (tab.props.onClick as () => void)();
      await view.flush();
      return view;
    },
    dispose: () => {
      g.__ModuleLoader__ = previousLoader;
      g.fetch = previousFetch;
      g.setInterval = previousSetInterval;
      g.clearInterval = previousClearInterval;
    },
  };
}

test('模型页每行两个勾选框：启用 + 图片', async () => {
  const harness = boot(statusDoc());
  try {
    const view = await harness.renderModels();
    const panel = findPanel(view.element, 'tabModels');
    assert.ok(panel !== undefined, '找不到模型页');
    const boxes = checkboxes(panel);
    assert.equal(boxes.length, 4, '两个模型 ×（启用 + 图片）= 4 个勾选框');
    const all = texts(panel);
    assert.ok(all.includes('DeepSeek V4.1 Flash'), '模型名要显示');
    assert.ok(all.includes('modelImage'), '图片勾选框要有标签');
  } finally {
    harness.dispose();
  }
});

test('关掉一个模型：POST 的 disabledModels 是整张表的绝对值', async () => {
  const harness = boot(statusDoc());
  try {
    const view = await harness.renderModels();
    // 每行第 1 个勾选框是「启用」。关掉第二行。
    const boxes = checkboxes(findPanel(view.element, 'tabModels'));
    (boxes[2]?.props.onChange as (event: { target: { checked: boolean } }) => void)({
      target: { checked: false },
    });
    await view.flush();

    assert.equal(harness.posts.length, 1, '点一次应当只发一次写入');
    assert.match(harness.posts[0]?.url ?? '', /action=settings/);
    assert.deepEqual(harness.posts[0]?.body, { disabledModels: ['deepseek-v4-pro-0813'] });
  } finally {
    harness.dispose();
  }
});

test('关掉图片：imageOffModels 记「与上游默认不同」的那一侧', async () => {
  const harness = boot(statusDoc());
  try {
    const view = await harness.renderModels();
    // 第 1 行的图片勾选框（下标 1）关掉：上游本来支持，所以要进 imageOffModels。
    const boxes = checkboxes(findPanel(view.element, 'tabModels'));
    (boxes[1]?.props.onChange as (event: { target: { checked: boolean } }) => void)({
      target: { checked: false },
    });
    await view.flush();

    assert.deepEqual(harness.posts[0]?.body, {
      imageOffModels: ['deepseek-v4.1-flash'],
      imageOnModels: [],
    });
  } finally {
    harness.dispose();
  }
});

test('给上游不支持的模型勾上图片：进 imageOnModels', async () => {
  const harness = boot(statusDoc());
  try {
    const view = await harness.renderModels();
    // 第 2 行的图片勾选框（下标 3）：上游没声明，勾上 = 用户自己担保。
    const boxes = checkboxes(findPanel(view.element, 'tabModels'));
    (boxes[3]?.props.onChange as (event: { target: { checked: boolean } }) => void)({
      target: { checked: true },
    });
    await view.flush();

    assert.deepEqual(harness.posts[0]?.body, {
      imageOffModels: [],
      imageOnModels: ['deepseek-v4-pro-0813'],
    });
  } finally {
    harness.dispose();
  }
});

test('只剩一个启用模型时，它的启用勾选框被禁用（不能全关）', async () => {
  const doc = statusDoc() as { models: Array<{ enabled: boolean; id: string }> };
  for (const model of doc.models) if (model.id !== 'deepseek-v4.1-flash') model.enabled = false;
  const harness = boot(doc);
  try {
    const view = await harness.renderModels();
    const boxes = checkboxes(findPanel(view.element, 'tabModels'));
    assert.equal(boxes[0]?.props.disabled, true, '最后一个启用的模型不许关掉');
    assert.equal(boxes[2]?.props.disabled, false, '已关闭的行可以再打开');
  } finally {
    harness.dispose();
  }
});

/** 从渲染结果里收集所有带 `data-account-id` 的元素（账号池的每一行）。 */
function accountRows(node: unknown, acc: Element[] = []): Element[] {
  if (Array.isArray(node)) {
    for (const child of node) accountRows(child, acc);
    return acc;
  }
  if (node === null || typeof node !== 'object') return acc;
  const element = node as Element;
  if (element.props['data-account-id'] !== undefined) acc.push(element);
  accountRows(element.props.children, acc);
  return acc;
}

/** 收集所有带指定 prop 的元素。 */
function collectByProp(node: unknown, prop: string, acc: Element[] = []): Element[] {
  if (Array.isArray(node)) {
    for (const child of node) collectByProp(child, prop, acc);
    return acc;
  }
  if (node === null || typeof node !== 'object') return acc;
  const element = node as Element;
  if (element.props[prop] !== undefined) acc.push(element);
  collectByProp(element.props.children, prop, acc);
  return acc;
}

/** 渲染 main 面板并切到「账号」页。 */
async function renderAccountTab(harness: Booted): Promise<Rendered> {
  const view = await harness.renderMain();
  await view.flush();
  const tab = findTab(view.element, 'tabAccount');
  assert.ok(tab !== undefined, '找不到账号 Tab');
  (tab.props.onClick as () => void)();
  await view.flush();
  return view;
}

test('账号池：两个账号各一行，当前那个带标记', async () => {
  const harness = boot(statusDoc());
  try {
    const view = await renderAccountTab(harness);
    const rows = accountRows(view.element);
    assert.equal(rows.length, 2, '两个账号应当各渲染一行');
    assert.deepEqual(
      rows.map((row) => row.props['data-account-id']),
      ['uid-1', 'uid-2'],
    );
    const pool = texts(view.element);
    // 测试里的 `t` 是「返回 key」的桩，所以 `accountCurrent` 原样出现。
    assert.ok(pool.includes('主账号 · accountCurrent'), '当前账号要带「当前」标记');
    assert.ok(pool.includes('副账号'), '另一个账号照常显示名字');
  } finally {
    harness.dispose();
  }
});

test('账号池：切换用独立按钮，点勾选框只改勾选不切换', async () => {
  const harness = boot(statusDoc());
  try {
    const view = await renderAccountTab(harness);
    const rows = accountRows(view.element);

    // 每行有一个「切到这里」按钮，但**当前账号没有**（点了没有意义）。
    const switchButtons = rows
      .map((row) => (row.props.children as unknown[]).find(
        (child) => (child as Element)?.props?.['data-switch-account'] !== undefined,
      ) as Element | undefined)
      .filter(Boolean);
    assert.equal(switchButtons.length, 1, '只有非当前账号才有切换按钮');

    // 点勾选框：只发 settings，不发 switch-account。
    // 这两件事必须分开，否则点勾选会顺带把账号切了。
    const box = (rows[0]?.props.children as unknown[]).find(
      (child) => (child as Element)?.props?.['data-account-enabled'] !== undefined,
    ) as Element;
    assert.ok(box !== undefined, '每行要有勾选框');
    (box.props.onChange as (event: unknown) => void)({ target: { checked: false } });
    await view.flush();
    const settingsPosts = harness.posts.filter((post) => post.url.includes('settings'));
    assert.equal(settingsPosts.length, 1, '点勾选框只该发 settings');
    assert.deepEqual(settingsPosts[0]?.body, { enabledAccounts: ['uid-2'] });
    assert.equal(
      harness.posts.filter((post) => post.url.includes('switch-account')).length,
      0,
      '点勾选框不该切换账号',
    );

    // 点切换按钮：发 switch-account，带对的 accountId。
    const button = switchButtons[0] as Element;
    (button.props.onClick as () => void)();
    await view.flush();
    const switched = harness.posts.filter((post) => post.url.includes('switch-account'));
    assert.equal(switched.length, 1, '应当发一次切换请求');
    assert.deepEqual(switched[0]?.body, { accountId: 'uid-2' });
  } finally {
    harness.dispose();
  }
});

test('账号池：只有一个账号时仍然显示（常驻，不是多账号才出现）', async () => {
  // 只在多账号时显示会让用户以为这个功能不存在 —— 这一点有真实反馈。
  const doc = statusDoc() as { accounts: unknown[] };
  doc.accounts = [doc.accounts[0]];
  const harness = boot(doc);
  try {
    const view = await renderAccountTab(harness);
    assert.equal(accountRows(view.element).length, 1, '单账号也要显示这一行');
    assert.ok(
      texts(view.element).includes('poolEnabled'),
      '单账号时池开关也要显示（用户可以先把签到用起来）',
    );
  } finally {
    harness.dispose();
  }
});

test('账号池：余额读不到显示破折号，不是 0', async () => {
  // 把「没查到」显示成 0 会让用户以为账号没钱了。
  const harness = boot(statusDoc());
  try {
    const view = await renderAccountTab(harness);
    const rows = accountRows(view.element);
    const creditCells = rows.map((row) =>
      (row.props.children as unknown[]).find(
        (child) => (child as Element)?.props?.['data-account-credits'] !== undefined,
      ) as Element,
    );
    // 第一个账号有余额，第二个没有。用 texts() 取值，不假设 credits() 返回字符串。
    const first = texts(creditCells[0]?.props.children).join('');
    const second = texts(creditCells[1]?.props.children).join('');
    assert.match(first, /3[,.]?000/, `有余额要显示数字，实际 "${first}"`);
    assert.equal(second, '—', '读不到必须是破折号，不能是 0');
  } finally {
    harness.dispose();
  }
});

test('账号池：批量操作在没有勾选任何账号时禁用', async () => {
  const doc = statusDoc() as { accountPool: { selected: number } };
  doc.accountPool.selected = 0;
  const harness = boot(doc);
  try {
    const view = await renderAccountTab(harness);
    const buttons = collectByProp(view.element, 'data-pool-action');
    assert.equal(buttons.length, 2, '签到与测试两个按钮');
    for (const button of buttons) {
      assert.equal(button.props.disabled, true, '没勾选账号时批量按钮必须禁用');
    }
  } finally {
    harness.dispose();
  }
});

test('账号池：选择失效时给出「重新选一个」的提示，而不是让人重新登录', async () => {
  const doc = statusDoc() as { selectionLost: boolean };
  doc.selectionLost = true;
  const harness = boot(doc);
  try {
    const view = await renderAccountTab(harness);
    assert.ok(
      texts(view.element).includes('selectionLostHint'),
      '要说明是「选择失效」，不是「请重新登录」',
    );
  } finally {
    harness.dispose();
  }
});
