/* Service Worker 入口：只做事件注册与转发，业务逻辑在 store/orchestrator/lease/downloads/scheduler。
 * 所有监听器都必须写在文件顶层同步执行，否则 SW 冷启动时收不到事件。 */
importScripts(
  '../shared/constants.js',
  '../shared/selectors.js',
  '../shared/slug.js',
  '../shared/sched.js',
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
  await store.load();
  await store.withLock(async () => {
    await lease.sweepExpired();
  });
  await store.publishView();
  sched.ensure();

  for (const b of store.listBatches()) {
    if (b.status === G.RUNNING) await orch.wakeBatch(b.id);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) {
    /* ignore */
  }
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

    if (existed) {
      // 只更新已登记的标签页，保留它的批次归属
      activeTabs[tabId] = Object.assign({}, activeTabs[tabId], {
        convId: msg.convId || '',
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
      if (Number(tid) !== tabId && other && other.batchId === info.batchId && other.convId === convId) {
        store.addLog('warn', `标签页 ${tabId} 与 ${tid} 处于同一对话，跳过派发`);
        return { ok: false, reason: 'conv-conflict' };
      }
    }
  }
  return orch.claim(tabId, convId);
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
      return orch.createBatch(p.name);
    case CGR.CMD.BATCH_UPDATE:
      return orch.updateBatch(p.id, p.patch || {});
    case CGR.CMD.BATCH_DELETE:
      return orch.deleteBatch(p.id);
    case CGR.CMD.BATCH_SELECT:
      return orch.selectBatch(p.id);
    case CGR.CMD.ADD_ITEM:
      return orch.addItem(p.batchId, p.prompt, p.refImages);
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
      const list = await tabs.usableTabs();
      if (!list.length) return { ok: false, error: '没有打开的 ChatGPT 标签页，请先打开 chatgpt.com' };
      const tabId = p.tabId || list[0].id;
      const res = await CGR.withTimeout(tabs.send(tabId, { type: CGR.MSG.SELFCHECK }), 8000, null);
      if (!res) return { ok: false, error: '标签页无响应，请刷新 chatgpt.com 后重试' };
      return { ok: true, report: res.report, tabId };
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
      // 一键修复：重新接管指定批次（不指定则接管所有 ChatGPT 标签页）
      const list = await tabs.usableTabs();
      if (!list.length) return { ok: false, error: '没有打开的 ChatGPT 标签页' };

      const rt = store.getRuntime();
      const targetBatch = p.batchId;
      const fixed = [];
      for (const t of list) {
        if (targetBatch) {
          const info = (rt.activeTabs || {})[t.id];
          if (!info || info.batchId !== targetBatch) continue;
        }
        if (await tabs.ensureContentScript(t.id)) fixed.push(t.id);
      }
      if (!fixed.length) return { ok: false, error: '接管失败，请手动刷新该批次的窗口后重试' };

      await store.withLock(async () => {
        const cur = store.getRuntime();
        const activeTabs = Object.assign({}, cur.activeTabs);
        for (const id of fixed) {
          activeTabs[id] = Object.assign({}, activeTabs[id], { state: 'idle', at: Date.now() });
        }
        const b = targetBatch ? store.getBatch(targetBatch) : null;
        if (b) {
          b.status = G.RUNNING;
          b.startedAt = b.startedAt || Date.now();
          b.limitUntil = 0;
          b.lastError = null;
          await store.putBatch(b);
        }
        await store.setRuntime({ activeTabs });
      });

      for (const id of fixed) await tabs.send(id, { type: CGR.MSG.WAKE });
      store.addLog('info', `已重新接管标签页：${fixed.join(', ')}`);
      return { ok: true, fixed };
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

chrome.downloads.onChanged.addListener((delta) => {
  store
    .withLock(async () => {
      await store.ensureLoaded();
      await dl.handleChanged(delta);
      await store.publishView();
    })
    .catch(() => {});
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
  sched.onAlarm(alarm);
});

boot().catch(() => {});
