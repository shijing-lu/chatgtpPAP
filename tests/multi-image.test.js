/* 一次生成多张图时只下载第一张（零依赖）：node tests/multi-image.test.js
 *
 * 覆盖两段链路：
 *  ① 页面侧：产物按 DOM 真实顺序排好、跨轮询轮次锁定首图、上报前剥离 DOM 节点
 *  ② 后台侧：默认按页面顺序只发起一次下载；切回 best 才用旧的评分策略
 *
 * 关键回归点：旧版 pickArtifact 按「内嵌大图 / 4K 高清链接」评分挑图，
 * 4 张图里往往挑到第 2~4 张；且产物列表没有页面顺序，谈不上「第一张」。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const load = (f) => vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });

/* ============ 可控时钟 ============ */
let NOW = 1000000;
Date.now = () => NOW;
const realSetImmediate = global.setImmediate;

/* ============ 页面 DOM 桩 ============ */
const FOLLOWING = 4;   // Node.DOCUMENT_POSITION_FOLLOWING
const PRECEDING = 2;   // Node.DOCUMENT_POSITION_PRECEDING
global.Node = { DOCUMENT_POSITION_FOLLOWING: FOLLOWING, DOCUMENT_POSITION_PRECEDING: PRECEDING };
global.location = {
  href: 'https://chatgpt.com/c/conv-1',
  pathname: '/c/conv-1',
  hostname: 'chatgpt.com'
};

let imgs = [];
let links = [];
let cards = [];
let msgNodes = [];
let assistantNodes = [];
let alerts = [];
let stopBtn = null;
let bodyText = '';
const mainEl = { tag: 'main' };

/** pos = 节点在页面上的位置；compareDocumentPosition 与真实 DOM 一样是反对称的 */
function makeImg(src, pos) {
  return {
    currentSrc: src,
    src,
    pos,
    naturalWidth: 1024,
    naturalHeight: 1024,
    className: '',
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 400, height: 400 }),
    closest: () => null,
    compareDocumentPosition(other) {
      return other.pos > this.pos ? FOLLOWING : PRECEDING;
    }
  };
}

const document = {
  querySelectorAll(sel) {
    if (sel === 'img') return imgs;
    if (sel === 'a[href]') return links;
    if (/data-testid|role="button"/.test(sel)) return cards;
    if (sel === '[data-message-author-role]') return msgNodes;
    if (sel === '[data-message-author-role="assistant"]') return assistantNodes;
    if (sel === '[role="alert"]') return alerts;
    return [];
  },
  querySelector(sel) {
    if (/main/i.test(sel)) return mainEl;
    if (/stop/i.test(sel)) return stopBtn;
    return null;
  },
  contains: () => true,
  body: {
    get innerText() {
      return bodyText;
    }
  }
};
global.document = document;

global.MutationObserver = class {
  constructor(cb) {
    this.cb = cb;
  }
  observe() {}
  disconnect() {}
};

global.setInterval = () => 1;
global.clearInterval = () => {};

/* ============ 加载页面模块 ============ */
load('src/shared/constants.js');
load('src/shared/selectors.js');
load('src/content/probes.js');
load('src/content/watcher.js');

const CGR = global.CGR;
const probe = global.CGR_PROBE;
const watch = global.CGR_WATCH;

const U = (n) => `https://files.oaiusercontent.com/gen${n}.png`;

function reset() {
  imgs = [];
  links = [];
  cards = [];
  msgNodes = [{ innerText: '' }];
  assistantNodes = [{ innerText: '' }];
  alerts = [];
  stopBtn = null;
  bodyText = '';
  NOW = 1000000;
}

let result = null;
function start(cfg) {
  result = null;
  const before = probe.snapshot();
  const full = Object.assign({ timeoutMs: 300000, firstSignalMs: 120000, stableMs: 3000 }, cfg || {});
  watch.waitForOutcome(before, full, () => false).then((r) => {
    result = r;
  });
  return before;
}
async function tick(ms) {
  NOW += ms || 1000;
  watch.triggerEvaluate();
  await new Promise((r) => (realSetImmediate ? realSetImmediate(r) : setImmediate(r)));
  return result;
}
async function untilDone(max) {
  let guard = 0;
  while (!result && guard++ < (max || 12)) await tick(3000);
  return result;
}
/** 生成中 → 生成结束，然后由调用方决定图片何时插入 */
async function begin() {
  stopBtn = {};
  assistantNodes = [{ innerText: '' }, { innerText: '正在生成' }];
  msgNodes = [{}, {}, {}];
  await tick(1000);
  stopBtn = null;
}

