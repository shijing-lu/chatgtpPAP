/* 主循环停摆 / 页面脱节回归（零依赖）：node tests/loop-stall.test.js
 *
 * 复现两条用户反馈：
 *   「跑着跑着会自己断开，没有给聊天框发提示词了」
 *   「手机已经显示生成成功了，电脑不显示」
 *
 * 根因链：
 *  1) content.js 的 chrome.runtime.sendMessage 没有超时兜底。MV3 在 SW 回收/冷启动窗口里
 *     一条消息回调可能永远不回来，单个 await send() 就把主循环永久挂起，还不留异常日志。
 *  2) 页面 onMessage 监听器仍活着（PING 回 ok），心跳定时器仍替一条没人执行的任务续租，
 *     于是 wakeTick / 定时扫描 / claim 全被「有任务在跑」挡住 —— 批次显示运行中却不再发提示词。
 *  3) 页面 SSE/渲染与服务端脱节时服务端其实已出图，只能提前收敛成 PAGE_STALE，
 *     标「待确认、绝不重发」，让队列继续下一条，而不是把整批拖到 5 分钟总超时。
 *
 * 覆盖：
 *  A1 消息永不回调时主循环仍继续派发
 *  A2 PING 会带回 loop 活性，健康页面不误判
 *  A3 主循环卡在空闲等待时 PING 能报 stalled（后台才有得救）
 *  B1 force 重注入清 __CGR_LOADED__ 并递增实例代次（旧实例必须闭嘴）
 *  B2 scan 遇停摆页：回收租约（已出图转待确认）+ 强制重注入 + 明确日志 + 不再续租
 *  B3 scan 遇健康页：正常续租、不重注入
 *  B4 handleOutcome(PAGE_STALE)：标待确认、attempt 不变、绝不重发提示词
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const realSetInterval = global.setInterval;
const wait = (ms) => new Promise((r) => realSetTimeout(r, ms));

function newEnv(extra) {
  const sb = Object.assign(
    {
      console,
      setTimeout: realSetTimeout,
      clearTimeout: realClearTimeout,
      setInterval: realSetInterval,
      clearInterval: () => {},
      setImmediate,
      Date,
      Math,
      JSON,
      Promise,
      String,
      Number,
      Object,
      Array,
      Map,
      Set,
      RegExp,
      Error
    },
    extra || {}
  );
  sb.self = sb;
  sb.window = sb;
  vm.createContext(sb);
  sb.load = (f) => vm.runInContext(read(f), sb, { filename: f });
  return sb;
}

/* ---------------- A. 页面侧：消息超时与主循环活性 ---------------- */

async function pageSide() {
  const sent = [];
  const listeners = [];
  const sb = newEnv({
    location: {
      href: 'https://chatgpt.com/c/conv-1',
      hostname: 'chatgpt.com',
      pathname: '/c/conv-1'
    },
    // 模拟后台标签页定时器被节流：长延时 timer 永远不触发
    setTimeout: (fn, ms) => (ms >= 1000 ? 0 : realSetTimeout(fn, ms)),
    clearTimeout: (t) => realClearTimeout(t),
    setInterval: () => 1,
    clearInterval: () => {},
    chrome: {
      runtime: {
        lastError: null,
        // 关键：永不调用回调，复现 SW 回收窗口里的丢消息
        sendMessage: (msg) => void sent.push(msg),
        onMessage: { addListener: (fn) => listeners.push(fn) }
      }
    }
  });

  sb.load('src/shared/constants.js');
  sb.load('src/shared/sched.js');
  const C = sb.CGR;
  C.isChatSite = () => true;
  C.getConvId = () => 'conv-1';
  C.currentSiteLabel = () => 'ChatGPT';
  C.currentSiteId = () => 'chatgpt';
  C.getMain = () => ({});
  C.pick = () => null;
  C.pickAll = () => [];
  C.SEL = {};
  C.LIMITS.msgTimeoutMs = 10;
  C.LIMITS.idlePollMs = 5000;
  C.LIMITS.idleMaxPollMs = 5000;
  C.LIMITS.loopStallMs = 90000;
  C.DEFAULTS.minDelayMs = 5000;
  C.DEFAULTS.maxDelayMs = 5000;

  sb.CGR_PROBE = { snapshot: () => ({}), hasLoginWall: () => false };
  sb.CGR_COMPOSER = { getComposer: () => ({}), attachmentSrcs: () => [] };
  sb.CGR_WATCH = { waitForOutcome: () => Promise.resolve({ status: 'NO_IMAGE' }), triggerEvaluate: () => {} };
  sb.CGR_SELFCHECK = { run: () => Promise.resolve({}) };
  sb.CGR_PREMISE = { apply: () => Promise.resolve({ ok: true }) };

  sb.load('src/content/content.js');

  const ping = () => {
    let res = null;
    for (const fn of listeners) fn({ type: C.MSG.PING }, {}, (r) => {
      if (r) res = r;
    });
    return res;
  };

  await wait(600);
  const leases = sent.filter((m) => m.type === C.MSG.LEASE_REQUEST).length;
  assert.ok(leases >= 2, `消息永不回调也必须继续派发，实际只发了 ${leases} 次 LEASE_REQUEST`);
  console.log('PASS A1: chrome.runtime.sendMessage 永不回调时主循环仍持续派发（超时兜底生效）');

  let p = ping();
  assert.ok(p && p.loop, 'PING 响应必须带回 loop 活性');
  assert.strictEqual(p.loop.alive, true, '主循环正在跑时 alive=true');
  assert.strictEqual(p.loop.stalled, false, '刚推进过的健康页面不能被误判为停摆');
  console.log('PASS A2: PING 带回 loop 活性，健康页面不误判');

  // 把停摆阈值压到 30ms，模拟主循环卡在空闲等待很久没推进
  C.LIMITS.loopStallMs = 30;
  await wait(120);
  p = ping();
  assert.strictEqual(p.loop.alive, true, '监听器仍活着 —— 这正是旧版会漏判的「假活」');
  assert.strictEqual(p.loop.stalled, true, '主循环没推进时必须报 stalled');
  assert.strictEqual(p.loop.phase, 'idle', '停摆发生在空闲派发阶段');
  console.log('PASS A3: 监听器活着但主循环停摆时，PING 能如实上报 stalled');
}

