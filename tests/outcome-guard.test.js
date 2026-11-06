/* 结果处理 / 重试护栏回归测试（零依赖）：node tests/outcome-guard.test.js
 *
 * 针对「网页已经出图，插件却判失败并反复重发同一提示词、生成多张图」：
 *  - 过期租约回收必须累加 attempt，否则 maxAttempts 永远失效、可无限重发
 *  - 同一 OUTCOME 重复上报必须幂等，不能重复触发下载
 *  - 诊断显示页面已有大图时，绝不退回队列重发
 *  - 默认「未出图」策略是标记待确认，而不是自动重发提示词
 *  - 页面跳转/中止同样计数，避免另一条无限重发路径
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const load = (f) => vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });

/* ---------- Chrome API 桩 ---------- */
let mem = {};
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
    sendMessage: () => Promise.resolve({ ok: true }),
    onRemoved: noop,
    onUpdated: noop
  },
  scripting: { executeScript: () => Promise.resolve([{ result: 1 }]) },
  windows: { update: () => Promise.resolve({}) },
  alarms: { create() {}, onAlarm: noop },
  downloads: { download: () => Promise.resolve(1), onChanged: noop }
};
global.chrome = chrome;
global.self = global;
global.window = global;

const realSetInterval = global.setInterval;
global.setInterval = () => 1;
global.clearInterval = () => {};

/* ---------- 依赖桩：下载与标签页 ---------- */
let dlCalls = [];
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

const CGR = global.CGR;
const store = global.CGR_STORE;
const lease = global.CGR_LEASE;
const S = CGR.STATUS;

global.CGR_DL = {
  startUrlDownload: async (item, url) => {
    dlCalls.push({ kind: 'url', url });
    item.lease = null;
    item.status = S.DOWNLOADING;
    await store.putItem(item.batchId, item);
    return item;
  },
  startDataDownload: async (item) => {
    dlCalls.push({ kind: 'data' });
    item.lease = null;
    item.status = S.DOWNLOADING;
    await store.putItem(item.batchId, item);
    return item;
  },
  requestFallback: async (item, reason) => {
    dlCalls.push({ kind: 'fallback', reason });
    await store.putItem(item.batchId, item);
  },
  buildPath: () => '',
  handleChanged: async () => {},
  pushChunk() {},
  commitChunks() {},
  clearCache() {}
};
load('src/background/orchestrator.js');

const orch = global.CGR_ORCH;

async function setup() {
  mem = {};
  dlCalls = [];
  await store.withLock(async () => {
    store.S.loaded = false;
    store.S.batches.clear();
    store.S.items.clear();
    store.S.logs = [];
    store.S.runtime = null;
    store.S.cfg = null;
    await store.load();
  });
  const r = await orch.createBatch('测试');
  await orch.addItem(r.batch.id, '一条生图提示词');
  await orch.start(r.batch.id);
  return r.batch.id;
}

async function claim(bid) {
  const g = await orch.claim(1, 'conv-test');
  assert.ok(g && g.ok, '应能领到任务');
  void bid;
  return g.leaseToken;
}

function outcome(token, status, data) {
  return orch.handleOutcome({ leaseToken: token, status, data: data || {} }, 1);
}

