/**
 * dsh-pet-baifan 的宿主半侧 —— 只做一件事：把本包的 `assets/` 挂成
 * `/dsh-pet-baifan/assets` 前缀路由。
 *
 * ## 为什么需要这一半
 *
 * `POST /dsh-pet-7340/anim` 的 `url` 形态（第三方自带素材）**只放行 http/https 的完整地址**，
 * 而且两端消费端都是 `fetch` + blob —— 跨域要求对方自己带 `Access-Control-Allow-Origin`。
 * 本扩展的 5 个 webm 和三张米饭图就在本包里，最省事的做法是把它们挂在**同一个 DSH 端口**上：
 * 同源、零跨域、零代理，`new URL('/dsh-pet-baifan/assets/...', location.origin)` 直接能点播。
 *
 * ## 为什么是 prefix 而不是逐个 exact
 *
 * 素材是一棵树（`webm/` + `pic/`），以后加一段动画不该回来改路由表。前缀路由只负责
 * 「按相对路径读文件」，目录结构就是 URL 结构。
 *
 * ## 为什么前缀带着包名
 *
 * 路由名是**全局唯一**的（撞了直接抛错），而这是个 dsh-pet 的扩展 —— 前缀里带上
 * `dsh-pet-` 一眼就知道是谁挂的，也不会和别的插件抢 `/assets` 这种通用名字。
 *
 * @module dsh-pet-baifan
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Cordis 插件名（诊断与日志里显示）。 */
export const name = 'dsh-pet-baifan';

/** 需要宿主提供 HTTP 路由表。 */
export const inject = ['webServer'];

/** 素材根目录：包内 `assets/`。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');

/** 对外前缀：URL 里的 `/dsh-pet-baifan/assets/<相对路径>` ↔ 磁盘上的 `assets/<相对路径>`。 */
const PREFIX = '/dsh-pet-baifan/assets';

/** 只发这几种类型；其余一律 404（这个路由不是通用文件服务器）。 */
const TYPES = {
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.json': 'application/json',
};

/**
 * 注册素材路由。
 *
 * @param ctx - 宿主 Cordis 上下文；`webServer` 由 inject 保证在场。
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: serve }));
}

/**
 * 读一个素材回给浏览器。
 *
 * @param req - Node 请求；只用到 URL。
 * @param res - Node 响应；本函数拥有完整响应生命周期。
 */
async function serve(req, res) {
  const full = resolve(req.url);
  if (full === null) {
    res.writeHead(404).end();
    return;
  }
  let info;
  try {
    info = await stat(full);
  } catch {
    res.writeHead(404).end();
    return;
  }
  if (!info.isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(full).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': info.size,
    // 长缓存：渲染端每换一次点播都要 fetch 一遍这段 webm，命中缓存与重新读盘差着
    // 几百毫秒 —— 那几百毫秒就是「人已经在滑、动画还没起来」。
    // 换素材靠 URL 上的 ?v= 版本号（见 lib/client.js 的 ASSET_V），不靠这里过期。
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(full);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/**
 * URL → 磁盘绝对路径。
 *
 * 只接受 `PREFIX` 之下的路径，且解析后必须仍落在 `ROOT` 里 —— 反斜杠、`..`、编码过的
 * `%2e%2e` 都在这条判断上被挡下，所以这里不需要额外的白名单。
 *
 * @param url - 请求行里的原始 URL。
 * @returns 磁盘路径；越界或不在前缀下返回 `null`。
 */
function resolve(url) {
  if (typeof url !== 'string') return null;
  let pathname;
  try {
    pathname = new URL(url, 'http://127.0.0.1').pathname;
  } catch {
    return null;
  }
  if (pathname !== PREFIX && !pathname.startsWith(PREFIX + '/')) return null;
  let rel;
  try {
    rel = decodeURIComponent(pathname.slice(PREFIX.length));
  } catch {
    return null;
  }
  const full = path.resolve(ROOT, '.' + rel);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  return full;
}
