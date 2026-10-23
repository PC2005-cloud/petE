/**
 * dsh-pet-fish-day 的浏览器半侧 —— 「大肥鱼的一天」。
 *
 * ## 它是什么
 *
 * 一个第三方客户端插件：不新增素材、不画宠物，只在 dsh-pet 的右键菜单里挂一项
 * （`更多 / 大肥鱼的一天`）。点下去以后拿占用锁，按**一天的日程**依次调用
 *
 *   POST /anim       → 播 dsh-pet 现有的动画（按名字，素材全部复用）
 *   POST /broadcast  → 在宠物头顶说一句话
 *
 * 需要移动时也走 /anim：传移动类动画（螃蟹走路 / 原地漂浮踏步 / 原地左转奔跑）。
 * dsh-pet 的移动系统会接管这一段——按素材自己的 leadSec / tailSec 走真实位移，
 * 不换视频源（回执会被报成 failed/busy），所以移动后不能用回执判断结束，要等整段播完。
 *
 * 直到演完一天，或用户拖走宠物（锁被撤）为止。
 *
 * ## 为什么是"推演"而不是一串固定动画
 *
 * 一天有日程：起床、三餐、工作、午休、晚上娱乐、睡觉；日期还有节日与季节。
 * 事件表（SCHEDULE / FESTIVALS / SEASONS）只描述"几点、做什么、说什么、要不要动"，
 * 调度器负责按时间排序、插入节日与季节事件、在空隙里随机插曲。动画名全部来自
 * dsh-pet 的动画池，名字即文件名，写错会被 /anim 以 unknown-animation 拒绝。
 *
 * ## 覆盖
 *
 * 动画池有一百来个，一场演不完。这里用 shuffle bag：优先抽"还没演过"的，
 * 进度存在 sessionStorage，下一场接着覆盖。
 *
 * ## 契约（DSH 客户端插件）
 *
 * 必须是经典脚本（无顶层 import/export），整份包一层 IIFE，末尾用
 * `window.__ModuleLoader__.load({ id, factory })` 注册。重复执行时按根节点 id 摘掉旧层。
 *
 * @module dsh-pet-fish-day/client
 */

