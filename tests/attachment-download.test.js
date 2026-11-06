/* 附件产物下载链路回归（零依赖）：node tests/attachment-download.test.js
 *
 * 用真实 store / lease / downloads / orchestrator，只打桩 Chrome API：
 *  - 卡片 / sandbox: 产物走「页面内取流 → 点击附件 → 下载归位」
 *  - 页面点击产生的下载必须改到批次目录并登记归属，任务才能变「已完成」
 *  - http(s) 图片链接仍走直链下载
 *  - 页面已有附件产物却判 NO_IMAGE 时，绝不重发提示词
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const load = (f) => vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });

/* ---------- Chrome API 桩 ---------- */
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
global.setInterval = () => 1;
global.clearInterval = () => {};

/* ---------- 标签页桩 ---------- */
global.CGR_TABS = {
  ensureBatchTabs: () => Promise.resolve({ ids: [1], windowId: 1 }),
  ensureContentScript: () => Promise.resolve(true),
  ping: () => Promise.resolve(true),
  send: () => Promise.resolve({ ok: true }),
  reviveTab: () => Promise.resolve('ok'),
  replaceTab: () => Promise.resolve(null),
  usableTabs: () => Promise.resolve([{ id: 1 }])
};

/* ---------- 加载真实模块 ---------- */
load('src/shared/constants.js');
load('src/shared/sched.js');
load('src/shared/selectors.js');
load('src/shared/slug.js');
load('src/background/store.js');
load('src/background/lease.js');
load('src/background/downloads.js');
load('src/background/orchestrator.js');

const CGR = global.CGR;
const S = CGR.STATUS;
const store = global.CGR_STORE;
const dl = global.CGR_DL;
const orch = global.CGR_ORCH;

async function setup() {
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
  });
  const r = await orch.createBatch('查找');
  await orch.addItem(r.batch.id, '画一张静态链表对比图');
  await orch.start(r.batch.id);
  const grant = await orch.claim(1, 'conv-attach');
  assert.ok(grant && grant.ok, '应能领到任务');
  return { bid: r.batch.id, token: grant.leaseToken };
}

function outcome(token, status, data) {
  return orch.handleOutcome({ leaseToken: token, status, data: data || {} }, 1);
}

const CARD = {
  src: 'card:static_linked_list_4k.png',
  kind: 'card',
  label: 'static_linked_list_4k.png 图像',
  w: 0,
  h: 0,
  score: 2,
  click: true
};
const SANDBOX = {
  src: 'sandbox:/mnt/data/static_linked_list_4k.png',
  kind: 'link',
  label: '查看 4K 高清原图（3072 × 4096 PNG）',
  w: 0,
  h: 0,
  score: 3,
  click: true
};

