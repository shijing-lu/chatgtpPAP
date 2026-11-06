/* 文件附件产物识别回归（零依赖）：node tests/attachment-detect.test.js
 *
 * 复现用户日志：`img=4 新增=0 大图=0 规则命中=0 canvas=0 消息=0`
 * —— ChatGPT 已经把图作为「xxx.png 附件卡片 / 查看 4K 高清原图」返回，
 * 页面上没有任何新增 <img>，旧版只扫 <img> 必然判 NO_IMAGE。
 *
 * 覆盖：附件卡片 / 图片链接识别、旧产物差集、用户气泡降噪、
 *       消息节点选择器失效时的回复信号、点击目标不误点外链、诊断输出。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const load = (f) => vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });

/* ---------- 可控时钟 ---------- */
let NOW = 1000000;
Date.now = () => NOW;

/* ---------- DOM 桩 ---------- */
let imgs = [];
let canvases = [];
let msgNodes = [];
let assistantNodes = [];
let alerts = [];
let links = [];
let cards = [];
let buttons = [];
let stopBtn = null;
let bodyText = '';
const clicked = [];

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
    getAttribute(n) {
      return (opts.attrs && opts.attrs[n]) || null;
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

function makeNode(o) {
  const opts = o || {};
  return {
    tagName: opts.tag || 'A',
    innerText: opts.text || '',
    textContent: opts.text || '',
    _attrs: opts.attrs || {},
    getAttribute(n) {
      return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null;
    },
    hasAttribute(n) {
      return Object.prototype.hasOwnProperty.call(this._attrs, n);
    },
    setAttribute(n, v) {
      this._attrs[n] = v;
    },
    closest(sel) {
      return opts.closest && opts.closest(sel);
    },
    querySelector(sel) {
      return opts.inner && /a\[href\]|button/.test(sel) ? opts.inner : null;
    },
    compareDocumentPosition() {
      return Node.DOCUMENT_POSITION_FOLLOWING;
    },
    click() {
      clicked.push(this);
    }
  };
}

const mainEl = { tag: 'main' };
const document = {
  querySelectorAll(sel) {
    if (sel === 'img') return imgs;
    if (sel === 'canvas') return canvases;
    if (sel === '[data-message-author-role]') return msgNodes;
    if (sel === '[data-message-author-role="assistant"]') return assistantNodes;
    if (sel === '[role="alert"]') return alerts;
    if (sel === 'a[href]') return links;
    if (sel === '[data-testid*="file" i]' || sel === '[data-testid*="attachment" i]') return cards;
    if (sel === 'button') return buttons;
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
  body: {
    get innerText() {
      return bodyText;
    }
  }
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

global.setInterval = () => 1;
global.clearInterval = () => {};

/* ---------- 加载真实模块 ---------- */
load('src/shared/selectors.js');
load('src/content/probes.js');
load('src/content/watcher.js');

const probe = global.CGR_PROBE;
const watch = global.CGR_WATCH;
const realSetImmediate = global.setImmediate;

/* ---------- 测试工具 ---------- */
const OLD_IMG = makeImg('https://chatgpt.com/avatar.png', { nw: 32, nh: 32, rw: 32, rh: 32 });

function reset() {
  imgs = [OLD_IMG]; // 页面本来就有的头像/图标，发送前后都在
  canvases = [];
  msgNodes = [{ innerText: '' }];
  assistantNodes = [{ innerText: '' }];
  alerts = [];
  links = [];
  cards = [];
  buttons = [];
  stopBtn = null;
  bodyText = '旧回复内容';
  clicked.length = 0;
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

/** 模拟「生成中 → 生成结束 → 产物稳定」的完整节奏 */
async function runGeneration(extraTicks) {
  await tick(1000);
  stopBtn = null;
  await tick(1000);
  for (let i = 0; i < (extraTicks == null ? 4 : extraTicks); i++) await tick(1000);
  return result;
}

async function run() {
  /* A: 页面完全没有新增 <img>，只有 xxx.png 附件卡片 —— 必须判「已出图」 */
  reset();
  let before = start();
  stopBtn = {};
  cards = [makeNode({ tag: 'DIV', text: 'static_linked_list_4k.png 图像', attrs: { 'data-testid': 'file-card' } })];
  bodyText = '重点检查：… 查看 4K 高清原图（3072 × 4096 PNG）';
  let r = await runGeneration();
  assert.strictEqual(r && r.status, 'IMAGE_READY', '附件卡片也算产物，不能判 NO_IMAGE');
  assert.ok((r.images || []).some((a) => a.kind === 'card'), '产物里应包含 card');
  assert.ok((r.kinds || []).includes('card'));
  console.log('PASS A: 无 <img> 的附件卡片被识别为出图产物');

  /* B: sandbox: 图片链接 + 「查看 4K 高清原图」文字 */
  reset();
  before = start();
  stopBtn = {};
  links = [makeNode({
    text: '查看 4K 高清原图（3072 × 4096 PNG）',
    attrs: { href: 'sandbox:/mnt/data/static_linked_list_4k.png' }
  })];
  r = await runGeneration();
  assert.strictEqual(r && r.status, 'IMAGE_READY', 'sandbox 图片链接必须能识别');
  const linkArt = (r.images || []).find((a) => a.kind === 'link');
  assert.ok(linkArt, '应产出 link 产物');
  assert.strictEqual(linkArt.click, true, 'sandbox: 不是 http(s)，应标记需要点击兜底');
  console.log('PASS B: sandbox: 图片链接被识别且标记 click');

  /* C: 发送前就存在的卡片不能被算成「本次新出的图」 */
  reset();
  const oldCard = makeNode({ tag: 'DIV', text: 'old.png 图像' });
  cards = [oldCard];
  before = start();
  stopBtn = {};
  await tick(1000); // 先让 watcher 观察到「生成中」
  stopBtn = null;
  // 生成结束后还要等满图片宽限期才会判 NO_IMAGE
  for (let i = 0; i < 40; i++) {
    await tick(1000);
    if (result) break;
  }
  assert.strictEqual(result && result.status, 'NO_IMAGE', '旧卡片不能冒充新产物');
  console.log('PASS C: 旧附件卡片被差集排除，真没出图仍判 NO_IMAGE');

  /* D: 用户气泡里自己贴的图片链接不算生成产物 */
  reset();
  before = probe.snapshot();
  links = [
    makeNode({
      text: 'my_ref.png',
      attrs: { href: 'https://chatgpt.com/backend-api/estuary/content/ref.png' },
      closest: (sel) => (sel === '[data-message-author-role="user"]' ? {} : null)
    })
  ];
  assert.strictEqual(probe.linkArtifacts(before, null, true).length, 0, '用户气泡内的链接应排除');
  assert.strictEqual(probe.freshArtifacts(before, null, true).length, 0);
  console.log('PASS D: 用户气泡里的参考图链接不误判');

  /* E: 消息节点选择器全失效（msgNodes=0）、stopButton 也失效时，靠附件信号仍能收敛 */
  reset();
  before = start();
  stopBtn = {};
  msgNodes = [];
  assistantNodes = [];
  links = [makeNode({ text: 'result.png 图像', attrs: { href: 'https://cdn.example-imagecdn.net/result.png' } })];
  bodyText = '旧回复内容'.padEnd(300, '生');
  r = await runGeneration();
  assert.strictEqual(r && r.status, 'IMAGE_READY', '消息选择器失效时不能卡到 TIMEOUT');
  console.log('PASS E: 消息节点为 0 时靠产物/文本信号仍能判定回复结束');

  /* F: 诊断里必须能看出是「链接 / 附件」形态，而不是一片 0 */
  reset();
  before = probe.snapshot();
  cards = [makeNode({ tag: 'DIV', text: 'static_linked_list_4k.png 图像' })];
  links = [makeNode({ text: '查看原图 PNG', attrs: { href: 'https://chatgpt.com/backend-api/estuary/content?id=9' } })];
  const d = probe.diagnose(before);
  assert.strictEqual(d.freshImgs, 0, '确实没有新增 <img>');
  assert.ok(d.freshLinks >= 1, '诊断应报出新增链接数');
  assert.ok(d.fileCards >= 1, '诊断应报出附件卡片数');
  assert.ok(d.artifactHits >= 2, '诊断应报出总产物数');
  assert.ok(d.samples.some((s) => /链接|附件/.test(s)), '日志样本要写明产物形态');
  console.log('PASS F: NO_IMAGE 诊断新增链接/附件/产物字段');

  /* G: 点击兜底不能去点「查看原图」外链（会开新标签 / 导航走） */
  reset();
  const viewLink = makeNode({ text: '查看 4K 高清原图', attrs: { href: 'https://example.com/huge.png' } });
  const cardNode = makeNode({ tag: 'DIV', text: 'static_linked_list_4k.png 图像' });
  links = [viewLink];
  cards = [cardNode];
  const target = probe.findClickTarget('card:static_linked_list_4k.png', 'static_linked_list_4k.png');
  assert.strictEqual(target, cardNode, '应优先点附件卡片');
  assert.notStrictEqual(target, viewLink, '绝不能点查看原图外链');
  const target2 = probe.findClickTarget('https://example.com/huge.png', 'huge.png');
  assert.notStrictEqual(target2, viewLink, 'http 直链也不该通过点击处理');
  console.log('PASS G: 点击目标避开外链，只取附件卡片');

  /* H: 普通网页外链 score=0，不会被当成产物 */
  reset();
  assert.strictEqual(probe.linkScore('https://example.com/article', '一篇文章'), 0);
  assert.strictEqual(probe.linkScore('#', 'png'), 0);
  assert.ok(probe.linkScore('https://cdn.oaiusercontent.com/abc.png', '') >= 3);
  console.log('PASS H: 非图片外链被内容规则挡住');

  /* I: 内嵌图仍排在文件产物之前（不会被卡片顶掉） */
  reset();
  before = probe.snapshot();
  imgs = [OLD_IMG, makeImg('https://files.oaiusercontent.com/generated.png', { nw: 1024, nh: 1024 })];
  cards = [makeNode({ tag: 'DIV', text: 'generated.png 图像' })];
  const arts = probe.freshArtifacts(before, null, false);
  assert.ok(arts.length >= 2, '两种产物都应收集');
  assert.strictEqual(arts[0].kind, 'img', '内嵌图排在前面供后台优先选择');
  console.log('PASS I: 内嵌图与卡片并存时顺序稳定');

  console.log('\nALL PASS — 文件附件产物识别回归通过');
}

run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
