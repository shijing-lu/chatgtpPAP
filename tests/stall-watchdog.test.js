/* 单条任务停摆 / 队列「跑一半停了」回归（零依赖）：node tests/stall-watchdog.test.js
 *
 * 用户主诉「为什么经常执行到一半就不执行了」。定位到三条确定性原因：
 *  1) 页面心跳每 20 秒续一次租约 → sweepExpired 永远等不到过期；
 *     scan 的自愈看到 anyActive 直接跳过。一条卡死的任务就能把整批队列冻住，
 *     批次还显示「运行中」，却再也不发下一条。
 *  2) findClaimable 会静默跳过 attempt 已达上限的 PENDING 条目，状态却不改：
 *     maybeFinish 永远认为还有剩余，批次挂在运行中，页面只回「队列里没有可领的任务」。
 *  3) sendFailStreak 是全局计数且只在「成功出图」时清零：两次不相邻的发送失败
 *     （中间夹着几条成功任务）也会累计到 2，把整批误暂停。
 *
 * 用真实 store / lease / orchestrator / scheduler，只打桩 Chrome API。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const load = (f) => vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });

/* ---------- Chrome API 桩 ---------- */
let mem = {};
let tabSeq = 500;
let tabsMap = new Map();
const sentMessages = [];
const noopListener = { addListener: () => {} };

function addTab(url, active, windowId) {
  const id = ++tabSeq;
  const t = { id, url, active: !!active, windowId: windowId == null ? 1 : windowId, discarded: false, status: 'complete' };
  tabsMap.set(id, t);
  return t;
}

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
        } else {
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
    id: 'cgr-stall-test',
    getManifest: () => ({ version: '0.6.3', content_scripts: [{ js: ['content.js'] }] }),
    sendMessage: () => Promise.resolve({ ok: true }),
    lastError: null,
    onInstalled: noopListener,
    onStartup: noopListener,
    onMessage: noopListener
  },
  action: { onClicked: noopListener },
  sidePanel: { setPanelBehavior: () => Promise.resolve(), open: () => Promise.resolve() },
  tabs: {
    query: (q) => {
      let list = Array.from(tabsMap.values());
      if (q && q.url != null) list = list.filter((t) => /chatgpt\.com|chat\.openai\.com|gemini\.google\.com/.test(t.url || ''));
      if (q && q.active === true) list = list.filter((t) => t.active);
      return Promise.resolve(list);
    },
    get: (id) => Promise.resolve(tabsMap.get(Number(id)) || null),
    create: (opts) => Promise.resolve(addTab(opts.url || 'https://chatgpt.com/', opts.active, opts.windowId)),
    remove: (id) => {
      tabsMap.delete(Number(id));
      return Promise.resolve();
    },
    update: () => Promise.resolve({}),
    reload: () => Promise.resolve(),
    sendMessage: (tabId, msg) => {
      sentMessages.push({ tabId: Number(tabId), type: msg && msg.type });
      if (['PING', 'WAKE', 'EVALUATE'].includes(msg && msg.type)) {
        return Promise.resolve({ ok: true, ts: Date.now(), loop: { alive: true, phase: 'lease', stalled: false } });
      }
      return Promise.resolve({ ok: true });
    },
    onRemoved: noopListener,
    onUpdated: noopListener
  },
  scripting: { executeScript: () => Promise.resolve([{ result: 1 }]) },
  windows: { update: () => Promise.resolve({}), getLastFocused: () => Promise.resolve({ id: 1 }) },
  alarms: { create: () => {}, onAlarm: noopListener },
  downloads: { onChanged: noopListener, onDeterminingFilename: noopListener }
};

global.chrome = chrome;
global.self = global;
global.window = global;
global.setInterval = () => 1;
global.clearInterval = () => {};

global.importScripts = (...files) => {
  for (const f of files) load(path.join('src/background', f).replace(/\\/g, '/'));
};
load('src/background/service-worker.js');

const CGR = global.CGR;
const store = global.CGR_STORE;
const orch = global.CGR_ORCH;
const lease = global.CGR_LEASE;
const sched = global.CGR_SCHED;
const G = CGR.GLOBAL;
const S = CGR.STATUS;

const logsText = () => store.getLogs().map((l) => l.message).join('\n');

