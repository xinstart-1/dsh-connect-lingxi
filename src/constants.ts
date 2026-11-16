/**
 * WPS 灵犀协议常量。所有值见 `docs/PROTOCOL.md` §1。
 * @module dsh-connect-lingxi/constants
 */

/** DSH provider 路由键；同时是 pi-ai collection 的 key。 */
export const PROVIDER = 'wps-lingxi';

/** 插件版本号（卡片与日志显示）。与 package.json 的 version 保持一致。 */
export const VERSION = '0.0.20';

/** 设置页命名空间（插件设置卡片的挂载点）。 */
export const SETTINGS_NS = 'lingxi';

/** 灵犀主站。 */
export const BASE = 'https://lingxi.wps.cn';

/** 登录域名；部分账号的会话只在这一侧有效，握手时两个都要试。 */
export const KDOCS_BASE = 'https://lingxi.kdocs.cn';

/** 建会话。 */
export const AGENT_SESSIONS_PATH = '/api/aioffice/v1/cowork/sessions';
/** 领 run。 */
export const AGENT_RUNS_PATH = '/api/public/v1/credits/runs';
/** 对话（SSE）。 */
export const AGENT_CHAT_PATH = '/api/public/v1/agent-runtime/chat/completions';
/** 模型 / 模式目录。 */
export const PLANS_PATH = '/api/aioffice/v1/sessions/plans';
/** 智点余额。 */
export const BALANCE_PATH = '/api/public/v1/credits/balance';
/** 任务中心（每日签到 + 一次性任务）。 */
export const TASKS_PATH = '/api/public/v1/tasks';
/** 账号资料（用于校验 cookie 是否有效）。 */
export const PROFILE_PATH = '/api/public/v1/account/profile';

/** 客户端指纹：请求头与 cookie 都用这个值。 */
export const CLIENT_TYPE = 'lingxi_claw';
/** 客户端语言。 */
export const CLIENT_LANG = 'zh-CN';

/** 浏览器 UA（灵犀客户端是 Chromium 壳）。 */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

/** 设备号：由固定串派生，保证同一台机器稳定。 */
export const DEVICE_ID = 'dsh-connect-lingxi-device';

/** 以下三个 cookie 每次请求都要拼在用户 cookie 之后。 */
export const KSO_COOKIE_PARTS = [
  'x-kso-app-name=win-lingxi-desktop',
  'x-kso-app-version=1.3.31',
  `x-kso-device-id=${DEVICE_ID}`,
] as const;

/** run 缓存有效期（1 小时）。 */
export const RUN_TTL_MS = 60 * 60 * 1000;

/**
 * 单轮 prompt 的 token 上限（灵犀 1M 上下文的实际上限）。
 *
 * **已实测**（2026-11-11，`deepseek-v4.1-flash`，`scripts` 外部探针）：
 * - 英文 4096KB（4,194,304 字节）→ `prompt_tokens = 932,102`，200 正常；
 * - 英文 4607KB 正常、4608KB 起返回 `HTTP 200 + SSE AIError/AI服务异常`（usage 全 0）；
 * - 同样 4608KB 的中文只有约 175 万字符，正常通过 —— 限制是 token，不是字节。
 *
 * **不用于自动裁剪/压缩**：历史原样发出；只在估计接近上限、或上游以
 * `AI服务异常` 拒绝时，用它在错误信息里说明原因（见 `oversizeNote`）。
 */
export const MAX_PROMPT_TOKENS = 1_048_576;

/** 单次上游请求的默认超时。 */
export const REQUEST_TIMEOUT_MS = 120_000;

/** SSE 空闲超时：这么久没有新帧就认为流断了。 */
export const STREAM_IDLE_TIMEOUT_MS = 180_000;

/** 默认模型（模型目录全部失败时的最后兜底）。 */
export const DEFAULT_MODEL_ID = 'deepseek-v4.1-flash';

/** 本地 shim 监听的路径前缀。 */
export const SHIM_PREFIX = '/v1/chat/completions';

/** 图片请求预算，与 dsh-llm-pi-ai 默认值一致。 */
export const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
  maxRequestImages: 8,
  imageOffloadCountQuantum: 4,
} as const;

