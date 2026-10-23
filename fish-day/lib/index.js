/**
 * dsh-pet-fish-day 的宿主半侧 —— 没有自己的素材与路由。
 *
 * ## 为什么还要有这一半
 *
 * DSH 的组合包 patch 只能插入一个插件 entry，而 entry 的 `name` 会解析到本包的 main。
 * 本扩展的全部行为都在浏览器半侧（lib/client.js）：它只调用 dsh-pet 的动画、气泡与位置接口，
 * 不需要宿主提供任何服务。所以这里只提供一个空的 Cordis 插件，让这个包能作为 profile 的一层
 * 被加载，客户端半侧再由 dsh-client-modules 挂到同名 entry 上。
 *
 * @module dsh-pet-fish-day
 */

/** Cordis 插件名（诊断与日志里显示）。 */
export const name = 'dsh-pet-fish-day';

/** 不需要宿主提供任何服务。 */
export const inject = [];

/** 空实现：全部逻辑在浏览器半侧。 */
export function apply() {}
