/**
 * 浏览器半侧：插件详情页 + 输入框里的智点胶囊。
 *
 * 这是一个**经典脚本**，不是 ES 模块：宿主用 `<script>` 加载它，然后调用
 * `window.__ModuleLoader__.load({ id, factory })`，把 factory 交给 `require`
 * （解析到浏览器自己的模块表）。所以这里：
 * - 不 import 任何东西，React 从 `require('react')` 拿（宿主提供，不重复打包）；
 * - 导出的模块形状与 Cordis 插件一致：`{ name, inject, apply }`。
 *
 * 两份界面读同一份数据：
 * 1. `plugins.bundle.config` —— 插件详情页（余额、任务、模型、诊断）；
 * 2. `conversation.input.right` —— 输入框右侧、模型选择器紧前面的账号+智点读数。
 * 两者共用一个 store 与一个 ticker，所以多一个界面不会多一次请求。
 *
 * 数据来源只有宿主的两条路由：`/plugins/dsh-connect-lingxi/status` 与 `.../action`。
 * **cookie 永远不会到这里**（这就是不直接问上游的原因）。
 */

(function bootstrapLingxiClient() {
  /** 与 package.json 的 name 一致；宿主用它在 `/plugins/<id>/client.js` 下提供本文件。 */
  var BUNDLE_NAME = 'dsh-connect-lingxi';
  /** 本插件注册的 provider id（与宿主侧 constants.ts 的 PROVIDER 一致）。 */
  var PROVIDER_ID = 'wps-lingxi';
  var PANEL_ID = 'dsh-connect-lingxi';
  var STATUS_PATH = '/plugins/dsh-connect-lingxi/status';
  var ACTION_PATH = '/plugins/dsh-connect-lingxi/action';
  /** 轮询间隔：宿主那边真正的刷新节奏由它自己的 pollIntervalMs 决定，这里只决定界面多久问一次。 */
  var POLL_INTERVAL_MS = 60000;

  var LINGXI_PAGE_CSS = [
    '.dsm-lingxi-page{width:100%;max-width:1120px;margin:0 auto;box-sizing:border-box;overflow-wrap:anywhere}',
    // 只有侧栏整页自己占满中间那一列，需要自己的内边距与滚动；插件详情页与设置页
    // 坐在别人给的容器里，再加一层内边距会与外壳的留白叠成两层。
    '.dsm-lingxi-page[data-surface="page"]{padding:24px clamp(20px,4vw,40px) 40px;min-height:100%;overflow:auto}',
    '.dsm-lingxi-page-head{display:flex;flex-direction:column;gap:8px;min-width:0}',
    '.dsm-lingxi-page-heading{display:flex;align-items:center;flex-wrap:wrap;gap:10px;min-width:0}',
    '.dsm-lingxi-page-title{margin:0;font-size:20px;font-weight:600;line-height:1.4}',
    '.dsm-lingxi-page-version,.dsm-lingxi-page-desc{font-size:12px;color:var(--dsw-alias-label-tertiary,#999)}',
    '.dsm-lingxi-page-desc{margin:0;line-height:1.6}',
    '.dsm-lingxi-page-back{appearance:none;font:inherit;cursor:pointer;align-self:flex-start;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#e6e6e6);padding:5px 12px}',
    '.dsm-lingxi-tabs{position:sticky;top:-1px;z-index:2;display:flex;min-width:0;overflow-x:auto;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.24));background:var(--dsw-alias-bg-layer-1,#17181b)}',
    '.dsm-lingxi-tab{appearance:none;font:inherit;cursor:pointer;flex:none;border:0;border-bottom:2px solid transparent;background:transparent;padding:8px 14px;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#999)}',
    '.dsm-lingxi-tab-active{color:var(--dsw-alias-label-primary,#e6e6e6);border-bottom-color:var(--dsw-alias-brand-primary,#5686fe)}',
    '.dsm-lingxi-tab:focus-visible,.dsm-lingxi-page-back:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:-2px}',
    '.dsm-lingxi-panel{display:flex;flex-direction:column;gap:12px;min-width:0}',
    '.dsm-lingxi-panel[hidden]{display:none}',
    '.dsm-lingxi-card{min-width:0;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);background:var(--dsw-alias-bg-layer-3,#202126);padding:14px 16px;box-sizing:border-box}',
    // 最后一行不画分隔线：它下面紧接着的是卡片自己的内边距，多一条线看起来像内容被截断。
    // 行样式是内联的（保留了原有实现），所以这里必须用 !important 才盖得住。
    '.dsm-lingxi-card>:last-child{border-bottom:0 !important}',
    '.dsm-lingxi-card>div,.dsm-lingxi-card li{flex-wrap:wrap}',
    '.dsm-lingxi-card input,.dsm-lingxi-card select,.dsm-lingxi-card button{max-width:100%}'
  ].join('\n');

  var zh = {
    tabAccount: '账号',
    tabModels: '模型',
    tabTasks: '任务',
    tabSettings: '设置',
    tabDiag: '诊断',
    backToChat: '返回对话',
    openPanel: '打开灵犀面板',
    checkinPending: '今日未签到',

    metaTitle: 'DSH Connect WPS 灵犀',
    metaDescription:
      '把 WPS 灵犀接入 DSH：原生工具调用与思考通道直通，这里管理智点余额、签到与模型目录。',
    name: 'WPS 灵犀',
    pill: '灵犀',
    pillCredits: '灵犀 · {total}',
    pillUnknown: '灵犀 · —',
    pillAccount: 'WPS灵犀 · {total} 智点',
    pillAccountUnknown: 'WPS灵犀 · — 智点',
    pillAccountHint: '灵犀 · 当前账号 {account}（点开看各账号余额与签到）',
    pillPanelTitle: '灵犀 积分',
    pillRefresh: '刷新',
    pillRefreshHint: '重新读一次各账号余额',
    pillSettings: '设置',
    pillAccountColumn: '账号',
    pillCreditsColumn: '积分',
    pillAccountCurrent: '当前选用',
    pillAccountIdle: '未加入账号池',
    pillAccountError: '{error}',
    pillUnknownValue: '—',
    pillLoading: '读取中…',
    pillNoAccounts: '本机还没有保存账号',
    pillNoRows: '余额没读到',
    pillRefreshedAt: '最近刷新 {time}',
    balance: '智点余额',
    balanceValue: '{total} 智点',
    consumed: '已用 {consumed} / {value}',
    expiring: '临时积分 {amount} 智点 · {date} 到期',
    noExpiring: '15 天内没有积分到期',
    refreshedAt: '更新于 {time}',
    refresh: '刷新',
    refreshing: '刷新中…',
    checkin: '签到',
    checkinDone: '今日已签到',
    checkinStreak: '已连续 {days} 天',
    checkinReward: '签到成功 +{reward} 智点',
    claimOneTime: '领取可领任务',
    tasks: '任务中心',
    noTasks: '任务中心暂时读不到',
    reward: '+{reward} 智点',
    statusClaimed: '已领取',
    statusClaimable: '可领取',
    statusIncomplete: '未完成',
    statusLocked: '未解锁',
    models: '模型目录',
    modelsHint: '勾选决定哪些模型出现在 DSH 的模型选择器里；「图片」控制该模型能不能接收图片输入。点一下即生效。',
    noModels: '还没有读到模型目录',
    modelEnable: '启用',
    modelImage: '图片',
    modelLastOne: '至少保留一个模型',
    modelImageNativeOff: '上游未声明支持图片；勾上表示你自己确认过它可用',
    multiplier: '倍率 {value}',
    vision: '图片',
    reasoning: '思考',
    diagnostic: '诊断',
    diagVersion: '插件版本',
    diagLogin: '登录态',
    navPanel: 'WPS 灵犀',
    diagSource: '登录来源',
    diagAccount: '账号',
    diagError: '上游最近一次错误',
    diagNone: '无',
    loginSignedIn: '已登录',
    loginSignedOut: '未登录',
    loginExpired: '登录态已失效',
    sourceManual: '手动粘贴',
    sourceClient: '本机灵犀客户端',
    sourceBrowser: '浏览器登录态',
    sourceNone: '无',
    loginNow: '登录灵犀',
    logoutNow: '忘记登录态',
    logoutHint: '只删插件自己保存的那份登录态，不会退出你浏览器或客户端里的灵犀登录',
    accountsPool: '账号池',
    accountsPoolCount: '已选 {selected} / {total}',
    poolEnabled: '启用账号池',
    poolEnabledHint: '开启后由账号池在勾选的账号里挑一个来用；关闭时只用你手动选定的那个。',
    claimSelected: '签到勾选的账号',
    testSelected: '测试勾选的账号',
    useThisAccount: '切到这里',
    accountCurrent: '当前',
    switchAccountHint: '点一下切到这个账号',
    selectionLostHint: '你之前选中的账号已经不在这台机器上了，请从上面的列表里重新选一个。',
    loggingIn: '登录窗口已打开…',
    loginHint: '会自动读取本机灵犀客户端或你浏览器里的登录态；都没有时点下面这个按钮登录一次。',
    signedOutHint:
      '未读到 WPS 灵犀登录态。插件会自动读取本机灵犀客户端与你日常浏览器（Chrome / Edge 等）的登录，也可以点「登录灵犀」在你自己的浏览器里登录一次。',
    settings: '设置',
    autoCheckin: '每天自动签到',
    composerPill: '在输入框显示智点读数',
    sidebarPanel: '在侧边栏显示灵犀面板',
    pollInterval: '刷新间隔',
    poll1: '1 分钟',
    poll5: '5 分钟',
    poll10: '10 分钟',
    poll30: '30 分钟',
    poll60: '60 分钟',
    lastAction: '最近一次操作',
    copyDiagnostics: '复制诊断信息',
    copied: '已复制',
  };

  var en = {
    tabAccount: 'Account',
    tabModels: 'Models',
    tabTasks: 'Tasks',
    tabSettings: 'Settings',
    tabDiag: 'Diagnostics',
    backToChat: 'Back to chat',
    openPanel: 'Open Lingxi panel',
    checkinPending: 'Not checked in today',

    metaTitle: 'DSH Connect WPS Lingxi',
    metaDescription:
      'WPS Lingxi as a DSH model provider: native tool calls and reasoning passthrough, with credits, check-in and the model catalog managed here.',
    name: 'WPS Lingxi',
    pill: 'Lingxi',
    pillCredits: 'Lingxi · {total}',
    pillUnknown: 'Lingxi · —',
    pillAccount: 'WPS Lingxi · {total} credits',
    pillAccountUnknown: 'WPS Lingxi · — credits',
    pillAccountHint: 'Lingxi · current account {account} (click for per-account balances)',
    pillPanelTitle: 'Lingxi credits',
    pillRefresh: 'Refresh',
    pillRefreshHint: 'Read every account balance again',
    pillSettings: 'Settings',
    pillAccountColumn: 'Account',
    pillCreditsColumn: 'Credits',
    pillAccountCurrent: 'in use',
    pillAccountIdle: 'not in pool',
    pillAccountError: '{error}',
    pillUnknownValue: '—',
    pillLoading: 'Reading…',
    pillNoAccounts: 'No accounts saved on this machine',
    pillNoRows: 'Balances unavailable',
    pillRefreshedAt: 'Updated {time}',
    balance: 'Credit balance',
    balanceValue: '{total} credits',
    consumed: 'Used {consumed} / {value}',
    expiring: '{amount} credits expire in 15 days · {date}',
    noExpiring: 'Nothing expires within 15 days',
    refreshedAt: 'updated {time}',
    refresh: 'Refresh',
    refreshing: 'Refreshing…',
    checkin: 'Check in',
    checkinDone: 'Checked in today',
    checkinStreak: '{days} days in a row',
    checkinReward: 'Checked in +{reward} credits',
    claimOneTime: 'Claim available tasks',
    tasks: 'Task center',
    noTasks: 'Task center unavailable',
    reward: '+{reward} credits',
    statusClaimed: 'Claimed',
    statusClaimable: 'Claimable',
    statusIncomplete: 'Incomplete',
    statusLocked: 'Locked',
    models: 'Models',
    modelsHint: 'Tick the models DSH should offer; “Images” decides whether that model accepts image input. Changes apply immediately.',
    noModels: 'No model catalog yet',
    modelEnable: 'Enabled',
    modelImage: 'Images',
    modelLastOne: 'Keep at least one model',
    modelImageNativeOff: 'The vendor does not document image input for this model; ticking it means you verified it works',
    multiplier: 'x{value}',
    vision: 'Images',
    reasoning: 'Reasoning',
    diagnostic: 'Diagnostics',
    diagVersion: 'Plugin version',
    diagLogin: 'Sign-in',
    navPanel: 'WPS Lingxi',
    diagSource: 'Credential source',
    diagAccount: 'Account',
    diagError: 'Last upstream error',
    diagNone: 'None',
    loginSignedIn: 'Signed in',
    loginSignedOut: 'Signed out',
    loginExpired: 'Sign-in expired',
    sourceManual: 'Pasted cookie',
    sourceClient: 'Lingxi desktop app',
    sourceBrowser: 'Browser sign-in',
    sourceNone: 'None',
    loginNow: 'Sign in to Lingxi',
    logoutNow: 'Forget sign-in',
    logoutHint: 'Removes only the copy this plugin stored; your browser or desktop app stays signed in',
    accountsPool: 'Accounts',
    accountsPoolCount: '{selected} of {total} selected',
    poolEnabled: 'Enable account pool',
    poolEnabledHint: 'When on, the pool picks among the accounts you ticked. When off, only your selected account is used.',
    claimSelected: 'Check in ticked accounts',
    testSelected: 'Test ticked accounts',
    useThisAccount: 'Use this',
    accountCurrent: 'current',
    switchAccountHint: 'Click to switch to this account',
    selectionLostHint: 'The account you picked is gone from this machine. Choose another one above.',
    loggingIn: 'Sign-in window is open…',
    loginHint:
      'The plugin reads your Lingxi desktop app or your browser sign-in automatically. If neither is found, sign in once with the button below.',
    signedOutHint:
      'No WPS Lingxi sign-in found. The plugin reads the desktop app and your daily browser (Chrome / Edge, …) automatically, or press “Sign in to Lingxi” to sign in once in your own browser.',
    settings: 'Settings',
    autoCheckin: 'Check in daily on its own',
    composerPill: 'Show credits in the composer',
    sidebarPanel: 'Show a Lingxi panel in the sidebar',
    pollInterval: 'Refresh interval',
    poll1: '1 minute',
    poll5: '5 minutes',
    poll10: '10 minutes',
    poll30: '30 minutes',
    poll60: '60 minutes',
    lastAction: 'Last action',
    copyDiagnostics: 'Copy diagnostics',
    copied: 'Copied',
  };

  var loader = globalThis.__ModuleLoader__;
  if (loader === undefined) return;

  loader.load({
    id: BUNDLE_NAME,
    factory: function factory(require) {
      var React = require('react');
      var h = React.createElement;

      /** 数字格式化：拿不到就显示破折号，绝不显示 `NaN`。 */
      function credits(value) {
        if (value === undefined || value === null || !Number.isFinite(value)) return '—';
        return value.toLocaleString();
      }

      /**
       * 不带千分位的数字：`3000` 而不是 `3,000`。
       *
       * 输入框那颗胶囊只放得下很短的一行，逗号在这种小字号里会被读成一个
       * 多余的字符；账号表里空间充足，仍用 {@link credits} 的千分位。
       */
      function plainCredits(value) {
        if (value === undefined || value === null || !Number.isFinite(value)) return '—';
        return String(Math.round(value));
      }

      /**
       * 输入框里显示的当前账号名（短形式）。
       *
       * 账号名在上游就是一个 `uid-895137935` 这样的串，没有昵称。整串贴到
       * 输入框里会把模型选择器挤开，所以去掉 `uid-` 前缀、超长再省略中间。
       *
       * 按 `current` 取，不按 `selected`：用户点选的与真在用的可能不是一个
       * （账号被删、或者池子挑了别人），而这个读数要回答的是「这一条消息
       * 由哪个账号出账」。
       * @param status - 状态文档。
       * @returns 账号短名，没有账号时为 `undefined`。
       */
      function currentAccountName(status) {
        if (status === undefined || !Array.isArray(status.accounts)) return undefined;
        var current = undefined;
        for (var index = 0; index < status.accounts.length; index += 1) {
          if (status.accounts[index].current === true) {
            current = status.accounts[index];
            break;
          }
        }
        if (current === undefined) return undefined;
        var name = String(current.name === undefined ? current.id : current.name);
        if (name.indexOf('uid-') === 0) name = name.slice(4);
        return name.length > 12 ? name.slice(0, 6) + '…' + name.slice(-4) : name;
      }

      /** 时间格式化到分钟。 */
      function clock(ms) {
        if (ms === undefined || !Number.isFinite(ms)) return '—';
        var date = new Date(ms);
        return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      }

      /** 短日期：`2026-11-30T…` → `11-30`。 */
      function shortDate(value) {
        if (typeof value !== 'string') return '—';
        var match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
        return match === null ? value : match[2] + '-' + match[3];
      }

      /**
       * 登录来源的展示名。
       *
       * 抽成模块级函数的原因：**同一套映射要用在两处**（登录组一处、账号池每行
       * 一处）。复制两遍以后改一处忘一处，就会出现「上面的登录态说浏览器、
       * 下面的账号池说手动」这种自相矛盾的界面。
       *
       * 必须是模块级而不能放在某个组件内部：两处调用分属不同组件，
       * 组件内定义的函数在另一个组件里看不到（真踩过：`labelOfSource is not defined`）。
       * @param {Function} t - 翻译函数。
       * @param {string} source - 来源 id。
       * @returns {string} 展示名。
       */
      function labelOfSource(t, source) {
        if (source === 'manual') return t('sourceManual');
        if (source === 'client') return t('sourceClient');
        if (source === 'browser') return t('sourceBrowser');
        // 我们自己拉起浏览器拿到的，对用户就是「浏览器登录态」。
        if (source === 'login') return t('sourceBrowser');
        return t('sourceNone');
      }

      // ── 共享 store：一个 ticker 服务所有界面 ────────────────────────────
      var listeners = new Set();
      var snapshot;
      var timer;
      // 导航观察者不拥有轮询；页面订阅者单独计数，避免 watch 影响首订阅与末次退订。
      var subscriberCount = 0;

      function watch(listener) {
        listeners.add(listener);
        return function () {
          listeners.delete(listener);
        };
      }

      function load() {
        return fetch(STATUS_PATH, { headers: { accept: 'application/json' } })
          .then(function (response) {
            if (!response.ok) return undefined;
            return response.json();
          })
          .then(function (document) {
            if (document === undefined) return;
            snapshot = document;
            listeners.forEach(function (listener) {
              listener(snapshot);
            });
          })
          .catch(function () {
            // 一次轮询失败不值得把读数变成空白：保留上一次的值。
          });
      }

      function subscribe(listener) {
        listeners.add(listener);
        subscriberCount += 1;
        if (subscriberCount === 1) {
          void load();
          timer = setInterval(function () {
            void load();
          }, POLL_INTERVAL_MS);
        }
        return function () {
          listeners.delete(listener);
          subscriberCount -= 1;
          if (subscriberCount === 0 && timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
          }
        };
      }

      /** 读共享状态。返回 `[status, reload]`。 */
      function useStatus() {
        var state = React.useState(snapshot);
        var status = state[0];
        var setStatus = state[1];
        React.useEffect(function () {
          return subscribe(setStatus);
        }, []);
        return [
          status,
          function () {
            void load();
          },
        ];
      }

      /** 发一个动作并立刻重读状态（不乐观更新：界面显示上游的真读数）。 */
      function act(action, body) {
        return fetch(ACTION_PATH + '?action=' + encodeURIComponent(action), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body === undefined ? {} : body),
        })
          .then(function (response) {
            return response.ok ? response.json() : undefined;
          })
          .catch(function () {
            return undefined;
          })
          .then(function (result) {
            void load();
            return result;
          });
      }

      // ── 样式 ───────────────────────────────────────────────────────────
      var surface = 'var(--dsw-alias-bg-layer-2, #24262c)';
      var border = '1px solid var(--dsw-alias-border-l2, #3a3d45)';
      var textPrimary = 'var(--dsw-alias-label-primary, #e8e9ed)';
      var textSecondary = 'var(--dsw-alias-label-secondary, #b8bcc4)';
      var textTertiary = 'var(--dsw-alias-label-tertiary, #8b8f98)';

      var css = {
        root: {
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          fontSize: '13px',
          lineHeight: 1.6,
          color: textPrimary,
          minWidth: 0,
        },
        head: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
        title: { margin: 0, fontSize: '16px', fontWeight: 600, lineHeight: 1.4 },
        version: { fontSize: '12px', color: textTertiary },
        desc: { margin: 0, fontSize: '12px', lineHeight: 1.6, color: textTertiary },
        card: {
          border: border,
          borderRadius: '12px',
          background: surface,
          padding: '14px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          minWidth: 0,
        },
        // DSH 设置页风格：分组无外框，标题小写灰字，行之间用细分隔线。
        group: {
          display: 'flex',
          flexDirection: 'column',
          gap: '2px',
          minWidth: 0,
        },
        groupHead: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          padding: '10px 0 6px',
          borderBottom: border,
          minWidth: 0,
        },
        groupTitle: {
          fontSize: '13px',
          fontWeight: 600,
          color: textPrimary,
        },
        groupLine: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
          padding: '9px 0',
          borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.18))',
          minWidth: 0,
        },
        rowLabel: { fontSize: '13px', color: textPrimary, flexShrink: 0 },
        /** 账号池一行：整行可点，所以要有 hover 提示（cursor + 内边距）。 */
        accountRow: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '6px 4px',
          borderRadius: '6px',
          cursor: 'pointer',
        },
        /** 「当前在用」的实心圆点。 */
        accountDotOn: {
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: 'var(--dsw-accent, #4c8dff)',
          flexShrink: 0,
        },
        /** 非当前账号的空心圆点。 */
        accountDotOff: {
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          border: '1px solid var(--dsw-border, #c9ccd1)',
          flexShrink: 0,
        },
        /** 模型名 + 徽标排成一行；徽标紧跟名字，不参与右对齐。 */
        modelNameRow: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', minWidth: 0 },
        /** 官网徽标：橙边框小圆角，与官网截图同一形状（不抢名字的字重）。 */
        badge: {
          fontSize: '10px',
          lineHeight: '15px',
          padding: '0 6px',
          borderRadius: '999px',
          border: '1px solid var(--dsw-warning, #d0a215)',
          color: 'var(--dsw-warning, #d0a215)',
          whiteSpace: 'nowrap',
        },
        rowValue: { fontSize: '12px', color: textSecondary, textAlign: 'right', minWidth: 0, overflowWrap: 'anywhere' },
        big: { fontSize: '22px', fontWeight: 600, lineHeight: 1.2 },
        row: { display: 'flex', justifyContent: 'space-between', gap: '16px', minWidth: 0 },
        muted: { fontSize: '12px', color: textTertiary },
        actions: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
        button: {
          appearance: 'none',
          font: 'inherit',
          fontSize: '12px',
          lineHeight: '20px',
          padding: '3px 12px',
          borderRadius: '8px',
          border: border,
          background: 'transparent',
          color: textPrimary,
          cursor: 'pointer',
          minHeight: '28px',
        },
        buttonPrimary: {
          appearance: 'none',
          font: 'inherit',
          fontSize: '12px',
          lineHeight: '20px',
          padding: '3px 12px',
          borderRadius: '8px',
          border: '1px solid transparent',
          background: textPrimary,
          color: 'var(--dsw-alias-bg-base, #181818)',
          cursor: 'pointer',
          minHeight: '28px',
          fontWeight: 600,
        },
        buttonDisabled: { opacity: 0.5, cursor: 'default' },
        list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '6px' },
        item: {
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px',
          minWidth: 0,
        },
        itemMain: { display: 'flex', flexDirection: 'column', minWidth: 0 },
        itemName: { fontSize: '13px', color: textPrimary, overflow: 'hidden', textOverflow: 'ellipsis' },
        itemMeta: { fontSize: '11px', color: textTertiary },
        pillGroup: { display: 'flex', gap: '4px', flexWrap: 'wrap', justifyContent: 'flex-end' },
        tag: {
          fontSize: '11px',
          lineHeight: '16px',
          padding: '0 6px',
          borderRadius: '999px',
          border: border,
          color: textSecondary,
          whiteSpace: 'nowrap',
        },
        tagOn: {
          fontSize: '11px',
          lineHeight: '16px',
          padding: '0 6px',
          borderRadius: '999px',
          border: '1px solid transparent',
          background: textPrimary,
          color: 'var(--dsw-alias-bg-base, #181818)',
          whiteSpace: 'nowrap',
        },
        warning: { fontSize: '12px', color: 'var(--dsw-warning, #d0a215)' },
        error: { fontSize: '12px', color: 'var(--dsw-danger, #e05c5c)', wordBreak: 'break-all' },
        checkbox: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: textSecondary },
        checkboxOff: { opacity: 0.55, cursor: 'default' },
        select: {
          font: 'inherit',
          fontSize: '12px',
          padding: '2px 6px',
          borderRadius: '6px',
          border: border,
          background: 'transparent',
          color: textPrimary,
        },
        pre: {
          margin: 0,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '11px',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: textSecondary,
        },
      };

      /** 把 `{name}` 占位符换成参数。 */
      function format(template, params) {
        if (typeof template !== 'string') return '';
        return template.replace(/\{(\w+)\}/g, function (_match, name) {
          return params !== undefined && params[name] !== undefined ? String(params[name]) : '';
        });
      }

      /** 插件的兜底翻译器（宿主没给 `t` 时用）。 */
      function translator(props) {
        if (typeof props.t === 'function') return props.t;
        return function (key, params) {
          return format(zh[key] === undefined ? key : zh[key], params);
        };
      }

      /** 一级分组卡片：保留标题 + 细分隔线 + 行，外层提供边框与底色。 */
      function section(t, title) {
        // 调用方传入多行内容；全部留在卡片内，不能把第四参当标题附件或丢掉后续行。
        var kids = Array.prototype.slice.call(arguments, 2);
        return h.apply(null, [
          'section',
          { className: 'dsm-lingxi-card', style: css.group },
          h('div', { style: css.groupHead }, h('div', { style: css.groupTitle }, title))
        ].concat(kids));
      }

      /** 一行 label / value（左标签 + 右控件，对齐 DSH 设置页的行布局）。 */
      function line(label, value, valueStyle) {
        return h(
          'div',
          { style: css.row },
          h('span', { style: css.rowLabel }, label),
          h('span', { style: valueStyle === undefined ? css.rowValue : valueStyle }, value),
        );
      }

      var STATUS_LABEL = {
        claimed: 'statusClaimed',
        claimable: 'statusClaimable',
        incomplete: 'statusIncomplete',
        locked: 'statusLocked',
      };

      // ── 余额块 ─────────────────────────────────────────────────────────
      function BalanceBlock(props) {
        var t = props.t;
        var credits_ = props.credits;
        var refresh = props.refresh;
        var busy = props.busy;
        if (credits_ === undefined || credits_.state !== 'ok' || credits_.total === undefined) {
          var reason =
            credits_ !== undefined && credits_.state === 'expired' ? t('loginExpired') : t('noTasks');
          return section(
            t,
            t('balance'),
            h(
              'div',
              { style: css.groupLine },
              h('span', { style: css.muted }, reason),
              h(
                'button',
                {
                  type: 'button',
                  style: busy ? assign(css.button, css.buttonDisabled) : css.button,
                  disabled: busy,
                  onClick: refresh,
                },
                busy ? t('refreshing') : t('refresh'),
              ),
            ),
          );
        }
        var hasQuota = credits_.totalValue > 0 && credits_.consumed !== undefined;
        return section(
          t,
          t('balance'),
          h('div', { style: css.groupLine }, h('div', { style: css.big }, t('balanceValue', { total: credits(credits_.total) }))),
          hasQuota
            ? h(
                'div',
                { style: css.groupLine },
                h('span', { style: css.rowLabel }, t('consumed', { consumed: credits(credits_.consumed), value: credits(credits_.totalValue) })),
              )
            : null,
          credits_.expiring !== undefined && credits_.expiring.amount > 0
            ? h(
                'div',
                { style: css.groupLine },
                h('span', { style: css.warning }, t('expiring', { amount: credits(credits_.expiring.amount), date: shortDate(credits_.expiring.earliest) })),
              )
            : h('div', { style: css.groupLine }, h('span', { style: css.muted }, t('noExpiring'))),
          h(
            'div',
            { style: css.actions },
            h(
              'button',
              {
                type: 'button',
                style: busy ? assign(css.button, css.buttonDisabled) : css.button,
                disabled: busy,
                onClick: refresh,
              },
              busy ? t('refreshing') : t('refresh'),
            ),
            credits_.updatedAtMs !== undefined
              ? h('span', { style: css.muted }, t('refreshedAt', { time: clock(credits_.updatedAtMs) }))
              : null,
          ),
        );
      }

      /** 两个 style 对象合并（后者优先）。 */
      function assign(first, second) {
        return Object.assign({}, first, second);
      }

      // ── 任务块 ─────────────────────────────────────────────────────────
      function TaskBlock(props) {
        var t = props.t;
        var tasks = props.tasks;
        var busy = props.busy;
        var onCheckin = props.onCheckin;
        var onClaim = props.onClaim;
        var daily = tasks === undefined ? undefined : tasks.daily;
        var oneTime = tasks === undefined ? [] : tasks.oneTime;
        if (daily === undefined && oneTime.length === 0) {
          return section(t, t('tasks'), h('div', { style: css.muted }, t('noTasks')));
        }
        var claimable = oneTime.filter(function (task) {
          return task.status === 'claimable';
        });
        return section(
          t,
          t('tasks'),
          daily === undefined
            ? null
            : h(
                'div',
                { style: css.groupLine },
                h(
                  'div',
                  { style: css.itemMain },
                  h('span', { style: css.rowLabel }, daily.title),
                  h(
                    'span',
                    { style: css.itemMeta },
                    [t('reward', { reward: credits(daily.reward) })]
                      .concat(daily.streak === undefined ? [] : [t('checkinStreak', { days: daily.streak })])
                      .join(' · '),
                  ),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    style:
                      daily.status === 'claimed' || busy
                        ? assign(css.button, css.buttonDisabled)
                        : css.buttonPrimary,
                    disabled: daily.status === 'claimed' || busy,
                    onClick: onCheckin,
                  },
                  daily.status === 'claimed' ? t('checkinDone') : t('checkin'),
                ),
              ),
          oneTime.length === 0
            ? null
            : h(
                'ul',
                { style: css.list },
                oneTime.map(function (task) {
                  var labelKey = STATUS_LABEL[task.status];
                  return h(
                    'li',
                    { key: task.key, style: css.groupLine },
                    h(
                      'div',
                      { style: css.itemMain },
                      h('span', { style: css.rowLabel }, task.title),
                      h('span', { style: css.itemMeta }, t('reward', { reward: credits(task.reward) })),
                    ),
                    h(
                      'span',
                      { style: task.status === 'claimable' ? css.tagOn : css.tag },
                      labelKey === undefined ? task.status : t(labelKey),
                    ),
                  );
                }),
              ),
          claimable.length === 0
            ? null
            : h(
                'div',
                { style: css.actions },
                h(
                  'button',
                  {
                    type: 'button',
                    style: busy ? assign(css.button, css.buttonDisabled) : css.button,
                    disabled: busy,
                    onClick: onClaim,
                  },
                  t('claimOneTime'),
                ),
              ),
        );
      }

      // ── 模型块 ─────────────────────────────────────────────────────────
      /**
       * 一行一个模型，行首是「启用」勾选框，行尾是「图片」勾选框。
       *
       * 为什么勾选框而不是去「设置 → 模型」里选：那是 DSH 自己的模型表单，
       * 灵犀的 provider 是 `declared: false` 的动态目录，在那里改一次要过
       * 「保存 → 重载插件」，而这两个开关的要求是「点一下立刻生效」。
       *
       * 两个勾选框的状态都来自宿主 `/status`（**生效后的值**），不做乐观更新：
       * 勾完立刻重读，界面显示的就是下一次请求真的会用的能力。
       */
      function ModelBlock(props) {
        var t = props.t;
        var models = props.models;
        var busy = props.busy === true;
        var onToggleEnabled = props.onToggleEnabled;
        var onToggleImage = props.onToggleImage;
        if (models.length === 0) {
          return section(t, t('models'), h('div', { style: css.muted }, t('noModels')));
        }
        var enabledCount = 0;
        models.forEach(function (model) {
          if (model.enabled !== false) enabledCount += 1;
        });
        /** 最后一个启用的模型不许关：全关掉之后选择器里就一个灵犀模型都没有了。 */
        function isLastEnabled(model) {
          return model.enabled !== false && enabledCount <= 1;
        }
        return section(
          t,
          t('models'),
          h('div', { style: css.muted }, t('modelsHint')),
          h(
            'ul',
            { style: css.list },
            models.map(function (model) {
              var last = isLastEnabled(model);
              return h(
                'li',
                { key: model.id, style: css.groupLine },
                h(
                  'label',
                  {
                    style: last ? assign(css.checkbox, css.checkboxOff) : css.checkbox,
                    title: last ? t('modelLastOne') : undefined,
                  },
                  h('input', {
                    type: 'checkbox',
                    checked: model.enabled !== false,
                    disabled: busy || last,
                    onChange: function (event) {
                      onToggleEnabled(model.id, event.target.checked === true);
                    },
                  }),
                  h(
                    'span',
                    { style: css.itemMain },
                    h(
                      'span',
                      { style: css.modelNameRow },
                      h('span', { style: css.rowLabel }, model.name),
                      // 官网的徽标（NEW / 正式版 / 首发接入）原样显示：用户在选择器里
                      // 认的也是这几个字，卡片上没有就成了两套说法。
                      model.badge === undefined
                        ? null
                        : h('span', { style: css.badge }, String(model.badge)),
                    ),
                    h(
                      'span',
                      { style: css.itemMeta },
                      [
                        model.multiplier === '' ? '' : t('multiplier', { value: model.multiplier }),
                        credits(Math.round(model.contextWindow / 1024)) + 'K',
                      ]
                        .filter(function (part) {
                          return part !== '';
                        })
                        .join(' · '),
                    ),
                    model.description === undefined
                      ? null
                      : h('span', { style: css.itemMeta }, String(model.description)),
                  ),
                ),
                h(
                  'div',
                  { style: css.pillGroup },
                  model.reasoning ? h('span', { style: css.tag }, t('reasoning')) : null,
                  h(
                    'label',
                    {
                      style: css.checkbox,
                      // 上游没声明支持图片时说明「勾上等于你自己担保」，否则用户会以为
                      // 勾选框只是把上游已经支持的能力显示出来。
                      title: model.visionNative === true ? undefined : t('modelImageNativeOff'),
                    },
                    h('input', {
                      type: 'checkbox',
                      checked: model.vision === true,
                      disabled: busy,
                      onChange: function (event) {
                        onToggleImage(model.id, event.target.checked === true);
                      },
                    }),
                    h('span', null, t('modelImage')),
                  ),
                ),
              );
            }),
          ),
        );
      }

      // ── 设置块（点一下即生效，不走保存） ───────────────────────────────
      var POLL_CHOICES = [
        [60000, 'poll1'],
        [300000, 'poll5'],
        [600000, 'poll10'],
        [1800000, 'poll30'],
        [3600000, 'poll60'],
      ];

      function SettingsBlock(props) {
        var t = props.t;
        var settings = props.settings;
        var onToggle = props.onToggle;
        var onInterval = props.onInterval;
        if (settings === undefined) {
          return section(t, t('settings'), h('div', { style: css.muted }, t('noTasks')));
        }
        return section(
          t,
          t('settings'),
          checkbox(t, t('autoCheckin'), settings.autoCheckin === true, function (checked) {
            onToggle('autoCheckin', checked);
          }),
          checkbox(t, t('composerPill'), settings.composerPill === true, function (checked) {
            onToggle('composerPill', checked);
          }),
          checkbox(t, t('sidebarPanel'), settings.sidebarPanel === true, function (checked) {
            onToggle('sidebarPanel', checked);
          }),
          h(
            'div',
            { style: css.groupLine },
            h('span', { style: css.rowLabel }, t('pollInterval')),
            h(
              'select',
              {
                style: css.select,
                value: String(settings.pollIntervalMs),
                onChange: function (event) {
                  onInterval(Number(event.target.value));
                },
              },
              POLL_CHOICES.map(function (choice) {
                return h('option', { key: choice[0], value: String(choice[0]) }, t(choice[1]));
              }),
            ),
          ),
        );
      }

      function checkbox(t, label, checked, onChange) {
        return h(
          'label',
          { style: css.checkbox },
          h('input', {
            type: 'checkbox',
            checked: checked,
            onChange: function (event) {
              onChange(event.target.checked === true);
            },
          }),
          h('span', null, label),
        );
      }

      // ── 诊断块 ─────────────────────────────────────────────────────────
      function DiagnosticBlock(props) {
        var t = props.t;
        var status = props.status;
        if (status === undefined) return null;
        var login = status.login === undefined ? { state: 'signed-out', source: 'none' } : status.login;
        var loginLabel =
          login.state === 'signed-in'
            ? t('loginSignedIn')
            : login.state === 'expired'
              ? t('loginExpired')
              : t('loginSignedOut');
        var sourceLabel = labelOfSource(t, login.source);
        return section(
          t,
          t('diagnostic'),
          h('div', { style: css.groupLine }, h('span', { style: css.rowLabel }, t('diagVersion')), h('span', { style: css.rowValue }, status.version === undefined ? '—' : String(status.version))),
          h('div', { style: css.groupLine }, h('span', { style: css.rowLabel }, t('diagLogin')), h('span', { style: css.rowValue }, loginLabel)),
          h('div', { style: css.groupLine }, h('span', { style: css.rowLabel }, t('diagSource')), h('span', { style: css.rowValue }, sourceLabel)),
          login.name === undefined ? null : h('div', { style: css.groupLine }, h('span', { style: css.rowLabel }, t('diagAccount')), h('span', { style: css.rowValue }, login.name)),
          h(
            'div',
            { style: css.groupLine },
            h('span', { style: css.rowLabel }, t('diagError')),
            h(
              'span',
              { style: css.rowValue },
              status.lastError === undefined ? t('diagNone') : h('span', { style: css.error }, String(status.lastError)),
            ),
          ),
        );
      }

      // ── 插件详情页（`plugins.bundle.config`） ───────────────────────────
      function PanelIcon(props) {
        var size = typeof props.size === 'number' ? props.size : 16;
        return h('svg', {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': true, style: { flexShrink: 0, color: props.active === true ? textPrimary : textTertiary }
        },
          h('path', { d: 'M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z' }),
          h('path', { d: 'M19 3l.9 2.1L22 6l-2.1.9L19 9l-.9-2.1L16 6l2.1-.9z' })
        );
      }

      function PluginPage(props) {
        var t = translator(props);
        var state = useStatus();
        var status = state[0];
        var reload = state[1];
        var busyState = React.useState(false);
        var busy = busyState[0];
        var setBusy = busyState[1];
        var lastState = React.useState('');
        var lastAction = lastState[0];
        var setLastAction = lastState[1];
        var tabState = React.useState('tabAccount');
        var activeTab = tabState[0];
        var setActiveTab = tabState[1];
        var tabs = ['tabAccount', 'tabModels', 'tabTasks', 'tabSettings', 'tabDiag'];
        function panel(key, children) {
          return h('div', {
            className: 'dsm-lingxi-panel', role: 'tabpanel',
            'aria-label': t(key), hidden: activeTab !== key
          }, children);
        }

        /** 动作的统一包装：置忙、执行、把结果写成一行话。 */
      function perform(action, body, describe) {
          setBusy(true);
          return act(action, body)
            .then(function (result) {
              setLastAction(describe(result));
              if (
                action === 'claim-checkin' ||
                action === 'claim-one-time' ||
                action === 'refresh' ||
                action === 'login' ||
                action === 'logout' ||
                action === 'switch-account'
              ) {
                reload();
              }
            })
            .catch(function () {
              setLastAction('');
            })
            .then(function () {
              setBusy(false);
            });
        }

        // 插件列表那一行：只给一句摘要，别把一个 2000 像素高的页面塞进列表。
        if (props.view === 'summary') {
          if (status === undefined) return h('span', null, '—');
          var totalSummary =
            status.credits === undefined || status.credits.total === undefined
              ? t('pillUnknown')
              : t('balanceValue', { total: credits(status.credits.total) });
          var suffix = status.tasks !== undefined && status.tasks.checkedInToday === true ? ' · ' + t('checkinDone') : '';
          return h('span', { 'data-lingxi-summary': true }, totalSummary + suffix);
        }

        var signedOut = status !== undefined && status.login !== undefined && status.login.state === 'signed-out';
        var settings = status === undefined ? undefined : status.settings;

        return h(
          'div',
          {
            className: 'dsm-lingxi-page',
            style: css.root,
            'data-lingxi-page': true,
            // 供 CSS 区分「整页」与「嵌在别人的页面里」：只有整页要自己的内边距。
            'data-surface': props.surface === 'page' ? 'page' : props.surface === 'settings' ? 'settings' : 'detail',
          },
          h('div', { className: 'dsm-lingxi-page-head' },
            props.surface === 'page' && typeof props.backToConversation === 'function'
              ? h('button', { type: 'button', className: 'dsm-lingxi-page-back', onClick: props.backToConversation }, '← ' + t('backToChat'))
              : null,
            h('div', { className: 'dsm-lingxi-page-heading' },
              h(PanelIcon, { size: 32, active: true }),
              h('h2', { className: 'dsm-lingxi-page-title' }, t('metaTitle')),
              h('span', { className: 'dsm-lingxi-page-version' }, status === undefined || status.version === undefined ? '' : 'v' + String(status.version))
            ),
            h('p', { className: 'dsm-lingxi-page-desc' }, t('metaDescription'))
          ),
          h('div', { className: 'dsm-lingxi-tabs', role: 'tablist', 'aria-label': t('name') },
            tabs.map(function (key) {
              return h('button', {
                key: key, type: 'button', role: 'tab', 'aria-selected': activeTab === key,
                className: 'dsm-lingxi-tab' + (activeTab === key ? ' dsm-lingxi-tab-active' : ''),
                onClick: function () { setActiveTab(key); }
              }, t(key));
            })
          ),
          panel('tabAccount', h(React.Fragment, null,
            signedOut ? h('div', { style: css.warning }, t('signedOutHint')) : null,
            // 登录组：未登录或登录失效时给一个按钮；有登录态时只说明来源。
            section(
              t,
              t('diagLogin'),
              status === undefined || status.login === undefined
                ? h('div', { style: css.groupLine }, h('span', { style: css.muted }, '—'))
                : h(
                    'div',
                    { style: css.groupLine },
                    h(
                      'div',
                      { style: css.itemMain },
                      h(
                        'span',
                        { style: css.rowLabel },
                        status.login.state === 'signed-in'
                          ? t('loginSignedIn')
                          : status.login.state === 'expired'
                            ? t('loginExpired')
                            : t('loginSignedOut'),
                      ),
                      h('span', { style: css.itemMeta }, t('diagSource') + '：' + (
                        status.login.source === 'client' ? t('sourceClient') :
                        status.login.source === 'browser' ? t('sourceBrowser') :
                        status.login.source === 'manual' ? t('sourceManual') : t('sourceNone')
                      )),
                      h('span', { style: css.itemMeta }, t('loginHint')),
                    ),
                    h(
                      'div',
                      { style: css.pillGroup },
                      status.login.state === 'signed-in' || status.login.canLogin !== true
                        ? null
                        : h(
                            'button',
                            {
                              type: 'button',
                              style: busy ? assign(css.button, css.buttonDisabled) : css.buttonPrimary,
                              disabled: busy,
                              onClick: function () {
                                void perform('login', {}, function (result) {
                                  return result !== undefined && result.message !== undefined
                                    ? String(result.message)
                                    : '';
                                });
                              },
                            },
                            t('loginNow'),
                          ),
                      // 只有真的有登录态时才给「忘记」：没登录的时候按它没有任何可做的事，
                      // 而一个点了没反应的按钮会被当成坏了。
                      status.login.state === 'signed-in' || status.login.state === 'expired'
                        ? h(
                            'button',
                            {
                              type: 'button',
                              style: busy ? assign(css.button, css.buttonDisabled) : css.button,
                              disabled: busy,
                              title: t('logoutHint'),
                              onClick: function () {
                                void perform('logout', {}, function (result) {
                                  return result !== undefined && result.message !== undefined
                                    ? String(result.message)
                                    : '';
                                });
                              },
                            },
                            t('logoutNow'),
                          )
                        : null,
                    ),
                  ),
            ),
            // 账号池：常驻显示（即使只有一个账号）。只在多账号时出现的做法
            // 会让用户以为这个功能不存在 —— 这一点有真实反馈。
            status !== undefined && status.accountPool !== undefined
              ? h(
                  React.Fragment,
                  null,
                  section(
                    t,
                    t('accountsPool'),
                    h(
                      'div',
                      { style: css.itemMeta },
                      t('accountsPoolCount', {
                        selected: String(status.accountPool.selected),
                        total: String(status.accountPool.total),
                      }),
                    ),
                    // 池总开关：开着才允许插件在账号之间自动挑。
                    h(
                      'div',
                      { style: css.groupLine },
                      h('input', {
                        type: 'checkbox',
                        'data-pool-toggle': true,
                        checked: status.accountPool.enabled === true,
                        disabled: busy,
                        onChange: function (event) {
                          void perform(
                            'settings',
                            { accountPoolEnabled: Boolean(event.target.checked) },
                            function () {
                              return '';
                            },
                          );
                        },
                      }),
                      h(
                        'span',
                        { style: css.itemMain },
                        h('span', { style: css.rowLabel }, t('poolEnabled')),
                        h('span', { style: css.itemMeta }, t('poolEnabledHint')),
                      ),
                    ),
                    // 批量操作：只作用于勾选的账号。
                    h(
                      'div',
                      { style: css.pillGroup },
                      h(
                        'button',
                        {
                          type: 'button',
                          style: busy ? assign(css.button, css.buttonDisabled) : css.button,
                          disabled: busy || status.accountPool.selected === 0,
                          'data-pool-action': 'claim',
                          onClick: function () {
                            void perform('claim-pool-checkin', {}, function (result) {
                              return result !== undefined && result.message !== undefined
                                ? String(result.message)
                                : '';
                            });
                          },
                        },
                        t('claimSelected'),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          style: busy ? assign(css.button, css.buttonDisabled) : css.button,
                          disabled: busy || status.accountPool.selected === 0,
                          'data-pool-action': 'test',
                          onClick: function () {
                            void perform('test-pool-accounts', {}, function (result) {
                              return result !== undefined && result.message !== undefined
                                ? String(result.message)
                                : '';
                            });
                          },
                        },
                        t('testSelected'),
                      ),
                    ),
                    // 逐账号列表：勾选框（参与池）+ 点行切换当前账号 + 余额。
                    h(
                      'div',
                      null,
                      status.accounts.map(function (account) {
                        return h(
                          'div',
                          {
                            key: account.id,
                            style: css.accountRow,
                            'data-account-id': account.id,
                          },
                          // 勾选框与「切换当前」是两个独立动作，所以不能让整行
                          // 都变成切换按钮 —— 否则点勾选框会顺带切换账号。
                          h('input', {
                            type: 'checkbox',
                            'data-account-enabled': account.id,
                            checked: account.enabled === true,
                            disabled: busy,
                            onChange: function (event) {
                              if (busy) return;
                              var next = (status.accounts || [])
                                .filter(function (row) {
                                  if (row.id === account.id) return Boolean(event.target.checked);
                                  return row.enabled === true;
                                })
                                .map(function (row) {
                                  return row.id;
                                });
                              void perform('settings', { enabledAccounts: next }, function () {
                                return '';
                              });
                            },
                          }),
                          h(
                            'span',
                            { style: css.itemMain },
                            h(
                              'span',
                              { style: css.rowLabel },
                              account.name +
                                (account.current ? ' · ' + t('accountCurrent') : ''),
                            ),
                            h('span', { style: css.itemMeta }, labelOfSource(t, account.source)),
                          ),
                          // 余额：读不到显示破折号（不是 0）。
                          h(
                            'span',
                            { style: css.rowValue, 'data-account-credits': account.id },
                            account.credits === undefined
                              ? '—'
                              : credits(account.credits),
                          ),
                          // 「切换到这里」只在不是当前时出现。
                          account.current
                            ? null
                            : h(
                                'button',
                                {
                                  type: 'button',
                                  style: css.button,
                                  disabled: busy,
                                  'data-switch-account': account.id,
                                  onClick: function () {
                                    if (busy) return;
                                    void perform(
                                      'switch-account',
                                      { accountId: account.id },
                                      function (result) {
                                        return result !== undefined &&
                                          result.message !== undefined
                                          ? String(result.message)
                                          : '';
                                      },
                                    );
                                  },
                                },
                                t('useThisAccount'),
                              ),
                        );
                      }),
                    ),
                  ),
                )
              : null,
            // 用户选中的账号不在了，但池里还有别的：说清楚是「选择失效」，
            // 而不是笼统让人重新登录 —— 他的凭据通常是好的。
            status !== undefined && status.selectionLost === true
              ? h('div', { style: css.warning }, t('selectionLostHint'))
              : null,
            h(BalanceBlock, {
              t: t,
              credits: status === undefined ? undefined : status.credits,
              refresh: function () {
                void perform('refresh', {}, function () {
                  return '';
                });
              },
              busy: busy,
            }),
            // 今日签到只报状态；真正的签到按钮在「任务」页里，同一件事不出现两个按钮。
            section(
              t,
              t('checkin'),
              h(
                'div',
                { style: css.groupLine },
                h(
                  'div',
                  { style: css.itemMain },
                  h(
                    'span',
                    { style: css.rowLabel },
                    status === undefined || status.tasks === undefined
                      ? '—'
                      : status.tasks.checkedInToday === true
                        ? t('checkinDone')
                        : t('checkinPending'),
                  ),
                  status !== undefined &&
                    status.tasks !== undefined &&
                    status.tasks.daily !== undefined &&
                    status.tasks.daily.streak !== undefined
                    ? h('span', { style: css.itemMeta }, t('checkinStreak', { days: status.tasks.daily.streak }))
                    : null,
                ),
              ),
            ))),
          panel('tabModels', h(ModelBlock, {
            t: t,
            models: status === undefined || !Array.isArray(status.models) ? [] : status.models,
            busy: busy,
            onToggleEnabled: function (id, nextEnabled) {
              if (status === undefined || !Array.isArray(status.models)) return;
              // 禁用名单是**绝对**的（存「关掉的」），所以整张表重算一遍：
              // 只翻转这一行，别的行保持它们当前的生效状态。
              var disabled = [];
              status.models.forEach(function (model) {
                var enabled = model.id === id ? nextEnabled : model.enabled !== false;
                if (!enabled) disabled.push(model.id);
              });
              // 全关掉之后选择器里一个灵犀模型都不剩；界面上最后一行也是禁用的，
              // 这里再挡一次是因为状态可能比界面新。
              if (disabled.length >= status.models.length) return;
              void perform('settings', { disabledModels: disabled }, function () {
                return '';
              });
            },
            onToggleImage: function (id, nextOn) {
              if (status === undefined || !Array.isArray(status.models)) return;
              var model = undefined;
              status.models.forEach(function (item) {
                if (item.id === id) model = item;
              });
              if (model === undefined) return;
              // 两张名单只记录**与上游默认不同**的一侧：勾选回到上游声明时，
              // 两边都清掉，让默认值重新接管（上游以后改了能力也能自动跟上）。
              var off = (status.settings === undefined || !Array.isArray(status.settings.imageOffModels)
                ? []
                : status.settings.imageOffModels
              ).filter(function (item) {
                return item !== id;
              });
              var on = (status.settings === undefined || !Array.isArray(status.settings.imageOnModels)
                ? []
                : status.settings.imageOnModels
              ).filter(function (item) {
                return item !== id;
              });
              if (nextOn !== (model.visionNative === true)) {
                if (nextOn) on.push(id);
                else off.push(id);
              }
              void perform('settings', { imageOffModels: off, imageOnModels: on }, function () {
                return '';
              });
            },
          })),
          panel('tabTasks', h(TaskBlock, {
            t: t,
            tasks: status === undefined ? undefined : status.tasks,
            busy: busy,
            onCheckin: function () {
              void perform('claim-checkin', {}, function (result) {
                return result !== undefined && result.message !== undefined
                  ? String(result.message)
                  : '';
              });
            },
            onClaim: function () {
              void perform('claim-one-time', {}, function (result) {
                if (result === undefined) return '';
                var claimed = Array.isArray(result.claimed) ? result.claimed.length : 0;
                return result.message !== undefined
                  ? String(result.message)
                  : claimed > 0
                    ? t('checkinReward', { reward: credits(result.reward) })
                    : '';
              });
            },
          })),
          panel('tabSettings', h(SettingsBlock, {
            t: t,
            settings: settings,
            onToggle: function (key, value) {
              var body = {};
              body[key] = value;
              void perform('settings', body, function () {
                return '';
              });
            },
            onInterval: function (value) {
              void perform('settings', { pollIntervalMs: value }, function () {
                return '';
              });
            },
          })),
          panel('tabDiag', h(React.Fragment, null,
            h(DiagnosticBlock, { t: t, status: status }),
            lastAction === '' ? null : section(t, t('lastAction'), h('div', { style: css.muted }, lastAction)))),
        );
      }

      // ── 输入框右侧的账号+智点胶囊（`conversation.input.right`） ────────
      //
      // 为什么是 `right` 而不是 `left`：宿主把 `input.right` 渲染在模型选择器
      // **紧前面**，`input.left` 则贴着「完全权限」。读数不是操作，摆在模型旁边
      // 既符合「这个模型由谁出账」，也不会和用户真正要点的权限下拉抢点击
      // （dsh-connect-workbuddy / dsh-connect-trae 都因为这一点从 left 挪到了 right）。
      /**
       * 把一个账号名遮成参考界面那样的 `195****4950`。
       *
       * 上游账号名就是 `uid-895137935`，一串数字。整串露在输入框里没必要，
       * 遮住中间几位既能认出是哪个号，又不会把完整 uid 摆在截图里。
       * 非数字的名字（以后的昵称）整体保留 —— 遮一个中文昵称只会变成乱码。
       */
      function maskAccount(name) {
        var text = String(name === undefined || name === null ? '' : name).replace(/^uid-/, '');
        if (!/^[0-9]+$/.test(text)) return text;
        if (text.length <= 4) return text;
        if (text.length <= 7) return text.slice(0, 1) + '***' + text.slice(-2);
        return text.slice(0, 3) + '****' + text.slice(-3);
      }

      /** `灵犀 积分` 面板里一行账号：名字 / 状态 / 余额。 */
      function accountRow(t, row, index) {
        var error = typeof row.creditsError === 'string' ? row.creditsError : undefined;
        var name = row.name === undefined || row.name === null ? row.id : row.name;
        return h(
          'div',
          {
            key: String(row.id === undefined ? index : row.id),
            style: {
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: '10px',
              padding: '6px 0',
              borderTop: index === 0 ? 'none' : border,
            },
          },
          h(
            'div',
            { style: { minWidth: 0, flex: '1 1 auto' } },
            h(
              'div',
              { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
              maskAccount(name),
            ),
            row.current === true
              ? h(
                  'div',
                  { style: { color: 'var(--dsw-alias-label-success, #3aa757)', fontSize: '11px' } },
                  t('pillAccountCurrent'),
                )
              : row.enabled !== true
                ? h('div', { style: { color: textTertiary, fontSize: '11px' } }, t('pillAccountIdle'))
                : null,
            error === undefined
              ? null
              : h(
                  'div',
                  {
                    style: {
                      color: 'var(--dsw-alias-label-danger, #e5574a)',
                      fontSize: '11px',
                      lineHeight: 1.4,
                      wordBreak: 'break-word',
                    },
                  },
                  t('pillAccountError', { error: error }),
                ),
          ),
          h(
            'div',
            {
              style: {
                flex: '0 0 auto',
                fontVariantNumeric: 'tabular-nums',
                fontWeight: 600,
              },
            },
            typeof row.credits === 'number' ? credits(row.credits) : t('pillUnknownValue'),
          ),
        );
      }

      function CreditPill(props) {
        var t = translator(props);
        var state = useStatus();
        var status = state[0];
        var reload = state[1];
        var openState = React.useState(false);
        var open = openState[0];
        var setOpen = openState[1];
        // 账号表格：**只在弹层打开时**读。状态轮询是 5 分钟一次，账号有 N 个
        // 就会变成 N 倍上游请求，而灵犀按设备限流 —— 那份数据不能跟着轮询走。
        var rowsState = React.useState(undefined);
        var rows = rowsState[0];
        var setRows = rowsState[1];
        var loadingState = React.useState(false);
        var loading = loadingState[0];
        var setLoading = loadingState[1];
        var total =
          status === undefined || status.credits === undefined ? undefined : status.credits.total;
        // 当前账号：读数要回答「这个模型由哪个账号出账」，所以账号和余额一样重要。
        // 取 `current` 而不是 `selected` —— 用户点选的与真在用的可能不是一个。
        var account = currentAccountName(status);
        // 胶囊只回答「这条消息花的是哪家、还剩多少」，账号名留给 tooltip 和
        // 弹层里的账号表 —— 一行里塞「账号 · 余额」，小字号下挤成一片，
        // 而且同一串 `895****935` 在弹层标题下又出现一次。
        var label;
        if (account === undefined) {
          // 没有账号（未登录）：只报余额，不编一个产品名冒充账号。
          label = total === undefined ? t('pillUnknown') : t('pillCredits', { total: plainCredits(total) });
        } else if (total === undefined) {
          label = t('pillAccountUnknown');
        } else {
          label = t('pillAccount', { total: plainCredits(total) });
        }
        var readRows = function () {
          setLoading(true);
          act('account-balances').then(function (result) {
            setLoading(false);
            setRows(
              result === undefined || result === null || result.ok !== true ? undefined : result,
            );
          });
        };
        var toggle = function () {
          var next = !open;
          setOpen(next);
          if (next) {
            // 打开就现读一次：账号余额是「此刻」的事实，不能拿上次的糊过去。
            readRows();
            reload();
          }
        };
        var list = rows === undefined || !Array.isArray(rows.accounts) ? [] : rows.accounts;
        return h(
          'div',
          { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' }, 'data-lingxi-pill': true },
          h(
            'button',
            {
              type: 'button',
              title:
                account === undefined
                  ? t('name')
                  : t('pillAccountHint', { account: maskAccount(account) }),
              style: {
                appearance: 'none',
                background: 'transparent',
                border: '1px solid var(--dsh-composer-dock-inset, currentColor)',
                borderRadius: '999px',
                color: 'inherit',
                cursor: 'pointer',
                font: 'inherit',
                fontSize: '12px',
                lineHeight: 1.4,
                opacity: 0.8,
                padding: '1px 8px',
                whiteSpace: 'nowrap',
              },
              onClick: toggle,
            },
            label,
          ),
          open
            ? h(
                'div',
                {
                  style: {
                    position: 'absolute',
                    bottom: 'calc(100% + 6px)',
                    left: 0,
                    zIndex: 10,
                    width: '288px',
                    borderRadius: '10px',
                    background: 'var(--dsh-panel-background, Canvas)',
                    color: 'var(--dsh-panel-foreground, CanvasText)',
                    border: '1px solid var(--dsh-panel-border, currentColor)',
                    boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
                    padding: '10px 12px',
                    fontSize: '12px',
                    lineHeight: 1.6,
                    textAlign: 'left',
                  },
                },
                // 标题行：左标题，右「刷新 / 设置」。
                h(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '8px',
                      marginBottom: '6px',
                    },
                  },
                  h('div', { style: { fontWeight: 600 } }, t('pillPanelTitle')),
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
                    h(
                      'button',
                      {
                        type: 'button',
                        title: t('pillRefreshHint'),
                        style: {
                          appearance: 'none',
                          background: 'transparent',
                          border: 'none',
                          color: 'inherit',
                          cursor: 'pointer',
                          font: 'inherit',
                          opacity: loading ? 0.5 : 0.75,
                          padding: '1px 4px',
                        },
                        onClick: function () {
                          readRows();
                          reload();
                        },
                      },
                      t('pillRefresh'),
                    ),
                    typeof props.openPanel === 'function'
                      ? h(
                          'button',
                          {
                            type: 'button',
                            style: {
                              appearance: 'none',
                              background: 'var(--dsh-panel-item-active, rgba(127,127,127,0.16))',
                              border: 'none',
                              borderRadius: '6px',
                              color: 'inherit',
                              cursor: 'pointer',
                              font: 'inherit',
                              padding: '1px 8px',
                            },
                            onClick: function () {
                              props.openPanel();
                              setOpen(false);
                            },
                          },
                          t('pillSettings'),
                        )
                      : null,
                  ),
                ),
                // 表头：账号 / 积分。
                h(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      justifyContent: 'space-between',
                      color: textTertiary,
                      fontSize: '11px',
                      borderBottom: border,
                      paddingBottom: '4px',
                    },
                  },
                  h('span', null, t('pillAccountColumn')),
                  h('span', null, t('pillCreditsColumn')),
                ),
                list.length === 0
                  ? h(
                      'div',
                      { style: { color: textTertiary, padding: '8px 0' } },
                      loading ? t('pillLoading') : t('pillNoAccounts'),
                    )
                  : h(
                      'div',
                      null,
                      list.map(function (row, index) {
                        return accountRow(t, row, index);
                      }),
                    ),
                // 脚注：最近刷新。读不到就说读不到，不假装表是新的。
                h(
                  'div',
                  {
                    style: {
                      color: textTertiary,
                      fontSize: '11px',
                      borderTop: border,
                      marginTop: '4px',
                      paddingTop: '4px',
                    },
                  },
                  rows === undefined
                    ? loading
                      ? t('pillLoading')
                      : t('pillNoRows')
                    : t('pillRefreshedAt', { time: clock(rows.readAtMs) }),
                ),
              )
            : null,
        );
      }

      /**
       * 胶囊的门控：只在**本插件的 provider** 被选中时显示。
       *
       * 余额属于「下一次请求真的会用的那个 provider」；选了别人的模型还显示灵犀的
       * 余额，是一句看起来像事实的错误陈述。宿主没给投影时照常显示——
       * 「我不知道」不该等于「藏起来」。
       */
      function CreditPillGate(props) {
        var projection =
          typeof props.useProjection === 'function' ? props.useProjection('modelSelection') : undefined;
        var next = projection === undefined || projection === null ? undefined : (projection.next === undefined || projection.next === null ? projection.lastUsed : projection.next);
        var provider = next === undefined ? undefined : next.provider;
        if (provider !== undefined && provider !== PROVIDER_ID) return null;
        return h(CreditPill, props);
      }

      /** 插件模块。`inject` 声明依赖的服务，`apply` 在服务就绪时注册槽位。 */
      function apply(ctx) {
        var namespace = 'dsh-connect-lingxi';
        if (typeof document !== 'undefined') {
          var cssId = 'dsh-connect-lingxi/client.css';
          var existing = document.querySelector('style[data-plugin-css="' + cssId + '"]');
          if (existing !== null) existing.textContent = LINGXI_PAGE_CSS;
          else {
            var styleTag = document.createElement('style');
            styleTag.dataset.pluginCss = cssId;
            styleTag.textContent = LINGXI_PAGE_CSS;
            document.head.appendChild(styleTag);
          }
        }
        function getLayout() {
          try {
            var layout = ctx.get('layout');
            return layout && typeof layout.selectPanel === 'function' ? layout : undefined;
          } catch (error) {
            return undefined;
          }
        }
        /**
         * 侧栏整页（`main`）的 props。
         *
         * 只有这一处传 `surface: 'page'`：`plugins.bundle.config` 是从 Plugins 页
         * 点进来的，那里没有「对话」可返回，给它一个返回按钮会指向用户没来的地方。
         * `backToConversation` 也只为它准备 —— 宿主没声明 `layout` 时留 undefined，
         * 页面自己会把按钮藏起来，而不是渲染一个点了报错的按钮。
         */
        function panelPageProps() {
          return {
            t: t,
            surface: 'page',
            backToConversation: getLayout() === undefined ? undefined : function () {
              var layout = getLayout();
              if (layout !== undefined) layout.selectPanel(null);
            },
          };
        }
        ctx.effect(function () {
          return ctx.locale.register(namespace, { zh: zh, en: en });
        }, 'dsh-connect-lingxi: locale');
        var t = ctx.locale.bind(namespace);

        /**
         * 注册一个槽位，失败只记日志。
         *
         * 为什么要内层 try/catch：`ctx.slots.inject(name, cb)` 的回调是**晚执行**的
         * （等宿主声明那个槽位），异常会被 `queueMicrotask` 重新抛到渲染器外，
         * 外层的 try 抓不到 —— 结果是整个插件详情页空白，而控制台里只有一条
         * 和本插件无关的堆栈。所以每个注入回调自己兜住。
         */
        function injectSlot(name, register) {
          try {
            return ctx.slots.inject(name, function () {
              try {
                return register();
              } catch (error) {
                console.error('[dsh-connect-lingxi] 槽位注册失败（' + name + '，不影响模型路由）：', error);
                return undefined;
              }
            });
          } catch (error) {
            console.error('[dsh-connect-lingxi] 槽位注入失败（' + name + '，不影响模型路由）：', error);
          }
        }

        // 主页面常注册：关闭导航行后，胶囊仍能打开页面，当前页也不会因开关被销毁。
        // sidebar.panellist 的行来自元数据，必须注销 entry，返回 null 无法隐藏它。
        injectSlot('main', function () {
          return ctx.slots.register({
            name: 'main', key: PANEL_ID, locale: namespace, inject: panelPageProps
          }, PluginPage);
        });
        var panelDisposers = [];
        /**
         * 上一次同步时开关的值。
         *
         * 没有它，`watch` 每收到一次状态（60 秒一次轮询也会触发）就会注销并重新注册
         * 侧栏行 —— 行本身看不出变化，但宿主会为此重排导航、图标组件重新挂载。
         * 只在「开关真的变了」时动手。
         */
        var panelRowWanted = undefined;
        function disposePanelRow() {
          panelDisposers.forEach(function (dispose) {
            try { dispose(); } catch (error) {
              console.error('[dsh-connect-lingxi] sidebar row disposal failed:', error);
            }
          });
          panelDisposers = [];
        }
        function syncPanelRow() {
          var wanted =
            snapshot !== undefined && snapshot.settings !== undefined && snapshot.settings.sidebarPanel === true;
          // 读不到状态时（`snapshot` 还是 undefined）按「关」处理，但不能把它记成
          // 已经同步过：第一次真正读到 true 时还要能注册。
          if (snapshot === undefined) return;
          if (wanted === panelRowWanted) return;
          panelRowWanted = wanted;
          disposePanelRow();
          if (!wanted) return;
          var dispose = injectSlot('sidebar.panellist', function () {
            return ctx.slots.register({
              name: 'sidebar.panellist', id: PANEL_ID, order: 60,
              label: function () { return t('navPanel'); }, locale: namespace
            }, PanelIcon);
          });
          if (typeof dispose === 'function') panelDisposers.push(dispose);
        }
        ctx.effect(function () {
          void load();
          var unwatch = watch(syncPanelRow);
          syncPanelRow();
          return function () {
            unwatch();
            disposePanelRow();
            panelRowWanted = undefined;
          };
        }, 'dsh-connect-lingxi: sidebar panel');

        // 插件详情页：`key` 必须是包名（宿主按它把页面挂到 bundle 详情上）。
        // 这个槽位渲染两次：`view: 'summary'` 是插件列表里那一行，`view: 'page'`
        // 是点进去的整页。只处理 page，summary 交回一行摘要。
        injectSlot('plugins.bundle.config', function () {
          return ctx.slots.register(
            {
              name: 'plugins.bundle.config',
              key: BUNDLE_NAME,
              locale: namespace,
              inject: function () {
                // 详情页：`surface` 不给 page，因此没有返回按钮。
                return { t: t, surface: 'detail' };
              },
            },
            PluginPage,
          );
        });

        // 输入框右侧的读数：宿主把 `input.right` 渲染在模型选择器**紧前面**。
        /**
         * 模型名 + `· x倍率` + 徽标（`conversation.input.model.label`）。
         *
         * 为什么要自己画：宿主只把 `model.name` 当字符串画出来，倍率与徽标得贴上去
         * 才看得见（参考界面里是 `DeepSeek-V4.1-Flash · x0.11` + 绿色徽标）。
         * 倍率是选模型时唯一要比的数字，藏在两层菜单里等于没有。
         *
         * 别人的模型行必须**按原样还回去**（名字 + 它自己的徽标）：这个槽位在宿主上
         * 是 `single` —— 只有一个格子，谁注册谁独占。一个「只输出纯文本」的占位者
         * 一样占着格子，所以返回 null 也不会把格子让出来。宿主自己的 1017 徽标只在
         * **没有占位者**时由它自己画，因此一旦我们占了格子，就必须替别人的行补画
         * `model.badge`，否则那个徽标会从它自己的行上消失。
         */
        function ModelLabel(props) {
          var model = props === undefined || props === null ? undefined : props.model;
          var provider = props === undefined || props === null ? undefined : props.provider;
          if (model === undefined || model === null) return h('span', null, '');
          var name = String(model.name === undefined || model.name === null ? model.id : model.name);
          var theirs = provider === undefined || provider === null || provider.id !== PROVIDER_ID;
          var badge = model.badge === undefined || model.badge === null ? undefined : model.badge;
          if (theirs) {
            var foreign = [h('span', { key: 'name' }, name)];
            if (badge !== undefined && badge.text !== undefined) {
              foreign.push(
                h(BadgeChip, {
                  key: 'badge',
                  text: localizedText(badge.text),
                  tone: badge.tone,
                }),
              );
            }
            return h(
              'span',
              { style: { display: 'inline-flex', alignItems: 'center', gap: '4px', minWidth: 0 } },
              foreign,
            );
          }
          return h(LingxiModelLabel, { model: model });
        }

        /**
         * 本插件模型的名字：`名字 · x0.12` + 徽标胶囊。
         *
         * 倍率从状态文档的目录里拿（`models[].multiplier`），不再从 `description`
         * 里解析 —— 那个字符串是给人看的，随时可能改格式。状态还没读到时只画名字，
         * 不猜一个倍率出来。
         */
        function LingxiModelLabel(props) {
          var model = props.model;
          var state = useStatus();
          var multiplier = findMultiplier(state[0], model.id);
          var badge = model.badge === undefined || model.badge === null ? undefined : model.badge;
          var parts = [
            h('span', { key: 'name' }, String(model.name === undefined ? model.id : model.name)),
          ];
          if (multiplier !== '') {
            parts.push(h('span', { key: 'rate', style: { opacity: 0.65 } }, ' · x' + multiplier));
          }
          if (badge !== undefined && badge.text !== undefined) {
            parts.push(
              h(BadgeChip, { key: 'badge', text: localizedText(badge.text), tone: badge.tone }),
            );
          }
          return h(
            'span',
            { style: { display: 'inline-flex', alignItems: 'center', gap: '4px', minWidth: 0 } },
            parts,
          );
        }

        /** 徽标胶囊：颜色只看 `tone`，文字用宿主给的那份。 */
        function BadgeChip(props) {
          var tone = props.tone;
          var color =
            tone === 'success'
              ? 'var(--dsw-alias-label-success, #3aa757)'
              : tone === 'warning'
                ? 'var(--dsw-alias-label-warning, #d98a1f)'
                : tone === 'info'
                  ? 'var(--dsw-alias-label-info, #3b82f6)'
                  : 'var(--dsw-alias-label-tertiary, #8b8f98)';
          return h(
            'span',
            {
              style: {
                flex: 'none',
                border: '1px solid ' + color,
                borderRadius: '999px',
                color: color,
                fontSize: '11px',
                lineHeight: 1.3,
                padding: '0 6px',
                whiteSpace: 'nowrap',
              },
            },
            props.text,
          );
        }

        /** 状态文档里这个模型的倍率；没有就是空串（不是「0」）。 */
        function findMultiplier(status, modelId) {
          if (status === undefined || status === null || !Array.isArray(status.models)) return '';
          for (var index = 0; index < status.models.length; index += 1) {
            var item = status.models[index];
            if (item !== undefined && item !== null && item.id === modelId) {
              return typeof item.multiplier === 'string' ? item.multiplier : '';
            }
          }
          return '';
        }

        /**
         * 徽标文案可能是字面量，也可能是按语言分开的翻译（宿主的 `LocalizedText`）。
         * 宿主给了翻译就挑当前语言那份 —— 把 `{en, zh}` 画成 `[object Object]` 是
         * 最糟糕的结果，比显示错语言的单词还差。
         */
        function localizedText(text) {
          if (typeof text === 'string') return text;
          if (text === undefined || text === null || typeof text !== 'object') return '';
          var locale = currentLocale();
          if (typeof text[locale] === 'string') return text[locale];
          var dash = locale.indexOf('-');
          var base = dash === -1 ? locale : locale.slice(0, dash);
          if (typeof text[base] === 'string') return text[base];
          if (typeof text.en === 'string') return text.en;
          var keys = Object.keys(text);
          return keys.length === 0 ? '' : String(text[keys[0]]);
        }

        /** 当前界面语言（`zh-CN` 这种）；读不到就当中文。 */
        function currentLocale() {
          try {
            if (
              typeof document !== 'undefined' &&
              document !== null &&
              document.documentElement !== null &&
              typeof document.documentElement.lang === 'string' &&
              document.documentElement.lang !== ''
            ) {
              return document.documentElement.lang.toLowerCase();
            }
            if (
              typeof navigator !== 'undefined' &&
              navigator !== null &&
              typeof navigator.language === 'string'
            ) {
              return navigator.language.toLowerCase();
            }
          } catch (error) {
            // 读不到语言不值得报错：下面按中文处理。
          }
          return 'zh';
        }

        /**
         * 模型标签席位的优先级：**必须小于 0**。
         *
         * 这是 `single` 槽位：只有一个格子，同一优先级上第二份注册会直接抛
         * （「already has a registration at priority 0 — register at a different
         * priority to shadow it」）。宿主自己在 priority 0 注册了官方模型徽标，
         * 所以 0 是必冲突的位置，负数才是「盖在它上面」。
         */
        var MODEL_LABEL_PRIORITY = -105;

        /** 读槽位声明的形态；读不到就当 `undefined`（按单格子处理）。 */
        function declaredSlotKind(name) {
          var slots = ctx === undefined || ctx === null ? undefined : ctx.slots;
          if (slots === undefined || slots === null || typeof slots.spec !== 'function') return undefined;
          var spec;
          try {
            spec = slots.spec(name);
          } catch (error) {
            return undefined;
          }
          var kind = spec === undefined || spec === null ? undefined : spec.kind;
          if (kind === 'single' || kind === 'keyed' || kind === 'list' || kind === 'chain') return kind;
          return undefined;
        }

        /**
         * 模型名后面贴倍率与徽标。
         *
         * `keyed` 宿主上每家 provider 一个格子，各画各的，宿主的 1017 徽标不受影响；
         * 其它形态（含读不到）只注册一份，用负优先级盖住宿主的默认标签 ——
         * 那时就得替别人的行补画徽标，见 {@link ModelLabel}。
         */
        injectSlot('conversation.input.model.label', function () {
          var name = 'conversation.input.model.label';
          var kind = declaredSlotKind(name);
          // 列表/链式槽位不是「一个格子里的标签」，注册进去只会画出一堆重复的。
          if (kind === 'list' || kind === 'chain') return undefined;
          // 这个槽位声明的是 `registerOptions: []`：只认 `priority`（`keyed` 上再加
          // `key`）。塞 `id` / `locale` / `inject` 是没用的字段，甚至可能被宿主拒掉。
          var options = { name: name, priority: MODEL_LABEL_PRIORITY };
          if (kind === 'keyed') options.key = PROVIDER_ID;
          return ctx.slots.register(options, ModelLabel);
        });

        injectSlot('conversation.input.right', function () {
          return ctx.slots.register(
            {
              name: 'conversation.input.right',
              id: BUNDLE_NAME + '-credits',
              order: 4,
              locale: namespace,
              inject: function () {
                return { t: t, openPanel: getLayout() === undefined ? undefined : function () {
                  var layout = getLayout();
                  if (layout !== undefined) layout.selectPanel(PANEL_ID);
                } };
              },
            },
            CreditPillGate,
          );
        });

        /**
         * 设置页侧栏入口（参考 DSH 自带设置的布局：左侧导航 + 右侧整页）。
         *
         * `id` 同时驱动两件事：侧栏过滤（`only: active`）与图标匹配
         * （`settings.section.icon` 的 id 必须等于 section 的 id，不匹配就不渲染）。
         * `order` 挑 60：排在官方页（general/models/plugins …）之后，
         * 不挤它们的位置。
         */
        var SETTINGS_SECTION_ID = 'dsh-connect-lingxi';
        injectSlot('settings.section', function () {
          return ctx.slots.register(
            {
              name: 'settings.section',
              id: SETTINGS_SECTION_ID,
              order: 60,
              label: function () {
                return t('navPanel');
              },
              locale: namespace,
              inject: function () {
                return { t: t, surface: 'settings' };
              },
            },
            function (props) {
              // owner props 是 `{ close }`（设置面板的开合归壳所有）。
              // 本页不需要关面板，但要把签名收全，方便以后用。
              void props.close;
              return h(PluginPage, props);
            },
          );
        });

        // 侧栏图标：id 必须等于 section 的 id；props 是 `{ size, active }`。
        // 用内联 SVG 而不是图片文件 —— 经典脚本里没有打包资源管线。
        injectSlot('settings.section.icon', function () {
          return ctx.slots.register(
            {
              name: 'settings.section.icon',
              id: SETTINGS_SECTION_ID,
              locale: namespace,
            },
            function (props) {
              var size = typeof props.size === 'number' ? props.size : 16;
              var color = props.active === true ? textPrimary : textTertiary;
              return h('span', {
                style: {
                  display: 'inline-flex',
                  width: String(size) + 'px',
                  height: String(size) + 'px',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: color,
                },
                dangerouslySetInnerHTML: {
                  __html:
                    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="' +
                    String(size) +
                    '" height="' +
                    String(size) +
                    '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                    // 星座连线形状：一颗四角星 + 两条光线，呼应「灵犀」。
                    '<path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z"/>' +
                    '<path d="M19 3l.9 2.1L22 6l-2.1.9L19 9l-.9-2.1L16 6l2.1-.9z"/>' +
                    '</svg>',
                },
              });
            },
          );
        });
      }

      return {
        name: BUNDLE_NAME,
        inject: ['slots', 'locale'],
        apply: apply,
      };
    },
  });
})();
