/**
 * 宿主侧对「浏览器半侧到底加载了哪个文件」的观察。
 *
 * 输入框胶囊消失时，界面上是「什么都没有」，我们从宿主控制台看不到原因。
 * 能确定的一件事是：宿主在启动时把每个插件的 `lib/client.js` 读进客户端
 * 模块表，再从 `/plugins/<id>/client.js?…` 供给浏览器。所以只要把**它读的
 * 那份字节**和**它组出来的条目**摊开，就能把问题切成两半：
 *
 * - 条目不在图里 / 文件里没有槽位注册 → 加载侧的问题（本文件就能看出来）；
 * - 条目在、文件里有注册 → 执行侧的问题（看浏览器半侧上报的事件）。
 *
 * 这里只读文件、只读注册表，不发请求、不写任何东西。
 *
 * @module dsh-connect-lingxi/host/client-diag
 */

import { readFileSync, statSync } from 'node:fs';

/** 本插件在宿主客户端模块表里的 id。 */
const CLIENT_ID = 'dsh-connect-lingxi';

/** 客户端模块服务里我们用到的最小形状。 */
export interface ClientModulesLike {
  /** 当前供给浏览器的条目图（`window.__DSH_BOOT__` 的内容）。 */
  graph?: () => unknown;
  /** 条目对应的客户端文件绝对路径。 */
  clientPath?: (id: string) => string | undefined;
}

/** 诊断快照里的一段。 */
export interface ClientModulesSnapshot {
  /** 服务是否可读；false 时其余字段都没意义。 */
  available: boolean;
  /** 图里有没有本插件的条目。 */
  inGraph: boolean;
  /** 条目（原样截取几个字段，不整个抛出去）。 */
  entry?: { id: string; rev?: string; url?: string };
  /** 图的整体 rev（换了它说明宿主重新组过图）。 */
  graphRev?: string;
  /** 宿主读的那份客户端文件。 */
  file?: {
    path: string;
    bytes: number;
    mtime: string;
    /** 文件里有没有输入框右侧槽位的注册（有 = 加载侧没问题）。 */
    registersInputRight: boolean;
    /** 文件里有没有胶囊组件。 */
    hasPill: boolean;
    /** 文件里有没有客户端上报通道（用来确认浏览器跑的是这一版）。 */
    hasReport: boolean;
  };
  /** 读不到时的原因。 */
  error?: string;
}

/** 从任意值里取一个字符串字段。 */
function str(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'string' ? found : undefined;
}

/**
 * 组一份快照。
 *
 * 任何一步失败都只降级成字段缺失，绝不抛：这是诊断通道本身。
 * @param service - 宿主注入的客户端模块服务。
 * @returns 快照。
 */
export function snapshotClientModules(service: ClientModulesLike): ClientModulesSnapshot {
  const snapshot: ClientModulesSnapshot = { available: true, inGraph: false };
  try {
    const graph = typeof service.graph === 'function' ? service.graph() : undefined;
    snapshot.graphRev = str(graph, 'rev');
    const entries =
      typeof graph === 'object' && graph !== null
        ? (graph as Record<string, unknown>).entries
        : undefined;
    if (Array.isArray(entries)) {
      for (const row of entries) {
        if (str(row, 'id') !== CLIENT_ID) continue;
        snapshot.inGraph = true;
        snapshot.entry = {
          id: CLIENT_ID,
          ...(str(row, 'rev') === undefined ? {} : { rev: str(row, 'rev') }),
          ...(str(row, 'url') === undefined ? {} : { url: str(row, 'url') }),
        };
        break;
      }
    }
    const path = typeof service.clientPath === 'function' ? service.clientPath(CLIENT_ID) : undefined;
    if (path !== undefined) {
      const stat = statSync(path);
      const text = readFileSync(path, 'utf8');
      snapshot.file = {
        path,
        bytes: stat.size,
        mtime: new Date(stat.mtimeMs).toISOString(),
        registersInputRight: text.includes('conversation.input.right'),
        hasPill: text.includes('CreditPill'),
        hasReport: text.includes('client-report'),
      };
    }
  } catch (error) {
    snapshot.available = false;
    snapshot.error = error instanceof Error ? error.message : String(error);
  }
  return snapshot;
}
