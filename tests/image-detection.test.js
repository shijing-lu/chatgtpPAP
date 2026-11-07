/* 出图检测回归测试（零依赖）：node tests/image-detection.test.js
 *
 * 复现「ChatGPT 网页已经生成图，但插件判生成失败 → 重发提示词 → 重复生图」的几类根因：
 *  - 图片 URL 不在白名单时严格规则全漏，宽松规则必须兜住
 *  - 尺寸门槛过高误杀真实生成图
 *  - 签名 URL 在重渲染时变化，稳定计时不能被清零
 *  - 图片晚于「生成结束」插入时不能立刻判 NO_IMAGE
 *  - stopButton 选择器失效时靠 DOM 静默仍能收敛
 *  - 无关 toast 不再误判成 PAGE_ERROR
 *  - 真没出图时仍要给出带页面实况的 NO_IMAGE
 *  - 页面与服务端脱节（服务端已出图、这一页卡在生成中）要提前收敛成 PAGE_STALE
 *  - 页面持续有进展（流式输出）时绝不能误判成 PAGE_STALE
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const load = (f) => vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });

/* ---------- 可控时钟 ---------- */
let NOW = 1000000;
const realNow = Date.now;
Date.now = () => NOW;

/* ---------- DOM 桩 ---------- */
let imgs = [];
let canvases = [];
let msgNodes = [];
let assistantNodes = [];
let alerts = [];
let stopBtn = null;
const mainEl = { tag: 'main' };

global.Node = { DOCUMENT_POSITION_FOLLOWING: 4 };
global.location = {
  href: 'https://chatgpt.com/c/conv-1',
  pathname: '/c/conv-1',
  hostname: 'chatgpt.com'
};

function makeImg(src, o) {
  const opts = o || {};
  return {
    currentSrc: src,
    src,
    naturalWidth: opts.nw == null ? 1024 : opts.nw,
    naturalHeight: opts.nh == null ? 1024 : opts.nh,
    className: opts.cls || '',
    _attrs: opts.attrs || {},
    getAttribute(n) {
      return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null;
    },
    getBoundingClientRect() {
      return { width: opts.rw == null ? 400 : opts.rw, height: opts.rh == null ? 400 : opts.rh };
    },
    closest(sel) {
      return opts.closest && opts.closest(sel);
    },
    compareDocumentPosition() {
      return Node.DOCUMENT_POSITION_FOLLOWING;
    }
  };
}

const document = {
  querySelectorAll(sel) {
    if (sel === 'img') return imgs;
    if (sel === 'canvas') return canvases;
    if (sel === '[data-message-author-role]') return msgNodes;
    if (sel === '[data-message-author-role="assistant"]') return assistantNodes;
    if (sel === '[role="alert"]') return alerts;
    return [];
  },
  querySelector(sel) {
    if (sel === 'main') return mainEl;
    if (/stop/i.test(sel)) return stopBtn;
    return null;
  },
  contains() {
    return true;
  },
  body: {}
};
global.document = document;

const moInstances = [];
global.MutationObserver = class {
  constructor(cb) {
    this.cb = cb;
    moInstances.push(this);
  }
  observe() {}
  disconnect() {}
};

const realSetInterval = global.setInterval;
const realClearInterval = global.clearInterval;
global.setInterval = (fn) => {
  void fn;
  return moInstances.length + 1000;
};
global.clearInterval = () => {};

/* ---------- 加载真实模块 ---------- */
load('src/shared/selectors.js');
load('src/content/probes.js');
load('src/content/watcher.js');

const CGR = global.CGR;
const probe = global.CGR_PROBE;
const watch = global.CGR_WATCH;

/* ---------- 测试工具 ---------- */
function reset() {
  imgs = [];
  canvases = [];
  msgNodes = [{ innerText: '' }];
  assistantNodes = [{ innerText: '' }];
  alerts = [];
  stopBtn = null;
  NOW = 1000000;
}

let result = null;
let started = null;

function start(cfg, beforePatch) {
  result = null;
  const before = probe.snapshot();
  Object.assign(before, beforePatch || {});
  const full = Object.assign({ timeoutMs: 300000, firstSignalMs: 120000, stableMs: 3000 }, cfg || {});
  watch.waitForOutcome(before, full, () => false).then((r) => {
    result = r;
  });
  started = before;
  return before;
}

async function tick(ms) {
  NOW += ms || 1000;
  watch.triggerEvaluate();
  await new Promise((r) => realSetImmediate ? realSetImmediate(r) : setImmediate(r));
  return result;
}

const realSetImmediate = global.setImmediate;

