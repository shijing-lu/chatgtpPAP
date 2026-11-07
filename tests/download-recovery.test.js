/* 下载失败链路回归（零依赖）：node tests/download-recovery.test.js
 *
 * 用户主诉「经常下载图片下载失败」。定位到的确定性 bug：
 *  1) A 级直链被服务端拒绝（403/签名过期）后要降级到页面内取流，但
 *     startUrlDownload 清掉了 lease、又从来不写 tabId → requestFallback
 *     必然 NO_TAB_FOR_FALLBACK，页面上明明有图却判「下载失败」。
 *  2) DOWNLOADING 阶段没有租约，sweepExpired 管不到；取流失败/丢分片
 *     时任务永远挂在 ACTIVE，整批队列被一条下载拖死。
 *  3) commitChunks 缺片也照样 join 出去 → 保存一个打不开的损坏文件。
 *  4) 4K PNG 转 data: URL 会踩 Chrome 的长度上限 → 改走页面 blob 点击，
 *     点击前必须先由后台登记归位目标，否则又变默认「下载.png」。
 *
 * 用真实 store / downloads，只打桩 Chrome API。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const load = (f) => vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });

/* ---------- Chrome API 桩 ---------- */
const EXT_ID = 'cgr-test-extension';
let mem = {};
let dlSeq = 900;
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
    id: EXT_ID,
    getManifest: () => ({ version: '0.6.2' }),
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
      downloadCalls.push({ opts });
      dlSeq += 1;
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

/* ---------- 加载真实模块 ---------- */
load('src/shared/constants.js');
load('src/shared/sched.js');
load('src/shared/slug.js');
load('src/background/store.js');
load('src/background/downloads.js');

const CGR = global.CGR;
const S = CGR.STATUS;
const store = global.CGR_STORE;
const dl = global.CGR_DL;

function capture() {
  const rec = { calls: 0, value: undefined };
  return { rec, fn: (v) => { rec.calls += 1; rec.value = v; } };
}

async function reset() {
  mem = {};
  dlSeq = 900;
  downloadCalls.length = 0;
  tabMessages.length = 0;
  dl.purge();
  await store.withLock(async () => {
    store.S.loaded = false;
    store.S.batches.clear();
    store.S.items.clear();
    store.S.logs = [];
    store.S.runtime = null;
    store.S.cfg = null;
    await store.load();
  });
  const b = await store.createBatch('操作系统第12');
  b.folder = CGR.normalizeFolder('操作系统第12', '');
  await store.putBatch(b);
  const item = {
    index: 0,
    batchId: b.id,
    prompt: '画一张死锁预防知识图',
    status: S.PENDING,
    attempt: 0,
    lease: null,
    tabId: 1,
    image: { src: 'https://files.oaiusercontent.com/abc.png', kind: 'https', label: '' },
    download: null,
    error: null,
    filename: '',
    ts: {}
  };
  await store.putItem(b.id, item);
  return { bid: b.id, item };
}

const logsText = () => store.getLogs().map((l) => l.message).join('\n');

