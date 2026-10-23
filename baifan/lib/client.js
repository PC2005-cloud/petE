/**
 * dsh-pet-baifan 的浏览器半侧 —— 「吃白饭」的全部行为。
 *
 * ## 它是什么
 *
 * 一个**第三方客户端插件**：不自己养宠物、不画宠物，只在 dsh-pet 的右键菜单里挂一项
 * （`更多 / 吃白饭`），点下去以后拿 dsh-pet 的**占用锁**，用 HTTP 接口指挥
 * 那只真实的桌宠演一段：跑到底部 → 蓄力 → 期待开饭 → 米饭从天上掉 → 追着吃，无限循环，
 * 直到锁丢掉（用户拖走宠物）。
 *
 * 页面里自己只画两样东西：**米饭**（掉下来、被吃掉的抛物线）和**分数气泡**。
 * 宠物本身的位移与动画全部走 `/dsh-pet-7340/*`，所以我们和桌面端看到的是同一只宠物。
 *
 * ## 名字为什么都带前缀
 *
 * 包名、模块 id、插件名、菜单 owner、路由前缀、样式标记、sessionStorage 键都是**全局可见**
 * 的名字 —— 撞了就是踩别人的脚（路由撞了直接抛错，模块 id 撞了组合失败）。所以统一用
 * `dsh-pet-baifan`：一眼能看出它是 dsh-pet 的扩展，也不会和 `baifan` 这种通用词抢。
 *
 * ## 契约（DSH 客户端插件）
 *
 * 必须是**经典脚本**（无顶层 import/export），整份包一层 IIFE，末尾用
 * `window.__ModuleLoader__.load({ id, factory })` 注册 factory。bundle 重建 / combo 重试时
 * 同一文件会在同一页面**再执行一次**，所以顶层不能留可变状态，重复执行时按根节点 id 摘掉旧层。
 *
 * ## 三个"为什么"
 *
 * - **为什么动作全走 HTTP**：页面内的 `petApi7340` 只有 `pose` / `progress` 两个只读方法。
 *   位置、朝向靠 `pose(id)` 读（同页，零请求），这也让米饭落地、嘴部对齐能跟着真实宠物走。
 * - **为什么动画速度是烘进素材的**：`POST /anim` 没有播放速率参数，`<video>` 的
 *   `playbackRate` 是渲染端的事。所以「期待 2 倍速」「吃 2 倍速」在流水线里就编码好了
 *   （10.04s → 5.08s），运行时不需要也不可能再调速。
 * - **为什么结束时刻问回执**：`url` 形态的语义是「插播一段，播完回到正常动画链」，没有 loop，
 *   而 `POST /anim` 的 `ok: true` 只代表**受理**。素材没拿到、解码失败、被顶掉、被锁冻结，
 *   都可能让它根本没播完 —— 所以「期待完了吗」「吃完了吗」「侧身跑该接下一遍了吗」全部走
 *   `GET /playback/{id}?wait=ended,failed,cancelled`，一个定时器都不用（定时器在素材加载
 *   失败时照样会走到"播完"）。
 *
 * @module dsh-pet-baifan/client
 */

