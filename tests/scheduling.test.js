/* 调度链路回归测试（零依赖）：node tests/scheduling.test.js
 *
 * 覆盖「点开始后有时正常、有时卡很久」的几类根因：
 *  - 标签页复用 / 不新开窗口
 *  - 无可用标签页时不留假运行中
 *  - 定时扫描不因异常中断
 *  - 运行中无页面领任务时自动重新接管
 *  - 标签页归属丢失时 claim 就地补绑定
 *  - 高频空闲轮询不反复写 storage
 *  - SW 运行期唤醒只在确实卡住时触发
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const load = (f) => vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });

/* ---------- chrome API 桩 ---------- */
let mem = {};
let tabSeq = 100;
let tabsMap = new Map();
let createCount = 0;
let pingsOk = true;
let scriptThrows = false;
let runtimeWrites = 0;
const sentMessages = [];
const intervals = [];

function addTab(url, active) {
  const id = ++tabSeq;
  const t = { id, url, active: !!active, windowId: 1, discarded: false, status: 'complete' };
  tabsMap.set(id, t);
  return t;
}

const noopListener = { addListener: () => {} };

const chrome = {
  storage: {
    local: {
      get: (keys) => {
        let out = {};
        if (keys == null) out = Object.assign({}, mem);
        else if (typeof keys === 'string') {
          if (keys in mem) out[keys] = mem[keys];
        } else if (Array.isArray(keys)) {
          for (const k of keys) if (k in mem) out[k] = mem[k];
        } else if (typeof keys === 'object') {
          for (const k of Object.keys(keys)) out[k] = k in mem ? mem[k] : keys[k];
        }
        return Promise.resolve(out);
      },
      set: (obj) => {
        if ('runtime' in obj) runtimeWrites += 1;
        Object.assign(mem, obj);
        return Promise.resolve();
      },
      remove: (keys) => {
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete mem[k]);
        return Promise.resolve();
      }
    },
    onChanged: noopListener
  },
  runtime: {
    getManifest: () => ({ content_scripts: [{ js: ['content.js'] }] }),
    sendMessage: () => Promise.resolve({ ok: true }),
    lastError: null,
    onInstalled: noopListener,
    onStartup: noopListener,
    onMessage: noopListener
  },
  action: { onClicked: noopListener },
  sidePanel: { setPanelBehavior: () => Promise.resolve(), open: () => Promise.resolve() },
  tabs: {
    query: () => Promise.resolve(Array.from(tabsMap.values())),
    get: (id) => Promise.resolve(tabsMap.get(Number(id)) || null),
    create: (opts) => {
      createCount += 1;
      return Promise.resolve(addTab(opts.url || 'https://chatgpt.com/', opts.active));
    },
    remove: (id) => {
      tabsMap.delete(Number(id));
      return Promise.resolve();
    },
    update: () => Promise.resolve({}),
    reload: () => Promise.resolve(),
    sendMessage: (tabId, msg) => {
      sentMessages.push({ tabId, type: msg.type });
      if (['PING', 'WAKE', 'EVALUATE'].includes(msg.type)) {
        return Promise.resolve(pingsOk ? { ok: true, ts: Date.now() } : null);
      }
      return Promise.resolve(null);
    },
    onRemoved: noopListener,
    onUpdated: noopListener
  },
  scripting: {
    executeScript: () => (scriptThrows ? Promise.reject(new Error('cannot inject')) : Promise.resolve([{ result: 1 }]))
  },
  windows: { update: () => Promise.resolve({}) },
  alarms: { create: () => {}, onAlarm: noopListener },
  downloads: { onChanged: noopListener, onDeterminingFilename: noopListener }
};

global.chrome = chrome;
global.self = global;
global.window = global;

// 不真正起定时器，避免测试进程被挂住；需要时手动调用 wakeTick
const realSetInterval = global.setInterval;
global.setInterval = (fn, ms) => {
  intervals.push({ fn, ms });
  return intervals.length;
};
global.clearInterval = () => {};

/* ---------- 加载真实模块（与 service worker 的 importScripts 顺序一致） ----------
 * store / lease / downloads / tabpool / orchestrator / scheduler 全部用真实实现，
 * 只把 Chrome API 打桩，这样测到的才是真的调度行为。 */