async function reset() {
  mem = {};
  tabsMap = new Map();
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
}

/** 建一个运行中的批次，n 条提示词；返回 batchId */
async function runningBatch(n) {
  const r = await orch.createBatch('停摆回归');
  for (let i = 0; i < n; i++) await orch.addItem(r.batch.id, `提示词 ${i + 1}`);
  await store.withLock(async () => {
    const b = store.getBatch(r.batch.id);
    b.status = G.RUNNING;
    b.startedAt = Date.now() - 3600000;
    b.lastPageAt = Date.now() - 3600000;
    b.lastClaimAt = Date.now() - 3600000;
    await store.putBatch(b);
  });
  return r.batch.id;
}

async function markItem(bid, index, patch) {
  await store.withLock(async () => {
    const it = store.getItem(bid, index);
    Object.assign(it, patch);
    await store.putItem(bid, it);
  });
}

const TOKEN = (n) => `tok-${n}`;

(async () => {
  let passed = 0;
  const ok = (m) => {
    passed += 1;
    console.log('  ✓ ' + m);
  };

  /* A: 生成中超时 → 待确认，且绝不重发（attempt 不变） */
  {
    await reset();
    const bid = await runningBatch(2);
    const old = Date.now() - 11 * 60000;
    await markItem(bid, 0, {
      status: S.GENERATING,
      attempt: 0,
      ts: { sentAt: old },
      lease: { token: TOKEN(1), tabId: 501, batchId: bid, acquiredAt: old, renewedAt: Date.now(), expiresAt: Date.now() + 90000 }
    });
    const touched = await store.withLock(() => lease.sweepStuck());
    const it = store.getItem(bid, 0);
    assert.strictEqual(touched.length, 1);
    assert.strictEqual(it.status, S.NEEDS_REVIEW);
    assert.strictEqual(it.attempt, 0, '已经发出去的提示词绝不能因为超时被重发');
    assert.strictEqual(it.lease, null);
    assert.match(it.error.code, /ITEM_STALLED/);
    assert.match(logsText(), /看门狗/);
    ok('A: 生成中超过时长上限 → 待确认，不重发');
  }

  /* B: 正常慢生成（1 分钟）不被误伤 */
  {
    await reset();
    const bid = await runningBatch(1);
    const recent = Date.now() - 60000;
    await markItem(bid, 0, {
      status: S.GENERATING,
      ts: { sentAt: recent },
      lease: { token: TOKEN(2), tabId: 501, batchId: bid, acquiredAt: recent, renewedAt: Date.now(), expiresAt: Date.now() + 90000 }
    });
    const touched = await store.withLock(() => lease.sweepStuck());
    assert.strictEqual(touched.length, 0);
    assert.strictEqual(store.getItem(bid, 0).status, S.GENERATING);
    ok('B: 正常慢生成不被看门狗误伤');
  }

  /* C: 还没发出去就卡住 → 退回队列重试 */
  {
    await reset();
    const bid = await runningBatch(2);
    const old = Date.now() - 11 * 60000;
    await markItem(bid, 0, {
      status: S.SENDING,
      attempt: 0,
      ts: {},
      lease: { token: TOKEN(3), tabId: 501, batchId: bid, acquiredAt: old, renewedAt: Date.now(), expiresAt: Date.now() + 90000 }
    });
    await store.withLock(() => lease.sweepStuck());
    const it = store.getItem(bid, 0);
    assert.strictEqual(it.status, S.PENDING);
    assert.strictEqual(it.attempt, 1);
    assert.strictEqual(it.lease, null);
    ok('C: 卡在发送阶段 → 退回队列并计数');
  }

  /* D: 重试次数用尽的发送中任务 → 待确认，不再占队列 */
  {
    await reset();
    const bid = await runningBatch(2);
    const old = Date.now() - 11 * 60000;
    await markItem(bid, 0, {
      status: S.CLAIMED,
      attempt: 2,
      ts: {},
      lease: { token: TOKEN(4), tabId: 501, batchId: bid, acquiredAt: old, renewedAt: Date.now(), expiresAt: Date.now() + 90000 }
    });
    await store.withLock(() => lease.sweepStuck());
    assert.strictEqual(store.getItem(bid, 0).status, S.NEEDS_REVIEW);
    ok('D: 重试已用尽的卡死任务转待确认');
  }

  /* E: attempt 达上限的 PENDING 不再静默躺着（否则批次永远「运行中」） */
  {
    await reset();
    const bid = await runningBatch(2);
    await markItem(bid, 0, { status: S.PENDING, attempt: 2, lease: null });
    await markItem(bid, 1, { status: S.DONE, attempt: 1, lease: null });
    const touched = await store.withLock(() => lease.normalizeExhausted());
    assert.strictEqual(touched.length, 1);
    assert.strictEqual(store.getItem(bid, 0).status, S.NEEDS_REVIEW);
    assert.strictEqual(store.getItem(bid, 0).error.code, 'RETRY_EXHAUSTED');
    await store.withLock(() => orch.maybeFinish(bid));
    assert.strictEqual(store.getBatch(bid).status, G.FINISHED, '没有可领任务时必须收尾，不能挂着运行中');
    ok('E: 重试耗尽的条目转待确认，批次能正常收尾');
  }

  /* F: 扫描里跑看门狗 → 收敛后立刻唤醒页面继续下一条 */
  {
    await reset();
    const bid = await runningBatch(2);
    const tab = addTab('https://chatgpt.com/c/abc', true);
    await store.setRuntime({ selectedBatchId: bid, activeTabs: { [tab.id]: { batchId: bid, state: 'busy', stale: false, at: Date.now() } } });
    const old = Date.now() - 11 * 60000;
    await markItem(bid, 0, {
      status: S.GENERATING,
      ts: { sentAt: old },
      lease: { token: TOKEN(5), tabId: tab.id, batchId: bid, acquiredAt: old, renewedAt: Date.now(), expiresAt: Date.now() + 90000 }
    });
    await sched.scan();
    assert.strictEqual(store.getItem(bid, 0).status, S.NEEDS_REVIEW);
    assert.ok(
      sentMessages.some((m) => m.type === CGR.MSG.WAKE && m.tabId === tab.id),
      '收敛后必须唤醒执行页，让队列接着跑'
    );
    assert.strictEqual(store.getBatch(bid).status, G.RUNNING, '还有待生成的任务，批次应保持运行');
    ok('F: 扫描收敛卡死任务后立即唤醒页面继续');
  }

  /* G: 成功后清掉连续发送失败计数，不相邻的两次失败不该暂停整批 */
  {
    await reset();
    const bid = await runningBatch(2);

    // 第 1 次发送失败：streak=1
    let t0 = '';
    await store.withLock(async () => {
      const it = await lease.grant(bid, 501, '');
      t0 = it.lease.token;
    });
    await orch.handleOutcome({ leaseToken: t0, status: 'SEND_FAILED', data: { code: 'send-button-missing' } }, 501);
    assert.strictEqual(store.getBatch(bid).status, G.RUNNING, '第一次失败不该暂停');

    // 中间有一条真的发出去了 → streak 必须清零
    await store.withLock(async () => {
      const it = await lease.grant(bid, 501, '');
      global.__sentToken = it.lease.token;
    });
    await orch.markProgress(501, global.__sentToken, 'sent');

    // 再一次发送失败：如果没清零，这里就是第 2 次 → 整批暂停
    let t2 = '';
    await store.withLock(async () => {
      const it = store.getItem(bid, 0);
      it.lease = { token: TOKEN(9), tabId: 501, batchId: bid, acquiredAt: Date.now(), renewedAt: Date.now(), expiresAt: Date.now() + 90000 };
      await store.putItem(bid, it);
      t2 = TOKEN(9);
    });
    await orch.handleOutcome({ leaseToken: t2, status: 'SEND_FAILED', data: { code: 'send-button-missing' } }, 501);
    assert.strictEqual(store.getBatch(bid).status, G.RUNNING, '中间有成功发送时，不应累计成连续失败而暂停整批');
    ok('G: 成功发送会清空连续失败计数，不再误暂停');
  }

  console.log(`\nALL PASS — 任务停摆看门狗回归通过（${passed} 组）`);
})().catch((e) => {
  console.error('FAIL:', e && e.message);
  console.error(e && e.stack);
  process.exit(1);
});