;(() => {
  'use strict';

  /** 插件 id：与 package.json 的 name 一致。 */
  const PLUGIN_ID = 'dsh-pet-fish-day';

  /** 菜单分区键。 */
  const OWNER = 'dsh-pet-fish-day';

  /** 菜单项文案；菜单事件按文案回传，是协议的一部分。 */
  const LABEL = '大肥鱼的一天';

  /** dsh-pet 的 HTTP 基址（同源）。 */
  const API = '/dsh-pet-7340';

  /**
   * 端归属：`any` = 不关心宠物显示在网页还是桌面。
   *
   * dsh-pet 的动作端点要求显式传 `?surface=`；`any` 是它提供的"两端都行"取值。
   * 菜单也注册成 both，所以网页里和桌面上的宠物都能触发同一场演出。
   */
  const SURFACE = 'any';

  /** 本插件挂在页面上的唯一根节点。 */
  const ROOT_ID = 'dsh-pet-fish-day-layer';

  /** sessionStorage 键：本标签页的锁编号 / 已演过的动画。 */
  const LOCK_KEY = 'dsh-pet-fish-day:lock:';
  const SEEN_KEY = 'dsh-pet-fish-day:seen';

  /** 可调参数。 */
  const CFG = {
    lockTtl: 30000,      // 取锁时长：刷新页面留下的锁最多糊住 30 秒
    lockWaitMs: 25000,   // 撞上别人的锁时最多等这么久
    renewMs: 6000,       // 心跳续期间隔
    bubbleHoldMs: 30000, // 气泡挂多久：足够覆盖任何一段素材，下一段动画开始时会被新气泡覆盖
    waitBudgetMs: 30000, // 等一次点播走到终态的总预算
    gapMs: 900,          // 两个事件之间的停顿
    randomChance: 0.3,   // 每个事件之后插一段随机动作的概率
  };

  /**
   * 固定日程。
   *
   * `at` 是游戏内时刻（只用于显示与排序，不是真实等待）；`anim` 按顺序播；
   * `say` 是气泡文案；`move` 只在"有理由走过去"的事件上出现。
   */
  const SCHEDULE = [
    { at: '06:30', anim: ['哈欠连天', '超大伸懒腰'], say: '唔……几点了' },
    { at: '06:50', anim: ['晨间刷牙'], say: '刷牙，精神一下' },
    { at: '07:20', anim: ['吃早餐', '吃白饭'], say: '早饭吃什么好呢', move: 'left' },
    { at: '08:20', anim: ['照镜子', '整体换装试色'], say: '今天穿这件？' },
    { at: '09:00', anim: ['写代码', '工作状态-忙碌点按'], say: '开工' },
    { at: '10:30', anim: ['工作状态-原地踱步张望', '工作状态-思考冒泡', '工作状态-垂头叹气冒汗'], say: '这 bug 哪来的' },
    { at: '11:20', anim: ['偷吃零食被抓住'], say: '就一口……' },
    { at: '12:00', anim: ['吃午餐'], say: '午饭！', move: 'center' },
    { at: '13:00', anim: ['原地小憩沉眠'], say: '眯一会儿' },
    { at: '13:40', anim: ['打瞌睡被惊醒'], say: '！我没睡' },
    { at: '14:30', anim: ['工作状态-清点归档', '轻快记录'], say: '整理一下' },
    { at: '16:00', anim: ['吃冰淇淋融化'], say: '甜一下' },
    { at: '17:40', anim: ['工作状态-雀跃庆祝', '轻快摇摆舞'], say: '下班！' },
    { at: '18:30', anim: ['吃晚餐'], say: '晚饭吃啥', move: 'right' },
    { at: '19:30', anim: ['东张西望'], say: '走两步', move: 'center' },
    { at: '20:00', anim: ['玩水枪', '玩游戏气急败坏'], say: '来一局' },
    { at: '20:40', anim: ['小提琴演奏'], say: '献丑了' },
    { at: '21:20', anim: ['撸猫'], say: '猫呢？' },
    { at: '21:50', anim: ['照镜子'], say: '该睡了', move: 'center' },
    { at: '22:00', anim: ['原地小憩沉眠', '哈欠连天'], say: '晚安' },
  ];

  /**
   * 节日事件：命中当天就替换/插入到日程里。
   *
   * `lunar` = 农历月日（由 Intl 的中文历法算出来）；`solar` = 公历月日。
   * 春节、元宵、端午、七夕、中秋、重阳、腊八、除夕都按农历；圣诞、万圣按公历。
   */
  const FESTIVALS = [
    { name: '春节', lunar: [1, 1], at: '09:30', anim: ['收红包', '吃饺子', '写福字'], say: '新年快乐！' },
    { name: '元宵', lunar: [1, 15], at: '19:00', anim: ['吃汤圆', '放孔明灯'], say: '元宵节快乐' },
    { name: '清明', lunar: [3, 5], at: '10:00', anim: ['吃青团'], say: '青团好吃' },
    { name: '端午', lunar: [5, 5], at: '12:30', anim: ['吃粽子'], say: '粽子咸甜之争' },
    { name: '七夕', lunar: [7, 7], at: '20:30', anim: ['穿针乞巧'], say: '手要巧一点' },
    { name: '中秋', lunar: [8, 15], at: '20:30', anim: ['中秋赏月吃月饼', '放河灯'], say: '月亮真圆' },
    { name: '重阳', lunar: [9, 9], at: '10:00', anim: ['吃重阳糕', '插茱萸赏菊'], say: '登高去' },
    { name: '腊八', lunar: [12, 8], at: '08:00', anim: ['吃腊八粥'], say: '腊八粥' },
    { name: '圣诞', solar: [12, 25], at: '20:30', anim: ['装点圣诞树', '拆礼物'], say: '圣诞快乐' },
    { name: '万圣', solar: [10, 31], at: '19:30', anim: ['讨糖南瓜灯', '萌化小幽灵'], say: '不给糖就捣蛋' },
  ];

  /** 季节事件：按公历月份插入一个。 */
  const SEASONS = {
    spring: { at: '15:40', anim: ['放风筝'], say: '风不错' },
    summer: { at: '15:40', anim: ['吃西瓜', '摇扇纳凉'], say: '热死了' },
    autumn: { at: '15:40', anim: ['被落叶淹没'], say: '秋天了' },
    winter: { at: '15:40', anim: ['堆雪人'], say: '下雪了' },
  };

  /** 三餐按季节换口味：冬天的晚饭吃火锅、秋天的晚饭吃蟹。 */
  const MEALS = {
    lunch: { default: ['吃午餐'] },
    dinner: { winter: ['涮火锅'], autumn: ['吃大闸蟹'], default: ['吃晚餐'] },
  };

  /** 随机插曲池：都是 dsh-pet 的动画名，不属于任何固定时段。 */
  const RANDOM_POOL = [
    '变鸽子', '蓝鲸现世', '鲸鱼吐泡泡特效', '动物环绕', '蝴蝶蜜蜂环绕头顶开花', '凭空生花',
    '舞狮头', '用鲸鱼尾巴拍打地面', '原地专心玩魔方', '下五子棋', '抽陀螺',
    '踢毽子', '荡秋千', '扑克魔术', '小幅度原地360度旋转展示', '原地蹲下玩玩具汽车',
    '原地敲击桌面互动', '原地跳跃抓碎头顶物品', '原地重力下蹲压缩',
    '被吓一跳', '悠闲哼歌', '可爱宅舞', '优雅女仆舞', '女仆屈膝礼仪', '是啊，吃什么',
    '吃Token', '吃白饭', '待机呼吸休闲', '吃年糕', '吃长寿面', '大口吃零食',
    '三球抛接', '骑木马',
  ];

  /**
   * 每段动画自己的台词。
   *
   * 覆盖率的要求来自"气泡不能空着"：一段动画播十秒，只配一句三秒的话，剩下七秒就是干演。
   * 所以这里按动画名给台词，播放时把气泡时长设成片长，播多久挂多久。
   * 没写到的名字落到 GENERIC_LINES，不会出现"没台词"。
   */
  const LINES = {
    // 日常
    '哈欠连天': '唔……还困',
    '超大伸懒腰': '伸个懒腰',
    '晨间刷牙': '刷牙，精神一下',
    '照镜子': '今天状态不错',
    '整体换装试色': '这件还是那件',
    '东张西望': '看看有什么',
    '悠闲哼歌': '哼～',
    '原地小憩沉眠': '眯一会儿',
    '打瞌睡被惊醒': '！我没睡',
    '待机呼吸休闲': '发呆中',
    '撸猫': '猫呢？',
    // 三餐
    '吃早餐': '早饭吃什么好呢',
    '吃午餐': '午饭！',
    '吃晚餐': '晚饭吃啥',
    '吃白饭': '白饭真香',
    '涮火锅': '火锅！',
    '吃大闸蟹': '这蟹不错',
    '吃冰淇淋融化': '甜一下',
    '吃糖葫芦': '酸酸甜甜',
    '吃年糕': '黏黏的',
    '吃长寿面': '吸溜——',
    '大口吃零食': '停不下来',
    '偷吃零食被抓住': '就一口……',
    // 工作
    '写代码': '开工',
    '轻快记录': '记一下',
    '工作状态-忙碌点按': '忙忙忙',
    '工作状态-思考冒泡': '这个逻辑不对',
    '工作状态-垂头叹气冒汗': '好难',
    '工作状态-原地踱步张望': '走走想想',
    '工作状态-清点归档': '整理一下',
    '工作状态-雀跃庆祝': '搞定了！',
    // 娱乐
    '玩水枪': '来一局',
    '玩游戏气急败坏': '这也能输？',
    '小提琴演奏': '献丑了',
    '吹笛子': '听我吹一段',
    '吹气球': '呼——',
    '轻快摇摆舞': '跳一个',
    '可爱宅舞': '宅舞时间',
    '优雅女仆舞': '请多关照',
    '女仆屈膝礼仪': '欢迎回来',
    '三球抛接': '看好了',
    '骑木马': '驾！',
    '荡秋千': '再高一点',
    '踢毽子': '一、二、三',
    '抽陀螺': '转起来',
    '下五子棋': '该你了',
    '原地专心玩魔方': '就差一面',
    '扑克魔术': '见证奇迹',
    '小幅度原地360度旋转展示': '转一圈',
    '原地蹲下玩玩具汽车': '嘟嘟——',
    '原地敲击桌面互动': '敲敲',
    '原地跳跃抓碎头顶物品': '抓到了',
    '原地重力下蹲压缩': '压扁',
    '被吓一跳': '吓我一跳',
    // 特殊演出
    '变鸽子': '变！',
    '蓝鲸现世': '本体出现',
    '鲸鱼吐泡泡特效': '啵啵啵',
    '动物环绕': '都来了',
    '蝴蝶蜜蜂环绕头顶开花': '开花了',
    '凭空生花': '送你一朵',
    '舞狮头': '咚咚锵',
    '萌化小幽灵': '不给糖就捣蛋',
    '讨糖南瓜灯': '不给糖就捣蛋',
    '用鲸鱼尾巴拍打地面': '拍一下',
    '是啊，吃什么': '是啊，吃什么',
    '吃Token': '吃 Token 吗',
    // 节日
    '收红包': '新年快乐！',
    '吃饺子': '饺子！',
    '写福字': '福到了',
    '吃汤圆': '元宵节快乐',
    '放孔明灯': '许个愿',
    '吃青团': '青团好吃',
    '吃粽子': '粽子咸甜之争',
    '穿针乞巧': '手要巧一点',
    '中秋赏月吃月饼': '月亮真圆',
    '放河灯': '放一盏',
    '吃重阳糕': '登高去',
    '插茱萸赏菊': '菊花开了',
    '吃腊八粥': '腊八粥',
    '装点圣诞树': '圣诞快乐',
    '拆礼物': '是什么？',
    '放烟花': '放烟花！',
    // 季节
    '放风筝': '风不错',
    '吃西瓜': '好甜',
    '摇扇纳凉': '热死了',
    '被落叶淹没': '秋天了',
    '堆雪人': '下雪了',
    // 移动
    '螃蟹走路': '走两步',
    '原地漂浮踏步': '飘过去',
    '原地左转奔跑': '跑一段',
  };

  /** 没有专门台词的动画用这些，保证气泡不空。 */
  const GENERIC_LINES = ['嗯……', '这样啊', '试试这个', '嘿', '闲着也是闲着'];

  /** 移动前说的话。 */
  const MOVE_LINES = ['走两步', '换个地方', '过去看看'];

  /** 取一段动画的台词；没有专门的就用通用句。 */
  function lineFor(name) {
    const line = LINES[name];
    if (typeof line === 'string' && line !== '') return line;
    return GENERIC_LINES[Math.floor(Math.random() * GENERIC_LINES.length)];
  }

  // ===== 运行时状态 =====

  let layer = null;
  let toastEl = null;
  let petId = null;
  let lockId = null;
  let lockLost = false;
  let running = false;
  let disposed = false;
  let showAbort = null;
  let renewTimer = null;
  let menuAbort = null;
  let showGen = 0;

  const alive = () => running && !lockLost && !disposed;

  /** 被用户打断（拖拽撤锁 / 卸载）时用这个异常跳出去。 */
  class Halted extends Error {}

  const enc = encodeURIComponent;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ===== 基础 =====

  /** 页面内的只读服务（pose / progress），零请求。 */
  function petApi() {
    return ctxRef === null ? undefined : ctxRef.get('petApi7340');
  }

  let ctxRef = null;

  /** 读当前实况的中心点（归一化）。 */
  function poseOf() {
    const api = petApi();
    if (api === undefined || petId === null || typeof api.pose !== 'function') return null;
    try {
      return api.pose(petId);
    } catch {
      return null;
    }
  }

  /** 一个带样式的 div。 */
  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  /** 注入本插件唯一的样式。 */
  function injectCss() {
    const style = document.createElement('style');
    style.id = ROOT_ID + '-style';
    style.textContent =
      '.dsh-pet-fish-day-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);' +
      'padding:6px 14px;border-radius:999px;background:rgba(30,30,30,.82);color:#fff;' +
      'font-size:13px;line-height:1.4;z-index:2147483600;pointer-events:none;' +
      'opacity:0;transition:opacity .2s ease;max-width:70vw;text-align:center}' +
      '.dsh-pet-fish-day-toast.show{opacity:1}';
    document.head.appendChild(style);
    return style;
  }

  /** 底部提示条（不是宠物气泡）。 */
  function toast(text) {
    if (toastEl === null) return;
    toastEl.textContent = text;
    toastEl.classList.add('show');
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => toastEl.classList.remove('show'), 2600);
  }
  toast.timer = 0;

  /**
   * 调 dsh-pet 的 HTTP 端点。
   *
   * @param {string} method
   * @param {string} path - 以 / 开头、不含 API 前缀。
   * @param {object} [body]
   * @param {AbortSignal} [signal]
   */
  async function http(method, path, body, signal) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 20000);
    const merged = signal === undefined ? controller.signal : combineSignals(signal, controller.signal);
    try {
      const response = await fetch(API + path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: merged,
        cache: 'no-store',
      });
      const text = await response.text();
      return text === '' ? {} : JSON.parse(text);
    } finally {
      window.clearTimeout(timer);
    }
  }

  /** 兼容不支持 AbortSignal.any 的旧浏览器。 */
  function combineSignals(a, b) {
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (a.aborted || b.aborted) controller.abort();
    else {
      a.addEventListener('abort', abort, { once: true });
      b.addEventListener('abort', abort, { once: true });
    }
    return controller.signal;
  }

  // ===== 播放 =====

  /**
   * 播一段池内动画，同时挂上它的台词，等它走到终态。
   *
   * 气泡和动画**同时发**：先点播、紧接着说话，然后才等回执。
   * 气泡时长给得足够长，靠"下一段动画开始时写成新气泡"来换句——
   * 而下一段本来就要等这一次 ended 才发，所以两句之间不会错位、也不会空窗。
   *
   * @param {string} name - dsh-pet 的动画名。
   * @param {string} [line] - 指定台词；不给就用这个动画自己的。
   */
  async function playOne(name, line) {
    const r = await http(
      'POST',
      '/anim?pet=' + enc(petId) + '&surface=' + SURFACE + '&lock=' + enc(lockId),
      { name },
      showAbort === null ? undefined : showAbort.signal,
    );
    if (r.ok !== true) {
      if (r.reason === 'unknown-animation') return; // 名字不在池里：跳过，不中断一天
      if (r.reason === 'locked' || r.reason === 'pet-required' || r.reason === 'unknown-pet') {
        lockLost = true;
        throw new Halted();
      }
      return;
    }
    await say(line !== undefined && line !== '' ? line : lineFor(name));
    await waitPlayback(r.playbackId ?? null);
    markSeen(name);
  }

  /**
   * 等一次点播的真正终态。
   *
   * `POST /anim` 的 ok 只代表受理；素材没拿到、解码失败、被顶掉都会被回执报出来。
   *
   * @param {string|null} id
   */
  async function waitPlayback(id) {
    if (id === null) return;
    const deadline = performance.now() + CFG.waitBudgetMs;
    for (;;) {
      const left = deadline - performance.now();
      if (left <= 0) return;
      let r;
      try {
        r = await http(
          'GET',
          '/playback/' + enc(id) + '?wait=ended,failed,cancelled&timeout=' + Math.min(10000, Math.round(left)),
        );
      } catch {
        return;
      }
      if (r === null || typeof r !== 'object' || r.error !== undefined) return;
      if (r.status === 'ended' || r.status === 'failed' || r.status === 'cancelled') return;
    }
  }

  /** 让宠物说一句话。 */
  async function say(text) {
    try {
      await http(
        'POST',
        '/broadcast?pet=' + enc(petId) + '&surface=' + SURFACE + '&lock=' + enc(lockId),
        { text, duration: CFG.bubbleHoldMs, anim: false },
        showAbort === null ? undefined : showAbort.signal,
      );
    } catch {
      // 说话失败不影响推演
    }
  }

  /** 读当前实况的播放进度（页面内只读服务，零请求）。 */
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
   * 用移动类动画走一段。
   *
   * 为什么不自己发 /position：那样宠物是"滑"过去的，没有走路动作。移动类动画由 dsh-pet
   * 的移动系统接管——它按素材的 leadSec / tailSec 在原地等完首尾，中间才真的位移。
   *
   * @param {'left'|'center'|'right'} slot - 往哪个方向挪（决定走向与朝向）。
   */
  async function moveWithAnim(slot) {
    const pose = poseOf();
    const facing = slot === 'left'
      ? 'left'
      : slot === 'right'
        ? 'right'
        : pose !== null && pose.x > 0.5 ? 'left' : 'right';
    const name = slot === 'center'
      ? '原地漂浮踏步'
      : Math.random() < 0.3 ? '原地左转奔跑' : '螃蟹走路';
    const r = await http(
      'POST',
      '/anim?pet=' + enc(petId) + '&surface=' + SURFACE + '&lock=' + enc(lockId),
      { name, facing },
      showAbort === null ? undefined : showAbort.signal,
    );
    if (r.ok !== true) {
      if (r.reason === 'locked' || r.reason === 'pet-required' || r.reason === 'unknown-pet') {
        lockLost = true;
        throw new Halted();
      }
      return;
    }
    // 移动系统接管：回执会被报成 failed/busy，别等它。先挂台词，再等整段（lead + 位移 + tail）播完。
    await say(MOVE_LINES[Math.floor(Math.random() * MOVE_LINES.length)]);
    await waitMoveDone();
    markSeen(name);
  }

  /**
   * 等一次移动走完。
   *
   * 素材首尾都有"原地不动"的延时（leadSec / tailSec），所以：
   *   1. 先等它真的动起来（这一段就是 leadSec）；
   *   2. 再用播放进度读到片长，等剩下的部分（含 tailSec）播完。
   * 贴边挪不动时 dsh-pet 会退化成原地播放，这里最多等几秒就放行。
   */
  async function waitMoveDone() {
    const start = performance.now();
    const deadline = start + 25000;
    let lastX = null;
    let moved = false;
    while (performance.now() < deadline && alive()) {
      const pose = poseOf();
      if (pose !== null) {
        if (lastX !== null && Math.abs(pose.x - lastX) > 0.0006) {
          moved = true;
          break;
        }
        lastX = pose.x;
      }
      if (performance.now() - start > 8000) break;
      await sleep(150);
    }

    const progress = progressOf();
    const left = progress !== null && progress.duration > 0.3
      ? Math.max(0, (progress.duration - progress.currentTime) * 1000)
      : 3000;
    await sleep((moved ? left : Math.min(left, 3000)) + 250);
  }

  // ===== 覆盖（shuffle bag） =====

  function readSeen() {
    try {
      const raw = sessionStorage.getItem(SEEN_KEY);
      const list = raw === null ? [] : JSON.parse(raw);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function markSeen(name) {
    try {
      const seen = readSeen();
      if (!seen.includes(name)) {
        seen.push(name);
        sessionStorage.setItem(SEEN_KEY, JSON.stringify(seen));
      }
    } catch {
      // 存储不可用不影响演出
    }
  }

  /** 优先抽没演过的动画。 */
  function pickRandom() {
    const seen = readSeen();
    const fresh = RANDOM_POOL.filter((name) => !seen.includes(name));
    const pool = fresh.length === 0 ? RANDOM_POOL : fresh;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // ===== 日历 =====

  /** 农历日期（Intl 的中文历法）；不支持时返回 null。 */
  function lunarOf(date) {
    try {
      const formatter = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'numeric', day: 'numeric' });
      const parts = formatter.formatToParts(date);
      const monthPart = parts.find((p) => p.type === 'month');
      const dayPart = parts.find((p) => p.type === 'day');
      if (monthPart === undefined || dayPart === undefined) return null;
      const month = parseMonth(monthPart.value);
      const day = parseDay(dayPart.value);
      if (month === null || day === null) return null;
      return { month, day };
    } catch {
      return null;
    }
  }

  function parseNumber(text) {
    if (/^\d+$/.test(text)) return Number(text);
    const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (text === '十') return 10;
    if (text.length === 1 && digits[text] !== undefined) return digits[text];
    const [tens, ones] = text.split('十');
    if (text.includes('十')) {
      return (tens === '' || tens === undefined ? 1 : digits[tens] ?? 0) * 10 + (ones === undefined || ones === '' ? 0 : digits[ones] ?? 0);
    }
    return null;
  }

  function parseMonth(text) {
    const raw = text.replace(/^闰/, '').replace(/月$/, '');
    const named = { 正: 1, 冬: 11, 腊: 12 };
    if (named[raw] !== undefined) return named[raw];
    return parseNumber(raw);
  }

  function parseDay(text) {
    return parseNumber(text.replace(/^初/, '').replace(/日$/, ''));
  }

  /** 今天的节日事件（没有就返回 null）。 */
  function festivalOf(date) {
    const lunar = lunarOf(date);
    const month = date.getMonth() + 1;
    const day = date.getDate();
    for (const item of FESTIVALS) {
      if (item.lunar !== undefined && lunar !== null && lunar.month === item.lunar[0] && lunar.day === item.lunar[1]) {
        return { name: item.name, at: item.at, anim: item.anim, say: item.say };
      }
      if (item.solar !== undefined && month === item.solar[0] && day === item.solar[1]) {
        return { name: item.name, at: item.at, anim: item.anim, say: item.say };
      }
    }
    // 除夕：腊月最后一天（29/30），给一场烟花
    if (lunar !== null && lunar.month === 12 && lunar.day >= 29) {
      return { name: '除夕', at: '23:30', anim: ['放烟花'], say: '新年快乐！' };
    }
    return null;
  }

  /** 季节事件。 */
  function seasonOf(date) {
    const month = date.getMonth() + 1;
    if (month >= 3 && month <= 5) return SEASONS.spring;
    if (month >= 6 && month <= 8) return SEASONS.summer;
    if (month >= 9 && month <= 11) return SEASONS.autumn;
    return SEASONS.winter;
  }

  /**
   * 生成今天的演出手册。
   *
   * 固定日程 + 节日事件 + 季节事件，按时刻排序；三餐按季节换口味。
   *
   * @param {Date} date
   * @returns {{at: string, anim: string[], say: string, move?: string}[]}
   */
  function buildPlan(date) {
    const month = date.getMonth() + 1;
    const plan = SCHEDULE.map((step) => {
      const copy = { at: step.at, anim: step.anim.slice(), say: step.say };
      if (step.move !== undefined) copy.move = step.move;
      if (step.at === '12:00') copy.anim = pickMeal(MEALS.lunch, month);
      if (step.at === '16:00') copy.anim = pickSnack(month);
      if (step.at === '18:30') copy.anim = pickMeal(MEALS.dinner, month);
      if (step.at === '20:40') copy.anim = pickByDay(['小提琴演奏', '吹笛子', '吹气球'], date);
      return copy;
    });

    const festival = festivalOf(date);
    if (festival !== null) plan.push(festival);
    plan.push(seasonOf(date));

    plan.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return plan;
  }

  function pickMeal(meal, month) {
    if (month >= 6 && month <= 8 && meal.summer !== undefined) return meal.summer.slice();
    if ((month === 12 || month <= 2) && meal.winter !== undefined) return meal.winter.slice();
    if (month >= 9 && month <= 11 && meal.autumn !== undefined) return meal.autumn.slice();
    return meal.default.slice();
  }

  /** 下午茶：冬天吃糖葫芦，其余吃冰淇淋。 */
  function pickSnack(month) {
    return month === 12 || month <= 2 ? ['吃糖葫芦'] : ['吃冰淇淋融化'];
  }

  /** 按日期轮换，让每天的重点不一样。 */
  function pickByDay(list, date) {
    const start = new Date(date.getFullYear(), 0, 0);
    const day = Math.floor((date - start) / 86400000);
    return [list[day % list.length]];
  }

  // ===== 锁 =====

  /** 读本标签页记下的锁编号。 */
  function readStoredLock(id) {
    try {
      return sessionStorage.getItem(LOCK_KEY + id);
    } catch {
      return null;
    }
  }

  /** 写 / 清本标签页的锁编号。 */
  function writeStoredLock(id, lock) {
    try {
      if (lock === null) sessionStorage.removeItem(LOCK_KEY + id);
      else sessionStorage.setItem(LOCK_KEY + id, lock);
    } catch {
      // 隐私模式不影响演出
    }
  }

  /** 取锁。 */
  async function acquire() {
    const stored = readStoredLock(petId);
    if (stored !== null) {
      const renewed = await http('POST', '/lock?pet=' + enc(petId) + '&surface=' + SURFACE, { lockId: stored });
      if (renewed.ok === true) {
        lockId = renewed.lockId;
        lockLost = false;
        return;
      }
      writeStoredLock(petId, null);
    }

    const r = await http('POST', '/lock?pet=' + enc(petId) + '&surface=' + SURFACE, { ttl: CFG.lockTtl });
    if (r.ok === true) {
      lockId = r.lockId;
      lockLost = false;
      writeStoredLock(petId, lockId);
      return;
    }

    const reason = r.reason || 'unknown';
    if (reason === 'pet-not-displayed') throw new Error('这只宠物没显示在网页里（display=' + r.display + '）');
    if (reason !== 'locked') throw new Error('取锁失败：' + reason);

    const expiresAt = typeof r.expiresAt === 'number' ? r.expiresAt : 0;
    const waitMs = Math.min(CFG.lockWaitMs, Math.max(0, expiresAt - Date.now()) + 2000);
    toast('上一场还没收干净，等它过期…');
    const deadline = performance.now() + waitMs;
    for (;;) {
      if (!alive()) throw new Halted();
      if (performance.now() > deadline) break;
      await sleep(1500);
      if (!alive()) throw new Halted();
      const retry = await http('POST', '/lock?pet=' + enc(petId) + '&surface=' + SURFACE, { ttl: CFG.lockTtl });
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

  /** 心跳续期，顺带探活。 */
  function startRenew() {
    stopRenew();
    renewTimer = window.setInterval(async () => {
      if (!running || lockId === null || lockLost) return;
      try {
        const r = await http('POST', '/lock?pet=' + enc(petId) + '&surface=' + SURFACE, { lockId });
        if (r.ok !== true) lockLost = true;
      } catch {
        // 网络抖动不算丢锁
      }
    }, CFG.renewMs);
  }

  function stopRenew() {
    if (renewTimer !== null) window.clearInterval(renewTimer);
    renewTimer = null;
  }

  // ===== 推演 =====

  /** 一场演出。 */
  async function runShow(id) {
    const gen = ++showGen;
    petId = id;
    running = true;
    lockLost = false;
    showAbort = new AbortController();
    toast('大肥鱼的一天 —— 开始');
    try {
      await acquire();
      startRenew();
      const plan = buildPlan(new Date());
      for (const step of plan) {
        if (!alive()) throw new Halted();
        if (step.move !== undefined) await moveWithAnim(step.move);
        for (const [index, name] of step.anim.entries()) {
          if (!alive()) throw new Halted();
          const line = index === 0 && step.say !== undefined && step.say !== ''
            ? step.at + ' ' + step.say
            : undefined;
          await playOne(name, line);
        }
        if (Math.random() < CFG.randomChance) {
          if (!alive()) throw new Halted();
          await playOne(pickRandom());
        }
        await sleep(CFG.gapMs);
      }
      if (alive()) toast('一天结束了');
    } catch (error) {
      if (!(error instanceof Halted)) {
        toast(error instanceof Error ? error.message : String(error));
        console.warn('[dsh-pet-fish-day]', error);
      }
    } finally {
      await halt('', gen);
    }
  }

  /** 收场：停一切、放锁。幂等。 */
  async function halt(reason, gen) {
    if (gen !== undefined && gen !== showGen) return;
    running = false;
    if (showAbort !== null) {
      showAbort.abort();
      showAbort = null;
    }
    stopRenew();
    const lease = lockId;
    lockId = null;
    if (lease !== null) {
      // 气泡挂得比片段长（30s），推演结束时主动收掉，否则会一直盖在宠物头顶
      try {
        await http('POST', '/bubble/clear?pet=' + enc(petId) + '&surface=' + SURFACE + '&lock=' + enc(lease));
      } catch {
        // 清不掉不影响收场
      }
      try {
        await http('POST', '/lock/release?pet=' + enc(petId), { lockId: lease });
      } catch {
        // 放不掉也没关系：TTL 到点自己失效
      }
    }
    writeStoredLock(petId, null);
    if (reason !== undefined && reason !== '') toast(reason);
  }

  /** 页面要走了：用 sendBeacon 尽力放锁。 */
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
      // 落到下面的 fetch
    }
    try {
      void fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true });
    } catch {
      // TTL 兜底
    }
  }

  // ===== 菜单 =====

  async function ensureMenu() {
    const r = await http('POST', '/menu/item', { owner: OWNER, labels: [LABEL], target: 'both' });
    if (r.ok !== true) console.warn('[dsh-pet-fish-day] 注册菜单失败：' + (r.reason || 'unknown'));
  }

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
        if (events[LABEL]) {
          if (running || lockId !== null) {
            await halt('重新开始');
            await sleep(150);
          }
          void runShow(events[LABEL]);
        }
      } catch {
        if (disposed) return;
        await sleep(1500);
        await ensureMenu().catch(() => {});
      }
    }
  }

  // ===== 装配 =====

  window.__ModuleLoader__.load({
    id: PLUGIN_ID,
    /**
     * @param {(name: string) => any} _require - 本插件不 import 任何模块。
     */
    factory(_require) {
      const name = 'dsh-pet-fish-day';
      const inject = ['petApi7340'];

      /**
       * @param {any} ctx - 页面内 Cordis 上下文。
       * @returns {() => void} 卸载钩子。
       */
      function apply(ctx) {
        if (typeof document === 'undefined' || document.body === null) {
          console.warn('[dsh-pet-fish-day] 缺少 document，跳过');
          return () => {};
        }
        const stale = document.getElementById(ROOT_ID);
        if (stale !== null) stale.remove();

        ctxRef = ctx;
        disposed = false;
        petId = null;
        lockId = null;
        lockLost = false;
        running = false;

        const style = injectCss();
        layer = el('div', 'dsh-pet-fish-day-layer');
        layer.id = ROOT_ID;
        toastEl = el('div', 'dsh-pet-fish-day-toast');
        layer.appendChild(toastEl);
        document.body.appendChild(layer);

        ensureMenu().catch(() => {});
        pollMenu();
        window.addEventListener('pagehide', releaseOnPageHide);

        return () => {
          disposed = true;
          window.removeEventListener('pagehide', releaseOnPageHide);
          void halt('');
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