(async () => {
  let passed = 0;
  const ok = (m) => { passed += 1; console.log('  ✓ ' + m); };

  /* A: 直链下载被拒 → 必须降级到原执行页取流，不能判「找不到标签页」 */
  {
    const ctx = await reset();
    await dl.startUrlDownload(ctx.item, ctx.item.image.src, 'png');
    const cap = capture();
    dl.onDeterminingFilename({ id: 901, byExtensionId: EXT_ID, url: ctx.item.image.src }, cap.fn);
    await store.withLock(() => dl.handleChanged({
      id: 901,
      state: { current: 'interrupted' },
      error: { current: 'SERVER_UNAUTHORIZED' }
    }));
    const it = store.getItem(ctx.bid, 0);
    assert.strictEqual(it.status, S.DOWNLOADING, 'A 级失败应留在下载中并尝试降级');
    assert.strictEqual(it.download.tier, 'B');
    assert.strictEqual(it.download.state, 'fetching');
    assert.strictEqual(it.tabId, 1, '执行页 ID 必须保留');
    const fetchMsg = tabMessages.find((x) => x.msg && x.msg.type === 'FETCH_IMAGE');
    assert.ok(fetchMsg, '必须向执行页发起页面内取流');
    assert.strictEqual(fetchMsg.tabId, 1);
    assert.ok(!/NO_TAB_FOR_FALLBACK/.test(logsText()));
    ok('A: 直链 401/签名过期后能找回执行页降级取流');
  }

  /* B: 丢一片也不能拼出损坏文件 */
  {
    const ctx = await reset();
    dl.pushChunk(ctx.bid, 0, 0, 2, 'AAAA');
    const res = await store.withLock(() => dl.commitChunks(ctx.bid, 0, 'image/png', 'png'));
    assert.strictEqual(res, null);
    assert.strictEqual(downloadCalls.length, 0, '缺片时绝不发起下载');
    const it = store.getItem(ctx.bid, 0);
    assert.strictEqual(it.status, S.NEEDS_REVIEW);
    assert.strictEqual(it.error.code, 'DL_CHUNK_INCOMPLETE');
    assert.strictEqual(it.attempt, 0, '绝不重发提示词');
    ok('B: 分片不完整时放弃下载并标待确认');
  }

  /* C: 分片完整时仍走原来的 data URL 下载 */
  {
    const ctx = await reset();
    dl.pushChunk(ctx.bid, 0, 0, 2, 'AAAA');
    dl.pushChunk(ctx.bid, 0, 1, 2, 'BBBB');
    await store.withLock(() => dl.commitChunks(ctx.bid, 0, 'image/png', 'png'));
    assert.strictEqual(downloadCalls.length, 1);
    assert.ok(/^data:image\/png;base64,AAAABBBB$/.test(downloadCalls[0].opts.url));
    ok('C: 完整分片照常下载，不误伤正常路径');
  }

  /* D: 取流卡住有看门狗，DOWNLOADING 不再永久 ACTIVE */
  {
    const ctx = await reset();
    const it = store.getItem(ctx.bid, 0);
    it.status = S.DOWNLOADING;
    it.download = { tier: 'B', state: 'fetching', startedAt: Date.now() - 120000, tabId: 1 };
    await store.putItem(ctx.bid, it);
    await store.withLock(() => dl.checkPendingFetches());
    const after = store.getItem(ctx.bid, 0);
    assert.strictEqual(after.status, S.NEEDS_REVIEW);
    assert.strictEqual(after.error.code, 'FETCH_TIMEOUT');
    assert.strictEqual(after.attempt, 0, '保存失败不能变成重发提示词');
    ok('D: 取流超时收敛为待确认，队列可以继续下一条');
  }

  /* E: 未超时的正常取流不被看门狗误伤 */
  {
    const ctx = await reset();
    const it = store.getItem(ctx.bid, 0);
    it.status = S.DOWNLOADING;
    it.download = { tier: 'B', state: 'fetching', startedAt: Date.now() - 3000, tabId: 1 };
    await store.putItem(ctx.bid, it);
    await store.withLock(() => dl.checkPendingFetches());
    assert.strictEqual(store.getItem(ctx.bid, 0).status, S.DOWNLOADING);
    ok('E: 刚开始取流时看门狗不误伤');
  }

  /* F: 页面侧明确报「取流失败」时立即收敛 */
  {
    const ctx = await reset();
    const it = store.getItem(ctx.bid, 0);
    it.status = S.DOWNLOADING;
    it.download = { tier: 'B', state: 'fetching', startedAt: Date.now(), tabId: 1 };
    await store.putItem(ctx.bid, it);
    await store.withLock(() => dl.failFetch(ctx.bid, 0, 'canvas-tainted'));
    const after = store.getItem(ctx.bid, 0);
    assert.strictEqual(after.status, S.NEEDS_REVIEW);
    assert.strictEqual(after.error.code, 'FETCH_FAILED');
    assert.match(after.error.message, /手动保存/);
    ok('F: 取流失败立即上报并给出手动保存提示');
  }

  /* G: 大图 blob 点击前登记归位目标，页面发起的下载也能改到批次目录 */
  {
    const ctx = await reset();
    const arm = await store.withLock(() => dl.armBlobClick(ctx.bid, 0, 'png'));
    assert.strictEqual(arm.ok, true);
    assert.match(arm.filename, /操作系统第12\/001_/);
    assert.ok(mem['dl:pending-click'], '必须登记页面点击意图');
    const cap = capture();
    const ret = dl.onDeterminingFilename({ id: 902, url: 'blob:https://chatgpt.com/xyz' }, cap.fn);
    assert.strictEqual(ret, false);
    assert.strictEqual(cap.rec.calls, 1);
    assert.strictEqual(cap.rec.value.filename, arm.filename);
    assert.ok(mem['dl:902'], '下载 id 必须归属到该任务');
    await store.withLock(() => dl.handleChanged({ id: 902, state: { current: 'complete' } }));
    assert.strictEqual(store.getItem(ctx.bid, 0).status, S.DONE);
    assert.ok(!mem['dl:pending-click'], '有终态后清掉点击意图，避免 45 秒看门狗补误报');
    ok('G: 大图走页面 blob 下载仍归位到批次目录，完成后不误报');
  }

  /* H: tabId 全丢时，从 runtime 的同批次活跃标签页兜底 */
  {
    const ctx = await reset();
    const it = store.getItem(ctx.bid, 0);
    it.status = S.DOWNLOADING;
    it.tabId = null;
    it.lease = null;
    it.download = { tier: 'A', state: 'pending' };
    await store.putItem(ctx.bid, it);
    await store.withLock(() => store.setRuntime({
      activeTabs: { 7: { batchId: ctx.bid, state: 'busy', stale: false, at: Date.now() } }
    }));
    await dl.requestFallback(it, 'missing-tab-id');
    const fetchMsg = tabMessages.find((x) => x.msg && x.msg.type === 'FETCH_IMAGE');
    assert.ok(fetchMsg, '仍应发出取流请求');
    assert.strictEqual(fetchMsg.tabId, 7);
    assert.strictEqual(store.getItem(ctx.bid, 0).tabId, 7);
    ok('H: tabId 丢失时从 runtime 找回同批次执行页');
  }

  /* I: 新消息类型与后台入口必须齐全（内容侧引用了但常量漏定义会静默失效） */
  {
    assert.strictEqual(CGR.MSG.DL_BLOB_CLICK, 'DL_BLOB_CLICK');
    assert.strictEqual(CGR.MSG.DL_FETCH_FAILED, 'DL_FETCH_FAILED');
    assert.strictEqual(CGR.MSG.PAGE_NOT_READY, 'PAGE_NOT_READY');
    assert.ok(CGR.LIMITS.fetchTimeoutMs > 0);
    assert.ok(CGR.LIMITS.maxDataUrlB64 > 0);
    for (const fn of ['armBlobClick', 'failFetch', 'checkPendingFetches']) {
      assert.strictEqual(typeof dl[fn], 'function', `dl.${fn} 必须导出`);
    }
    ok('I: 新消息类型、超时参数与后台入口齐全');
  }

  console.log(`\nALL PASS — 下载失败链路回归通过（${passed} 组）`);
  process.exit(0);
})().catch((e) => {
  console.error('FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