/* ============ 后台桩（Part 2 用） ============ */
let mem = {};
let dlSeq = 700;
const downloadCalls = [];
const tabMessages = [];
const noop = { addListener() {} };

const chrome = {
  storage: {
    local: {
      get: (keys) => {
        let out = {};
        if (keys == null) out = Object.assign({}, mem);
        else if (typeof keys === 'string') {
          if (keys in mem) out[keys] = mem[keys];
        } else if (Array.isArray(keys) || typeof keys === 'object') {
          for (const k of Array.isArray(keys) ? keys : Object.keys(keys)) {
            if (k in mem) out[k] = mem[k];
          }
        }
        return Promise.resolve(out);
      },
      set: (obj) => {
        Object.assign(mem, obj);
        return Promise.resolve();
      },
      remove: (keys) => {
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete mem[k]);
        return Promise.resolve();
      },
      clear: () => {
        mem = {};
        return Promise.resolve();
      }
    },
    onChanged: noop
  },
  runtime: {
    getManifest: () => ({ content_scripts: [{ js: ['content.js'] }] }),
    sendMessage: () => Promise.resolve({ ok: true }),
    lastError: null,
    onInstalled: noop,
    onStartup: noop,
    onMessage: noop
  },
  action: { onClicked: noop },
  sidePanel: { setPanelBehavior: () => Promise.resolve(), open: () => Promise.resolve() },
  tabs: {
    query: () => Promise.resolve([{ id: 1, url: 'https://chatgpt.com/', active: true, windowId: 1 }]),
    get: (id) => Promise.resolve({ id: Number(id), url: 'https://chatgpt.com/', windowId: 1 }),
    create: () => Promise.resolve({ id: 1 }),
    remove: () => Promise.resolve(),
    update: () => Promise.resolve({}),
    reload: () => Promise.resolve(),
    sendMessage: (tabId, msg) => {
      tabMessages.push({ tabId, msg });
      return Promise.resolve({ ok: true });
    },
    onRemoved: noop,
    onUpdated: noop
  },
  scripting: { executeScript: () => Promise.resolve([{ result: 1 }]) },
  windows: { update: () => Promise.resolve({}) },
  alarms: { create() {}, onAlarm: noop },
  downloads: {
    download: (opts) => {
      dlSeq += 1;
      downloadCalls.push({ id: dlSeq, opts });
      return Promise.resolve(dlSeq);
    },
    onChanged: noop,
    onDeterminingFilename: noop
  }
};
global.chrome = chrome;
global.self = global;
global.window = global;
global.CGR_TABS = {
  ensureBatchTabs: () => Promise.resolve({ ids: [1], windowId: 1 }),
  ensureContentScript: () => Promise.resolve(true),
  ping: () => Promise.resolve(true),
  send: () => Promise.resolve({ ok: true }),
  reviveTab: () => Promise.resolve('ok'),
  replaceTab: () => Promise.resolve(null),
  usableTabs: () => Promise.resolve([{ id: 1 }])
};