global.importScripts = (...files) => {
  for (const f of files) load(path.join('src/background', f).replace(/\\/g, '/'));
};
load('src/background/service-worker.js');

const CGR = global.CGR;
const store = global.CGR_STORE;
const orch = global.CGR_ORCH;
const sched = global.CGR_SCHED;
const G = CGR.GLOBAL;
const S = CGR.STATUS;

const reset = async () => {
  mem = {};
  tabsMap = new Map();
  // tabSeq 故意不重置：让每个用例的 tabId 唯一，避免 scheduler 内部的 misses Map 串味
  createCount = 0;
  pingsOk = true;
  scriptThrows = false;
  runtimeWrites = 0;
  sentMessages.length = 0;
  // store 是常驻内存缓存，只清 storage 桩不够，必须连同 S 一起重置，
  // 否则上一个用例的批次会残留，测「唯一运行中批次」时必定误判。
  await store.withLock(async () => {
    store.S.loaded = false;
    store.S.batches.clear();
    store.S.items.clear();
    store.S.logs = [];
    store.S.runtime = null;
    store.S.cfg = null;
    await store.load();
  });
};

const newBatchWithItem = async (name) => {
  const r = await orch.createBatch(name);
  await orch.addItem(r.batch.id, '一条测试提示词');
  return r.batch.id;
};

const markRunning = (bid, ageMs) => store.withLock(async () => {
  const b = store.getBatch(bid);
  b.status = G.RUNNING;
  b.startedAt = Date.now() - (ageMs || 0);
  b.lastClaimAt = 0;
  await store.putBatch(b);
});

