/* Gemini 站点适配回归（零依赖）：node tests/site-adapter.test.js
 *
 * 覆盖「加第二个站点」最容易漏改的几层：
 *  - URL 事实只在 sites.js：站点识别、首页、对话 ID、匹配模式
 *  - selectors.js 按当前站点合并候选链（Gemini 专属优先）
 *  - 批次绑定站点：只接管同站点标签页，跨站点领任务被拒绝
 *  - Gemini 生成图走「全尺寸下载按钮」而不是 blob: 预览图，下载仍归位到批次目录
 *  - 复制提示词取后台原文（视图里只有 240 字预览）
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const load = (f) => vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ---------- Chrome API 桩 ---------- */
let mem = {};
let tabsMap = new Map();
let tabSeq = 100;
const createdUrls = [];
const tabMessages = [];
const downloadCalls = [];
const noop = { addListener() {} };

function addTab(url, active) {
  const id = ++tabSeq;
  const t = { id, url, active: !!active, windowId: 1, discarded: false, status: 'complete' };
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
    id: 'cgr-test-extension',
    getManifest: () => ({ version: '0.6.0', content_scripts: [{ js: [] }] }),
    sendMessage: () => Promise.resolve({ ok: true }),
    lastError: null,
    onInstalled: noop,
    onStartup: noop,
    onMessage: noop
  },
  action: { onClicked: noop },
  sidePanel: { setPanelBehavior: () => Promise.resolve(), open: () => Promise.resolve() },
  tabs: {
    query: () => Promise.resolve(Array.from(tabsMap.values())),
    get: (id) => Promise.resolve(tabsMap.get(Number(id)) || null),
    create: (opts) => {
      createdUrls.push(opts.url || '');
      return Promise.resolve(addTab(opts.url || '', opts.active));
    },
    remove: (id) => Promise.resolve(tabsMap.delete(Number(id))),
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
  windows: { update: () => Promise.resolve({}), getLastFocused: () => Promise.resolve({ id: 1 }) },
  alarms: { create() {}, onAlarm: noop },
  downloads: {
    download: (opts) => {
      downloadCalls.push(opts);
      return Promise.resolve(1234);
    },
    onChanged: noop,
    onDeterminingFilename: noop
  }
};

global.chrome = chrome;
global.self = global;
global.window = global;
// 让 selectors.js 在加载时按 Gemini 页面合并候选链
global.location = { href: 'https://gemini.google.com/app', hostname: 'gemini.google.com' };
global.setInterval = () => 1;
global.clearInterval = () => {};

// 后台 addLog 会往控制台刷日志，测试里静音，保留断言输出
const realConsole = { log: console.log, warn: console.warn, error: console.error };
console.log = () => {};
console.warn = () => {};
console.error = () => {};

/* ---------- 加载真实模块（与 service worker 的 importScripts 顺序一致） ---------- */
load('src/shared/constants.js');
load('src/shared/sites.js');
load('src/shared/selectors.js');
load('src/shared/slug.js');
load('src/shared/sched.js');
load('src/background/store.js');
load('src/background/lease.js');
load('src/background/downloads.js');
load('src/background/tabpool.js');
load('src/background/orchestrator.js');

const CGR = global.CGR;
const store = global.CGR_STORE;
const dl = global.CGR_DL;
const tabs = global.CGR_TABS;
const orch = global.CGR_ORCH;

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  realConsole.log('  ✓ ' + name);
}

async function reset() {
  mem = {};
  tabsMap = new Map();
  tabSeq = 100;
  createdUrls.length = 0;
  tabMessages.length = 0;
  downloadCalls.length = 0;
  dl.purge();
  await store.withLock(async () => {
    store.S.loaded = false;
    store.S.batches.clear();
    store.S.items.clear();
    store.S.logs = [];
    store.S.runtime = { selectedBatchId: '', activeTabs: {} };
    await store.load();
    await store.publishView();
  });
}