(async () => {
  /* ---------- Part 1: 页面顺序与首图稳定 ---------- */

  /* A: sortByDom 按页面位置排序，跨产物类型同样生效 */
  reset();
  const mixed = [
    { kind: 'card', src: 'card:c', _el: makeImg('x', 40) },
    { kind: 'img', src: U(2), _el: makeImg('x', 20) },
    { kind: 'link', src: U(3), _el: makeImg('x', 30) },
    { kind: 'img', src: U(1), _el: makeImg('x', 10) }
  ];
  const sorted = probe.sortByDom(mixed);
  assert.deepStrictEqual(sorted.map((a) => a.src), [U(1), U(2), U(3), 'card:c'], '必须按页面位置排序');
  assert.deepStrictEqual(sorted.map((a) => a.order), [0, 1, 2, 3], 'order 必须连续且 0 表示第一张');
  console.log('PASS A: 产物跨类型按页面顺序排序，order 0 = 第一张');

  /* B: 无法比较的节点保持原收集顺序，不把顺序搞乱 */
  const flat = (v) => ({ compareDocumentPosition: () => v });
  const ambiguous = [
    { src: 'a', _el: flat(FOLLOWING) },
    { src: 'b', _el: flat(FOLLOWING) }
  ];
  assert.deepStrictEqual(probe.sortByDom(ambiguous).map((a) => a.src), ['a', 'b'], '不可判定时保持原顺序');
  console.log('PASS B: DOM 位置不可判定时保持原收集顺序（旧测试桩/脱离文档节点）');

  /* C: cleanArtifacts 必须彻底剥离 DOM 节点，否则 OUTCOME 结构化克隆会失败 */
  const cyclic = {};
  cyclic.self = cyclic;
  const cleaned = probe.cleanArtifacts([{ _el: cyclic, src: U(1), order: 0 }]);
  assert.ok(!('_el' in cleaned[0]), '_el 不能出现在上报数据里');
  assert.doesNotThrow(() => JSON.stringify(cleaned), '清理后必须可序列化');
  assert.strictEqual(cleaned[0].order, 0, '其余字段要保留');
  console.log('PASS C: 上报前剥离 DOM 节点，消息可安全结构化克隆');

  /* D: 一次生成 4 张图（DOM 数组故意打乱）→ 首图仍是页面上第一张 */
  reset();
  start();
  await begin();
  imgs = [makeImg(U(4), 40), makeImg(U(2), 20), makeImg(U(3), 30), makeImg(U(1), 10)];
  await untilDone();
  assert.strictEqual(result && result.status, 'IMAGE_READY', '4 张图应收敛为已出图');
  assert.strictEqual(result.images.length, 4, '四个产物都要上报给后台');
  assert.strictEqual(result.images[0].src, U(1), '第一项必须是页面上最靠前的那张');
  assert.deepStrictEqual(result.images.map((a) => a.order), [0, 1, 2, 3]);
  assert.ok(result.images.every((a) => !('_el' in a)), '消息里不能带 DOM 节点');
  assert.doesNotThrow(() => JSON.stringify(result.images), '整条结果必须可序列化');
  console.log('PASS D: 4 张图按页面顺序上报，第一张 = 页面第一张');

  /* E: 第一张加载得最慢，也不能被先加载完的第二张顶替 */
  reset();
  start({ stableMs: 8000 });
  await begin();
  imgs = [makeImg(U(2), 20)]; // 只有第 2 张先加载出来
  await tick(3000);
  assert.strictEqual(result, null, '稳定窗口内不该提前收敛');
  imgs = [makeImg(U(2), 20), makeImg(U(1), 10)]; // 第 1 张晚到，且数组顺序仍靠后
  await untilDone(14);
  assert.strictEqual(result && result.status, 'IMAGE_READY');
  assert.strictEqual(result.images[0].src, U(1), '晚到的页面第一张必须回到第 1 位');
  assert.ok(!('_el' in result.images[0]));
  console.log('PASS E: 第一张晚加载也不会被第二张顶替');

  /* F: 重渲染时第一张短暂消失，靠首图快照补回，不下载第二张 */
  reset();
  start();
  await begin();
  imgs = [makeImg(U(1), 10), makeImg(U(2), 20), makeImg(U(3), 30)];
  await tick(1000);
  imgs = [makeImg(U(2), 20), makeImg(U(3), 30)]; // 首图被 React 重渲染摘掉
  await untilDone();
  assert.strictEqual(result && result.status, 'IMAGE_READY');
  assert.strictEqual(result.images[0].src, U(1), '首图快照要补回第 1 位');
  assert.strictEqual(result.images[0].order, 0);
  console.log('PASS F: 首图短暂消失时不退化成下载第二张');

  /* ---------- Part 2: 后台只下载第一张 ---------- */

  load('src/shared/sched.js');
  load('src/shared/slug.js');
  load('src/background/store.js');
  load('src/background/lease.js');
  load('src/background/downloads.js');
  load('src/background/orchestrator.js');

  const S = CGR.STATUS;
  const store = global.CGR_STORE;
  const dl = global.CGR_DL;
  const orch = global.CGR_ORCH;

  async function setup(cfgPatch) {
    mem = {};
    dlSeq = 700;
    downloadCalls.length = 0;
    tabMessages.length = 0;
    dl.clearCache();
    await store.withLock(async () => {
      store.S.loaded = false;
      store.S.batches.clear();
      store.S.items.clear();
      store.S.logs = [];
      store.S.runtime = null;
      store.S.cfg = null;
      await store.load();
      if (cfgPatch) await store.setCfg(cfgPatch);
    });
    const r = await orch.createBatch('多图批次');
    await orch.addItem(r.batch.id, '画四张图');
    await orch.start(r.batch.id);
    const grant = await orch.claim(1, 'conv-multi');
    assert.ok(grant && grant.ok, '应能领到任务');
    return { bid: r.batch.id, token: grant.leaseToken };
  }
  const outcome = (token, images) =>
    orch.handleOutcome({ leaseToken: token, status: 'IMAGE_READY', data: { images } }, 1);

  // 第 4 个产物是「4K 高清原图」链接，尺寸最大的图在第 2 位：旧评分策略绝不会选第 1 张
  const ARTS = [
    { src: U(1), kind: 'img', w: 1024, h: 1024, known: true, order: 0 },
    { src: U(2), kind: 'img', w: 2048, h: 2048, known: true, order: 1 },
    { src: U(3), kind: 'img', w: 1024, h: 1024, known: true, order: 2 },
    { src: U(4), kind: 'link', w: 0, h: 0, score: 3, known: true, label: '查看 4K 高清原图', order: 3 }
  ];

  /* G: 默认策略只下载第一张，且只发起一次下载 */
  let ctx = await setup();
  await outcome(ctx.token, ARTS);
  let item = store.getItem(ctx.bid, 0);
  assert.strictEqual(item.image.src, U(1), '默认下载的必须是页面第一张');
  assert.strictEqual(downloadCalls.length, 1, '一条任务只能发起一次下载');
  assert.strictEqual(item.status, S.DOWNLOADING);
  assert.ok(store.S.logs.some((l) => /只下载第 1 张/.test(l.message)), '日志要写明只下载第一张');
  console.log('PASS G: 4 张产物默认只下载第 1 张，一次下载调用');

  /* H: 设置里切到 best，回到旧的评分策略（结果不再是第一张） */
  ctx = await setup({ multiImage: 'best' });
  await outcome(ctx.token, ARTS);
  item = store.getItem(ctx.bid, 0);
  assert.strictEqual(item.image.src, U(2), 'best 策略应选尺寸最大的一张');
  assert.strictEqual(downloadCalls.length, 1, '切换策略也仍是单次下载');
  console.log('PASS H: multiImage=best 回到旧评分策略，仍只下载一张');

  /* I: 没有 order 的旧上报数据按「内嵌图优先」回落，附件场景不受影响 */
  ctx = await setup();
  await outcome(ctx.token, [
    { src: 'card:old.png', kind: 'card', score: 2, click: true },
    { src: U(9), kind: 'img', w: 1024, h: 1024, known: true }
  ]);
  item = store.getItem(ctx.bid, 0);
  assert.strictEqual(item.image.src, U(9), '旧数据仍能选到内嵌图');
  assert.strictEqual(downloadCalls.length, 1);
  console.log('PASS I: 无 order 的旧数据兼容，附件卡片不会顶掉内嵌图');

  /* J: 默认值与设置页接线 */
  assert.strictEqual(CGR.DEFAULTS.multiImage, 'first', '默认值必须是只下载第一张');
  const html = fs.readFileSync(path.join(ROOT, 'src/sidepanel/sidepanel.html'), 'utf8');
  const panel = fs.readFileSync(path.join(ROOT, 'src/sidepanel/sidepanel.js'), 'utf8');
  assert.ok(/id="multiImage"/.test(html), '设置页要有该下拉');
  assert.ok(/\$\('multiImage'\)/.test(panel), '设置页 JS 要读写该字段');
  assert.ok(/multiImage:\s*\$\('multiImage'\)/.test(panel), '保存设置时要带上该字段');
  console.log('PASS J: 默认 first、设置页下拉与保存链路已接线');

  console.log('\nALL PASS — 多图只下载第一张回归通过（10 组）');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