(async () => {
  /* 参数：空闲轮询必须短且封顶，否则又会「越卡越久」 */
  assert.strictEqual(CGR.LIMITS.idlePollMs, 3000);
  assert.strictEqual(CGR.LIMITS.idleMaxPollMs, 8000);
  assert.ok(CGR.LIMITS.idleMaxPollMs < 30000, '空闲上限必须小于 SW 的 30 秒回收窗口');
  console.log('PASS 0: 空闲轮询短周期且封顶 8 秒');

  /* A：旧批次已停止时复用当前标签页，不新开 */
  await reset();
  const current = addTab('https://chatgpt.com/', true);
  const oldId = await newBatchWithItem('旧批次');
  await store.withLock(() => store.setRuntime({
    activeTabs: { [current.id]: { batchId: oldId, state: 'idle' } }
  }));
  const findId = await newBatchWithItem('查找');
  const a = await orch.start(findId);
  assert.strictEqual(a.ok, true);
  assert.strictEqual(createCount, 0, '不应新建标签页');
  assert.strictEqual(store.getRuntime().activeTabs[current.id].batchId, findId);
  assert.ok(sentMessages.some((m) => m.type === 'WAKE'));
  console.log('PASS A: 复用当前标签页，未新开');

  /* B：一个标签页都接管不了 → 明确报错，不留在「运行中」 */
  await reset();
  pingsOk = false;
  scriptThrows = true;
  const bidB = await newBatchWithItem('无页面批次');
  const b = await orch.start(bidB);
  assert.strictEqual(b.ok, false);
  assert.strictEqual(store.getBatch(bidB).status, G.ERROR);
  assert.match(store.getBatch(bidB).lastError || '', /标签页/);
  console.log('PASS B: 无可用标签页时不再假运行中');

  /* C：替换标签页分支不让整轮扫描崩溃 */
  await reset();
  pingsOk = false;
  const badTab = addTab('https://chatgpt.com/', true);
  const bidC = await newBatchWithItem('替换分支');
  await markRunning(bidC, 60000);
  await store.withLock(() => store.setRuntime({
    activeTabs: { [badTab.id]: { batchId: bidC, state: 'idle' } }
  }));
  await sched.scan();
  await sched.scan();
  const afterC = store.getRuntime();
  const replacement = Object.keys(afterC.activeTabs).find((id) => Number(id) !== badTab.id);
  assert.ok(replacement, '应登记替换后的新标签页');
  assert.strictEqual(afterC.activeTabs[replacement].batchId, bidC, '应继承批次归属');
  assert.ok(!store.getLogs().some((l) => /定时扫描异常/.test(l.message)));
  console.log('PASS C: 替换分支不再让整轮扫描崩溃');

  /* D：运行中却无绑定标签页 → 自动重新接管并唤醒 */
  await reset();
  pingsOk = true;
  const reuse = addTab('https://chatgpt.com/', true);
  const bidD = await newBatchWithItem('自愈批次');
  await markRunning(bidD, 60000);
  await store.withLock(() => store.setRuntime({ activeTabs: {} }));
  sentMessages.length = 0;
  await sched.scan();
  assert.strictEqual(store.getRuntime().activeTabs[reuse.id].batchId, bidD);
  assert.strictEqual(createCount, 0, '自愈也不该新开标签页');
  assert.ok(sentMessages.some((m) => m.type === 'WAKE'));
  console.log('PASS D: 无页面领任务时自动重新接管');

  /* E：归属丢失时，claim 就地补绑定（不用等 30 秒 alarm） */
  await reset();
  pingsOk = true;
  const lone = addTab('https://chatgpt.com/', true);
  const bidE = await newBatchWithItem('归属丢失');
  await markRunning(bidE, 1000);
  await store.withLock(() => store.setRuntime({ activeTabs: {} }));
  const grantE = await orch.claim(lone.id, 'conv-1');
  assert.strictEqual(grantE.ok, true, '归属丢失时应就地补绑定并直接派发');
  assert.strictEqual(store.getRuntime().activeTabs[lone.id].batchId, bidE, '应就地补绑定');
  assert.ok(store.getLogs().some((l) => /未登记.*已自动归到/.test(l.message)));
  console.log('PASS E: 标签页归属丢失时 claim 就地补绑定');

  /* 两个批次同时跑时不自动补绑定，避免多个标签页抢任务 */
  await reset();
  const tab2 = addTab('https://chatgpt.com/', true);
  const e1 = await newBatchWithItem('批次一');
  const e2 = await newBatchWithItem('批次二');
  await markRunning(e1, 1000);
  await markRunning(e2, 1000);
  await store.withLock(() => store.setRuntime({ activeTabs: {} }));
  const grantE2 = await orch.claim(tab2.id, 'conv-2');
  assert.strictEqual(grantE2.reason, 'no-batch', '多个运行中批次不应擅自绑定');
  assert.ok(!((store.getRuntime().activeTabs || {})[tab2.id] || {}).batchId);
  console.log('PASS E2: 多个批次运行时不擅自补绑定');

  /* F：队列已经跑空时，高频空闲轮询不反复写 runtime */
  await reset();
  pingsOk = true;
  const idleTab = addTab('https://chatgpt.com/', true);
  const bidF = await newBatchWithItem('空闲轮询');
  await markRunning(bidF, 1000);
  await store.withLock(async () => {
    const it = store.getItem(bidF, 0);
    it.status = S.DONE;
    await store.putItem(bidF, it);
    await store.setRuntime({
      activeTabs: { [idleTab.id]: { batchId: bidF, state: 'idle' } }
    });
  });
  runtimeWrites = 0;
  await orch.claim(idleTab.id, 'conv-f');
  await orch.claim(idleTab.id, 'conv-f');
  await orch.claim(idleTab.id, 'conv-f');
  assert.strictEqual(runtimeWrites, 0, '空闲时不应反复写 runtime');
  console.log('PASS F: 3 秒级空闲轮询不产生无谓写入');

  /* G：运行期唤醒只在确实卡住时触发 */
  await reset();
  pingsOk = true;
  const wakeTab = addTab('https://chatgpt.com/', true);
  const bidG = await newBatchWithItem('唤醒批次');
  await markRunning(bidG, 1000);
  await store.withLock(() => store.setRuntime({
    activeTabs: { [wakeTab.id]: { batchId: bidG, state: 'idle' } }
  }));
  sentMessages.length = 0;
  await global.wakeTick();
  assert.ok(!sentMessages.some((m) => m.type === 'WAKE'), '刚开始不该打扰');
  await markRunning(bidG, 60000);
  await global.wakeTick();
  assert.ok(sentMessages.some((m) => m.type === 'WAKE'), '超过 15 秒没派发应主动唤醒');
  console.log('PASS G: 运行期唤醒只在卡住时触发');

  console.log('\nALL PASS — 调度链路回归通过');
  process.exit(0);
})().catch((e) => {
  console.error('FAIL:', e && e.stack);
  process.exit(1);
});
