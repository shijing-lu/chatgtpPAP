/* 僵尸执行页回归（零依赖）：node tests/zombie-tab.test.js
 *
 * 复现用户日志：「开始…已接管标签页 803849432」→「等待派发：这个标签页未绑定批次」
 * → 25 秒仍没有页面来领任务。原因是 activeTabs 里那条绑定还标记着 stale:false，
 * 但对应页面根本不来领任务；其它 ChatGPT 标签页被 claim 永久拒绝，后台又只给死页发 WAKE。
 *
 * 覆盖：
 *  - 超时且无任务在执行 → 当前来领任务的标签页自动接管、清掉旧绑定
 *  - 没超时 / 有任务在生成 / 多个批次在跑 → 绝不抢执行权（防重复生图）
 *  - 接管后旧执行页再来领任务不会被派发
 *  - start 优先选用户当前激活的 ChatGPT 标签页并清理遗留绑定
 *  - WAKE 送不到时标失联；定时扫描 ping 通后清掉 stale
 *  - 「立即修复」把当前页纳为执行页并清掉僵尸绑定
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const load = (f) => vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });

/* ---------- Chrome API 桩 ---------- */
let mem = {};
let tabSeq = 100;
let tabsMap = new Map();
let focusedWindowId = 1;
let createCount = 0;
let pingsOk = true;
const wakeOk = new Map();
const sentMessages = [];

function addTab(url, active, windowId) {
  const id = ++tabSeq;
  const t = { id, url, active: !!active, windowId: windowId == null ? 1 : windowId, discarded: false, status: 'complete' };
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
        Object.assign(mem, obj);
        return Promise.resolve();
      },
      remove: (keys) => {
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete mem[k]);
        return Promise.resolve();
      },
      clear: () => {
        for (const k of Object.keys(mem)) delete mem[k];
        return Promise.resolve();
      }
    },
    onChanged: noopListener
  },
  runtime: {
    getManifest: () => ({ version: '0.5.1', content_scripts: [{ js: ['content.js'] }] }),
    sendMessage: () => Promise.resolve({ ok: true }),
    lastError: null,
    onInstalled: noopListener,
    onStartup: noopListener,
    onMessage: noopListener
  },
  action: { onClicked: noopListener },
  sidePanel: { setPanelBehavior: () => Promise.resolve(), open: () => Promise.resolve() },
  tabs: {
    // 支持 active / lastFocusedWindow / url 过滤，才能真实验证「当前激活页优先」
    query: (q) => {
      let list = Array.from(tabsMap.values());
      if (q && q.url != null) {
        list = list.filter((t) => /chatgpt\.com|chat\.openai\.com/.test(t.url || ''));
      }
      if (q && q.active === true) list = list.filter((t) => t.active);
      if (q && (q.lastFocusedWindow || q.currentWindow)) list = list.filter((t) => t.windowId === focusedWindowId);
      return Promise.resolve(list);
    },
    get: (id) => Promise.resolve(tabsMap.get(Number(id)) || null),
    create: (opts) => {
      createCount += 1;
      return Promise.resolve(addTab(opts.url || 'https://chatgpt.com/', opts.active, opts.windowId));
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
        const ok = pingsOk && wakeOk.get(Number(tabId)) !== false;
        return Promise.resolve(ok ? { ok: true, ts: Date.now() } : null);
      }
      return Promise.resolve(null);
    },
    onRemoved: noopListener,
    onUpdated: noopListener
  },
  scripting: { executeScript: () => Promise.resolve([{ result: 1 }]) },
  windows: {
    update: () => Promise.resolve({}),
    getLastFocused: () => Promise.resolve({ id: focusedWindowId })
  },
  alarms: { create: () => {}, onAlarm: noopListener },
  downloads: { onChanged: noopListener, onDeterminingFilename: noopListener }
};

global.chrome = chrome;
global.self = global;
global.window = global;

const realSetInterval = global.setInterval;
global.setInterval = () => 1;
global.clearInterval = () => {};

/* ---------- 加载真实后台模块 ---------- */
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
  focusedWindowId = 1;
  createCount = 0;
  pingsOk = true;
  wakeOk.clear();
  sentMessages.length = 0;
  await store.withLock(async () => {
    store.S.loaded = false;
    store.S.batches.clear();
    store.S.items.clear();
    store.S.logs = [];
    store.S.runtime = null;
    store.S.cfg = null;
    await store.load();
  });
  if (sched.reset) sched.reset();
};