/* ---------- A. 站点事实 ---------- */
test('siteOf 识别两个站点，未知域名返回空', () => {
  assert.strictEqual(CGR.siteOf('https://chatgpt.com/c/abc-123'), 'chatgpt');
  assert.strictEqual(CGR.siteOf('https://chat.openai.com/c/x'), 'chatgpt');
  assert.strictEqual(CGR.siteOf('https://gemini.google.com/app/xyz'), 'gemini');
  assert.strictEqual(CGR.siteOf('gemini.google.com'), 'gemini');
  assert.strictEqual(CGR.siteOf('https://example.com/gemini.google.com'), '');
  assert.strictEqual(CGR.siteOf(''), '');
});

test('站点元数据 / 首页 / 权限模式都来自同一张表', () => {
  assert.strictEqual(CGR.siteMeta('gemini').label, 'Gemini');
  assert.strictEqual(CGR.siteLabel('gemini'), 'Gemini');
  assert.strictEqual(CGR.siteHome('gemini'), 'https://gemini.google.com/app');
  assert.strictEqual(CGR.siteHome('chatgpt'), 'https://chatgpt.com/');
  assert.ok(CGR.allMatchPatterns().includes('https://gemini.google.com/*'));
  assert.ok(CGR.allMatchPatterns().includes('https://chatgpt.com/*'));
  assert.ok(CGR.allHostPermissions().includes('https://*.googleusercontent.com/*'));
});

test('convIdOf 按站点解析对话 ID，新对话根节点返回空', () => {
  assert.strictEqual(CGR.convIdOf('https://chatgpt.com/c/abc-123'), 'abc-123');
  assert.strictEqual(CGR.convIdOf('https://gemini.google.com/app/abcdefgh1234'), 'abcdefgh1234');
  assert.strictEqual(CGR.convIdOf('https://gemini.google.com/chat/abcdefgh1234'), 'abcdefgh1234');
  assert.strictEqual(CGR.convIdOf('https://gemini.google.com/app'), '');
  assert.strictEqual(CGR.convIdOf('https://chatgpt.com/'), '');
});

test('currentSite / isChatSite 只对受支持站点为真，且随 location 变化', () => {
  assert.strictEqual(CGR.currentSiteId(), 'gemini');
  assert.strictEqual(CGR.currentSiteLabel(), 'Gemini');
  assert.strictEqual(CGR.isChatSite(), true);
  global.location = { href: 'https://chatgpt.com/', hostname: 'chatgpt.com' };
  assert.strictEqual(CGR.currentSiteId(), 'chatgpt');
  global.location = { href: 'https://example.com/', hostname: 'example.com' };
  assert.strictEqual(CGR.isChatSite(), false);
  assert.strictEqual(CGR.currentSiteId(), '');
  global.location = { href: 'https://gemini.google.com/app', hostname: 'gemini.google.com' };
});

test('selectors.js 按 Gemini 合并候选链：专属优先、通用兜底、ChatGPT 不丢失', () => {
  assert.ok(CGR.SEL.composer[0].includes('Enter a prompt'), 'Gemini 候选必须排在最前');
  assert.ok(CGR.SEL.composer.some((s) => s === 'div[contenteditable="true"][role="textbox"]'), '通用兜底要保留');
  assert.ok(CGR.SEL.generatedImageBox.includes('generated-image'));
  assert.ok(CGR.SEL.imageDownloadButton.some((s) => /Download full size/i.test(s)));
  assert.strictEqual(CGR.SEL_CHATGPT.composer[0], '#prompt-textarea');
  assert.strictEqual(CGR.SEL_CHATGPT.generatedImageBox.length, 0);
});

test('manifest 同时匹配两个站点，且三处脚本清单都加载 sites.js', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.ok(m.content_scripts[0].matches.includes('https://gemini.google.com/*'));
  assert.ok(m.content_scripts[0].js.includes('src/shared/sites.js'));
  assert.ok(m.host_permissions.includes('https://gemini.google.com/*'));
  assert.ok(read('src/background/service-worker.js').includes("'../shared/sites.js'"));
  assert.ok(read('src/sidepanel/sidepanel.html').includes('../shared/sites.js'));
  assert.ok(read('src/sidepanel/sidepanel.html').includes('../shared/prompt-copy.js'));
});

