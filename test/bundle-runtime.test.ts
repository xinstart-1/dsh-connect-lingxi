/**
 * 浏览器半边的**运行时**冒烟测试（静态检查在 `client.test.ts`）。
 *
 * 为什么需要它：`src/client/bundle.js` 里有两条只有「真的跑一次 apply」才能验证的
 * 契约 —— ①`main` 面板必须**常注册**（关掉侧栏行之后胶囊仍要能打开它）；
 * ②`sidebar.panellist` 的导航行必须**随开关注册/注销**（行来自 entry 元数据，
 * 组件返回 null 隐藏不了它）。
 *
 * 这里不发网络请求、不碰 DOM：`fetch` 换成按脚本返回的桩，`document` 不定义
 * （bundle 自己用 `typeof document !== 'undefined'` 兜住），React 换成只记录
 * props 的假实现。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/client/bundle.js', import.meta.url), 'utf8');

/** 假 React：元素只是 `{ type, props }`，hooks 给固定/可写初值。 */
function fakeReact(): unknown {
  return {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
      type,
      props: { ...(props as Record<string, unknown> | null), children },
    }),
    Fragment: Symbol('Fragment'),
    useState: (initial: unknown) => [initial, () => undefined],
    useEffect: () => undefined,
  };
}

interface Registration {
  name: string;
  key?: string;
  id?: string;
  order?: number;
  label?: () => string;
  inject?: () => Record<string, unknown>;
  component: unknown;
}

interface Harness {
  registrations: Registration[];
  disposeAll: () => void;
  /** 让下一次（或正在等待的）状态请求返回这份文档。 */
  deliver: (document: unknown) => void;
}

/** 把一个 status 文档喂给 bundle 的 store，然后等它跑完微任务。 */
function statusDoc(sidebarPanel: boolean, accounts?: unknown[]): unknown {
  return {
    version: '0.0.0-test',
    login: { state: 'signed-in', source: 'client', name: 'tester' },
    credits: { state: 'ok', total: 1200, batches: [] },
    tasks: { oneTime: [], checkedInToday: false },
    models: [],
    ...(accounts === undefined ? {} : { accounts }),
    settings: {
      autoCheckin: false,
      pollIntervalMs: 300000,
      composerPill: true,
      sidebarPanel,
      disabledModels: [],
    },
    readAtMs: 0,
  };
}

/** 装载 bundle 并跑一遍 `apply`。 */
function boot(initial: unknown[]): Harness {
  const registrations: Registration[] = [];
  const effects: Array<() => void> = [];
  // 一个可替换的「当前状态」：轮询读到的永远是最新那份，历史文档不需要回放。
  let current = initial[0];

  const g = globalThis as unknown as Record<string, unknown>;
  const previousLoader = g.__ModuleLoader__;
  const previousFetch = g.fetch;
  let module: { apply: (ctx: unknown) => void } | undefined;
  g.__ModuleLoader__ = {
    load: ({ factory }: { factory: (require: (id: string) => unknown) => unknown }) => {
      module = factory((id: string) => {
        assert.equal(id, 'react', `bundle 只应该 require('react')，却要了 ${id}`);
        return fakeReact();
      }) as { apply: (ctx: unknown) => void };
    },
  };
  g.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(current) });

  // 经典脚本：直接求值即可（IIFE 会调用 __ModuleLoader__.load）。
  new Function(source)();
  assert.ok(module !== undefined, 'bundle 没有调用 __ModuleLoader__.load');

  const ctx = {
    effect: (fn: () => unknown) => {
      const dispose = fn();
      if (typeof dispose === 'function') effects.push(dispose as () => void);
      return dispose;
    },
    locale: {
      register: () => () => undefined,
      bind: () => (key: string) => key,
    },
    slots: {
      /**
       * 真实宿主里槽位**已声明**时，`inject` 的回调是同步执行的
       * （`dsh-client-ui-renderer` 的注释：already-declared → runs synchronously）。
       * 这里所有槽位都算已声明，所以立刻跑，才测得到「开关打开时行有没有注册」。
       */
      inject: (_name: string, callback: () => unknown) => callback(),
      register: (options: Registration, component: unknown) => {
        const entry: Registration = { ...options, component };
        registrations.push(entry);
        return () => {
          const index = registrations.indexOf(entry);
          if (index !== -1) registrations.splice(index, 1);
        };
      },
    },
    get: () => undefined,
  };

  module.apply(ctx);

  return {
    registrations,
    deliver: (document: unknown) => {
      current = document;
    },
    disposeAll: () => {
      for (const dispose of effects) dispose();
      g.__ModuleLoader__ = previousLoader;
      g.fetch = previousFetch;
    },
  };
}

