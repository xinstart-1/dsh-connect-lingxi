/**
 * 输入框智点读数的门控（浏览器半边）。
 *
 * 这条规则曾经把新会话的输入框塞满：旧逻辑是「读投影抛异常 = 我不知道 = 照旧
 * 显示」，而**新会话还没选模型**时宿主根本没有 `modelSelection` 投影，于是几家
 * 连接器插件（实测 果办 / WPS灵犀 / 小浣熊）在同一个输入框里各画一行余额。
 *
 * 现在照 WorkBuddy 的 `ComposerCreditsGate`：只有**确定**本会话的模型来自本插件
 * 才画；没 props、没 API、没值、别的 provider、读抛异常一律不画。诊断（report /
 * lastGate）保留，但不再影响显示决定。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

interface El {
  type: unknown;
  props: Record<string, unknown> & { children: unknown[] };
}

type Slot = { options: Record<string, unknown>; component: (props: unknown) => El | null };

/** 本仓库的 provider id（与 bundle 里 `PROVIDER_ID` 一致）。 */
const PROVIDER_ID = 'wps-lingxi';

/**
 * 把 bundle 装进假宿主，取回 `conversation.input.right` 那个注册项。
 *
 * 只实现这些组件真正用到的那几个 React hook：读数是纯渲染，没有副作用要跑。
 * `document` 传 undefined：bundle 里的样式注入有 `typeof document` 保护，
 * 没 DOM 时整段跳过，正好把测试限定在门控逻辑上。
 */
function loadComposerSlot(): Slot {
  const source = readFileSync('src/client/bundle.js', 'utf8');
  let loaded: { factory: (require: (name: string) => unknown) => Record<string, unknown> } | undefined;
  const fakeWindow = {
    __ModuleLoader__: {
      load: (module: never) => {
        loaded = module;
      },
    },
  };
  const runInFakeGlobal = new Function(
    'globalThis',
    'window',
    'document',
    'require',
    'console',
    `with (globalThis) { ${source} }`,
  );
  runInFakeGlobal(fakeWindow, fakeWindow, undefined, undefined, console);
  assert.ok(loaded !== undefined, 'bundle 应通过 __ModuleLoader__ 注册');

  const element = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El => ({
    type,
    props: { ...(props ?? {}), children },
  });
  /** 错误边界要 `React.Component`；给的足够让它被定义出来即可。 */
  class Component {
    props: unknown;
    state: unknown = {};
    constructor(props: unknown) {
      this.props = props;
    }
    setState(): void {}
    static getDerivedStateFromError(): { failed: boolean } {
      return { failed: true };
    }
  }
  const react = {
    createElement: element,
    Component,
    Fragment: 'Fragment',
    useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => undefined],
    useEffect: () => undefined,
    useRef: (initial: unknown) => ({ current: initial }),
    useMemo: (factory: () => unknown) => factory(),
    useCallback: (callback: unknown) => callback,
  };

  const mod = loaded.factory((name: string) => {
    assert.equal(name, 'react', 'bundle 只该 require react');
    return react;
  });

  const slots = new Map<string, Slot>();
  const ctx = {
    slots: {
      inject: (_name: string, callback: () => unknown) => {
        callback();
      },
      register: (options: Record<string, unknown>, component: (props: unknown) => El | null) => {
        slots.set(String(options['name']), { options, component });
        return () => slots.delete(String(options['name']));
      },
    },
    locale: {
      register: () => undefined,
      bind: () => (key: string) => key,
    },
    effect: (callback: () => unknown) => callback(),
  };
  (mod['apply'] as (context: unknown) => void)(ctx);

  const slot = slots.get('conversation.input.right');
  assert.ok(slot !== undefined, '应注册 conversation.input.right');
  return slot;
}

/** 造一个「宿主投影读出这些值」的 props。 */
function propsWithProjection(projection: unknown, throws = false): Record<string, unknown> {
  return {
    t: (key: string) => key,
    sessionId: 'sess-1',
    useProjection: (key: string) => {
      assert.equal(key, 'modelSelection', '门控只该问 modelSelection');
      if (throws) throw new Error('projection not mounted');
      return projection;
    },
  };
}

const slot = loadComposerSlot();

test('新会话（宿主没有 modelSelection 投影）→ 不画读数', () => {
  // 这就是实测那一屏：新会话还没选模型，`undefined` 表示「这一格还没有值」，
  // 不是错误。旧逻辑把「读不到」当异常放行，几家余额就一起画了出来。
  assert.equal(slot.component(propsWithProjection(undefined)), null);
});

test('投影里 next 与 lastUsed 都空 → 不画读数', () => {
  assert.equal(slot.component(propsWithProjection({})), null);
  assert.equal(slot.component(propsWithProjection({ next: null, lastUsed: null })), null);
});

test('选中别的 provider（实测：MiniMax Code 未登录）→ 不画读数', () => {
  const projection = { next: { provider: 'minimaxcode', model: 'minimax-code' }, lastUsed: undefined };
  assert.equal(slot.component(propsWithProjection(projection)), null);
});

test('宿主根本没提供 useProjection → 不画（不知道就不画，而不是「不知道就画」）', () => {
  assert.equal(slot.component({ t: (key: string) => key, sessionId: 'sess-1' }), null);
});

test('读投影抛异常 → 不画，也不把这一格渲崩', () => {
  // 这条是本仓库原来做错的地方：catch 里放行，于是「读不到」= 画。
  assert.equal(slot.component(propsWithProjection(undefined, true)), null);
});

test('没有 props 的空槽渲染 → 不画', () => {
  assert.equal(slot.component(undefined), null);
});

test('选中本插件的模型 → 画读数', () => {
  const projection = { next: { provider: PROVIDER_ID, model: 'lingxi-v1' }, lastUsed: undefined };
  const tree = slot.component(propsWithProjection(projection));
  assert.notEqual(tree, null, '本插件的模型就该显示余额');
});

test('next 优先于 lastUsed：刚切换、还没发出去的选择也算数', () => {
  const projection = { next: { provider: PROVIDER_ID, model: 'lingxi-v1' }, lastUsed: { provider: 'raccoon', model: 'm2' } };
  assert.notEqual(slot.component(propsWithProjection(projection)), null, 'next 是刚选的灵犀，应该画');

  const reversed = { next: null, lastUsed: { provider: PROVIDER_ID, model: 'lingxi-v1' } };
  assert.notEqual(slot.component(propsWithProjection(reversed)), null, 'next 为空时回落到 lastUsed');
});

test('读数比模型名更安静：12px / label-tertiary / 不写死高度（照 WorkBuddy 的度量）', () => {
  const source = readFileSync('src/client/bundle.js', 'utf8');
  const rule = /'\.dsm-lingxi-pill-trigger\{([^']*)\}'/.exec(source);
  assert.ok(rule !== null, '应有 .dsm-lingxi-pill-trigger 规则');
  const body = rule[1] ?? '';
  assert.match(body, /font-size:12px/, '读数应比模型名（13px）小一号');
  assert.match(body, /line-height:18px/);
  assert.match(body, /label-tertiary/, '次要信息用 tertiary 色，不能和模型名同色');
  assert.match(body, /padding:2px 6px/);
  assert.match(body, /align-self:stretch/, '高度与整行对齐交给 align-self:stretch');
  assert.doesNotMatch(body, /height:28px/, '别再写死固定高度');
});