/* ---------------- B. 后台侧：识别假活页面并强制重注入 ---------------- */

async function backgroundSide() {
  const noop = { addListener: () => {} };
  const tabId = 101;
  let mem = {};
  let pingLoop = { alive: true, stalled: false, phase: 'idle', contextDead: false };
  let reinjects = 0;

  const sb = newEnv({
    setInterval: () => 1,
    clearInterval: () => {},
    chrome: {
      storage: {
        local: {
          get: (keys) => {
            if (keys == null) return Promise.resolve(Object.assign({}, mem));
            const out = {};
            const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
            for (const k of list) if (k in mem) out[k] = mem[k];
            return Promise.resolve(out);
          },
          set: (obj) => (Object.assign(mem, obj), Promise.resolve()),
          remove: (keys) => ((Array.isArray(keys) ? keys : [keys]).forEach((k) => delete mem[k]), Promise.resolve()),
          clear: () => ((mem = {}), Promise.resolve())
        },
        onChanged: noop
      },
      runtime: {
        getManifest: () => ({ version: '0.6.1', content_scripts: [{ js: ['content.js'] }] }),
        sendMessage: () => Promise.resolve({ ok: true }),
        lastError: null,
        onInstalled: noop,
        onStartup: noop,
        onMessage: noop
      },
      action: { onClicked: noop },
      sidePanel: { setPanelBehavior: () => Promise.resolve(), open: () => Promise.resolve() },
      tabs: {
        query: () => Promise.resolve([{ id: tabId, url: 'https://chatgpt.com/c/conv-1', active: true, windowId: 1, discarded: false, status: 'complete' }]),
        get: (id) => Promise.resolve(Number(id) === tabId ? { id: tabId, url: 'https://chatgpt.com/c/conv-1', windowId: 1 } : null),
        create: () => Promise.resolve({ id: 999, windowId: 1 }),
        remove: () => Promise.resolve(),
        update: () => Promise.resolve({}),
        reload: () => Promise.resolve(),
        sendMessage: (id, msg) => {
          if (msg.type === 'PING') return Promise.resolve({ ok: true, ts: Date.now(), loop: pingLoop });
          if (msg.type === 'WAKE' || msg.type === 'EVALUATE') return Promise.resolve({ ok: true });
          return Promise.resolve(null);
        },
        onRemoved: noop,
        onUpdated: noop
      },
      scripting: {
        executeScript: (arg) => {
          if (arg && arg.func) vm.runInContext('(' + arg.func.toString() + ')()', sb);
          if (arg && arg.files) reinjects += 1;
          return Promise.resolve([{ result: 1 }]);
        }
      },
      windows: { update: () => Promise.resolve({}), getLastFocused: () => Promise.resolve({ id: 1 }) },
      alarms: { create: () => {}, onAlarm: noop },
      downloads: {
        onChanged: noop,
        onDeterminingFilename: noop,
        download: () => Promise.resolve(1),
        search: () => Promise.resolve([])
      }
    }
  });

  sb.importScripts = (...files) => {
    for (const f of files) {
      const rel = path.posix.normalize(path.posix.join('src/background', f));
      vm.runInContext(read(rel), sb, { filename: rel });
    }
  };
  vm.runInContext(read('src/background/service-worker.js'), sb, { filename: 'src/background/service-worker.js' });

  const C = sb.CGR;
  const store = sb.CGR_STORE;
  const orch = sb.CGR_ORCH;
  const sched = sb.CGR_SCHED;
  const tabs = sb.CGR_TABS;
  const S = C.STATUS;
  const G = C.GLOBAL;
  await store.load();

  const logsText = () => store.getLogs().map((l) => l.message).join('\n');

  const reset = async () => {
    mem = {};
    reinjects = 0;
    pingLoop = { alive: true, stalled: false, phase: 'idle', contextDead: false };
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

  const seed = async (status) => {
    const r = await orch.createBatch('停摆回归批次');
    const bid = r.batch.id;
    await orch.addItem(bid, '提示词 1');
    await store.withLock(async () => {
      const b = store.getBatch(bid);
      b.status = G.RUNNING;
      b.startedAt = Date.now() - 60000;
      b.lastClaimAt = Date.now() - 60000;
      await store.putBatch(b);
      const it = store.getItem(bid, 0);
      it.status = status;
      it.attempt = 0;
      it.lease = {
        token: 'tk-' + bid,
        tabId,
        batchId: bid,
        convId: '',
        acquiredAt: Date.now() - 60000,
        renewedAt: Date.now() - 60000,
        expiresAt: Date.now() + 90000
      };
      await store.putItem(bid, it);
      await store.setRuntime({ activeTabs: { [tabId]: { batchId: bid, state: 'busy', stale: false, at: Date.now() } } });
    });
    return bid;
  };

  /* B1: force 重注入必须让旧实例闭嘴 */
  await reset();
  sb.__CGR_LOADED__ = true;
  sb.__CGR_INSTANCE__ = 1;
  const okInject = await tabs.ensureContentScript(tabId, { force: true });
  assert.strictEqual(okInject, true, 'force 重注入应成功');
  assert.strictEqual(sb.__CGR_LOADED__, false, '必须清掉加载标记，否则新脚本会直接 return');
  assert.strictEqual(sb.__CGR_INSTANCE__, 2, '必须递增实例代次，否则旧 loop/心跳会和新实例一起领任务');
  assert.ok(reinjects >= 1, 'force 必须真的注入文件，不能被 ping 短路');
  console.log('PASS B1: 强制重注入清加载标记并递增实例代次');

  /* B2: PING 通但主循环停摆 —— 回收租约、强制重注入、不重发 */
  await reset();
  const bid2 = await seed(S.GENERATING);
  pingLoop = { alive: false, stalled: true, phase: 'dead', contextDead: true };
  await sched.scan();
  const it2 = store.getItem(bid2, 0);
  assert.strictEqual(it2.status, S.NEEDS_REVIEW, '已发出提示词、可能已出图，只能标待确认');
  assert.strictEqual(it2.lease, null, '停摆页的租约必须被回收，否则它会永远占着 active');
  assert.strictEqual(it2.attempt, 0, '绝不重发提示词：attempt 不该增加');
  assert.ok(reinjects >= 1, '停摆页必须强制重注入');
  assert.ok(logsText().includes('主循环停摆'), '日志要能直接定位到主循环停摆');
  console.log('PASS B2: 识别「PING 通但主循环死了」，回收租约 + 强制重注入 + 已出图不重发');

  /* B3: 健康页面不能被误伤 */
  await reset();
  const bid3 = await seed(S.GENERATING);
  const renewedBefore = store.getItem(bid3, 0).lease.renewedAt;
  await sched.scan();
  const it3 = store.getItem(bid3, 0);
  assert.ok(it3.lease, '健康页的租约应继续存在');
  assert.ok(it3.lease.renewedAt >= renewedBefore, '健康页应正常续租');
  assert.strictEqual(it3.status, S.GENERATING, '健康页任务状态不该被改动');
  assert.strictEqual(reinjects, 0, '健康页不该被重注入');
  console.log('PASS B3: 健康页面正常续租、不被重注入（无误伤）');

  /* B4: PAGE_STALE 只标待确认，绝不重发 */
  await reset();
  const bid4 = await seed(S.GENERATING);
  await orch.handleOutcome(
    {
      leaseToken: 'tk-' + bid4,
      status: 'PAGE_STALE',
      site: 'chatgpt',
      data: { site: 'chatgpt', phase: 'stuck-generating', diagnostic: {} }
    },
    tabId
  );
  const it4 = store.getItem(bid4, 0);
  assert.strictEqual(it4.status, S.NEEDS_REVIEW, 'PAGE_STALE 必须标待确认');
  assert.strictEqual(it4.error && it4.error.code, 'PAGE_STALE', '错误码要能区分「页面脱节」和「未出图」');
  assert.strictEqual(it4.attempt, 0, '绝不重发提示词');
  assert.ok(logsText().includes('绝不重发提示词'), '日志要明确提示刷新页面、不重发');
  console.log('PASS B4: 页面与服务端脱节时快速收敛为待确认，队列不被拖死');
}

(async () => {
  try {
    await pageSide();
    await backgroundSide();
    console.log('ALL PASS — 主循环停摆 / 页面脱节回归通过（7 组）');
  } catch (e) {
    console.error('FAIL:', e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();