async function run() {
  /* A: 新版图片 URL 不在白名单 —— 严格规则漏，宽松规则必须兜住 */
  reset();
  let before = probe.snapshot();
  const NEW_URL = 'https://cdn.example-imagecdn.net/v1/generated/abc?sig=xyz';
  imgs = [makeImg(NEW_URL)];
  assert.strictEqual(probe.isImageSrc(NEW_URL), false, '新 URL 确实不在白名单');
  assert.strictEqual(probe.freshImages(before, null, false).length, 0, '严格规则会漏掉它');
  assert.strictEqual(probe.freshImages(before, null, true).length, 1, '宽松规则必须识别出来');
  console.log('PASS A: 图片 URL 改版时宽松规则兜住，不再判「未出图」');

  /* B: 尺寸门槛 —— 150x150 的真实生成图不能被误杀 */
  reset();
  before = probe.snapshot();
  imgs = [makeImg('https://files.oaiusercontent.com/abc.png', { nw: 150, nh: 150, rw: 150, rh: 150 })];
  assert.strictEqual(probe.freshImages(before, null, false).length, 1, '150px 生成图应被接受');
  reset();
  before = probe.snapshot();
  imgs = [makeImg('https://cdn.example-imagecdn.net/avatar.png', { nw: 32, nh: 32, rw: 32, rh: 32 })];
  assert.strictEqual(probe.freshImages(before, null, true).length, 0, '头像仍应被排除');
  console.log('PASS B: 尺寸门槛放宽但不放过头像/图标');

  /* C: 签名 URL 变化不会让稳定计时清零，最终仍能 IMAGE_READY */
  reset();
  before = start({ stableMs: 20000, timeoutMs: 300000 });
  stopBtn = {};
  imgs = [makeImg('https://cdn.example-imagecdn.net/g/a?sig=1')];
  assistantNodes = [{ innerText: '' }, { innerText: '正在生成' }];
  msgNodes = [{}, {}, {}];
  await tick(1000);
  stopBtn = null;
  await tick(4000); // 生成结束
  imgs = [makeImg('https://cdn.example-imagecdn.net/g/a?sig=2')]; // 仅 query 变化：归一化后不算变化
  await tick(4000);
  imgs = [makeImg('https://cdn.example-imagecdn.net/g/b?sig=3')]; // 连主体都换了
  await tick(4000);
  imgs = [makeImg('https://cdn.example-imagecdn.net/g/c?sig=4')]; // 再换一次
  await tick(4000);
  await tick(5000); // 达到 stableMs 后才允许收敛
  assert.strictEqual(result && result.status, 'IMAGE_READY', 'URL 反复变化也应收敛到出图');
  assert.ok((result.sigChanges || 0) >= 2, '应记录到 URL 主体变化次数');
  console.log('PASS C: 签名 URL / CDN 路径重渲染不会把稳定计时清零');

  /* D: 图片晚于生成结束 10 秒才插入，不能立刻判 NO_IMAGE */
  reset();
  before = start();
  stopBtn = {};
  assistantNodes = [{ innerText: '' }, { innerText: '正在生成' }];
  msgNodes = [{}, {}, {}];
  await tick(1000);
  stopBtn = null;
  await tick(4000);
  await tick(10000);
  assert.strictEqual(result, null, '宽限期内不能判未出图');
  imgs = [makeImg('https://files.oaiusercontent.com/late.png')];
  await tick(4000);
  await tick(4000); // 新图需要两次观察 + 稳定窗口
  assert.strictEqual(result && result.status, 'IMAGE_READY', '晚到的图片仍应被下载');
  console.log('PASS D: 图片晚到不会立刻判失败去重发提示词');

  /* E: 真的没出图时仍会 NO_IMAGE，并带上页面实况 */
  reset();
  before = start({ timeoutMs: 120000 });
  stopBtn = {};
  assistantNodes = [{ innerText: '' }, { innerText: '抱歉，我不能生成' }];
  msgNodes = [{}, {}, {}];
  await tick(1000);
  stopBtn = null;
  let guard = 0;
  while (!result && guard++ < 20) await tick(4000);
  assert.strictEqual(result && result.status, 'NO_IMAGE', '真没出图仍应给出结论');
  assert.ok(result.diagnostic && typeof result.diagnostic.totalImgs === 'number', '应附带页面实况');
  assert.strictEqual(result.diagnostic.largeFresh, 0);
  console.log('PASS E: 真未出图时给出带诊断的 NO_IMAGE');

  /* F: 页面残留无关报错提示，但已有新回复时不判 PAGE_ERROR */
  reset();
  before = start();
  alerts = [{ innerText: 'Something went wrong' }];
  assistantNodes = [{ innerText: '' }, { innerText: '这是本次回复' }];
  msgNodes = [{}, {}, {}];
  stopBtn = {};
  await tick(1000);
  stopBtn = null;
  imgs = [makeImg('https://files.oaiusercontent.com/ok.png')];
  await tick(4000);
  assert.notStrictEqual(result && result.status, 'PAGE_ERROR', '无关 toast 不能判失败');
  console.log('PASS F: 残留 toast 不再误判成生成失败');

  /* G: stopButton 选择器完全失效，靠 DOM 静默仍能识别 */
  reset();
  before = start();
  assistantNodes = [{ innerText: '' }, { innerText: '回复' }];
  msgNodes = [{}, {}, {}];
  imgs = [makeImg('https://cdn.example-imagecdn.net/no-stop.png')];
  guard = 0;
  while (!result && guard++ < 12) await tick(3000);
  assert.strictEqual(result && result.status, 'IMAGE_READY', '停止按钮失效也应收敛');
  console.log('PASS G: stopButton 失效时靠 DOM 静默兜底');

  /* H: 用户消息里的参考图不会被当成生成结果 */
  reset();
  before = start();
  imgs = [
    makeImg('blob:user-ref', { closest: (sel) => (sel.includes('user') ? {} : null) }),
    makeImg('https://files.oaiusercontent.com/result.png')
  ];
  const fresh = probe.freshImages(before, null, true);
  assert.strictEqual(fresh.length, 1, '只应保留生成图');
  assert.ok(fresh[0].src.includes('result.png'));
  console.log('PASS H: 参考图不会混进生成结果');

  /* I: 旧图只是换了签名参数，不能被当成「本次新生成的图」 */
  reset();
  imgs = [makeImg('https://files.oaiusercontent.com/old.png?se=1&sig=aaa')];
  before = probe.snapshot();
  imgs = [
    makeImg('https://files.oaiusercontent.com/old.png?se=2&sig=bbb'),
    makeImg('https://files.oaiusercontent.com/new.png?se=2')
  ];
  const afterFresh = probe.freshImages(before, null, true);
  assert.strictEqual(afterFresh.length, 1, '仅签名变化不算新图');
  assert.ok(afterFresh[0].src.includes('new.png'), '真正的新图仍要识别');
  console.log('PASS I: 签名刷新不会把旧图误算成本次结果');

  /* J: 服务端已出图，但这一页卡在「生成中」且内容全无变化 → 提前收敛，不拖到 5 分钟总超时 */
  reset();
  stopBtn = {}; // 页面一直显示停止按钮：旧逻辑会每轮刷新 lastActivityAt，看起来「很活跃」
  assistantNodes = [{ innerText: '正在生成' }];
  msgNodes = [{}, {}, {}];
  before = start({ stalePageMs: 60000, timeoutMs: 300000, firstSignalMs: 120000 });
  const staleRes = await tick(61000);
  assert.strictEqual(staleRes && staleRes.status, 'PAGE_STALE', '页面脱节必须提前收敛成 PAGE_STALE');
  assert.strictEqual(staleRes.phase, 'stuck-generating', '要能看出是卡在生成中');
  console.log('PASS J: 页面卡在生成中且内容不变时提前收敛，不拖到 5 分钟总超时');

  /* K: 慢但有进展的流式生成不能被误判成页面脱节 */
  reset();
  stopBtn = {};
  assistantNodes = [{ innerText: '正在生成' }];
  msgNodes = [{}, {}, {}];
  before = start({ stalePageMs: 60000, timeoutMs: 300000, firstSignalMs: 120000 });
  let misjudged = false;
  for (let i = 1; i <= 7; i++) {
    assistantNodes = [{ innerText: '正在生成' + '.'.repeat(i) }];
    const r = await tick(20000);
    if (r && r.status === 'PAGE_STALE') misjudged = true;
  }
  assert.strictEqual(misjudged, false, '正文持续变化说明页面活着，绝不能误判成 PAGE_STALE');
  assert.strictEqual(result, null, '正常慢生成应继续等待，不该被提前结束');
  console.log('PASS K: 流式输出持续有进展时不误判、不打断正常慢生成');
}

run()
  .then(() => {
    Date.now = realNow;
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
    console.log('\nALL PASS — 出图检测回归通过');
  })
  .catch((e) => {
    Date.now = realNow;
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
    console.error('FAIL:', e && e.stack);
    process.exitCode = 1;
  });
