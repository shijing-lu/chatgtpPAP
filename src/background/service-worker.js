/* Service Worker 入口：只做事件注册与转发，业务逻辑在 store/orchestrator/lease/downloads/scheduler。
 * 所有监听器都必须写在文件顶层同步执行，否则 SW 冷启动时收不到事件。 */
importScripts(
  '../shared/constants.js',
  '../shared/sites.js',
  '../shared/selectors.js',
  '../shared/slug.js',
  '../shared/sched.js',
  '../shared/version.js',
  './store.js',
  './lease.js',
  './downloads.js',
  './tabpool.js',
  './orchestrator.js',
  './scheduler.js'
);

const store = self.CGR_STORE;
const lease = self.CGR_LEASE;
const dl = self.CGR_DL;
const orch = self.CGR_ORCH;
const tabs = self.CGR_TABS;
const sched = self.CGR_SCHED;
const CGR = self.CGR;
const G = CGR.GLOBAL;
const S = CGR.STATUS;

/* ---------------- 启动 ---------------- */

async function boot() {
  // 下载意图表可能被 SW 冷启动清空，先读回内存；否则 onDeterminingFilename 会把
  // 我们自己的下载当成「无关下载」放行，文件又变成默认「下载.png」落到下载根目录。
  await dl.restore();
  await store.load();
  await store.withLock(async () => {
    await lease.sweepExpired();
  });
  await store.publishView();
  sched.ensure();

  for (const b of store.listBatches()) {
    if (b.status === G.RUNNING) await orch.wakeBatch(b.id);
  }
  ensureWakeTicker();
}

/* ---------------- 版本变化记录（设置页显示用） ----------------
 * manifest.version 是唯一版本来源。onInstalled 负责记「从哪个版本升上来」，
 * 冷启动兜底补上漏记的升级；同版本重载只刷新生效时间，不重复记一条更新。
 * 用 Promise 链串行，避免 onInstalled 与冷启动同时读写同一个 key。 */

let versionChain = Promise.resolve();

function noteVersion(details) {
  versionChain = versionChain
    .then(async () => {
      const version = chrome.runtime.getManifest().version;
      const data = await chrome.storage.local.get(CGR.VERSION.KEY);
      const prev = data[CGR.VERSION.KEY];
      const changed = !prev || prev.version !== version;
      if (!changed && !details) return;
      const next = CGR.VERSION.record(prev, version, Date.now(), details || null);
      await chrome.storage.local.set({ [CGR.VERSION.KEY]: next });
    })
    .catch(() => {});
  return versionChain;
}

noteVersion(null); // SW 每次唤醒都兜底检查一次；同版本不写盘

/* ---------------- 运行期唤醒（不依赖页面定时器） ---------------- */

let wakeTimer = 0;
const wakeRebindAt = new Map();
const wakeScanAt = new Map();

/**
 * 每 5 秒看一眼：某个批次有待办、没有任务在跑、又超过 15 秒没派发过，
 * 就主动唤醒它的标签页；一个绑定标签页都没有时直接重新接管。
 * 页面里的 setTimeout 在后台标签页会被 Chrome 节流到分钟级，所以唤醒必须由 SW 发起。
 */
async function wakeTick() {
  await store.ensureLoaded();
  // 附件点击后若一直没产生下载，别让任务永远挂在「下载中」
  try {
    await store.withLock(() => dl.checkPendingClicks());
  } catch (e) {
    /* ignore */
  }
  const rt = store.getRuntime();
  for (const b of store.listBatches()) {
    if (b.status !== G.RUNNING) continue;
    const items = store.getItems(b.id);
    const hasPending = items.some((it) => it.status === S.PENDING);
    const hasActive = items.some((it) => lease.ACTIVE.includes(it.status));
    if (!hasPending && !hasActive) continue;

    // 正常的两条任务之间的间隔不打扰，只兜「确实卡住」的情况
    const quietFor = Date.now() - (b.lastClaimAt || b.startedAt || 0);

    // 有任务一直挂在「执行中」，多半是页面主循环停了、只剩僵尸心跳在替它续租。
    // 定时扫描会识别 loop. stalled 并强制重注入，这里提前触发一次，不用干等 30 秒 alarm。
    if (hasActive && quietFor >= (CGR.LIMITS.loopStallMs || 90000)) {
      if (Date.now() - (wakeScanAt.get(b.id) || 0) < 30000) continue;
      wakeScanAt.set(b.id, Date.now());
      sched.scan().catch(() => {});
      continue;
    }

    if (!hasPending || hasActive) continue;
    if (quietFor < CGR.LIMITS.wakeStuckMs) continue;

    const ids = Object.entries(rt.activeTabs || {})
      .filter(([, v]) => v && v.batchId === b.id)
      .map(([k]) => Number(k));

    if (!ids.length) {
      // rebind 会重新注入脚本，别每 5 秒重复来一次
      const last = wakeRebindAt.get(b.id) || 0;
      if (Date.now() - last < 15000) continue;
      wakeRebindAt.set(b.id, Date.now());
      await store.withLock(() => orch.rebindBatch(b.id));
      continue;
    }
    for (const id of ids) {
      const res = await CGR.withTimeout(tabs.send(id, { type: CGR.MSG.WAKE }), 2000, null);
      if (res && res.ok) continue;
      // 唤醒都送不到，说明这个「执行页」已经不干活了。立刻标成失联，
      // 让其它正在轮询的 ChatGPT 标签页在 claim 里就地接管，不用等 30 秒定时扫描。
      await store.withLock(async () => {
        const cur = store.getRuntime();
        const activeTabs = Object.assign({}, cur.activeTabs);
        const info = activeTabs[id];
        if (!info) return;
        activeTabs[id] = Object.assign({}, info, { stale: true });
        await store.setRuntime({ activeTabs });
      });
      store.addLog('warn', `执行页 ${id} 没有响应唤醒，已标记失联；同站点的其它对话标签页会自动接管`);
    }
  }
}