(async () => {
  /* A：默认策略不再自动重发 */
  assert.strictEqual(CGR.DEFAULTS.onNoImage, 'review');
  console.log('PASS A: 默认「未出图」策略为标记待确认，不自动重发');

  /* B：过期租约回收必须累加 attempt，杜绝无限重发 */
  let bid = await setup();
  let token = await claim(bid);
  let item = store.getItem(bid, 0);
  item.lease.expiresAt = Date.now() - 1;
  await store.putItem(bid, item);
  await store.withLock(() => lease.sweepExpired());
  assert.strictEqual(store.getItem(bid, 0).attempt, 1, '第一次过期应计数');
  assert.strictEqual(store.getItem(bid, 0).status, S.PENDING);
  token = await claim(bid);
  void token;
  item = store.getItem(bid, 0);
  item.lease.expiresAt = Date.now() - 1;
  await store.putItem(bid, item);
  await store.withLock(() => lease.sweepExpired());
  assert.strictEqual(store.getItem(bid, 0).status, S.NEEDS_REVIEW, '达到上限必须停下');
  assert.strictEqual(lease.findClaimable(bid), null, '不能再被领取重新生成');
  console.log('PASS B: 租约过期会计数，同一提示词不会无限重发');

  /* C：OUTCOME 重复上报幂等，只下载一次 */
  bid = await setup();
  token = await claim(bid);
  const msg = {
    leaseToken: token,
    status: 'IMAGE_READY',
    data: { images: [{ src: 'https://files.oaiusercontent.com/a.png', w: 1024, h: 1024 }] }
  };
  const r1 = await orch.handleOutcome(msg, 1);
  const r2 = await orch.handleOutcome(msg, 1);
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r2.duplicate, true, '重复上报应被识别');
  assert.strictEqual(dlCalls.length, 1, '绝不能触发两次下载');
  assert.ok(store.getLogs().some((l) => /已确认出图/.test(l.message)), '应留下明确日志');
  console.log('PASS C: 上报重试幂等，图片只下载一次');

  /* D：诊断显示网页已有大图 → 不重发，标待确认 */
  bid = await setup();
  token = await claim(bid);
  await outcome(token, 'NO_IMAGE', {
    diagnostic: { largeFresh: 1, freshImgs: 2, strictHits: 0, totalImgs: 3, samples: ['1024x1024 https://cdn/x'] }
  });
  item = store.getItem(bid, 0);
  assert.strictEqual(item.status, S.NEEDS_REVIEW);
  assert.strictEqual(item.error.code, 'IMAGE_PRESENT_NOT_SAVED');
  assert.ok(store.getLogs().some((l) => /已停止重发/.test(l.message)));
  console.log('PASS D: 网页已出图时立刻停止重发提示词');

  /* E：真没出图也按默认策略停下，不自动重跑 */
  bid = await setup();
  token = await claim(bid);
  await outcome(token, 'NO_IMAGE', {
    diagnostic: { largeFresh: 0, freshImgs: 0, strictHits: 0, totalImgs: 1, samples: [] }
  });
  item = store.getItem(bid, 0);
  assert.strictEqual(item.status, S.NEEDS_REVIEW);
  assert.ok(/停止自动重试/.test(item.error.message));
  console.log('PASS E: 真未出图时标待确认，不消耗第二次生图额度');

  /* F：页面跳转/中止也计数，堵住另一条无限重发路径 */
  bid = await setup();
  token = await claim(bid);
  await outcome(token, 'NAVIGATED');
  assert.strictEqual(store.getItem(bid, 0).attempt, 1);
  token = await claim(bid);
  await outcome(token, 'NAVIGATED');
  assert.strictEqual(store.getItem(bid, 0).status, S.NEEDS_REVIEW);
  console.log('PASS F: 页面跳转同样受次数上限约束');

  /* G：用户旧配置里存了 retry，加载时一次性迁移，其它配置不动 */
  mem = { cfg: { onNoImage: 'retry', folder: 'my-images' } };
  await store.withLock(async () => {
    store.S.loaded = false;
    store.S.batches.clear();
    store.S.items.clear();
    store.S.logs = [];
    store.S.runtime = null;
    store.S.cfg = null;
    await store.load();
  });
  assert.strictEqual(store.getCfg().onNoImage, 'review', '旧默认值应被迁移');
  assert.strictEqual(store.getCfg().folder, 'my-images', '其它设置不能被覆盖');
  assert.strictEqual(store.getCfg().noImagePolicyConfirmed, true, '只迁移一次');
  console.log('PASS G: 旧配置自动迁移到安全的默认策略');

  global.setInterval = realSetInterval;
  console.log('\nALL PASS — 结果处理与重试护栏回归通过');
})().catch((e) => {
  global.setInterval = realSetInterval;
  console.error('FAIL:', e && e.stack);
  process.exitCode = 1;
});