test('normalizeSite 把未知站点与老数据回落到默认站点', () => {
  assert.strictEqual(store.normalizeSite('gemini'), 'gemini');
  assert.strictEqual(store.normalizeSite('chatgpt'), 'chatgpt');
  assert.strictEqual(store.normalizeSite('nope'), 'chatgpt');
  assert.strictEqual(store.normalizeSite(undefined), 'chatgpt');
});

/* ---------- B. 站点隔离 ---------- */
async function integration() {
  // B1: Gemini 批次在没有 Gemini 标签页时，新建的是 Gemini 页而不是复用 ChatGPT 页
  await reset();
  addTab('https://chatgpt.com/', true);
  const secured = await tabs.ensureBatchTabs({ id: 'b-gemini', site: 'gemini' }, 1, false, false);
  assert.strictEqual(secured.ids.length, 1);
  assert.ok(createdUrls.some((u) => u.includes('gemini.google.com')), '必须新建 Gemini 标签页');
  assert.ok(/gemini\.google\.com/.test(tabsMap.get(secured.ids[0]).url), '不能把 ChatGPT 页当成执行页');
  test('ensureBatchTabs: Gemini 批次不会复用 ChatGPT 标签页', () => {});

  // B2: 反向也一样，ChatGPT 批次不碰 Gemini 页
  await reset();
  addTab('https://gemini.google.com/app', true);
  const secured2 = await tabs.ensureBatchTabs({ id: 'b-chatgpt', site: 'chatgpt' }, 1, false, false);
  assert.ok(createdUrls.some((u) => u.includes('chatgpt.com')), '必须新建 ChatGPT 标签页');
  assert.ok(/chatgpt\.com/.test(tabsMap.get(secured2.ids[0]).url));
  test('ensureBatchTabs: ChatGPT 批次不会复用 Gemini 标签页', () => {});

  // B3: 从 createBatch 到 start 到 claim 的完整链路
  await reset();
  const cgTab = addTab('https://chatgpt.com/', true);
  const gmTab = addTab('https://gemini.google.com/app', false);
  const made = await orch.createBatch('Gemini批次', 'gemini');
  const bid = made.batch.id;
  assert.strictEqual(store.getBatch(bid).site, 'gemini');
  await orch.addItem(bid, '画一只戴帽子的猫');
  await orch.addItem(bid, '画一只狗');
  const started = await orch.start(bid);
  assert.strictEqual(started.ok, true);
  const rt = store.getRuntime();
  const bound = Object.entries(rt.activeTabs)
    .filter(([, v]) => v && v.batchId === bid)
    .map(([k]) => Number(k));
  assert.ok(bound.length > 0);
  for (const id of bound) {
    assert.ok(/gemini\.google\.com/.test(tabsMap.get(id).url), 'Gemini 批次不能绑定到 ChatGPT 标签页');
  }
  test('start: Gemini 批次只绑定同站点执行页', () => {});

  // B4: 手工把 ChatGPT 页绑到 Gemini 批次，claim 必须拒绝而不是把提示词发到错误网站
  await store.withLock(async () => {
    const cur = store.getRuntime();
    await store.setRuntime({
      activeTabs: Object.assign({}, cur.activeTabs, {
        [cgTab.id]: { batchId: bid, state: 'idle', stale: false, at: Date.now() }
      })
    });
  });
  const mismatch = await orch.claim(cgTab.id, '', 'chatgpt');
  assert.strictEqual(mismatch.reason, 'site-mismatch');
  assert.strictEqual(mismatch.expectedSite, 'gemini');
  assert.strictEqual(mismatch.actualSite, 'chatgpt');
  const granted = await orch.claim(gmTab.id, '', 'gemini');
  assert.strictEqual(granted.ok, true);
  assert.strictEqual(granted.site, 'gemini');
  assert.strictEqual(granted.item.prompt, '画一只戴帽子的猫');
  test('claim: 跨站点领任务被拒绝，同站点正常派发', () => {});

  // B5: Gemini 生成图带「全尺寸下载按钮」标记时，走 D 级点击而不是 blob 取流
  await reset();
  const made2 = await orch.createBatch('Gemini下载', 'gemini');
  const bid2 = made2.batch.id;
  await orch.addItem(bid2, '画一只戴帽子的猫');
  const item = store.getItem(bid2, 0);
  const art = {
    src: 'blob:https://gemini.google.com/preview-1024',
    label: '',
    downloadLabel: '全尺寸图片',
    siteDownload: true
  };
  await dl.startSiteDownload(item, art, 777);
  const click = tabMessages.find((m) => m.msg && m.msg.type === CGR.MSG.CLICK_SITE_DOWNLOAD);
  assert.ok(click, '必须向内容脚本发「点全尺寸下载」消息');
  assert.strictEqual(click.tabId, 777);
  assert.ok(click.msg.filename.includes('Gemini下载'), '目标文件名要带批次子目录');
  assert.strictEqual(downloadCalls.length, 0, '不能把 blob: 预览图直接交给下载 API');
  const after = store.getItem(bid2, 0);
  assert.strictEqual(after.status, CGR.STATUS.DOWNLOADING);
  assert.strictEqual(after.download.tier, 'D');
  const pending = mem['dl:pending-click'];
  assert.ok(pending && pending.filename === click.msg.filename);

  // 页面点击产生的下载由 onDeterminingFilename 归位到同一个文件名
  let suggested = null;
  const asyncRet = dl.onDeterminingFilename(
    { id: 4321, url: 'https://gemini.google.com/download' },
    (a) => { suggested = a; }
  );
  assert.strictEqual(asyncRet, false);
  assert.ok(suggested && suggested.filename === pending.filename);
  test('startSiteDownload: 点全尺寸按钮且仍归位到批次目录', () => {});

  // B6: 复制提示词取后台原文，视图里的 p 只有 240 字
  await reset();
  const made3 = await orch.createBatch('复制测试', 'gemini');
  const bid3 = made3.batch.id;
  const longPrompt = '把这只猫画成油画风格，'.repeat(60);
  await orch.addItem(bid3, longPrompt);
  await orch.addItem(bid3, '第二条');
  await store.publishView();
  const viewPrompt = mem.view.current.items[0].p;
  assert.strictEqual(viewPrompt.length, 240, '视图里确实是截断预览');
  const full = store.getPrompts(bid3);
  assert.strictEqual(full.length, 2);
  assert.strictEqual(full[0].prompt, longPrompt, '复制必须拿到完整原文');
  assert.deepStrictEqual(store.getPrompts(bid3, [1]), [{ index: 1, prompt: '第二条' }]);
  test('GET_PROMPTS: 复制拿到完整原文，不依赖 240 字视图预览', () => {});

  // B7: 侧边栏保存批次设置总会带上站点；运行中只有「真的换站点」才该被拒
  await reset();
  const made4 = await orch.createBatch('改名测试', 'gemini');
  const bid4 = made4.batch.id;
  await orch.addItem(bid4, '画一只猫');
  await orch.start(bid4);
  const sameSite = await orch.updateBatch(bid4, { name: '新名字', folder: '', site: 'gemini' });
  assert.strictEqual(sameSite.ok, true, '运行中改名字不该被站点校验挡住');
  assert.strictEqual(store.getBatch(bid4).name, '新名字');
  const switchSite = await orch.updateBatch(bid4, { site: 'chatgpt' });
  assert.strictEqual(switchSite.ok, false);
  assert.ok(/运行中不能切换工作站点/.test(switchSite.error));
  await orch.stop(bid4);
  const switched = await orch.updateBatch(bid4, { site: 'chatgpt' });
  assert.strictEqual(switched.ok, true);
  assert.strictEqual(store.getBatch(bid4).site, 'chatgpt');
  test('updateBatch: 运行中只有真正切换站点才被拦截', () => {});
}

async function main() {
  await integration();
  console.log = realConsole.log;
  console.warn = realConsole.warn;
  console.error = realConsole.error;
  console.log(`\nALL PASS — Gemini 站点适配回归通过（${passed} 组）`);
}

main().catch((e) => {
  console.log = realConsole.log;
  console.warn = realConsole.warn;
  console.error = realConsole.error;
  console.error(e);
  process.exit(1);
});
