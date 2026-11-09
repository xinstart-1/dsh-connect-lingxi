/**
 * 插件配置。用户在设置页填的东西都在这里。
 * @module dsh-connect-lingxi/config
 */

import z from '@deepseek-ai/schemastery';

/** 配置 schema 与默认值。 */
export const Config = z.object({
  /**
   * 手动粘贴的 cookie（**兜底**，不是主路径）。
   *
   * 正常情况下不需要填：插件会自动从本机灵犀客户端 / 你日常浏览器的登录态里读。
   * 留空即「自动探测」。
   */
  cookie: z
    .string()
    .description('可选：手工粘贴 wps_sid。留空即自动探测本机灵犀客户端与浏览器的登录态。')
    .default(''),

  /**
   * 自动探测登录态（本机客户端 + 日常浏览器）。
   *
   * 关掉它只在排查问题时有意义：那会让插件只认手填的 cookie。
   */
  autoDetectCookie: z
    .boolean()
    .description('自动从本机灵犀客户端与浏览器读取登录态（推荐开启，无需手粘 cookie）。')
    .default(true),

  /** 是否允许复用日常浏览器（Chrome / Edge 等）的登录态。 */
  useBrowserProfile: z
    .boolean()
    .description('复用日常浏览器里已登录的灵犀网页版（Chrome / Edge / Brave / 360）。')
    .default(true),

  /** 显式指定客户端数据目录；留空自动探测。 */
  clientDataDir: z
    .string()
    .description('灵犀客户端数据目录；留空自动探测（`%APPDATA%\\kdesk`、`%APPDATA%\\WPS 灵犀` 等）。')
    .default(''),

  /** 是否启用灵犀路由。 */
  enabled: z
    .boolean()
    .description('在 DSH 模型选择器里启用 WPS 灵犀。')
    .default(true),

  /** 默认思考档位（模型未声明时的兜底）。 */
  defaultReasoningEffort: z
    .string()
    .description('默认思考档位：off / low / high / max。留空沿用上游默认。')
    .default(''),

  /** 是否在启动时预热模型目录（登录态有效时会多一次请求）。 */
  warmCatalogOnStart: z
    .boolean()
    .description('插件启动时预拉一次模型目录，让选择器更快显示真实模型。')
    .default(true),
});

/** 解析后的配置类型。 */
export interface LingxiConfig {
  cookie: string;
  autoDetectCookie: boolean;
  useBrowserProfile: boolean;
  clientDataDir: string;
  enabled: boolean;
  defaultReasoningEffort: string;
  warmCatalogOnStart: boolean;
}

/** 缺省值：直接跑 schema 得到。 */
export const DEFAULT_CONFIG: LingxiConfig = Config({}) as LingxiConfig;
