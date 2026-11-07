/* 下载命名与目录回归（零依赖）：node tests/download-filename.test.js
 *
 * 锁死的 bug：只要扩展注册了 chrome.downloads.onDeterminingFilename，
 * Chrome 就会忽略 downloads.download({filename})（Chromium issue 579563）。
 * 旧监听器遇到 byExtensionId 又直接裸调 suggest()，于是所有直链 / data URL
 * 下载都变成默认「下载.png」落在下载根目录，批次子目录和命名模板全部失效。
 *
 * 用真实 store / slug / downloads，只打桩 Chrome API：
 *  - A/B/C 三级下载都必须先登记「下载意图」，再由监听器 suggest 目标路径
 *  - 自己发起的下载也要改名；别的扩展 / 无关下载不干预
 *  - SW 冷启动（内存表清空）时能从 storage 恢复，异步 suggest 只调一次
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
let failDownload = false;
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
    getManifest: () => ({ version: '0.5.2' }),
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
      if (failDownload) return Promise.reject(new Error('api-error'));
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

const tick = () => new Promise((r) => setImmediate(r));

async function reset(opts) {
  const o = opts || {};
  mem = {};
  dlSeq = 900;
  failDownload = false;
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
  if (o.folder !== undefined || o.template) {
    await store.setCfg({
      folder: 'chatgpt-images',
      template: o.template || '{index:03}_{slug}'
    });
  }
  const b = await store.createBatch('操作系统第12');
  b.folder = o.folder === undefined ? CGR.normalizeFolder('操作系统第12', '') : o.folder;
  await store.putBatch(b);
  const item = {
    index: o.index == null ? 0 : o.index,
    batchId: b.id,
    prompt: o.prompt || '画一张静态链表对比图',
    status: S.PENDING,
    attempt: 0,
    lease: null,
    tabId: 1,
    image: null,
    download: null,
    error: null,
    filename: '',
    ts: {}
  };
  await store.putItem(b.id, item);
  return { bid: b.id, item };
}

function capture() {
  const rec = { calls: 0, value: undefined };
  const fn = (v) => {
    rec.calls += 1;
    rec.value = v;
  };
  return { rec, fn };
}

(async () => {
  /* A: buildPath 用批次子目录 + 命名模板，不是默认「下载.png」 */
  let ctx = await reset();
  const expected = '操作系统第12/001_画一张静态链表对比图.png';
  assert.strictEqual(dl.buildPath(ctx.item, 'png'), expected);
  console.log('PASS A: 目标路径 = 批次子目录 / 模板名.png');

  /* B: 直链下载前先登记意图，且 download() 仍带上 filename（双保险） */
  await dl.startUrlDownload(ctx.item, 'https://files.oaiusercontent.com/abc.png', 'png');
  assert.strictEqual(downloadCalls.length, 1);
  assert.strictEqual(downloadCalls[0].opts.filename, expected, 'download() 也要带目标路径');
  assert.ok(Array.isArray(mem['dl:intents']) && mem['dl:intents'].length === 1, '应登记下载意图');
  assert.strictEqual(mem['dl:intents'][0].filename, expected);
  console.log('PASS B: 直链下载预登记目标路径（内存 + storage）');

  /* C: 自己发起的下载也必须 suggest 目标文件名 —— 旧版在这里裸调 suggest() */
  let cap = capture();
  const syncReturn = dl.onDeterminingFilename(
    { id: 901, byExtensionId: EXT_ID, url: 'https://files.oaiusercontent.com/abc.png' },
    cap.fn
  );
  assert.strictEqual(syncReturn, false, '内存命中时必须同步调用 suggest');
  assert.strictEqual(cap.rec.calls, 1, 'suggest 只能调一次');
  assert.ok(cap.rec.value && cap.rec.value.filename === expected, '必须改回批次目录/模板名');
  assert.strictEqual(cap.rec.value.conflictAction, 'uniquify');
  assert.ok(mem['dl:901'], '下载 id 必须登记到任务');
  assert.ok(!mem['dl:intents'], '意图用掉后应清除，避免劫持下一次下载');
  console.log('PASS C: 扩展自己发起的下载被正确改名并归位（核心修复）');

  /* D: 归位后下载完成仍能把任务推进为已完成 */
  await store.withLock(() => dl.handleChanged({ id: 901, state: { current: 'complete' } }));
  assert.strictEqual(store.getItem(ctx.bid, 0).status, S.DONE);
  assert.strictEqual(store.getItem(ctx.bid, 0).filename, expected);
  console.log('PASS D: 下载完成事件仍正确推进为已完成');

  /* E: data URL（页面内取流）同样不能变成「下载.png」 */
  ctx = await reset();
  const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  await dl.startDataDownload(ctx.item, dataUrl, 'png');
  cap = capture();
  dl.onDeterminingFilename({ id: 902, byExtensionId: EXT_ID, url: dataUrl }, cap.fn);
  assert.ok(cap.rec.value && cap.rec.value.filename === expected, 'data URL 也要归位');
  console.log('PASS E: 页面内取流得到的 data URL 下载同样正确命名');

  /* F: 别的扩展发起的下载不干预 */
  cap = capture();
  dl.onDeterminingFilename({ id: 903, byExtensionId: 'some-other-extension' }, cap.fn);
  assert.strictEqual(cap.rec.calls, 1);
  assert.strictEqual(cap.rec.value, undefined, '不能抢别的扩展的文件名');
  console.log('PASS F: 其它扩展的下载不干预');

  /* G: 无关的用户下载不被待办意图劫持 */
  ctx = await reset();
  dl.clearCache(true);
  dl.restore();
  await tick();
  cap = capture();
  const ret = dl.onDeterminingFilename({ id: 904, byExtensionId: undefined, url: 'https://example.com/a.pdf' }, cap.fn);
  assert.strictEqual(ret, false, '已确认 storage 为空时应同步放行');
  assert.strictEqual(cap.rec.calls, 1);
  assert.strictEqual(cap.rec.value, undefined);
  console.log('PASS G: 无关下载不被劫持');

  /* H: SW 冷启动后调用 boot() 的 restore()，内存表恢复、仍是同步 suggest */
  ctx = await reset();
  await dl.startUrlDownload(ctx.item, 'https://files.oaiusercontent.com/abc.png', 'png');
  dl.clearCache(true); // 模拟 SW 被回收：内存全丢，storage 还在
  await dl.restore();
  cap = capture();
  assert.strictEqual(dl.onDeterminingFilename({ id: 905, byExtensionId: EXT_ID }, cap.fn), false);
  assert.ok(cap.rec.value && cap.rec.value.filename === expected, '恢复后仍同步改名');
  console.log('PASS H: SW 冷启动后 restore() 能恢复目标路径');

  /* I: 连 restore() 都来不及（SW 被下载事件唤醒）→ 异步从 storage 读，只 suggest 一次 */
  ctx = await reset();
  await dl.startUrlDownload(ctx.item, 'https://files.oaiusercontent.com/abc.png', 'png');
  dl.clearCache(true);
  cap = capture();
  const asyncReturn = dl.onDeterminingFilename({ id: 906, byExtensionId: EXT_ID }, cap.fn);
  assert.strictEqual(asyncReturn, true, '异步恢复时监听器必须返回 true');
  assert.strictEqual(cap.rec.calls, 0, '还没读 storage 时不能先裸调 suggest');
  await tick();
  await tick();
  assert.strictEqual(cap.rec.calls, 1, '异步路径只能调一次 suggest');
  assert.ok(cap.rec.value && cap.rec.value.filename === expected, '异步恢复也要改回目标路径');
  assert.ok(mem['dl:906'], '异步归位同样要登记下载 id');
  console.log('PASS I: 冷启动异步恢复也能正确改名，suggest 恰好一次');

  /* J: 下载 API 抛错时清掉意图，不留旧路径劫持之后的下载 */
  ctx = await reset();
  failDownload = true;
  await dl.startUrlDownload(ctx.item, 'https://files.oaiusercontent.com/abc.png', 'png');
  assert.ok(!mem['dl:intents'], '失败后不应残留意图');
  failDownload = false;
  console.log('PASS J: 下载调用失败时清理意图表');

  /* K: 一键重置的 purge() 连 storage 意图一起清 */
  ctx = await reset();
  await dl.startUrlDownload(ctx.item, 'https://files.oaiusercontent.com/abc.png', 'png');
  assert.ok(mem['dl:intents']);
  dl.purge();
  assert.ok(!mem['dl:intents'], 'purge 应清掉 storage 中的意图');
  await dl.restore();
  cap = capture();
  dl.onDeterminingFilename({ id: 907, byExtensionId: EXT_ID }, cap.fn);
  assert.strictEqual(cap.rec.value, undefined, '重置后不应再出现旧批次路径');
  console.log('PASS K: 一键重置后旧路径不再劫持下载');

  /* L: 附件点击（C 级）归位后，pending-click 与意图一起清掉 */
  ctx = await reset();
  const card = {
    src: 'sandbox:/mnt/data/static_linked_list_4k.png',
    label: 'static_linked_list_4k.png 图像',
    click: true
  };
  await dl.startFileDownload(ctx.item, card, 1);
  assert.ok(mem['dl:pending-click'], '点击前应准备好归位信息');
  assert.ok(mem['dl:intents'], '点击也要登记意图，防冷启动');
  cap = capture();
  dl.onDeterminingFilename({ id: 908, byExtensionId: undefined }, cap.fn);
  assert.ok(cap.rec.value && cap.rec.value.filename === expected, '页面点击下载也要归位');
  assert.ok(!mem['dl:pending-click'] && !mem['dl:intents'], '两条归位记录都要清掉');
  console.log('PASS L: 附件点击下载归位并清理全部临时记录');

  /* M: 自定义命名模板与基础目录生效 */
  ctx = await reset({ folder: '', template: '{batch}_{index:03}_{date}' });
  const path2 = dl.buildPath(ctx.item, 'jpg');
  assert.ok(/^chatgpt-images\/操作系统第12\/操作系统第12_001_\d{8}\.jpg$/.test(path2), path2);
  console.log('PASS M: 未指定子目录时回落「基础目录/批次名」，自定义模板生效');

  /* N: 真的又被 Chrome 改成「下载.png」时，日志要直接报出来 */
  ctx = await reset();
  await dl.startUrlDownload(ctx.item, 'https://files.oaiusercontent.com/abc.png', 'png');
  cap = capture();
  dl.onDeterminingFilename({ id: 909, byExtensionId: EXT_ID }, cap.fn);
  assert.ok(cap.rec.value);
  await store.withLock(() =>
    dl.handleChanged({
      id: 909,
      state: { current: 'complete' },
      filename: { current: 'C:\\Users\\me\\Downloads\\下载.png' }
    })
  );
  assert.strictEqual(store.getItem(ctx.bid, 0).status, S.DONE);
  assert.ok(
    store.getLogs().some((l) => /实际落盘路径与设定不一致/.test(l.message)),
    '路径不对时必须写一条可诊断的警告'
  );
  console.log('PASS N: 路径被改错时日志明确报出实际路径');

  /* O: 提示词自带编号时，文件名只用它，不能再叠队列序号（用户反馈 037_36_xxx） */
  ctx = await reset({ index: 36, prompt: '## 36 死锁检测资源分配图与检测算法' });
  assert.strictEqual(
    dl.buildPath(ctx.item, 'png'),
    '操作系统第12/036_死锁检测资源分配图与检测算法.png',
    '队列第 37 条 + 提示词编号 36 → 只能出现一个编号，且必须是提示词里的 36'
  );
  console.log('PASS O: 提示词编号接管文件名，不再出现 037_36_ 双编号');

  /* P: `## 01 | 标题` 这种写法同样只保留一个编号 */
  ctx = await reset({ index: 0, prompt: '## 01 | 操作系统的基本概念' });
  assert.strictEqual(dl.buildPath(ctx.item, 'png'), '操作系统第12/001_操作系统的基本概念.png');
  console.log('PASS P: markdown 编号（## 01 |）被正确解析并去重');

  /* Q: 提示词没有编号 → 继续用队列序号，行为不变 */
  ctx = await reset({ index: 1, prompt: '画一张静态链表对比图' });
  assert.strictEqual(dl.buildPath(ctx.item, 'png'), '操作系统第12/002_画一张静态链表对比图.png');
  console.log('PASS Q: 无编号提示词仍用队列序号，不误伤');

  /* R: 模板本身不含 {index} 时，slug 保留提示词编号，仍然只有一个编号 */
  ctx = await reset({ index: 36, prompt: '36_死锁检测资源分配图', template: '{slug}' });
  assert.strictEqual(dl.buildPath(ctx.item, 'png'), '操作系统第12/36_死锁检测资源分配图.png');
  console.log('PASS R: 自定义模板不含 {index} 时保留原编号，不丢编号也不重复');

  console.log('\nALL PASS — 下载命名与目录回归通过（18 组）');
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