/** 等 store 的 `load()` 跑完（一次 fetch + 一次 json + 若干 then）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

test('main 面板常注册，且 props 声明自己是整页', () => {
  const harness = boot([statusDoc(false)]);
  try {
    const main = harness.registrations.filter((entry) => entry.name === 'main');
    assert.equal(main.length, 1, 'main 必须注册一次');
    assert.equal(main[0]?.key, 'dsh-connect-lingxi', 'main 用 key = 面板 id');
    const props = main[0]?.inject?.() ?? {};
    assert.equal(props.surface, 'page', '侧栏整页要告诉页面自己是整页');
  } finally {
    harness.disposeAll();
  }
});

test('sidebar.panellist 行在开关关闭时不注册', async () => {
  const harness = boot([statusDoc(false)]);
  try {
    await settle();
    assert.equal(
      harness.registrations.filter((entry) => entry.name === 'sidebar.panellist').length,
      0,
      '开关关闭时不能占侧栏座位',
    );
  } finally {
    harness.disposeAll();
  }
});

test('sidebar.panellist 行在开关打开时注册，且用 id + label', async () => {
  const harness = boot([statusDoc(true)]);
  try {
    await settle();
    const rows = harness.registrations.filter((entry) => entry.name === 'sidebar.panellist');
    assert.equal(rows.length, 1, '开关打开时正好注册一行');
    assert.equal(rows[0]?.id, 'dsh-connect-lingxi');
    assert.equal(typeof rows[0]?.label, 'function', '行名来自 label，宿主会回退到 id');
  } finally {
    harness.disposeAll();
  }
});

test('宿主没声明 layout 时不伪造返回按钮', () => {
  const harness = boot([statusDoc(false)]);
  try {
    const main = harness.registrations.find((entry) => entry.name === 'main');
    const props = main?.inject?.() ?? {};
    assert.equal(
      props.backToConversation,
      undefined,
      '拿不到 layout 时留 undefined，页面会把按钮藏掉而不是渲染一个点了报错的按钮',
    );
  } finally {
    harness.disposeAll();
  }
});

test('账号+智点读数注册在模型选择器前面（input.right），不在 input.left', async () => {
  // 宿主把 `input.right` 渲染在模型选择器紧前面，`input.left` 贴着「完全权限」。
  // 读数不是操作，摆在权限选择器旁边会抢点击（trae / workbuddy 都因此改过位置）。
  const harness = boot([statusDoc(false)]);
  try {
    await settle();
    assert.equal(
      harness.registrations.filter((entry) => entry.name === 'conversation.input.right').length,
      1,
      '读数要注册到 input.right',
    );
    assert.equal(
      harness.registrations.filter((entry) => entry.name === 'conversation.input.left').length,
      0,
      '不能再占 input.left（那里和权限下拉抢点击）',
    );
  } finally {
    harness.disposeAll();
  }
});

test('读数上是产品名加余额，账号名在 tooltip 与弹层里', async () => {
  const accounts = [
    { id: 'uid-111', name: 'uid-111111111', current: false, enabled: true },
    { id: 'uid-895137935', name: 'uid-895137935', current: true, enabled: true },
  ];
  const harness = boot([statusDoc(false, accounts)]);
  try {
    await settle();
    const gate = harness.registrations.find((entry) => entry.name === 'conversation.input.right');
    assert.ok(gate !== undefined, '读数没注册');
    // 直接调用组件函数：假 React 不会替我们渲染函数组件。
    const inner = (gate.component as (props: unknown) => { type: unknown; props: Record<string, unknown> })(
      {
        t: (key: string, params?: Record<string, string>) =>
          params === undefined ? key : key + '(' + Object.values(params).join('|') + ')',
        useProjection: () => ({ next: { provider: 'wps-lingxi' } }),
      },
    );
    const pill = (inner.type as (props: unknown) => { props: Record<string, unknown> })(inner.props);
    const button = (pill.props.children as Array<{ props: Record<string, unknown> }>)[0];
    const label = String((button?.props.children as unknown[])[0]);
    // 胶囊上只留产品名 + 读数：账号名挪到 tooltip（下面断言）与弹层账号表。
    assert.match(label, /^pillAccount/, '用带账号的标签键');
    assert.match(label, /1200/, '要显示智点余额');
    assert.doesNotMatch(label, /1,200/, '胶囊里不用千分位（小字号下逗号像多余字符）');
    assert.doesNotMatch(label, /895/, '账号名不该再挤在胶囊上');
    assert.doesNotMatch(label, /undefined/, '不能把 undefined 拼进读数');
    // 账号名没有丢：tooltip 里仍然能看出是哪个号，且完整 uid 不整串外露。
    const title = String(button?.props.title);
    assert.match(title, /895\*\*\*\*935/, 'tooltip 要说明当前账号（取 current 那个，不是第一个）');
    assert.doesNotMatch(title, /895137935/, '完整 uid 不该整串摆在界面上');
  } finally {
    harness.disposeAll();
  }
});

test('登录期读不到账号时读数只报余额，不编账号名', async () => {
  const harness = boot([statusDoc(false)]);
  try {
    await settle();
    const gate = harness.registrations.find((entry) => entry.name === 'conversation.input.right');
    const inner = (gate?.component as (props: unknown) => { type: unknown; props: Record<string, unknown> })(
      {
        t: (key: string, params?: Record<string, string>) =>
          params === undefined ? key : key + '(' + Object.values(params).join('|') + ')',
        useProjection: () => ({ next: { provider: 'wps-lingxi' } }),
      },
    );
    const pill = (inner.type as (props: unknown) => { props: Record<string, unknown> })(inner.props);
    const button = (pill.props.children as Array<{ props: Record<string, unknown> }>)[0];
    const label = String((button?.props.children as unknown[])[0]);
    assert.match(label, /^pillCredits/, '没有账号时用只报余额的那条键');
    assert.doesNotMatch(label, /undefined/, '不能把 undefined 拼进读数');
  } finally {
    harness.disposeAll();
  }
});

test('新会话没选模型时输入框不显示读数（与 WorkBuddy 同一条规则）', () => {
  const harness = boot([statusDoc(false)]);
  try {
    const gate = harness.registrations.find((entry) => entry.name === 'conversation.input.right');
    assert.ok(gate !== undefined, '读数没注册');
    const component = gate.component as (props: unknown) => unknown;
    const t = (key: string, params?: Record<string, string>) =>
      params === undefined ? key : key + '(' + Object.values(params).join('|') + ')';
    // 新会话：投影里 next / lastUsed 都是 null —— 不知道用哪个 provider，不显示。
    assert.equal(component({ t, useProjection: () => ({ next: null, lastUsed: null }) }), null);
    // 投影压根没有：同样不显示。
    assert.equal(component({ t, useProjection: () => undefined }), null);
    // 选了别人的模型：不显示灵犀余额。
    assert.equal(component({ t, useProjection: () => ({ next: { provider: 'raccoon' } }) }), null);
    // 读投影抛异常也不显示。这条以前是反过来的（「读不到就照旧显示，免得胶囊消失」），
    // 实测后果更糟：新会话根本没有 `modelSelection` 投影，几家连接器插件于是同时
    // 在同一个输入框里画余额（果办 / WPS灵犀 / 小浣熊），堆成一排。
    const shown = component({
      t,
      useProjection: () => {
        throw new Error('projection renamed');
      },
    });
    assert.equal(shown, null, '读不到投影就不画：不知道用哪家，画出来就是抢别人的位置');
  } finally {
    harness.disposeAll();
  }
});

test('读数用 WorkBuddy 那种纯文字皮肤：无边框无底色，悬停才浮底', () => {
  // 胶囊的皮肤在注入的 CSS 里，不在内联样式里 —— 内联样式写不了 :hover。
  assert.match(source, /\.dsm-lingxi-pill-trigger\{/, '缺少读数皮肤类');
  assert.match(source, /\.dsm-lingxi-pill-trigger:hover\{/, '缺少悬停反馈');
  assert.match(source, /font-variant-numeric:tabular-nums/, '数字要等宽，余额跳动时不抖');
  assert.match(source, /border:0/, '不是带边框的 chip');
  assert.match(source, /font-size:12px;line-height:18px/, '与 WorkBuddy 一致的 12/18');
  // 文案也照它的形状：产品名 + 数字，不在胶囊上堆「智点」。
  assert.match(source, /pillAccount: 'WPS灵犀 · \{total\}',/);
  assert.match(source, /pillAccount: 'WPS Lingxi · \{total\}',/);
});

test('不去占模型名旁边的标签格子（倍率与徽标改由目录数据带到界面）', async () => {
  // 0.0.15 曾在这里注册 `conversation.input.model.label`。那个槽位在宿主上是
  // `single` —— 一个格子，谁注册谁独占：盖住宿主的默认标签，也会挤掉别的
  // 插件（比如给自家行画促销徽标的插件）的同一格。0.0.16 起倍率并进模型名、
  // 徽标走 `llm.listModels` 的目录字段，宿主自己的渲染就能画出来，不需要占格子。
  const harness = boot([statusDoc(false)]);
  try {
    await settle();
    assert.equal(
      harness.registrations.some((entry) => entry.name === 'conversation.input.model.label'),
      false,
      '别再注册模型标签槽位：那是别人的格子',
    );
  } finally {
    harness.disposeAll();
  }
});

test('触发器里徽标排在名字后面：只注入顺序样式，不重占标签格子', () => {
  // 宿主在触发器里的默认排法是「徽标 名字」（`ModelSelect` 的 `renderModelLabel`
  // 对 trigger 把徽标放在名字前），下拉菜单里却是「名字 徽标」。用一条只改视觉
  // 顺序的样式把触发器也对齐，而不是为此去抢 `single` 槽位。
  const styles: Array<{ dataset: Record<string, string>; textContent: string }> = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const previousDocument = g.document;
  g.document = {
    head: {
      appendChild: (node: unknown) => {
        styles.push(node as { dataset: Record<string, string>; textContent: string });
      },
    },
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
  };
  try {
    const harness = boot([statusDoc(false)]);
    harness.disposeAll();
    const order = styles.find((style) =>
      String(style.dataset.pluginCss ?? '').endsWith('model-label-order.css'),
    );
    assert.ok(order !== undefined, '没有注入模型标签顺序样式');
    assert.match(String(order.textContent), /triggerLabel/, '只作用在触发器');
    assert.match(String(order.textContent), /\[data-provider-id="wps-lingxi"\]/, '只作用在本插件的模型行');
    assert.match(String(order.textContent), /order:-1/, '把名字提到徽标前面');
  } finally {
    g.document = previousDocument;
  }
});

test('目录徽标配色照灵犀网页：浅橙底橙字胶囊，只作用在本插件模型行', () => {
  const styles: Array<{ dataset: Record<string, string>; textContent: string }> = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const previousDocument = g.document;
  g.document = {
    head: {
      appendChild: (node: unknown) => {
        styles.push(node as { dataset: Record<string, string>; textContent: string });
      },
    },
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
  };
  try {
    const harness = boot([statusDoc(false)]);
    harness.disposeAll();
    const badge = styles.find((style) =>
      String(style.dataset.pluginCss ?? '').endsWith('model-badge.css'),
    );
    assert.ok(badge !== undefined, '没有注入模型徽标配色样式');
    const css = String(badge.textContent);
    // apply 先落一份底：把宿主那张 Tag 藏掉（以后宿主恢复渲染也不会出现双份），
    // 范围只在本插件的模型行。
    assert.match(css, /display:none/, '宿主的 Tag 要藏起来');
    assert.match(css, /\[data-provider-id="wps-lingxi"\]/, '只作用在本插件的模型行');
    // 每个模型的胶囊由 `/status` 回来后的 `applyModelBadges` 生成。
    assert.match(source, /function applyModelBadges\(/, '缺少徽标样式生成函数');
    assert.match(source, /applyModelBadges\(document\.models\)/, '状态回来时没有重建徽标样式');
    assert.match(source, /\[data-provider-id="wps-lingxi"\]\[data-model-id="/, '按模型 id 定位');
    assert.match(source, /::after/, '用伪元素画胶囊');
    assert.match(source, /#fef1ea/, '浅橙底取自灵犀网页截图的填充色');
    assert.match(source, /#e2651a/, '橙字取自灵犀网页截图的文字色');
  } finally {
    g.document = previousDocument;
  }
});
