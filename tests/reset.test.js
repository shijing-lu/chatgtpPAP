/* 一键重置回归测试（零依赖）：node tests/reset.test.js
 *
 * 覆盖：
 *  - runtime 重置把批次/任务/租约/标签页绑定/失败计数清干净，但绝不动提示词、前提、目录、设置
 *  - 已完成的图不重跑；进行中 / 待确认 / 失败的任务 attempt 清零后可再次领取
 *  - 重置会中止页面里正在跑的循环，且绝不新开标签页
 *  - 重置后迟到的旧上报不会把状态改回去、不会重复下载
 *  - factory 重置清空全部数据、恢复默认设置并重建空批次
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
let createCount = 0;
let downloadCount = 0;
const sentMessages = [];

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
      if (['PING', 'WAKE', 'EVALUATE'].includes(msg.type)) return Promise.resolve({ ok: true, ts: Date.now() });
      return Promise.resolve(null);
    },
    onRemoved: noopListener,
    onUpdated: noopListener
  },
  scripting: { executeScript: () => Promise.resolve([{ result: 1 }]) },
  windows: { update: () => Promise.resolve({}) },
  alarms: { create: () => {}, onAlarm: noopListener },
  downloads: {
    onChanged: noopListener,
    download: () => {
      downloadCount += 1;
      return Promise.resolve(999);
    }
  }
};

global.chrome = chrome;
global.self = global;
global.window = global;

// service worker 的 5 秒唤醒 ticker 不真正起，否则测试进程不会退出
global.setInterval = () => 0;
global.clearInterval = () => {};

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

const fresh = async () => {
  mem = {};
  tabsMap = new Map();
  tabSeq += 100;
  createCount = 0;
  downloadCount = 0;
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
};

(async () => {
  /* 常量与导出必须齐全，否则界面按钮会打到 unknown-command */
  assert.strictEqual(CGR.CMD.RESET, 'RESET');
  assert.strictEqual(CGR.RESET_SCOPE.RUNTIME, 'runtime');
  assert.strictEqual(CGR.RESET_SCOPE.FACTORY, 'factory');
  assert.strictEqual(typeof orch.reset, 'function');
  assert.strictEqual(typeof store.factoryReset, 'function');
  assert.strictEqual(typeof sched.reset, 'function');
  console.log('PASS 0: RESET 命令、两种范围与后台导出齐全');

  /* A：runtime 重置清运行态，但完整保留用户数据 */
  await fresh();
  const tabA = addTab('https://chatgpt.com/', true);
  const b1 = (await orch.createBatch('查找')).batch.id;
  for (const t of ['提示词 A1', '提示词 A2', '提示词 A3', '提示词 A4']) await orch.addItem(b1, t);
  const b2 = (await orch.createBatch('养老金漫画')).batch.id;
  await orch.addItem(b2, '提示词 B1');
  await orch.addItem(b2, '提示词 B2');
  await orch.updateBatch(b1, { premises: ['前提一', '前提二'], folder: '查找目录' });
  await store.withLock(() => store.setCfg({ folder: 'my-base', maxAttempts: 5 }));

  await store.withLock(async () => {
    const items = store.getItems(b1);
    const now = Date.now();
    items[0].status = S.GENERATING;
    items[0].attempt = 2;
    items[0].lease = { token: 'tok-old', tabId: tabA.id, expiresAt: now + 60000 };
    items[0].tabId = tabA.id;
    items[0].error = { code: 'TIMEOUT' };
    items[0].chatPrepared = true;
    items[0].lastOutcomeToken = 'tok-out';
    items[0].image = { src: 'https://x/a.png' };
    items[0].download = { state: 'pending' };
    items[1].status = S.NEEDS_REVIEW;
    items[1].attempt = 2;
    items[1].error = { code: 'NO_IMAGE' };
    items[2].status = S.FAILED;
    items[2].attempt = 3;
    items[3].status = S.DONE;
    items[3].filename = 'done.png';
    for (const it of items) await store.putItem(b1, it);

    for (const [id, status] of [[b1, G.ERROR], [b2, G.PAUSED]]) {
      const b = store.getBatch(id);
      b.status = status;
      b.startedAt = now - 60000;
      b.lastClaimAt = now - 30000;
      b.limitUntil = now + 60000;
      b.lastError = '前提设定发送失败';
      b.windowId = 7;
      b.premiseFailStreak = 2;
      await store.putBatch(b);
    }
    await store.setRuntime({
      selectedBatchId: b1,
      activeTabs: {
        [tabA.id]: { batchId: b1, state: 'busy' },
        99999: { batchId: b2, state: 'idle', stale: true }
      }
    });
  });
  mem['dl:777'] = { index: 0, batchId: b1 };
  mem['img:ref-1'] = { createdAt: Date.now(), data: 'keep-me' };

  const resA = await orch.reset({ scope: CGR.RESET_SCOPE.RUNTIME });
  assert.strictEqual(resA.ok, true);
  assert.strictEqual(resA.batches, 2);
  assert.strictEqual(resA.items, 6);
  assert.strictEqual(resA.requeued, 3, '生成中 / 待确认 / 失败三条应退回待生成');
  assert.strictEqual(resA.tabsCleared, 2);
  assert.strictEqual(createCount, 0, '重置绝不新开标签页');
  assert.ok(sentMessages.some((m) => m.type === 'ABORT'), '应先中止页面里正在跑的循环');

  for (const id of [b1, b2]) {
    const b = store.getBatch(id);
    assert.strictEqual(b.status, G.IDLE, '所有批次回到空闲');
    assert.strictEqual(b.startedAt, 0);
    assert.strictEqual(b.lastClaimAt, 0);
    assert.strictEqual(b.limitUntil, 0);
    assert.strictEqual(b.lastError, null);
    assert.strictEqual(b.windowId, null);
    assert.strictEqual(b.premiseFailStreak, 0, '连续前提失败计数必须清零');
  }
  assert.deepStrictEqual(store.getRuntime().activeTabs, {}, '僵尸标签页绑定必须清空');
  assert.strictEqual(store.getRuntime().selectedBatchId, b1, '当前选中的批次保持不变');

  const after = store.getItems(b1);
  assert.deepStrictEqual(after.map((i) => i.prompt), ['提示词 A1', '提示词 A2', '提示词 A3', '提示词 A4']);
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(after[i].status, S.PENDING);
    assert.strictEqual(after[i].attempt, 0, 'attempt 不清零，重置后仍会被重试上限拦住');
    assert.strictEqual(after[i].lease, null);
    assert.strictEqual(after[i].error, null);
    assert.strictEqual(after[i].chatPrepared, false, '重新跑时前提要重新发');
    assert.strictEqual(after[i].lastOutcomeToken, null);
  }
  assert.strictEqual(after[3].status, S.DONE, '已完成的图不重跑');
  assert.strictEqual(after[3].filename, 'done.png');
  assert.deepStrictEqual(store.getBatch(b1).premises, ['前提一', '前提二']);
  assert.strictEqual(store.getBatch(b1).folder, '查找目录');
  assert.strictEqual(store.getCfg().folder, 'my-base');
  assert.strictEqual(store.getCfg().maxAttempts, 5);
  assert.ok(!('dl:777' in mem), '旧的下载索引必须清掉');
  assert.ok('img:ref-1' in mem, '参考图不能被重置误删');
  console.log('PASS A: 运行态清干净、提示词/前提/目录/设置/参考图全部保留');

  /* B：重置后迟到的旧上报不改状态、不重复下载 */
  const lateAbort = await orch.handleOutcome({ leaseToken: 'tok-old', status: 'ABORTED', data: {} }, tabA.id);
  assert.strictEqual(lateAbort.ok, true, '重置后的 ABORTED 残留应直接确认，避免前端刷屏重试');
  const lateImage = await orch.handleOutcome(
    { leaseToken: 'tok-old', status: 'IMAGE_READY', data: { images: [{ src: 'https://x/late.png' }] } },
    tabA.id
  );
  assert.strictEqual(lateImage.ok, false);
  assert.strictEqual(store.getItem(b1, 0).status, S.PENDING);
  assert.strictEqual(downloadCount, 0, '旧上报不得触发重复下载');
  console.log('PASS B: 迟到的旧租约上报不会污染状态或重复下载');

  /* C：重置后直接点「开始」即可跑，且复用现有标签页 */
  const started = await orch.start(b1);
  assert.strictEqual(started.ok, true, '重置后应当能立即开始');
  assert.strictEqual(createCount, 0, '开始也不新开标签页');
  assert.strictEqual(store.getBatch(b1).status, G.RUNNING);
  const granted = await orch.claim(tabA.id, 'conv-1');
  assert.strictEqual(granted.ok, true, 'attempt 清零后任务能再次被领取');
  assert.strictEqual(granted.item.index, 0);
  console.log('PASS C: 重置后可立即开始并领取第一条，无需重建批次');

  /* D：factory 清掉全部数据、恢复默认设置、重建空批次 */
  const resD = await orch.reset({ scope: CGR.RESET_SCOPE.FACTORY });
  assert.strictEqual(resD.ok, true);
  assert.strictEqual(resD.deletedBatches, 2);
  const list = store.listBatches();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, '批次 1');
  assert.strictEqual(store.getItems(list[0].id).length, 0);
  assert.strictEqual(store.getCfg().folder, CGR.DEFAULTS.folder);
  assert.strictEqual(store.getCfg().onNoImage, CGR.DEFAULTS.onNoImage);
  assert.strictEqual(store.getRuntime().selectedBatchId, list[0].id);
  assert.deepStrictEqual(store.getRuntime().activeTabs, {});
  assert.strictEqual(store.getLogs().length, 1, '日志随出厂设置一起清空，只留重置记录');
  const keys = Object.keys(mem);
  assert.ok(!keys.some((k) => k.startsWith('item:') || k.startsWith('dl:') || k.startsWith('img:')), '旧条目/下载索引/参考图全部删除');
  assert.ok(!keys.some((k) => k.startsWith('batch:') && k !== `batch:${list[0].id}`), '旧批次记录全部删除');
  console.log('PASS D: 清空全部数据后只剩一个空批次与默认设置');

  /* E：没有任何批次时重置也安全 */
  await fresh();
  const resE = await orch.reset({ scope: CGR.RESET_SCOPE.RUNTIME });
  assert.strictEqual(resE.ok, true);
  assert.strictEqual(resE.batches, 0);
  assert.strictEqual(createCount, 0);
  console.log('PASS E: 空数据下重置不报错');

  console.log('\nALL PASS — 一键重置回归通过');
})().catch((e) => {
  console.error('FAIL', e);
  process.exitCode = 1;
});