;(() => {
  'use strict';

  /** 插件 id：与 package.json 的 name 一致，DSH 模块系统按它去重。 */
  const PLUGIN_ID = 'dsh-pet-baifan';

  /** 菜单分区键（事件流按它隔离，也是唯一的入口分组）。 */
  const OWNER = 'dsh-pet-baifan';

  /**
   * 菜单项文案；菜单事件按文案回传，所以它是**协议**的一部分，不能随便改。
   *
   * 只有「吃白饭」一项：**没有停止项** —— 想让它停下来就拖一下宠物，锁被撤掉，表演当场收场。
   * 只有一个菜单项时 dsh-pet 会跳过 owner 那层，直接平铺成「更多 / 吃白饭」。
   */
  const LABEL_START = '吃白饭';

  /** dsh-pet 的 HTTP 基址（同源）。 */
  const API = '/dsh-pet-7340';

  /** 本包素材基址（由宿主半侧挂出来的同源路由）。 */
  const ASSET = '/dsh-pet-baifan/assets';

  /**
   * 素材版本号。
   *
   * 宿主对素材发的是长缓存（`immutable`），所以**重新编码素材之后必须把它 +1**，
   * 否则浏览器会一直用缓存里的旧片 —— 这个扩展里动画是频繁改的东西，忘了就白改。
   */
  const ASSET_V = '?v=1';

  /** 点播用的素材地址必须是**完整 http(s) 地址**：`url` 形态只放行这两种 scheme。 */
  const ORIGIN = window.location.origin;

  const A = {
    runForward: ORIGIN + ASSET + '/webm/run-forward.webm' + ASSET_V,
    expect: ORIGIN + ASSET + '/webm/expect.webm' + ASSET_V,
    runSide: ORIGIN + ASSET + '/webm/run-side.webm' + ASSET_V,
    eatBowl: ORIGIN + ASSET + '/webm/eat-bowl.webm' + ASSET_V,
    eatBall: ORIGIN + ASSET + '/webm/eat-ball.webm' + ASSET_V,
    bowlFull: ASSET + '/pic/bowl-full.png' + ASSET_V,
    bowlEmpty: ASSET + '/pic/bowl-empty.png' + ASSET_V,
    riceBall: ASSET + '/pic/rice-ball.png' + ASSET_V,
  };

  /**
   * 全部可调参数。
   *
   * 坐标一律用**视口像素**算，只在调接口时归一化成 0–1 —— 因为 `pose()` 回的就是归一化中心点，
   * 而米饭、气泡要按像素画在页面里，两边来回换算一次就够了。
   *
   * 注意这里**没有"素材多长"**：动画的结束一律问 `GET /playback/{id}` 的回执，不吃定时器
   * （素材加载失败时定时器会照常走到"播完"，回执不会）。只有吃动作里那段米饭飞行的动画
   * 需要一个时长，那是从 `progress().duration` 现读的。
   */
  const CFG = {
    groundOffset: 26,      // 地面线距视口底部（像素）
    prepMs: 2100,          // 下移前的原地蓄力时长
    travelMs: 5000,        // 跑到底部的行程时长
    runSpeed: 290,         // 侧身跑速度（像素/秒）
    patrolSpeedRatio: 0.72,// 没饭可追时的溜达速度倍率
    spawnMs: 4200,         // 掉饭间隔
    bowlRatio: 0.38,       // 碗饭的出现概率，其余是饭团
    maxRice: 2,            // 场上最多同时几份，避免堆成一地
    eatPx: 40,             // 离饭多近算"到了，可以吃"（像素，按 498px 宽精灵校准）
    arrivePx: 12,          // 离目标点多近算走到（像素）
    tripMaxMs: 4500,       // 单段位移的时长上限（别让一段跑太久，方向改不动）
    sideWatchMs: 400,      // 看门狗的间隔：跑动动画掉了多久之内必须补回来
    idleMs: 140,           // 没发指令时的空转节拍（防死循环，也让出主线程）
    animLeadMs: 300,       // 换段时最多等这么久让新视频开播，再发位移（收到即走）
    backTurnPenalty: 1.8,  // 身后那份饭的"距离折扣"：能不换朝向就不换
    pollLatencyMs: 1000,   // 渲染端对 /state 的轮询间隔：指令生效的最坏延迟
    preRollSec: 0.35,      // 上一段还剩这么多秒就点下一段（锁占用期间宠物自己静止，空档会露馅）
    lockTtl: 30000,        // 取锁时长：短一点，刷新页面留下的锁最多糊住 30 秒
    lockWaitMs: 25000,     // 撞上别人的锁时最多等这么久（等它自己过期）
    renewMs: 6000,         // 心跳续期间隔：也顺带是「锁还在吗」的探测频率
    flyFallbackMs: 5200,   // 读不到真实片长时，米饭飞向嘴边的兜底时长
    waitBudgetMs: 30000,   // 等一次点播走到终态的总预算（远大于任何一段素材）
    httpTimeoutMs: 20000,  // 单次 HTTP 的超时（长轮询 10s，留一倍余量）
    bubbleMs: 2400,        // 台词气泡停留时长（投喂时逐句覆盖）
    // 角色在 640×360 素材里的相对位置（实测），用来把「中心点」换算成脚底与嘴
    footRatio: 0.894,
    // 嘴的锚点：按素材里量出来的脸，眼睛在 0.475 左右、下巴在 0.61 —— 取 0.63（下巴略下）
    // 再把飞行末段的食物缩到 0.72，食物的上沿才刚好压在眼睛下面，不挡脸。
    mouthRatio: 0.63,
    mouthDx: -0.03,        // 嘴相对中线水平偏移（占素材宽度比例，负=左；镜像自动取反）
    refWidth: 498,         // 素材在 498px 宽时的校准基准（米饭尺寸、判定距离都按它缩放）
  };

  /**
   * 台词池。
   *
   * 用 `POST /broadcast` 投喂（第三方自己给文本，宿主只负责搬运）。**只在合适的节拍上说话**：
   * 起手、下去、等饭、饭落地、吃完一口、吃很多口之后 —— 其余时间闭嘴，否则气泡会一直糊在
   * 演出上。短、口语、带点赖着不走的脾气，和宠物原本那张嘴是一个调子。
   */
  const LINES = {
    start: ['开饭了——', '白饭时间到！', '饿了饿了饿了'],
    down: ['等我下去……', '下面有饭香', '让一让，我下去了'],
    expect: ['饭呢？饭呢？', '快点快点', '……还没好吗'],
    drop: ['掉下来了！', '接住！', '来了来了'],
    bowl: ['碗饭最香', '这个碗我要了', '再来一碗'],
    ball: ['饭团饭团', '一口一个', '捏得刚好'],
    full: ['嗝——还能吃！', '这点不够塞牙缝', '再来十份'],
  };

  /** 样式表去重标记（与 dsh-pet / cordis-probe 同一套 `data-plugin-css` 约定）。 */
  const STYLE_TAG = 'dsh-pet-baifan/baifan.css';

  /** 覆盖层根节点 id，重复执行时按它摘掉旧的。 */
  const ROOT_ID = 'dsh-pet-baifan-root';

  /**
   * 覆盖层压在宠物之上（渲染端 overlay 是 1000），但压不过 DSH 自己的模态框 ——
   * 米饭掉进对话框上面会很难看，所以贴着宠物那一层往上放一点点。
   */
  const Z_INDEX = 1500;

  const CSS = [
    '#dsh-pet-baifan-root{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:' + Z_INDEX + '}',
    '.bf-rice{position:absolute;transform-origin:50% 100%;will-change:transform,opacity;',
    'user-select:none;-webkit-user-drag:none;pointer-events:none}',
    '.bf-score{position:absolute;display:flex;align-items:center;gap:6px;',
    'padding:5px 13px 5px 7px;border-radius:999px;white-space:nowrap;',
    'background:linear-gradient(180deg,#fff 0%,#e9f1fa 100%);',
    'border:1px solid rgba(23,64,107,.16);',
    'box-shadow:0 8px 22px rgba(23,64,107,.2),inset 0 1px 0 #fff;',
    'pointer-events:none;transform-origin:50% 100%}',
    '.bf-score img{width:26px;height:26px;object-fit:contain;display:block}',
    '.bf-score img.bowl{width:32px;height:22px}',
    '.bf-score .num{font-size:22px;font-weight:800;color:#17406b;line-height:1}',
    '.bf-score .plus{position:absolute;right:-6px;top:-10px;font-size:13px;font-weight:800;',
    'color:#e8825a;text-shadow:0 1px 0 #fff}',
    '.bf-toast{position:absolute;left:50%;bottom:64px;transform:translateX(-50%);',
    'padding:8px 16px;border-radius:999px;font:13px/1.5 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;',
    'background:rgba(34,52,74,.88);color:#fff;opacity:0;transition:opacity .25s ease;pointer-events:none}',
    '.bf-toast.show{opacity:1}',
  ].join('');

  // ===== 状态（全部挂在页面级对象上，重复执行时由新一轮 apply 重新初始化） =====

  /** 行为状态机当前相位：idle / walk / expect / chase / eat。 */
  let phase = 'idle';

  /** 行为是否在跑。 */
  let running = false;

  /** 插件是否已卸载。 */
  let disposed = false;

  /** 当前指挥的宠物 id（由菜单事件带回来，不猜）。 */
  let petId = null;

  /** 占用锁编号；null = 没锁。 */
  let lockId = null;

  /** 心跳发现锁没了（用户拖走 / 过期 / 被抢）。 */
  let lockLost = false;

  /** 已经吃了几份。 */
  let eaten = 0;

  /** 当前朝向（'left' 素材原样 / 'right' 镜像）。 */
  let facing = 'left';

  /** 最近一次量到的精灵尺寸（像素），用来把米饭、判定距离一起缩放。 */
  let sprite = { w: 0, h: 0 };

  /** 地面上跑的目标垂直坐标（归一化，宠物**中心**）。 */
  let groundNormY = 0.86;

  /** 场上所有米饭：{ el, x, y, w, h, type, vy, rot, spin, state }。 */
  let rice = [];

  /** 没饭可追时的溜达目标（像素）；null = 该重新抽一个。 */
  let patrolX = null;

  /**
   * 侧身跑的"接力令牌"。
   *
   * 侧身跑是循环素材，靠「播完就再点一次」接下去 —— 谁在接由令牌决定：每次换朝向、
   * 开始吃、收场都 `+1`，旧的那轮在下一个 await 之后看到令牌变了就自己退出，
   * 不会跟新的点播抢这只宠物。
   */
  let sideToken = 0;

  /** 侧身跑的接力是否还活着（吃、收场会把它停掉，之后必须能重新拉起来）。 */
  let sideActive = false;


  let spawnTimer = null;
  let sideWatch = null;
  let renewTimer = null;
  let fallRaf = 0;
  let menuAbort = null;
  let lastFallTs = 0;

  let layer = null;
  let toastEl = null;

  /** 演出代号：每次开一场 +1，旧的那一场收尾时不能动新的一场。 */
  let showGen = 0;

  /** 本场演出的取消开关：收场时一刀切断所有挂在半路的请求。 */
  let showAbort = null;

  /** 页面内 Cordis 上下文（apply 时拿到）。 */
  let ctxRef = null;

  /**
   * 拿 dsh-pet 的页面内只读服务 `petApi7340`。
   *
   * 它只提供 `pose` / `progress` 两个读方法 —— 动作一律走 HTTP。拿不到就返回 undefined，
   * 调用点按"这一页没有宠物"处理。
   *
   * @returns {any}
   */
  function petApi() {
    if (ctxRef === null) return undefined;
    try {
      return ctxRef.get('petApi7340', false) ?? undefined;
    } catch {
      return undefined;
    }
  }

  // ===== 小工具 =====

  /** @param {number} ms */
  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  /** @param {string} s */
  const enc = (s) => encodeURIComponent(s);

  /**
   * 建一个元素。
   *
   * @param {string} tag
   * @param {string} [className]
   * @returns {HTMLElement}
   */
  function el(tag, className) {
    const node = document.createElement(tag);
    if (className !== undefined) node.className = className;
    return node;
  }

  /**
   * 注入样式表（只注入一次）。
   *
   * @returns {HTMLStyleElement|null} 本次新插入的标签；已存在时返回 null。
   */
  function injectCss() {
    if (document.querySelector('style[data-plugin-css="' + STYLE_TAG + '"]') !== null) return null;
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-pet-baifan';
    tag.dataset.pluginCss = STYLE_TAG;
    tag.textContent = CSS;
    document.head.appendChild(tag);
    return tag;
  }

  /**
   * 底部居中提示条，1.8 秒后自己淡掉。
   *
   * @param {string} text
   */
  function toast(text) {
    if (toastEl === null) return;
    toastEl.textContent = text;
    toastEl.classList.add('show');
    window.clearTimeout(toast._t);
    toast._t = window.setTimeout(() => toastEl.classList.remove('show'), 1800);
  }

  /**
   * 归一化坐标夹到 0–1（宿主也会夹，但我们算出来的值有时会因为窗口极小越界）。
   *
   * @param {number} v
   * @returns {number}
   */
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  // ===== HTTP =====

  /**
   * 调 dsh-pet 的接口。
   *
   * 业务失败一律 HTTP 200 + `ok: false`，所以这里不抛错，把判决权交给调用方；
   * 只有网络层失败（连接断了 / 被 abort）才会抛。
   *
   * 每一个调用都带**超时**，并且挂在本场演出的 AbortController 上：收场时能把还挂在
   * 半路的请求一刀切断，不然一次卡死就会让 `running` 永远为 true —— 再点菜单只会回
   * 「它已经在吃了」，而锁还挂在宿主里。
   *
   * @param {string} method
   * @param {string} path - 含 query 的路径，如 `/lock?pet=main&surface=web`。
   * @param {object} [body]
   * @param {AbortSignal} [signal]
   * @returns {Promise<any>}
   */
  async function http(method, path, body, signal) {
    /** @type {RequestInit} */
    const init = { method };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }

    const controller = new AbortController();
    const forward = () => controller.abort();
    const effective = signal !== undefined ? signal : showAbort === null ? undefined : showAbort.signal;
    if (effective !== undefined) {
      if (effective.aborted) controller.abort();
      else effective.addEventListener('abort', forward, { once: true });
    }
    const timer = window.setTimeout(() => controller.abort(), CFG.httpTimeoutMs);
    init.signal = controller.signal;
    try {
      const res = await fetch(API + path, init);
      try {
        return await res.json();
      } catch {
        return { ok: false, reason: 'bad-response' };
      }
    } finally {
      window.clearTimeout(timer);
      if (effective !== undefined) effective.removeEventListener('abort', forward);
    }
  }

  /** 锁类失败统一在这里判一下，省得每个调用点各写一遍。 */
  function noteFailure(reason) {
    if (reason === 'lock-lost' || reason === 'lock-required') lockLost = true;
  }

  // ===== 气泡 =====

  /**
   * 让桌宠说一句。
   *
   * 三个要点：
   * - `anim: false` **必须给**：缺省 `true` 会让渲染端联动它自己的 `events.whisper` 动画，
   *   那一下会把我们正在播的跑步 / 吃动画顶掉 —— 我们只要气泡，不要它抢戏；
   * - 写到 `pets.<id>.say` 这个叶子里，与碎碎念同一份，两端自带渲染，不需要我们画；
   * - 失败不影响演出：一律 `.catch` 掉。
   *
   * @param {string} text
   * @param {number} [ms] - 气泡停留时长，缺省 `CFG.bubbleMs`。
   */
  function say(text, ms) {
    if (!alive() || lockId === null) return;
    void http('POST', '/broadcast?pet=' + enc(petId) + '&surface=web&lock=' + enc(lockId), {
      text,
      duration: ms !== undefined ? ms : CFG.bubbleMs,
      anim: false,
    }).catch(() => {});
  }

  /**
   * 从台词池里随机挑一句。
   *
   * @param {string[]} pool
   * @returns {string}
   */
  function pickLine(pool) {
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // ===== 宠物几何 =====

  /**
   * 读当前实况。
   *
   * @returns {{x: number, y: number, facing: 'left'|'right'}|null}
   */
  function poseOf() {
    const api = petApi();
    if (api === undefined || petId === null) return null;
    try {
      return api.pose(petId);
    } catch {
      return null;
    }
  }

  /**
   * 量精灵盒子。
   *
   * 优先在 DOM 里找**正压在实况中心点上的那段 `<video>`**（渲染端把宠物画成 video），
   * 它的 rect 就是角色的真实占位 —— 这样不必猜 `size` 是宽还是高。找不到就退回
   * 最近一次量到的值，再不行按 498×280（16:9）兜底。
   *
   * @param {number} cx - 中心点视口 x（像素）。
   * @param {number} cy - 中心点视口 y（像素）。
   * @returns {{w: number, h: number}}
   */
  function spriteBox(cx, cy) {
    let best = null;
    let bestD = Infinity;
    const videos = document.querySelectorAll('video');
    for (const video of videos) {
      const rect = video.getBoundingClientRect();
      if (rect.width < 60 || rect.height < 30) continue;
      const d = Math.hypot(rect.left + rect.width / 2 - cx, rect.top + rect.height / 2 - cy);
      if (d < bestD) {
        bestD = d;
        best = rect;
      }
    }
    if (best !== null && bestD < 90) {
      sprite = { w: best.width, h: best.height };
      return sprite;
    }
    if (sprite.w > 0) return sprite;
    return { w: CFG.refWidth, h: (CFG.refWidth * 9) / 16 };
  }

  /**
   * 由实况算出这一帧的几何量（全部是视口像素）。
   *
   * 素材是 16:9，但渲染端的容器不一定也是 16:9（可能按正方形、也可能带内边距），
   * 那时角色在容器里是**带黑边的**。所以先按 16:9 从容器里裁出"真正画出来的那块"，
   * 再按它算脚底和嘴 —— 否则脚底会算低，角色被屏幕底边切掉半截。
   *
   * @param {{x: number, y: number, facing: string}} pose
   * @returns {{cx: number, cy: number, w: number, h: number, top: number, feet: number, mouthY: number, scale: number}}
   */
  function geometry(pose) {
    const cx = pose.x * window.innerWidth;
    const cy = pose.y * window.innerHeight;
    const box = spriteBox(cx, cy);
    const contentH = Math.min(box.h, (box.w * 9) / 16);
    const padTop = (box.h - contentH) / 2;
    const top = cy - box.h / 2 + padTop;
    return {
      cx,
      cy,
      w: box.w,
      h: contentH,
      top,
      feet: top + contentH * CFG.footRatio,
      mouthY: top + contentH * CFG.mouthRatio,
      scale: box.w / CFG.refWidth,
    };
  }

  /** 地面线（视口像素，米饭底边落在这儿）。 */
  const groundLine = () => window.innerHeight - CFG.groundOffset;

  /**
   * 让角色**脚底**落在地面线时，中心点该在哪个归一化 y。
   *
   * @param {{cy: number, feet: number}} geom
   * @returns {number}
   */
  function bottomNormY(geom) {
    return clamp01((groundLine() - (geom.feet - geom.cy)) / window.innerHeight);
  }

  // ===== 播放控制 =====

  /**
   * 点播一段自带素材。
   *
   * @param {string} url - 完整 http(s) 地址。
   * @param {'left'|'right'} [dir] - 朝向；不给就不动朝向。
   * @param {AbortSignal} [signal]
   * @returns {Promise<string|null>} playbackId。
   */
  async function playAnim(url, dir, signal) {
    const body = { url };
    if (dir !== undefined) body.facing = dir;
    const r = await http('POST', '/anim?pet=' + enc(petId) + '&surface=web&lock=' + enc(lockId), body, signal);
    if (r.ok !== true) {
      noteFailure(r.reason);
      throw new Error('点播失败：' + (r.reason || 'unknown'));
    }
    return r.playbackId ?? null;
  }

  /**
   * 等一次点播走到**终态**。
   *
   * `POST /anim` 的 `ok: true` 只代表受理了 —— 素材没拿到、解码失败、被新点播顶掉、
   * 被占用锁冻住，都可能让它根本没播完。真正的结束只有渲染端上报的回执知道，所以这里
   * 挂 `GET /playback/{id}?wait=ended,failed,cancelled`：终态三个一起等，只在 `ended` 上等
   * 会在失败时白等一整个 timeout。
   *
   * 单次 `timeout` 上限 10 秒，所以套一层循环把总预算拉长（比如浏览器节流、素材偏长）。
   *
   * @param {string|null} id - `playAnim` 回的 playbackId。
   * @returns {Promise<{status: string, reason?: string}>} 终态；查询失败/过期时 status 为 `gone`。
   */
  async function waitPlayback(id) {
    if (id === null) return { status: 'gone' };
    const deadline = performance.now() + CFG.waitBudgetMs;
    for (;;) {
      const left = deadline - performance.now();
      if (left <= 0) return { status: 'timeout' };
      let r;
      try {
        r = await http(
          'GET',
          '/playback/' + enc(id) + '?wait=ended,failed,cancelled&timeout=' + Math.min(10000, Math.round(left)),
        );
      } catch {
        return { status: 'gone' };
      }
      // 记录过期（60 秒后清理）回 { error: 'unknown playback' }
      if (r === null || typeof r !== 'object' || r.error !== undefined) return { status: 'gone' };
      if (r.status === 'ended' || r.status === 'failed' || r.status === 'cancelled') return r;
      // matched=false：这 10 秒里没结束，还在播 → 接着等
    }
  }

  /**
   * 读这次点播的**真实片长**（毫秒）。
   *
   * 只用来给「米饭飞向嘴边」的动画定长 —— 它不该比咀嚼先结束，也不该在咀嚼结束后还挂着。
   * 数据来自页面内的 `petApi7340.progress()`，用 playbackId 对上是哪一次；读不到就兜底。
   *
   * @param {string|null} id
   * @returns {Promise<number>}
   */
  async function clipMs(id) {
    const api = petApi();
    if (id !== null && api !== undefined && typeof api.progress === 'function') {
      for (let i = 0; i < 20; i += 1) {
        let p;
        try {
          p = api.progress(petId);
        } catch {
          break;
        }
        if (p !== null && p !== undefined && p.playbackId === id && p.duration > 0.2) return p.duration * 1000;
        await sleep(60);
      }
    }
    return CFG.flyFallbackMs;
  }

  /**
   * 读当前实况的播放进度（页面内只读服务，零请求）。
   *
   * 这是**无缝换段**的关键：回执只告诉你"结束了没有"，而 `progress` 有 `currentTime` /
   * `duration`，能在素材还剩一点尾巴时就点下一段 —— 锁占用期间宠物自己是静止的，
   * 一段播完到下一段开始之间的空档就是"在滑但没有跑步动画"。
   *
   * @returns {{playbackId: string|null, currentTime: number, duration: number, paused: boolean}|null}
   */
  function progressOf() {
    const api = petApi();
    if (api === undefined || typeof api.progress !== 'function' || petId === null) return null;
    try {
      return api.progress(petId);
    } catch {
      return null;
    }
  }

  /**
   * 守着一段正在播的素材，等它**快要播完**（而不是播完）时返回 true。
   *
   * @param {string|null} id - 要守的那一次的 playbackId。
   * @returns {Promise<boolean>} true = 该接下一段了；false = 这段已经不属于我们（被顶掉 / 换源）。
   */
  async function keepWarm(id) {
    if (id === null) return false;
    const start = performance.now();
    const deadline = start + CFG.waitBudgetMs;
    let seen = false;
    for (;;) {
      const p = progressOf();
      if (p !== null && p.playbackId === id) {
        seen = true;
        if (p.paused) return true;
        if (p.duration > 0.3 && p.currentTime >= p.duration - CFG.preRollSec) return true;
      } else if (seen) {
        // 播过一段，现在前台已经换成别的了 —— 我们这一轮到此为止
        return false;
      } else if (performance.now() - start > CFG.pollLatencyMs + 800) {
        // 一直没轮到我们播（被 busy 吞了 / 还没换源）：交给调用方重点一次
        return true;
      }
      if (performance.now() > deadline) return false;
      await sleep(90);
    }
  }

  /**
   * 等宠物走到某个位置。
   *
   * 渲染端对 `/state` 是**每秒轮询**的，所以一条位置指令从发出到真正起步最多差一秒，
   * 这里只负责"等到它到"，超时就交给调用方重发。
   *
   * @param {number|null} goalX - 目标像素 x；null = 不看 x。
   * @param {number|null} goalY - 目标归一化 y；null = 不看 y。
   * @param {number} budget - 最多等多久（毫秒）。
   */
  async function waitArrive(goalX, goalY, budget) {
    const deadline = performance.now() + budget;
    for (;;) {
      const pose = poseOf();
      if (pose === null) return;
      const okX = goalX === null || Math.abs(pose.x * window.innerWidth - goalX) <= CFG.arrivePx;
      const okY = goalY === null || Math.abs(pose.y - goalY) <= 0.02;
      if (okX && okY) return;
      if (!alive() || performance.now() > deadline) return;
      await sleep(100);
    }
  }

  /**
   * 下发一次位置。
   *
   * @param {number} xNorm
   * @param {number} yNorm
   * @param {'instant'|'line'} mode
   * @param {number} [duration] - 仅 line 用。
   * @param {AbortSignal} [signal]
   * @returns {Promise<any>}
   */
  async function movePet(xNorm, yNorm, mode, duration, signal) {
    const body = { x: clamp01(xNorm), y: clamp01(yNorm), mode };
    if (mode === 'line') body.duration = Math.max(0, duration ?? 0);
    const r = await http('POST', '/position?pet=' + enc(petId) + '&surface=web&lock=' + enc(lockId), body, signal);
    if (r.ok !== true) noteFailure(r.reason);
    return r;
  }

  // ===== 米饭 =====

  /**
   * 从天上掉一份饭。
   *
   * 位置在视口里随机（左右各留 70px），尺寸按精灵缩放 —— 大宠物配大盘饭。
   */
  function spawnRice() {
    if (rice.length >= CFG.maxRice) return;
    if (layer === null) return;
    const isBowl = Math.random() < CFG.bowlRatio;
    const scale = sprite.w > 0 ? sprite.w / CFG.refWidth : 1;
    const w = (isBowl ? 124 : 110) * scale;
    const img = el('img', 'bf-rice');
    img.src = isBowl ? A.bowlFull : A.riceBall;
    img.alt = '';
    img.draggable = false;
    img.style.width = w + 'px';
    img.style.height = w + 'px';
    const item = {
      el: img,
      x: 70 + Math.random() * Math.max(10, window.innerWidth - 140),
      y: -w - 20,
      w,
      h: w,
      type: isBowl ? 'bowl' : 'ball',
      vy: 170 + Math.random() * 60,
      rot: 0,
      spin: isBowl ? 0 : (Math.random() < 0.5 ? -1 : 1) * 90,
      state: 'falling',
    };
    layer.appendChild(img);
    rice.push(item);
    layoutRice(item);
  }

  /** @param {any} item */
  function layoutRice(item) {
    item.el.style.left = item.x - item.w / 2 + 'px';
    item.el.style.top = item.y - item.h + 'px';
    item.el.style.transform = 'rotate(' + item.rot + 'deg)';
  }

  /**
   * 空碗：从嘴边掉到地上，弹两下，然后淡出。
   *
   * @param {number} x - 嘴部视口 x。
   * @param {number} fromY - 嘴部视口 y（碗底先放这儿）。
   * @param {number} scale
   */
  function dropEmptyBowl(x, fromY, scale) {
    if (layer === null) return;
    const w = 124 * scale;
    const img = el('img', 'bf-rice');
    img.src = A.bowlEmpty;
    img.alt = '';
    img.draggable = false;
    img.style.width = w + 'px';
    img.style.height = w + 'px';
    img.style.left = x - w / 2 + 'px';
    img.style.top = fromY - w + 'px';
    layer.appendChild(img);

    const drop = Math.max(0, groundLine() - fromY);
    img.animate(
      [
        { transform: 'translateY(0)' },
        { transform: 'translateY(' + drop + 'px)', offset: 0.48, easing: 'ease-in' },
        { transform: 'translateY(' + (drop - 42 * scale) + 'px)', offset: 0.62, easing: 'ease-out' },
        { transform: 'translateY(' + drop + 'px)', offset: 0.74, easing: 'ease-in' },
        { transform: 'translateY(' + (drop - 14 * scale) + 'px)', offset: 0.82, easing: 'ease-out' },
        { transform: 'translateY(' + drop + 'px)', offset: 0.9 },
        { transform: 'translateY(' + drop + 'px)', offset: 1 },
      ],
      { duration: 820, easing: 'linear' },
    );
    window.setTimeout(() => {
      img.style.transition = 'opacity .9s ease';
      img.style.opacity = '0';
      window.setTimeout(() => img.remove(), 950);
    }, 900);
  }

  /**
   * 吃掉一份：飞到嘴边 → 随咀嚼变小 → 空碗落地 → 弹分数。
   *
   * 两处对齐很关键：
   * - **定住与点播一起发**：渲染端每秒轮询一次，分两条发就会"先站住一秒再开吃"；
   * - **嘴的位置在动画真的开始播之后才量**（`clipMs` 返回时 playbackId 已经出现），
   *   否则用的还是滑动中途的旧位置，米饭会飞到空气里。
   *
   * @param {any} item
   * @param {{cx: number, w: number, h: number, mouthY: number, scale: number}} geom
   */
  async function eatOne(item, geom) {
    phase = 'eat';
    // 先把侧身跑的接力停掉，否则它会在吃动画开始时把这一段顶掉
    sideToken += 1;
    sideActive = false;
    const index = rice.indexOf(item);
    if (index >= 0) rice.splice(index, 1);
    const isBowl = item.type === 'bowl';

    const pose = poseOf();
    const [, playId] = await Promise.all([
      pose === null ? null : movePet(pose.x, groundNormY, 'instant').catch(() => null),
      playAnim(isBowl ? A.eatBowl : A.eatBall, facing).catch(() => null),
    ]);
    const flyMs = await clipMs(playId);

    // 动画已经开播，这一刻的位置才是嘴的位置
    const settled = poseOf();
    const g = settled === null ? geom : geometry(settled);
    const mouthX = g.cx + CFG.mouthDx * g.w * (facing === 'right' ? -1 : 1);
    const mouthY = g.mouthY;
    const dx = mouthX - item.x;
    const dy = mouthY - (item.y - item.h / 2);
    item.el.style.zIndex = '5';
    // 飞行末段把食物缩到 0.72：整份原尺寸怼在脸上会把眼睛盖住。
    // transform-origin 是 50% 100%（底边），所以缩放是「从下往上收」，不会越缩越高。
    item.el.animate(
      [
        { transform: 'translate(0,0) scale(1)', opacity: 1, offset: 0 },
        { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.72)', opacity: 1, offset: 0.16 },
        { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.68)', opacity: 1, offset: 0.55 },
        { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.12)', opacity: 0, offset: 1 },
      ],
      { duration: flyMs, easing: 'ease-in-out', fill: 'forwards' },
    );
    window.setTimeout(() => item.el.remove(), flyMs + 80);

    if (isBowl) {
      window.setTimeout(() => dropEmptyBowl(mouthX, mouthY, g.scale), Math.max(0, flyMs - 120));
    }

    await waitPlayback(playId);
    if (!running || disposed) return;

    eaten += 1;
    popScore(eaten, item.type, g);
    say(pickLine(isBowl ? LINES.bowl : LINES.ball), 2400);
    // 吃到一定数量才吹牛，不然每口都来一句会烦
    if (eaten % 5 === 0) window.setTimeout(() => say(pickLine(LINES.full), 2600), 1200);
    phase = 'chase';
  }

  /**
   * 头顶分数气泡：图标随刚吃下的那份饭变（碗饭 / 饭团）。
   *
   * @param {number} value - 累计份数。
   * @param {'bowl'|'ball'} type
   * @param {{cx: number, top: number, h: number}} geom
   */
  function popScore(value, type, geom) {
    if (layer === null) return;
    const isBowl = type === 'bowl';
    const node = el('div', 'bf-score');
    node.innerHTML =
      '<img class="' + (isBowl ? 'bowl' : 'ball') + '" src="' + (isBowl ? A.bowlFull : A.riceBall) + '" alt="">' +
      '<span class="num">' + value + '</span>' +
      '<span class="plus">+1</span>';
    node.style.left = geom.cx + 'px';
    node.style.top = geom.top + geom.h * 0.09 + 'px';
    layer.appendChild(node);

    node.animate(
      [
        { opacity: 0, transform: 'translate(-50%,-100%) scale(.55)' },
        { opacity: 1, transform: 'translate(-50%,-100%) scale(1.16)', offset: 0.26 },
        { opacity: 1, transform: 'translate(-50%,-100%) scale(1)', offset: 0.5 },
        { opacity: 1, transform: 'translate(-50%,-100%) scale(1)', offset: 0.78 },
        { opacity: 0, transform: 'translate(-50%,-132%) scale(1)', offset: 1 },
      ],
      { duration: 1300, easing: 'ease-out', fill: 'forwards' },
    );
    const plus = node.querySelector('.plus');
    if (plus !== null) {
      plus.animate(
        [
          { opacity: 0, transform: 'translateY(6px) scale(.8)' },
          { opacity: 1, transform: 'translateY(-4px) scale(1)', offset: 0.25 },
          { opacity: 1, transform: 'translateY(-10px) scale(1)', offset: 0.7 },
          { opacity: 0, transform: 'translateY(-18px) scale(1)' },
        ],
        { duration: 1000, easing: 'ease-out', fill: 'forwards' },
      );
    }
    window.setTimeout(() => node.remove(), 1350);
  }

  /**
   * 落体循环：只在「有东西还在天上」时才跑 rAF，落地后自然停下来。
   *
   * @param {number} ts
   */
  function fallTick(ts) {
    fallRaf = 0;
    if (layer === null) return;
    if (!lastFallTs) lastFallTs = ts;
    const dt = Math.min((ts - lastFallTs) / 1000, 0.05);
    lastFallTs = ts;

    let falling = false;
    const line = groundLine();
    for (const item of rice) {
      if (item.state !== 'falling') {
        if (item.rot !== 0) {
          item.rot = 0;
          layoutRice(item);
        }
        continue;
      }
      falling = true;
      item.y += item.vy * dt;
      item.rot += item.spin * dt;
      if (item.y >= line) {
        item.y = line;
        item.state = 'ground';
        item.el.animate(
          [{ transform: 'scaleY(1)' }, { transform: 'scaleY(.92)' }, { transform: 'scaleY(1)' }],
          { duration: 160, easing: 'ease-out' },
        );
      }
      layoutRice(item);
    }
    if (falling && fallRaf === 0 && !disposed) fallRaf = window.requestAnimationFrame(fallTick);
  }

  /** 按需拉起落体循环。 */
  function kickFall() {
    if (fallRaf === 0 && !disposed) fallRaf = window.requestAnimationFrame(fallTick);
  }

  /** 开刷：先掉一份，之后按间隔继续，场上满了就自然停下。 */
  function startSpawning() {
    if (spawnTimer !== null) return;
    spawnRice();
    kickFall();
    spawnTimer = window.setInterval(() => {
      if (phase === 'chase' || phase === 'eat') {
        spawnRice();
        kickFall();
      }
    }, CFG.spawnMs);
  }

  // ===== 锁定 =====

  /** sessionStorage 里记锁编号用的键前缀（按宠物分开）。 */
  const LOCK_KEY = 'dsh-pet-baifan/lock/';

  /**
   * 读本标签页上次拿到的锁编号。
   *
   * 刷新页面时旧页面的 JS 直接被销毁，**来不及放锁** —— 那把锁会一直挂到 TTL 到点。
   * 记在 sessionStorage 里（同一标签页刷新后还在），下次开演先拿它去续期：
   * 续得上说明那本来就是我的锁，直接接管；续不上才是别人的。
   *
   * @param {string} id - 宠物 id。
   * @returns {string|null}
   */
  function readStoredLock(id) {
    try {
      return sessionStorage.getItem(LOCK_KEY + id);
    } catch {
      return null;
    }
  }

  /**
   * 写入 / 清除本标签页的锁编号。
   *
   * @param {string} id - 宠物 id。
   * @param {string|null} lock
   */
  function writeStoredLock(id, lock) {
    try {
      if (lock === null) sessionStorage.removeItem(LOCK_KEY + id);
      else sessionStorage.setItem(LOCK_KEY + id, lock);
    } catch {
      // 隐私模式 / 禁用存储都不影响演出
    }
  }

  /** 取锁。 */
  async function acquire() {
    // 1) 先试"我自己的旧锁"（刷新页面留下的）
    const stored = readStoredLock(petId);
    if (stored !== null) {
      const renewed = await http('POST', '/lock?pet=' + enc(petId) + '&surface=web', { lockId: stored });
      if (renewed.ok === true) {
        lockId = renewed.lockId;
        lockLost = false;
        return;
      }
      writeStoredLock(petId, null);
    }

    // 2) 新建
    const r = await http('POST', '/lock?pet=' + enc(petId) + '&surface=web', { ttl: CFG.lockTtl });
    if (r.ok === true) {
      lockId = r.lockId;
      lockLost = false;
      writeStoredLock(petId, lockId);
      return;
    }

    const reason = r.reason || 'unknown';
    if (reason === 'pet-not-displayed') throw new Error('这只宠物没显示在网页里（display=' + r.display + '）');
    if (reason !== 'locked') throw new Error('取锁失败：' + reason);

    // 3) 被占着：可能是上一场（或别的插件）还没过期。等一等，别直接判死。
    const expiresAt = typeof r.expiresAt === 'number' ? r.expiresAt : 0;
    const waitMs = Math.min(CFG.lockWaitMs, Math.max(0, expiresAt - Date.now()) + 2000);
    toast('上一场还没收干净，等它过期…');
    const deadline = performance.now() + waitMs;
    for (;;) {
      if (!alive()) throw new Halted();
      if (performance.now() > deadline) break;
      await sleep(1500);
      if (!alive()) throw new Halted();
      const retry = await http('POST', '/lock?pet=' + enc(petId) + '&surface=web', { ttl: CFG.lockTtl });
      if (retry.ok === true) {
        lockId = retry.lockId;
        lockLost = false;
        writeStoredLock(petId, lockId);
        return;
      }
      if (retry.reason !== 'locked') throw new Error('取锁失败：' + (retry.reason || 'unknown'));
    }
    throw new Error('宠物被别人占着，等会儿再试');
  }

  /** 心跳：续期顺带探活，丢了就置 lockLost，追击循环下一拍自然收场。 */
  function startRenew() {
    stopRenew();
    renewTimer = window.setInterval(async () => {
      if (!running || lockId === null || lockLost) return;
      try {
        const r = await http('POST', '/lock?pet=' + enc(petId) + '&surface=web', { lockId });
        if (r.ok !== true) {
          // 续不上就是丢了（过期 / 被用户拖走 / 被别的插件抢）—— 不必等 TTL
          noteFailure(r.reason);
          lockLost = true;
        }
      } catch {
        // 网络抖动不算丢锁：下一拍再试
      }
    }, CFG.renewMs);
  }

  function stopRenew() {
    if (renewTimer !== null) window.clearInterval(renewTimer);
    renewTimer = null;
  }

  // ===== 行为 =====

  /** 行为是否还该继续。 */
  const alive = () => running && !lockLost && !disposed;

  /** 被用户打断（拖拽撤锁 / 插件卸载）时用这个异常跳出去，避免走"出错"那条路。 */
  class Halted extends Error {}

  /**
   * 一阶段：跑到底部。
   *
   * 蓄力（原地播开心小跑）→ 直线跑到**随机落点**。落点只保留左右各一个身位的边距，
   * 其余全宽随机 —— 每次落点都不一样，是这个表演的第一眼观感。
   */
  async function phaseWalk() {
    phase = 'walk';
    const pose = poseOf();
    if (pose === null) throw new Error('这一页找不到这只宠物');
    const geom = geometry(pose);
    groundNormY = bottomNormY(geom);
    const margin = Math.max(60, geom.w / 2);
    const targetPx = margin + Math.random() * Math.max(10, window.innerWidth - margin * 2);
    facing = targetPx >= geom.cx ? 'right' : 'left';
    say(pickLine(LINES.down), 2400);
    // 先做一次"原地热身"再跑：见 warmPosition 的注释
    await warmPosition();
    await playAnim(A.runForward, facing);
    await sleep(CFG.prepMs);
    if (!alive()) throw new Halted();
    // 分三段走完：即便渲染端对某一条指令偷懒（直接落位），也只丢三分之一的路程
    await glideTo(targetPx / window.innerWidth, groundNormY, CFG.travelMs, 3);
    await waitArrive(targetPx, groundNormY, CFG.pollLatencyMs + 1500);
    if (!alive()) throw new Halted();
  }

  /**
   * 把一段直线位移拆成几段依次下发。
   *
   * 目的不是画质，是**抗单条指令失效**：渲染端若把某一条 line 当成"直接落位"，
   * 拆开之后那一下只丢掉 1/n 的距离，而不是整段瞬移。
   *
   * @param {number} xNorm - 终点归一化 x。
   * @param {number} yNorm - 终点归一化 y。
   * @param {number} ms - 总时长。
   * @param {number} steps - 拆几段（1–8）。
   */
  async function glideTo(xNorm, yNorm, ms, steps) {
    const start = poseOf();
    if (start === null) return;
    const n = Math.max(1, Math.min(8, steps));
    const part = ms / n;
    for (let i = 1; i <= n; i += 1) {
      const t = i / n;
      await movePet(start.x + (xNorm - start.x) * t, start.y + (yNorm - start.y) * t, 'line', part);
      if (!alive()) return;
      await sleep(part + 60);
    }
  }

  /**
   * 原地挪 2 像素，把渲染端的"起点"喂给它。
   *
   * 进入页面后的**第一条**位置指令不会做插值 —— 渲染端那一刻还没有"上一个位置"，
   * 于是直接落到目标点。表现就是："第一次点「吃白饭」，宠物瞬移到底部"。
   * 先用一条几乎为零的位移把起点建立起来（走 2px、耗时 140ms，肉眼看不出），
   * 后面那条真正的大位移才会老老实实按 duration 走。
   */
  async function warmPosition() {
    const pose = poseOf();
    if (pose === null) return;
    await movePet(pose.x, clamp01(pose.y - 0.003), 'line', 140);
    await sleep(220);
  }

  /**
   * 二阶段：期待开饭。
   *
   * 素材已烘成 2 倍速，播多久由进度说了算；**尾巴上就开始接侧身跑**，
   * 免得期待播完之后宠物站在那儿等下一段。
   */
  async function phaseExpect() {
    phase = 'expect';
    say(pickLine(LINES.expect), 3000);
    const playId = await playAnim(A.expect, facing);
    await keepWarm(playId);
    if (!alive()) throw new Halted();
  }

  /**
   * 让侧身跑「接力」下去。
   *
   * 素材是可任意相位打断的循环，但 `url` 形态没有 loop、锁占用期间宠物自己又是静止的 ——
   * 所以得在**上一段快播完时**就点下一段（`keepWarm`）。换朝向把令牌 +1，旧的那一轮在
   * 下一个 await 之后自然退出，不跟新点播抢这只宠物。
   *
   * 这是纯"点火"：它自己接着往下接力，**不把接力循环暴露给调用方**。返回的那个 promise
   * 只代表"第一遍点播的受理结果"，而且它来自一次带超时的真实请求，永远会 settle ——
   * 早先返回过一个在令牌被换掉的分支上永不 resolve 的 promise，调用方一 await 就把整场
   * 演出钉死了（`running` 永远是 true，锁也放不掉）。
   *
   * @param {'left'|'right'} dir
   * @returns {Promise<string|null>} 第一遍的 playbackId。
   */
  function runSide(dir) {
    if (dir !== facing) facing = dir;
    sideToken += 1;
    const token = sideToken;
    sideActive = true;
    const started = playAnim(A.runSide, dir).catch(() => null);
    void (async () => {
      let playId = await started;
      for (;;) {
        if (token !== sideToken || !alive()) return;
        if (playId === null) {
          // 被 busy 吞了 / 素材没拿到：缓一拍再点，别把节奏打散
          await sleep(400);
          if (token !== sideToken) return;
          playId = await playAnim(A.runSide, dir).catch(() => null);
          continue;
        }
        if (!(await keepWarm(playId))) {
          if (token === sideToken) sideActive = false;
          return;
        }
        if (token !== sideToken || !alive()) return;
        playId = await playAnim(A.runSide, dir).catch(() => null);
      }
    })();
    return started;
  }

  /**
   * 保证"往 dir 跑"这段动画正在接力中。
   *
   * 换朝向必须重开一段（`facing` 只能靠点播设）；但**吃完之后**那段接力是被刻意停掉的，
   * 如果下一个目标恰好还在同一侧，就没有任何东西会把跑动动画拉起来 —— 宠物会在滑却没有
   * 跑步动画。所以这里判断的是「朝向不对 **或** 接力已经断了」。
   *
   * @param {'left'|'right'} dir
   */
  function ensureSide(dir) {
    if (dir === facing && sideActive) return null;
    return runSide(dir);
  }

  /**
   * 等这段动画**真的开始播**（渲染端把 playbackId 报成我们这条），最多等 budget 毫秒。
   *
   * 位移一定要等它：渲染端换源要先 `fetch` + 解码，这一下就是用户看到的
   * 「人已经滑出去，0.x 秒后动画才跟上」。等到的时机由渲染端自己决定，不猜。
   *
   * @param {Promise<string|null>|null} pending - `runSide` / `ensureSide` 的返回。
   * @param {number} budget
   */
  async function waitPlayStarted(pending, budget) {
    if (pending === null) return;
    const id = await pending; // 真实请求，带超时，一定会 settle
    if (id === null) return;
    const deadline = performance.now() + budget;
    for (;;) {
      const p = progressOf();
      if (p !== null && p.playbackId === id) return;
      if (!alive() || performance.now() > deadline) return;
      await sleep(40);
    }
  }

  /**
   * 前台现在播的是不是侧身跑。
   *
   * 只看 `progress().anim`：`url` 形态点播时它就是素材地址。这是**兜底判据** ——
   * 位置写入会不会顺手把正在播的点播顶掉，文档没有保证，所以我们干脆盯着：一旦发现
   * 跑动动画不在了、而人还在追饭，就重新拉一段。宁可多重启一次，也不要让它在滑。
   *
   * @returns {boolean}
   */
  function sidePlaying() {
    const p = progressOf();
    return p !== null && typeof p.anim === 'string' && p.anim.indexOf('/run-side.webm') >= 0;
  }

  /** 追饭期间的看门狗：跑动动画掉了就补。 */
  function startSideWatch() {
    stopSideWatch();
    sideWatch = window.setInterval(() => {
      if (!alive() || phase !== 'chase') return;
      if (sidePlaying()) return;
      sideActive = false;
      void runSide(facing);
    }, CFG.sideWatchMs);
  }

  function stopSideWatch() {
    if (sideWatch !== null) window.clearInterval(sideWatch);
    sideWatch = null;
  }

  /**
   * 跑一段。
   *
   * 换朝向的动画和这条位移**一起发**：渲染端每秒轮询一次，隔一拍就会先滑出去再转身
   * （看起来就是"在动但动画不对"）。
   *
   * @param {number} goalPx - 目标像素 x。
   * @param {number} speed - 像素/秒。
   * @returns {Promise<boolean>} 是否真的发了一段位移（已在目标点时为 false）。
   */
  async function tripTo(goalPx, speed) {
    const pose = poseOf();
    if (pose === null) return false;
    const petPx = pose.x * window.innerWidth;
    const dist = Math.abs(goalPx - petPx);
    if (dist <= CFG.arrivePx) return false;

    const dir = goalPx > petPx ? 'right' : 'left';
    const duration = Math.min(CFG.tripMaxMs, Math.max(180, (dist / speed) * 1000));

    // 要重开一段动画时，先等它**真的开播**再发位移 —— 否则就是
    // 「人先滑出去，0.x 秒后动画才跟上」。同向续跑时 `ensureSide` 返回 null，不会等。
    await waitPlayStarted(ensureSide(dir), CFG.animLeadMs);

    await movePet(goalPx / window.innerWidth, groundNormY, 'line', duration);
    await waitArrive(goalPx, groundNormY, duration + CFG.pollLatencyMs + 600);
    return true;
  }

  /** 场上离得最近的、已经落地的饭。
   *
   * 但"最近"带一点**朝向偏好**：身后那份要打折才算数。换朝向就要重开一段跑步动画
   * （新视频要解码），那一下必然有个空档；能不换就不换。
   *
   * @param {number} petPx
   * @returns {any|null}
   */
  function pickRice(petPx) {
    let best = null;
    let bestScore = Infinity;
    for (const item of rice) {
      if (item.state !== 'ground') continue;
      const d = Math.abs(item.x - petPx);
      const ahead = facing === 'right' ? item.x > petPx : item.x < petPx;
      const score = ahead ? d : d * CFG.backTurnPenalty;
      if (score < bestScore) {
        bestScore = score;
        best = item;
      }
    }
    return best;
  }

  /** 没饭可追时随便挑个地方跑过去，到了下一拍再挑。 */
  function patrolGoal(petPx, geom) {
    const margin = Math.max(80, geom.w * 0.4);
    if (patrolX === null || Math.abs(patrolX - petPx) <= CFG.arrivePx) {
      patrolX = margin + Math.random() * Math.max(10, window.innerWidth - margin * 2);
    }
    return patrolX;
  }

  /**
   * 三阶段：追饭。
   *
   * 一段一段地跑：**跑到了才做下一个决定**。这不是偷懒 —— 渲染端每秒才轮询一次状态，
   * 一秒里发十条位置指令毫无意义（只会互相覆盖），反而让动画和位移对不上。
   */
  async function phaseChase(gen) {
    phase = 'chase';
    startSpawning();
    startSideWatch();
    say(pickLine(LINES.drop), 2200);

    while (alive() && gen === showGen) {
      const pose = poseOf();
      if (pose === null) throw new Error('这一页找不到这只宠物');
      const geom = geometry(pose);
      groundNormY = bottomNormY(geom);
      const petPx = geom.cx;

      const target = pickRice(petPx);
      const eatPx = CFG.eatPx * (geom.w / CFG.refWidth);
      if (target !== null && Math.abs(target.x - petPx) <= eatPx) {
        await eatOne(target, geom);
        continue;
      }

      const goalPx = target !== null ? target.x : patrolGoal(petPx, geom);
      const speed = target !== null ? CFG.runSpeed : CFG.runSpeed * CFG.patrolSpeedRatio;
      // 已经在目标点上（没发指令）就歇一拍，否则这段循环会空转成死循环
      if (!(await tripTo(goalPx, speed))) await sleep(CFG.idleMs);
    }
    throw new Halted();
  }

  /**
   * 跑完整场表演。
   *
   * @param {string} id - 菜单事件带回来的宠物 id。
   */
  async function runShow(id) {
    const gen = ++showGen;
    petId = id;
    running = true;
    lockLost = false;
    eaten = 0;
    sideToken += 1;
    sideActive = false;
    patrolX = null;
    phase = 'idle';
    showAbort = new AbortController();
    toast('吃白饭 —— 开饭了');

    try {
      await acquire();
      startRenew();
      say(pickLine(LINES.start), 2200);
      await phaseWalk();
      await phaseExpect();
      await phaseChase(gen);
    } catch (error) {
      if (error instanceof Halted) {
        // 正常收场（丢锁 / 卸载）
      } else if (lockLost) {
        toast('锁丢了，表演结束');
      } else {
        toast(error instanceof Error ? error.message : String(error));
        console.warn('[dsh-pet-baifan]', error);
      }
    } finally {
      await halt(lockLost ? '用户接管，已收场' : '', gen);
    }
  }

  /**
   * 收场：停一切、清干净、放锁。
   *
   * 幂等 —— 丢锁、插件卸载都会走到这儿。
   *
   * @param {string} [reason] - 给了就弹一条提示。
   */
  async function halt(reason, gen) {
    if (gen !== undefined && gen !== showGen) return;
    const wasRunning = running;
    running = false;
    phase = 'idle';
    // 把还挂在半路的请求切掉：不然它们会带着旧令牌回来继续动这只宠物
    if (showAbort !== null) {
      showAbort.abort();
      showAbort = null;
    }
    if (spawnTimer !== null) {
      window.clearInterval(spawnTimer);
      spawnTimer = null;
    }
    stopRenew();
    stopSideWatch();
    if (fallRaf !== 0) {
      window.cancelAnimationFrame(fallRaf);
      fallRaf = 0;
    }
    lastFallTs = 0;
    for (const item of rice) {
      const node = item.el;
      node.style.transition = 'opacity .5s ease';
      node.style.opacity = '0';
      window.setTimeout(() => node.remove(), 520);
    }
    rice = [];
    patrolX = null;
    sideToken += 1;
    sideActive = false;

    const lease = lockId;
    lockId = null;
    if (lease !== null) {
      try {
        await http('POST', '/lock/release?pet=' + enc(petId), { lockId: lease });
      } catch {
        // 放不掉也没关系：TTL 到点自己会失效
      }
    }
    writeStoredLock(petId, null);
    if (reason !== undefined && reason !== '' && (wasRunning || lease !== null)) toast(reason);
  }

  /**
   * 页面要走了（刷新 / 关标签页）时，尽最大努力把锁放掉。
   *
   * `fetch` 在这个时机大概率会被掐断，所以用 `sendBeacon`：它由浏览器接管发送，
   * 页面死了也会发完。放不掉还有 TTL（30 秒）与下次开演的"接管旧锁"兜底。
   */
  function releaseOnPageHide() {
    const lease = lockId;
    if (lease === null) return;
    lockId = null;
    if (petId !== null) writeStoredLock(petId, null);
    const url = API + '/lock/release?pet=' + enc(petId);
    const body = JSON.stringify({ lockId: lease });
    try {
      if (navigator.sendBeacon !== undefined) {
        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
        return;
      }
    } catch {
      // 退到 fetch
    }
    try {
      void http('POST', '/lock/release?pet=' + enc(petId), { lockId: lease });
    } catch {
      // 交给 TTL
    }
  }

  // ===== 菜单 =====

  /** 注册（或覆盖注册）本 owner 的菜单项。 */
  async function ensureMenu() {
    const r = await http('POST', '/menu/item', {
      owner: OWNER,
      labels: [LABEL_START],
      // 只挂在网页端：本扩展全在页面里跑（素材同源、位置按视口归一化），
      // 桌面端那条菜单点了也不会有任何反应。
      target: 'web',
    });
    if (r.ok !== true) console.warn('[dsh-pet-baifan] 注册菜单失败：' + (r.reason || 'unknown'));
  }

  /**
   * 长轮询菜单点击。
   *
   * 返回值是「读取即消费」的全量映射 `label → petId | null`，所以这里只处理有值的那两项。
   * owner 不存在（DSH 重启过 / 被别的插件清掉）就补注册一次再继续。
   */
  async function pollMenu() {
    while (!disposed) {
      menuAbort = typeof AbortController === 'function' ? new AbortController() : undefined;
      try {
        const r = await http(
          'GET',
          '/menu/events?owner=' + enc(OWNER) + '&wait=10000',
          undefined,
          menuAbort === undefined ? undefined : menuAbort.signal,
        );
        if (disposed) return;
        if (r.ok === false) {
          await ensureMenu().catch(() => {});
          await sleep(500);
          continue;
        }
        const events = r.events || {};
        if (events[LABEL_START]) {
          // 再点一次 = 重新开一场：先把上一场彻底收掉（含放锁），再起新的。
          // 没有"停止"菜单项，所以这也是从任何卡住状态里出来的唯一入口。
          if (running || lockId !== null) {
            await halt('重新开始');
            await sleep(150);
          }
          void runShow(events[LABEL_START]);
        }
      } catch {
        if (disposed) return;
        await sleep(1500);
        await ensureMenu().catch(() => {});
      }
    }
  }

  // ===== 装配 =====

  /**
   * 预热素材。
   *
   * 渲染端拿到 `anim.url` 后会自己 `fetch` 一次再换源 —— 第一次是冷读，几百毫秒就够让
   * 「人已经开始滑、动画还没起来」。页面里先预取一遍（宿主对素材发的是长缓存），
   * 后面每次点播都是一次缓存命中。
   */
  function warmAssets() {
    const videos = [A.runSide, A.runForward, A.expect, A.eatBowl, A.eatBall];
    void (async () => {
      for (const url of videos) {
        if (disposed) return;
        try {
          await fetch(url, { cache: 'force-cache' });
        } catch {
          // 预热失败无所谓：真点播时会再拉一次
        }
      }
    })();
    for (const url of [A.bowlFull, A.bowlEmpty, A.riceBall]) {
      const img = new Image();
      img.src = url;
    }
  }

  window.__ModuleLoader__.load({
    id: PLUGIN_ID,
    /**
     * @param {(name: string) => any} _require - 本插件不 import 任何模块。
     */
    factory(_require) {
      const name = 'dsh-pet-baifan';
      const inject = ['petApi7340'];

      /**
       * @param {any} ctx - 页面内 Cordis 上下文。
       * @returns {() => void} 卸载钩子。
       */
      function apply(ctx) {
        if (typeof document === 'undefined' || document.body === null) {
          console.warn('[dsh-pet-baifan] 缺少 document，跳过');
          return () => {};
        }
        // 重复执行防护：bundle 重建 / combo 重试会再跑一遍本文件
        const stale = document.getElementById(ROOT_ID);
        if (stale !== null) stale.remove();

        ctxRef = ctx;
        disposed = false;
        petId = null;
        lockId = null;
        lockLost = false;
        eaten = 0;
        facing = 'left';
        sprite = { w: 0, h: 0 };
        rice = [];

        const style = injectCss();
        layer = el('div', 'bf-layer');
        layer.id = ROOT_ID;
        toastEl = el('div', 'bf-toast');
        layer.appendChild(toastEl);
        document.body.appendChild(layer);

        ensureMenu().catch(() => {});
        pollMenu();
        warmAssets();
        window.addEventListener('pagehide', releaseOnPageHide);

        return () => {
          disposed = true;
          window.removeEventListener('pagehide', releaseOnPageHide);
          halt('');
          if (menuAbort !== undefined && menuAbort !== null) menuAbort.abort();
          menuAbort = null;
          http('DELETE', '/menu/item?owner=' + enc(OWNER)).catch(() => {});
          if (ctxRef === ctx) ctxRef = null;
          if (layer !== null) layer.remove();
          layer = null;
          toastEl = null;
          if (style !== null) style.remove();
        };
      }

      return { name, inject, apply };
    },
  });
})();