(async () => {
  /* A: 附件卡片 → 不调下载 API，发 FETCH_IMAGE 且带 click，准备归位 */
  let ctx = await setup();
  await outcome(ctx.token, 'IMAGE_READY', { images: [CARD] });
  let item = store.getItem(ctx.bid, 0);
  assert.strictEqual(item.image.artifactKind, 'card', '应记录产物形态');
  assert.strictEqual(downloadCalls.length, 0, '卡片不能交给 chrome.downloads.download');
  const fetchMsg = tabMessages.find((m) => m.msg.type === 'FETCH_IMAGE');
  assert.ok(fetchMsg, '应让页面内取流/点击附件');
  assert.strictEqual(fetchMsg.msg.click, true, '必须允许点击兜底');
  assert.strictEqual(fetchMsg.msg.label, CARD.label);
  assert.ok(mem['dl:pending-click'], '应预置下载归位信息');
  assert.ok(/\.png$/.test(mem['dl:pending-click'].filename), '扩展名应取卡片文件名');
  console.log('PASS A: 附件卡片走页面取流/点击，并按 .png 命名');

  /* B: 页面点击产生的下载被改到批次目录、登记归属、任务变已完成 */
  let suggested = null;
  dl.onDeterminingFilename({ id: 888, byExtensionId: undefined }, (v) => {
    suggested = v;
  });
  assert.ok(suggested && suggested.filename, '必须同步给出目标文件名');
  assert.strictEqual(suggested.filename, item.filename, '应落到批次目录/命名模板');
  assert.ok(mem['dl:888'], '下载 id 必须登记到任务');
  assert.ok(!mem['dl:pending-click'], '归位后应清掉待点击记录');
  await store.withLock(() => dl.handleChanged({ id: 888, state: { current: 'complete' } }));
  assert.strictEqual(store.getItem(ctx.bid, 0).status, S.DONE, '下载完成后任务应标已完成');
  assert.ok(store.getLogs().some((l) => /页面附件下载已归位/.test(l.message)));
  console.log('PASS B: 页面点击下载归位到批次目录并推进为已完成');

  /* C: http(s) 图片直链仍走 A，不预置点击归位 */
  ctx = await setup();
  await outcome(ctx.token, 'IMAGE_READY', {
    images: [{ src: 'https://files.oaiusercontent.com/abc.png', kind: 'link', w: 0, h: 0, score: 3, known: true, label: '原图' }]
  });
  assert.strictEqual(downloadCalls.length, 1, '直链应调用一次下载 API');
  assert.ok(!mem['dl:pending-click'], '直链不需要点击归位');
  assert.strictEqual(store.getItem(ctx.bid, 0).image.kind, 'https');
  console.log('PASS C: http(s) 图片链接走直链下载，不触发点击');

  /* D: sandbox: 链接同样走取流 + 点击兜底 */
  ctx = await setup();
  await outcome(ctx.token, 'IMAGE_READY', { images: [SANDBOX] });
  assert.ok(mem['dl:pending-click'], 'sandbox: 也应准备归位');
  assert.strictEqual(store.getItem(ctx.bid, 0).image.kind, 'file');
  const sandboxMsg = tabMessages.find((m) => m.msg.type === 'FETCH_IMAGE');
  assert.ok(sandboxMsg && sandboxMsg.msg.click, 'sandbox: 需要点击兜底');
  console.log('PASS D: sandbox: 链接走页面内取流并允许点击兜底');

  /* E: 页面已有附件产物却判 NO_IMAGE → 待确认，绝不退回重发 */
  ctx = await setup();
  await outcome(ctx.token, 'NO_IMAGE', {
    diagnostic: {
      totalImgs: 4,
      freshImgs: 0,
      largeFresh: 0,
      strictHits: 0,
      freshLinks: 1,
      fileCards: 1,
      artifactHits: 2,
      samples: ['附件 static_linked_list_4k.png 图像']
    }
  });
  item = store.getItem(ctx.bid, 0);
  assert.strictEqual(item.status, S.NEEDS_REVIEW, '应标待确认');
  assert.notStrictEqual(item.status, S.PENDING, '绝不能退回待生成重新发提示词');
  assert.strictEqual(item.error.code, 'IMAGE_PRESENT_NOT_SAVED');
  console.log('PASS E: 诊断里有附件产物时停止重发，避免重复生图');

  /* F: 内嵌图与卡片并存时优先选已知内嵌图 */
  ctx = await setup();
  await outcome(ctx.token, 'IMAGE_READY', {
    images: [
      CARD,
      { src: 'https://files.oaiusercontent.com/big.png', kind: 'img', w: 1024, h: 1024, known: true }
    ]
  });
  assert.strictEqual(store.getItem(ctx.bid, 0).image.artifactKind, 'img', '应优先内嵌大图');
  assert.strictEqual(downloadCalls.length, 1);
  console.log('PASS F: 产物优先级稳定，内嵌图不被卡片顶掉');

  /* G: 点击后一直没产生下载 → 超时标待确认，不永远挂「下载中」 */
  ctx = await setup();
  await outcome(ctx.token, 'IMAGE_READY', { images: [CARD] });
  assert.strictEqual(store.getItem(ctx.bid, 0).status, S.DOWNLOADING);
  dl.clearCache(); // 模拟 SW 重启：内存 pending 丢失，只剩 storage
  mem['dl:pending-click'].expiresAt = Date.now() - 1000;
  await store.withLock(() => dl.checkPendingClicks());
  item = store.getItem(ctx.bid, 0);
  assert.strictEqual(item.status, S.NEEDS_REVIEW);
  assert.strictEqual(item.error.code, 'ATTACHMENT_CLICK_TIMEOUT');
  assert.ok(!mem['dl:pending-click'], '超时后应清掉待点击记录');
  console.log('PASS G: 点击未产生下载时超时收敛为待确认');

  console.log('\nALL PASS — 附件下载链路回归通过');
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