function ensureWakeTicker() {
  if (wakeTimer) return;
  // SW 被回收后变量随之消失，下次任意消息都会重建这个 ticker
  wakeTimer = setInterval(() => {
    wakeTick().catch(() => {});
  }, CGR.LIMITS.wakeTickMs);
}

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) {
    /* ignore */
  }
  noteVersion(details);
  sched.ensure();
  boot().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  boot().catch(() => {});
});

chrome.action.onClicked.addListener((tab) => {
  try {
    chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (e) {
    /* sidePanel.open 需要用户手势 */
  }
});

/* ---------------- 来自标签页的事件 ---------------- */

async function onHello(msg, sender) {
  return store.withLock(async () => {
    await store.ensureLoaded();
    const tabId = sender.tab ? sender.tab.id : null;
    if (tabId == null) return { ok: false, error: 'no-tab' };

    // 页面刷新/重新注入：回收这个 tab 手上的租约（正在生成 → 待确认）
    const owned = lease.itemsByTab(tabId);
    if (owned.length) {
      await lease.reclaimByTab(tabId, 'tab-reloaded');
      store.addLog('warn', `标签页 ${tabId} 重新加载，已回收 ${owned.length} 条任务`);
    }

    const rt = store.getRuntime();
    const activeTabs = Object.assign({}, rt.activeTabs);
    const existed = activeTabs[tabId] && activeTabs[tabId].batchId;
    // 站点以页面自己上报为准，收不到时用 sender.tab.url 兜底（后台不能读 location）
    const site = msg.site || (typeof CGR.siteOf === 'function' ? CGR.siteOf(sender.tab && sender.tab.url) : '');

    if (existed) {
      // 只更新已登记的标签页，保留它的批次归属
      activeTabs[tabId] = Object.assign({}, activeTabs[tabId], {
        convId: msg.convId || '',
        site,
        state: 'idle',
        at: Date.now()
      });
      await store.setRuntime({ activeTabs });
    }
    // 没登记过的（用户自己打开的 ChatGPT 标签页）不往 activeTabs 里塞，
    // 否则会被当成执行器去 ping、去注入脚本，日志全是噪音

    return { ok: true, cfg: store.getCfg(), batchId: existed || '', url: msg.url || '' };
  });
}

async function onLeaseRequest(msg, sender) {
  const tabId = sender.tab ? sender.tab.id : null;
  if (tabId == null) return { ok: false, reason: 'no-tab' };

  const rt = store.getRuntime();
  const info = (rt.activeTabs || {})[tabId];
  const convId = msg.convId || '';

  // 同一批次内不允许两个标签页停在同一个对话
  if (convId && info) {
    for (const [tid, other] of Object.entries(rt.activeTabs || {})) {
      // 只有「另一个标签页正忙且停在同一对话」才挡；闲置标签页不该被永久跳过
      if (Number(tid) !== tabId && other && other.batchId === info.batchId && other.convId === convId && other.state === 'busy') {
        store.addLog('warn', `标签页 ${tabId} 与 ${tid} 处于同一对话，跳过派发`);
        return { ok: false, reason: 'conv-conflict' };
      }
    }
  }
  const site = msg.site || (typeof CGR.siteOf === 'function'
    ? CGR.siteOf(sender.tab && sender.tab.url)
    : '');
  return orch.claim(tabId, convId, site);
}

async function onOutcome(msg, sender) {
  const tabId = sender.tab ? sender.tab.id : null;
  const rt = store.getRuntime();
  const bid = ((rt.activeTabs || {})[tabId] || {}).batchId;
  const res = await orch.handleOutcome(msg, tabId);
  if (bid) orch.wakeBatch(bid).catch(() => {});
  return res;
}

async function handleContent(msg, sender) {
  switch (msg.type) {
    case CGR.MSG.HELLO:
      return onHello(msg, sender);
    case CGR.MSG.PING:
      return { ok: true, ts: Date.now() };
    case CGR.MSG.LEASE_REQUEST:
      return onLeaseRequest(msg, sender);
    case CGR.MSG.LEASE_HEARTBEAT:
      return orch.heartbeat(msg.leaseToken);
    case CGR.MSG.PROGRESS:
      return orch.markProgress(sender.tab ? sender.tab.id : null, msg.leaseToken, msg.phase);
    case CGR.MSG.OUTCOME:
      return onOutcome(msg, sender);
    case CGR.MSG.LOG:
      store.addLog(msg.level || 'info', msg.message, msg.meta);
      return { ok: true };
    case CGR.MSG.DL_CHUNK:
      dl.pushChunk(msg.batchId, msg.index, msg.seq, msg.total, msg.data);
      return { ok: true };
    case CGR.MSG.DL_COMMIT: {
      const res = await store.withLock(() => dl.commitChunks(msg.batchId, msg.index, msg.mime, msg.ext));
      return { ok: !!res };
    }
    default:
      return { ok: false, error: 'unknown-message' };
  }
}

/* ---------------- 来自侧边栏的命令 ---------------- */

async function handleCommand(msg) {
  const p = msg.payload || {};
  switch (msg.cmd) {
    case CGR.CMD.BATCH_CREATE:
      return orch.createBatch(p.name, p.site);
    case CGR.CMD.GET_PROMPTS: {
      await store.ensureLoaded();
      const bid = p.batchId || store.getSelectedId();
      if (!bid) return { ok: false, error: '还没有批次' };
      const prompts = store.getPrompts(bid, p.indexes);
      return { ok: true, batchId: bid, prompts };
    }
    case CGR.CMD.BATCH_UPDATE:
      return orch.updateBatch(p.id, p.patch || {});
    case CGR.CMD.BATCH_DELETE:
      return orch.deleteBatch(p.id);
    case CGR.CMD.BATCH_SELECT:
      return orch.selectBatch(p.id);
    case CGR.CMD.ADD_ITEM:
      return orch.addItem(p.batchId, p.prompt, p.refImages);
    case CGR.CMD.ADD_ITEMS:
      return orch.addItems(p.batchId, p.items);
    case CGR.CMD.START:
      return orch.start(p.batchId);
    case CGR.CMD.PAUSE:
      return orch.pause(p.batchId);
    case CGR.CMD.RESUME:
      return orch.resume(p.batchId);
    case CGR.CMD.STOP:
      return orch.stop(p.batchId);
    case CGR.CMD.SET_CONFIG: {
      const cfg = await store.withLock(async () => {
        const next = await store.setCfg(p);
        await store.publishView();
        return next;
      });
      return { ok: true, cfg };
    }
    case CGR.CMD.RESET_ITEM:
      return orch.resetItem(p.batchId, p.index);
    case CGR.CMD.SKIP_ITEM:
      return orch.skipItem(p.batchId, p.index);
    case CGR.CMD.RUN_ONE:
      return orch.runOne(p.batchId, p.index);
    case CGR.CMD.DELETE_ITEMS:
      return orch.deleteItems(p.batchId, p.indexes || (p.index != null ? [p.index] : []));
    case CGR.CMD.CLEAR_FINISHED:
      return orch.clearFinished(p.batchId);
    case CGR.CMD.CLEAR_ALL: {
      await store.withLock(async () => {
        const b = store.getBatch(p.batchId);
        if (!b) return;
        await lease.releaseBatch(b.id, 'stop');
        await store.clearItems(b.id);
        b.status = G.IDLE;
        b.count = 0;
        b.stats = { done: 0, failed: 0, needsReview: 0, skipped: 0 };
        await store.putBatch(b);
        await store.publishView();
        await orch.gcImages();
      });
      return { ok: true };
    }
    case CGR.CMD.SELFCHECK: {
      await store.ensureLoaded();
      const b = store.getBatch(p.batchId || store.getSelectedId());
      const site = store.normalizeSite(b && b.site);
      const label = CGR.siteLabel(site);
      const list = await tabs.usableTabs(site);
      if (!list.length) return { ok: false, error: `没有打开的 ${label} 标签页，请先打开 ${label} 对话页` };
      const tabId = p.tabId || list[0].id;
      const res = await CGR.withTimeout(tabs.send(tabId, { type: CGR.MSG.SELFCHECK }), 8000, null);
      if (!res) return { ok: false, error: `标签页无响应，请刷新 ${label} 页面后重试` };
      return { ok: true, report: res.report, tabId, site };
    }
    case CGR.CMD.OPEN_ITEM_TAB: {
      const item = store.getItem(p.batchId, p.index);
      const tabId = item && item.tabId;
      if (tabId) {
        try {
          await chrome.tabs.update(tabId, { active: true });
          const t = await chrome.tabs.get(tabId);
          await chrome.windows.update(t.windowId, { focused: true });
        } catch (e) {
          /* ignore */
        }
      }
      return { ok: true };
    }
    case CGR.CMD.FIX_TABS: {
      // 一键修复：重新接管指定批次（不指定则接管所有已打开的对话标签页）
      await store.ensureLoaded();
      const targetBatch = p.batchId;
      const targetRec = targetBatch ? store.getBatch(targetBatch) : null;
      // 只修同站点的标签页：Gemini 批次不该被「修」到 ChatGPT 页面上
      const site = targetRec ? store.normalizeSite(targetRec.site) : '';
      const label = site ? CGR.siteLabel(site) : '对话';
      const list = await tabs.usableTabs(site);
      if (!list.length) return { ok: false, error: `没有打开的 ${label} 标签页，请先打开 ${label} 对话页` };

      const rt = store.getRuntime();
      let candidates = list.filter((t) => {
        const info = (rt.activeTabs || {})[t.id];
        return !targetBatch || (info && info.batchId === targetBatch);
      });

      // 该批次一个登记过的标签页都没有（扩展重载后很常见）：直接复用当前这个标签页，
      // 并重新绑定归属。否则「立即修复」会报「接管失败」，批次还是卡在运行中。
      const rebind = !candidates.length && !!targetBatch;
      if (rebind) {
        candidates = list.slice().sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0)).slice(0, 1);
      }

      // 僵尸执行页常常 PING 得通、却根本不来领任务，只「修」它等于没修。
      // 指定批次时优先把用户当前正在看的 ChatGPT 标签页纳为执行页；
      // 数量严格按并发设置截断，避免一次修复后冒出两个执行页并行生图。
      if (targetBatch) {
        const here = await tabs.currentActiveChatTab(site);
        const cfg = store.getCfg();
        const want = cfg.mode === CGR.MODE.PARALLEL
          ? Math.max(1, Math.min(cfg.concurrency || 1, CGR.LIMITS.maxConcurrency))
          : 1;
        candidates = here ? [here, ...candidates.filter((t) => t.id !== here.id)].slice(0, want) : candidates.slice(0, want);
      }

      const fixed = [];
      for (const t of candidates) {
        if (await tabs.ensureContentScript(t.id)) fixed.push(t.id);
      }
      if (!fixed.length) return { ok: false, error: `接管失败，请手动刷新 ${label} 页面后重试` };

      await store.withLock(async () => {
        const cur = store.getRuntime();
        const activeTabs = Object.assign({}, cur.activeTabs);
        // 清掉同批次里这次没修好的其它绑定，别让它们继续占着执行页名额
        if (targetBatch) {
          const keep = new Set(fixed);
          for (const [tid, info] of Object.entries(activeTabs)) {
            if (info && info.batchId === targetBatch && !keep.has(Number(tid))) delete activeTabs[tid];
          }
        }
        for (const id of fixed) {
          activeTabs[id] = Object.assign({}, activeTabs[id], {
            batchId: targetBatch || (activeTabs[id] && activeTabs[id].batchId) || '',
            site: site || (activeTabs[id] && activeTabs[id].site) || '',
            state: 'idle',
            stale: false,
            at: Date.now()
          });
        }
        const b = targetBatch ? store.getBatch(targetBatch) : null;
        if (b) {
          b.status = G.RUNNING;
          b.startedAt = Date.now();
          b.lastClaimAt = 0;
          b.limitUntil = 0;
          b.lastError = null;
          await store.putBatch(b);
        }
        await store.setRuntime({ activeTabs });
      });

      for (const id of fixed) await tabs.send(id, { type: CGR.MSG.WAKE });
      store.addLog('info', `已重新接管标签页：${fixed.join(', ')}${rebind ? '（并重新绑定到该批次）' : ''}`);
      await store.publishView();
      return { ok: true, fixed, rebound: rebind };
    }
    case CGR.CMD.RESET: {
      // 清掉唤醒节留，避免重置后旧的重绑/扫描时间戳继续影响自愈
      wakeRebindAt.clear();
      wakeScanAt.clear();
      const out = await orch.reset({ scope: p.scope });
      // 恢复出厂设置会 storage.local.clear()。版本记录不是用户数据，重建一条，
      // 否则设置页会丢掉「当前版本 / 更新记录」。
      if (out && out.ok && p.scope === CGR.RESET_SCOPE.FACTORY) await noteVersion(null);
      return out;
    }
    case CGR.CMD.EXPORT_LOGS: {
      const b = store.getBatch(p.batchId);
      return {
        ok: true,
        logs: store.getLogs(),
        batches: store.listBatches(),
        current: b
          ? {
              batch: b,
              items: store.getItems(b.id).map((i) => ({
                index: i.index,
                status: i.status,
                attempt: i.attempt,
                filename: i.filename,
                error: i.error,
                prompt: i.prompt
              }))
            }
          : null
      };
    }
    default:
      return { ok: false, error: 'unknown-command' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ensureWakeTicker();
  (async () => {
    try {
      if (!msg || (!msg.type && !msg.cmd)) return sendResponse({ ok: false, error: 'bad-message' });
      await store.ensureLoaded();
      if (msg.cmd) return sendResponse(await handleCommand(msg));
      return sendResponse(await handleContent(msg, sender));
    } catch (e) {
      console.error('[CGR] handler error', e);
      return sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});

/* ---------------- 浏览器事件 ---------------- */

/* 只要注册了 onDeterminingFilename，Chrome 就会忽略 downloads.download({filename})
 * （Chromium issue 579563），所以扩展自己发起的 A/B 级下载也必须在这里把目标路径
 * suggest 回去；页面点击产生的 C 级下载同样在这里归位。
 * 监听器必须在 service worker 顶层同步注册；返回 true 表示稍后异步调用 suggest。 */
if (chrome.downloads && chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((d, suggest) => {
    try {
      return dl.onDeterminingFilename(d, suggest);
    } catch (e) {
      try {
        suggest();
      } catch (e2) {
        /* ignore */
      }
      return false;
    }
  });
}

chrome.downloads.onChanged.addListener((delta) => {
  store
    .withLock(async () => {
      await store.ensureLoaded();
      await dl.handleChanged(delta);
      await store.publishView();
    })
    .catch((e) => {
      // 以前这里静默吞异常：下载状态没被推进时用户完全看不出原因
      try {
        store.addLog('error', `下载状态事件处理失败（id=${delta && delta.id}）：${String((e && e.message) || e)}`);
      } catch (e2) {
        /* ignore */
      }
    });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  store
    .withLock(async () => {
      await store.ensureLoaded();
      const rt = store.getRuntime();
      const info = rt.activeTabs ? rt.activeTabs[tabId] : null;
      const activeTabs = Object.assign({}, rt.activeTabs);
      delete activeTabs[tabId];
      await store.setRuntime({ activeTabs });

      const touched = await lease.reclaimByTab(tabId, 'tab-closed');
      if (touched.length) store.addLog('warn', `标签页被关闭，${touched.length} 条任务已退回队列`);
      if (info && info.batchId) {
        await orch.maybeFinish(info.batchId);
        await orch.wakeBatch(info.batchId);
      }
      await store.publishView();
    })
    .catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.discarded === undefined) return;
  store
    .withLock(async () => {
      await store.ensureLoaded();
      const rt = store.getRuntime();
      if (!rt.activeTabs || !rt.activeTabs[tabId]) return;
      const m = String(tab.url || '').match(/\/c\/([a-zA-Z0-9-]+)/);
      const activeTabs = Object.assign({}, rt.activeTabs);
      activeTabs[tabId] = Object.assign({}, activeTabs[tabId], { convId: m ? m[1] : '', at: Date.now() });
      await store.setRuntime({ activeTabs });

      if (changeInfo.discarded) {
        try {
          await chrome.tabs.update(tabId, { autoDiscardable: false });
          await chrome.tabs.reload(tabId);
          store.addLog('warn', `标签页 ${tabId} 被浏览器休眠，已自动重载`);
        } catch (e) {
          /* ignore */
        }
      }
    })
    .catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  ensureWakeTicker();
  sched.onAlarm(alarm);
});

boot().catch(() => {});
