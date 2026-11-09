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
 * 2. `conversation.input.left` —— 输入框左侧的胶囊读数。
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
  var STATUS_PATH = '/plugins/dsh-connect-lingxi/status';
  var ACTION_PATH = '/plugins/dsh-connect-lingxi/action';
  /** 轮询间隔：宿主那边真正的刷新节奏由它自己的 pollIntervalMs 决定，这里只决定界面多久问一次。 */
  var POLL_INTERVAL_MS = 60000;

  var zh = {
    metaTitle: 'DSH Connect WPS 灵犀',
    metaDescription:
      '把 WPS 灵犀接入 DSH：原生工具调用与思考通道直通，这里管理智点余额、签到与模型目录。',
    name: 'WPS 灵犀',
    pill: '灵犀',
    pillCredits: '灵犀 · {total}',
    pillUnknown: '灵犀 · —',
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
    modelsHint: '在「设置 → 模型」里选择；这里只显示上游目录与倍率。',
    noModels: '还没有读到模型目录',
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
    metaTitle: 'DSH Connect WPS Lingxi',
    metaDescription:
      'WPS Lingxi as a DSH model provider: native tool calls and reasoning passthrough, with credits, check-in and the model catalog managed here.',
    name: 'WPS Lingxi',
    pill: 'Lingxi',
    pillCredits: 'Lingxi · {total}',
    pillUnknown: 'Lingxi · —',
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
    modelsHint: 'Pick one in Settings → Models; this list mirrors the upstream catalog and multipliers.',
    noModels: 'No model catalog yet',
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

      // ── 共享 store：一个 ticker 服务所有界面 ────────────────────────────
      var listeners = new Set();
      var snapshot;
      var timer;

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
        if (listeners.size === 1) {
          void load();
          timer = setInterval(function () {
            void load();
          }, POLL_INTERVAL_MS);
        }
        return function () {
          listeners.delete(listener);
          if (listeners.size === 0 && timer !== undefined) {
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
          padding: '0 0 16px',
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

      /** 一级分组标题 + 内容（DSH 设置页风格：无外框，标题 + 细分隔线 + 行）。 */
      function section(t, title, children, extra) {
        var kids = Array.isArray(children) ? children : [children];
        return h(
          'section',
          { style: css.group },
          h('div', { style: css.groupHead }, h('div', { style: css.groupTitle }, title), extra === undefined ? null : extra),
          ...kids,
        );
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
      function ModelBlock(props) {
        var t = props.t;
        var models = props.models;
        if (models.length === 0) {
          return section(t, t('models'), h('div', { style: css.muted }, t('noModels')));
        }
        return section(
          t,
          t('models'),
          h('div', { style: css.muted }, t('modelsHint')),
          h(
            'ul',
            { style: css.list },
            models.map(function (model) {
              return h(
                'li',
                { key: model.id, style: css.groupLine },
                h(
                  'div',
                  { style: css.itemMain },
                  h('span', { style: css.rowLabel }, model.enabled ? model.name : model.name + ' · ' + t('statusLocked')),
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
                ),
                h(
                  'div',
                  { style: css.pillGroup },
                  model.reasoning ? h('span', { style: css.tag }, t('reasoning')) : null,
                  model.vision ? h('span', { style: css.tag }, t('vision')) : null,
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
        var sourceLabel =
          login.source === 'manual'
            ? t('sourceManual')
            : login.source === 'client'
              ? t('sourceClient')
              : login.source === 'browser'
                ? t('sourceBrowser')
                : t('sourceNone');
        return section(
          t,
          t('diagnostic'),
          h('div', { style: css.groupLine }, h('span', { style: css.rowLabel }, t('diagVersion')), h('span', { style: css.rowValue }, status.version === undefined ? '—' : String(status.version))),
          h('div', { style: css.groupLine }, h('span', { style: css.rowLabel }, t('diagLogin')), h('span', { style: css.rowValue }, loginLabel)),
          h('div', { style: css.groupLine }, h('span', { style: css.rowLabel }, t('diagSource')), h('span', { style: css.rowValue }, sourceLabel)),
          ...(login.name === undefined ? [] : [h('div', { style: css.groupLine }, h('span', { style: css.rowLabel }, t('diagAccount')), h('span', { style: css.rowValue }, login.name))]),
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
                action === 'login'
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
          { style: css.root, 'data-lingxi-page': true },
          h(
            'div',
            { style: css.head },
            h('h2', { style: css.title }, t('metaTitle')),
            h('span', { style: css.version }, status === undefined ? '' : 'v' + String(status.version)),
          ),
          h('p', { style: css.desc }, t('metaDescription')),
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
                    h('span', { style: css.itemMeta }, t('loginHint')),
                  ),
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
                ),
          ),
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
          h(TaskBlock, {
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
          }),
          h(ModelBlock, {
            t: t,
            models: status === undefined || !Array.isArray(status.models) ? [] : status.models,
          }),
          h(SettingsBlock, {
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
          }),
          h(DiagnosticBlock, { t: t, status: status }),
          lastAction === '' ? null : h('div', { style: css.muted }, t('lastAction') + '：' + lastAction),
        );
      }

      // ── 输入框左侧的智点胶囊（`conversation.input.left`） ──────────────
      function CreditPill(props) {
        var t = translator(props);
        var state = useStatus();
        var status = state[0];
        var openState = React.useState(false);
        var open = openState[0];
        var setOpen = openState[1];
        var total =
          status === undefined || status.credits === undefined ? undefined : status.credits.total;
        var label =
          total === undefined ? t('pillUnknown') : t('pillCredits', { total: credits(total) });
        return h(
          'div',
          { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' }, 'data-lingxi-pill': true },
          h(
            'button',
            {
              type: 'button',
              title: t('name'),
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
              onClick: function () {
                setOpen(!open);
              },
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
                    minWidth: '220px',
                    borderRadius: '8px',
                    background: 'var(--dsh-panel-background, Canvas)',
                    color: 'var(--dsh-panel-foreground, CanvasText)',
                    border: '1px solid var(--dsh-panel-border, currentColor)',
                    boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
                    padding: '8px 10px',
                    fontSize: '12px',
                    lineHeight: 1.6,
                    textAlign: 'left',
                  },
                },
                h('div', { style: { fontWeight: 600 } }, t('balance')),
                h(
                  'div',
                  null,
                  total === undefined ? t('pillUnknown') : t('balanceValue', { total: credits(total) }),
                ),
                status !== undefined &&
                  status.credits !== undefined &&
                  status.credits.expiring !== undefined &&
                  status.credits.expiring.amount > 0
                  ? h(
                      'div',
                      { style: { opacity: 0.8 } },
                      t('expiring', {
                        amount: credits(status.credits.expiring.amount),
                        date: shortDate(status.credits.expiring.earliest),
                      }),
                    )
                  : null,
                status !== undefined &&
                  status.tasks !== undefined &&
                  status.tasks.checkedInToday === true
                  ? h('div', { style: { opacity: 0.8 } }, t('checkinDone'))
                  : null,
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
        var next = projection === undefined || projection === null ? undefined : projection.next ?? projection.lastUsed;
        var provider = next === undefined ? undefined : next.provider;
        if (provider !== undefined && provider !== PROVIDER_ID) return null;
        return h(CreditPill, props);
      }

      /** 插件模块。`inject` 声明依赖的服务，`apply` 在服务就绪时注册槽位。 */
      function apply(ctx) {
        var namespace = 'dsh-connect-lingxi';
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
            ctx.slots.inject(name, function () {
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
                return { t: t };
              },
            },
            PluginPage,
          );
        });

        // 输入框左侧的读数：坐在模型选择器旁边，与「这个 provider 在用」这件事同一个位置。
        injectSlot('conversation.input.left', function () {
          return ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: BUNDLE_NAME + '-credits',
              order: 4,
              locale: namespace,
              inject: function () {
                return { t: t };
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
                return { t: t };
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