const newBatch = async (name, count) => {
  const r = await orch.createBatch(name);
  for (let i = 0; i < (count || 1); i++) await orch.addItem(r.batch.id, `提示词 ${i + 1}`);
  return r.batch.id;
};

const markRunning = (bid, ageMs) => store.withLock(async () => {
  const b = store.getBatch(bid);
  b.status = G.RUNNING;
  b.startedAt = Date.now() - (ageMs || 0);
  b.lastClaimAt = 0;
  await store.putBatch(b);
});

const bindOnly = (bid, tabId, extra) => store.withLock(() => store.setRuntime({
  activeTabs: {
    [tabId]: Object.assign({ batchId: bid, state: 'idle', stale: false, at: Date.now() - 60000 }, extra || {})
  }
}));

const logsText = () => store.getLogs().map((l) => l.message).join('\n');

(async () => {
  let passed = 0;
  const ok = (msg) => {
    passed += 1;
    console.log('  ✓ ' + msg);
  };

  /* A：僵尸执行页超时 → 当前页接管，旧绑定清除 */
  await reset();
  const zombieA = addTab('https://chatgpt.com/', false);
  const hereA = addTab('https://chatgpt.com/', true);
  const bidA = await newBatch('操作系统第12', 2);
  await markRunning(bidA, 30000);
  await bindOnly(bidA, zombieA.id);
  const grantA = await orch.claim(hereA.id, 'conv-a');
  assert.strictEqual(grantA.ok, true, '执行页 30 秒没来领任务，当前页必须能自动接管');
  assert.strictEqual(store.getRuntime().activeTabs[hereA.id].batchId, bidA);
  assert.ok(!store.getRuntime().activeTabs[zombieA.id], '旧僵尸绑定必须清掉，否则会变成两个执行页');
  assert.match(logsText(), /没来领任务.*接管/);
  ok('A: 僵尸执行页超时后由当前标签页自动接管');

  /* B：刚点开始不久，不抢执行权 */
  await reset();
  const zombieB = addTab('https://chatgpt.com/', false);
  const hereB = addTab('https://chatgpt.com/', true);
  const bidB = await newBatch('刚开始', 1);
  await markRunning(bidB, 1000);
  await bindOnly(bidB, zombieB.id);
  const grantB = await orch.claim(hereB.id, 'conv-b');
  assert.strictEqual(grantB.ok, false);
  assert.strictEqual(grantB.reason, 'no-batch');
  assert.strictEqual(store.getRuntime().activeTabs[zombieB.id].batchId, bidB, '正常间隔内不能换执行页');
  ok('B: 未超过正常间隔时不抢执行权');

  /* C：有任务正在生成 → 超时也绝不接管（防重复生图） */
  await reset();
  const zombieC = addTab('https://chatgpt.com/', false);
  const hereC = addTab('https://chatgpt.com/', true);
  const bidC = await newBatch('生成中', 2);
  await markRunning(bidC, 60000);
  await store.withLock(async () => {
    const it = store.getItem(bidC, 0);
    it.status = S.GENERATING;
    await store.putItem(bidC, it);
  });
  await bindOnly(bidC, zombieC.id);
  const grantC = await orch.claim(hereC.id, 'conv-c');
  assert.strictEqual(grantC.ok, false, '有 ACTIVE 任务时不能换执行页');
  assert.strictEqual(grantC.reason, 'no-batch');
  ok('C: 有任务在生成时不接管，避免重复生图');

  /* D：多个批次同时跑 → 仍不擅自补绑定 */
  await reset();
  const zombieD = addTab('https://chatgpt.com/', false);
  const hereD = addTab('https://chatgpt.com/', true);
  const d1 = await newBatch('批次一', 1);
  const d2 = await newBatch('批次二', 1);
  await markRunning(d1, 60000);
  await markRunning(d2, 60000);
  await bindOnly(d1, zombieD.id);
  const grantD = await orch.claim(hereD.id, 'conv-d');
  assert.strictEqual(grantD.reason, 'no-batch');
  ok('D: 多个批次运行时不擅自补绑定');

  /* E：原有 stale 补绑定逻辑仍然生效（不用等超时） */
  await reset();
  const staleE = addTab('https://chatgpt.com/', false);
  const hereE = addTab('https://chatgpt.com/', true);
  const bidE = await newBatch('stale 批次', 1);
  await markRunning(bidE, 1000);
  await bindOnly(bidE, staleE.id, { stale: true });
  const grantE = await orch.claim(hereE.id, 'conv-e');
  assert.strictEqual(grantE.ok, true, 'stale 绑定应立即放行');
  ok('E: 已标记失联的绑定仍立即补绑定');

  /* F：接管后旧执行页再来领任务，绝不会被派发第二条 */
  await reset();
  const zombieF = addTab('https://chatgpt.com/', false);
  const hereF = addTab('https://chatgpt.com/', true);
  const bidF = await newBatch('不并发', 2);
  await markRunning(bidF, 30000);
  await bindOnly(bidF, zombieF.id);
  const firstF = await orch.claim(hereF.id, 'conv-f1');
  assert.strictEqual(firstF.ok, true);
  const lateF = await orch.claim(zombieF.id, 'conv-f2');
  assert.strictEqual(lateF.ok, false, '旧执行页不能又领到一条任务');
  assert.strictEqual(store.getItem(bidF, 1).status, S.PENDING, '第二条必须还在队列里');
  ok('F: 接管后旧执行页不会造成两个页面并行生图');

  /* G：start 优先选用户当前激活的 ChatGPT 标签页，并清掉遗留绑定 */
  await reset();
  const oldG = addTab('https://chatgpt.com/', false);
  const hereG = addTab('https://chatgpt.com/', true);
  const bidG = await newBatch('当前页优先', 1);
  await bindOnly(bidG, oldG.id);
  const startG = await orch.start(bidG);
  assert.strictEqual(startG.ok, true);
  assert.strictEqual(createCount, 0, '绝不新开标签页');
  assert.strictEqual(store.getRuntime().activeTabs[hereG.id].batchId, bidG, '应绑定当前激活页');
  assert.ok(!store.getRuntime().activeTabs[oldG.id], '遗留的后台绑定应被清掉');
  assert.match(logsText(), new RegExp(`已接管标签页：${hereG.id}`));
  ok('G: 开始优先绑定当前激活页，清理遗留绑定');

  /* H：WAKE 送不到 → 标失联，随后其它标签页可立即接管 */
  await reset();
  const zombieH = addTab('https://chatgpt.com/', false);
  const hereH = addTab('https://chatgpt.com/', true);
  const bidH = await newBatch('唤醒失败', 1);
  await markRunning(bidH, 60000);
  await bindOnly(bidH, zombieH.id);
  wakeOk.set(zombieH.id, false);
  await global.wakeTick();
  assert.strictEqual(store.getRuntime().activeTabs[zombieH.id].stale, true, '唤醒失败应立即标记失联');
  assert.match(logsText(), /没有响应唤醒/);
  wakeOk.delete(zombieH.id);
  const grantH = await orch.claim(hereH.id, 'conv-h');
  assert.strictEqual(grantH.ok, true, '标记失联后其它标签页应立即接管');
  ok('H: WAKE 无响应时标失联并立即放行接管');

  /* I：定时扫描 ping 通后要清掉 stale，别让标签页永久失联 */
  await reset();
  const tabI = addTab('https://chatgpt.com/', true);
  const bidI = await newBatch('恢复 stale', 1);
  await markRunning(bidI, 1000);
  await bindOnly(bidI, tabI.id, { stale: true });
  await sched.scan();
  assert.strictEqual(store.getRuntime().activeTabs[tabI.id].stale, false, 'ping 通后应恢复');
  ok('I: 定时扫描 ping 成功时清除 stale');

  /* J：立即修复指定批次时把当前页纳为执行页，并清掉僵尸绑定 */
  await reset();
  const zombieJ = addTab('https://chatgpt.com/', false);
  const hereJ = addTab('https://chatgpt.com/', true);
  const bidJ = await newBatch('立即修复', 1);
  await markRunning(bidJ, 30000);
  await bindOnly(bidJ, zombieJ.id);
  const fixJ = await global.handleCommand({ cmd: CGR.CMD.FIX_TABS, payload: { batchId: bidJ } });
  assert.strictEqual(fixJ.ok, true);
  assert.ok(fixJ.fixed.includes(hereJ.id), '修复应落到用户当前看的标签页');
  assert.strictEqual(store.getRuntime().activeTabs[hereJ.id].batchId, bidJ);
  assert.ok(!store.getRuntime().activeTabs[zombieJ.id], '僵尸绑定应被清掉');
  ok('J: 立即修复改用当前页并清掉僵尸绑定');

  console.log(`\nALL PASS — 僵尸执行页回归通过（${passed} 组）`);
  global.setInterval = realSetInterval;
  process.exit(0);
})().catch((e) => {
  global.setInterval = realSetInterval;
  console.error('FAIL:', e && e.stack);
  process.exit(1);
});
