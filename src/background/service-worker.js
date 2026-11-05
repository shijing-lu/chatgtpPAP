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

/* ---------------- 启动 ---------------- */

async function boot() {
  await store.load();
  await store.withLock(async () => {
    await lease.sweepExpired();
  });
  await store.publishView();
  sched.ensure();

  const rt = store.getRuntime();
  if (rt.status === G.RUNNING || rt.status === G.LIMIT_WAITING) {
    // SW 被回收后重建：重新拉起执行标签页
    for (const id of Object.keys(rt.activeTabs || {})) {
      await tabs.send(Number(id), { type: CGR.MSG.WAKE });
    }
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
    /* sidePanel.open 需要用户手势，失败时用户可手动点工具栏图标 */
  }
});

/* ---------------- 来自标签页的事件 ---------------- */

async function onHello(msg, sender) {
  return store.withLock(async () => {
    await store.ensureLoaded();
    const tabId = sender.tab ? sender.tab.id : null;
    if (tabId == null) return { ok: false, error: 'no-tab' };

    // 页面刷新/重新注入：如果这个 tab 手上还有租约，按「刷新」处理
    const owned = lease.itemsByTab(tabId);
    if (owned.length) {
      const hasGenerating = owned.some((i) => i.status === CGR.STATUS.GENERATING || i.status === CGR.STATUS.DOWNLOADING);
      await lease.reclaimByTab(tabId, hasGenerating ? 'tab-reloaded' : 'tab-reloaded');
      store.addLog('warn', `标签页 ${tabId} 重新加载，已回收 ${owned.length} 条任务`);
    }

    const rt = store.getRuntime();
    const activeTabs = Object.assign({}, rt.activeTabs);
    activeTabs[tabId] = Object.assign({}, activeTabs[tabId], { convId: msg.convId || '', state: 'idle', at: Date.now() });
    await store.setRuntime({ activeTabs });

    return { ok: true, cfg: store.getCfg(), status: store.getRuntime().status, url: msg.url || '' };
  });
}

async function onLeaseRequest(msg, sender) {
  const tabId = sender.tab ? sender.tab.id : null;
  if (tabId == null) return { ok: false, reason: 'no-tab' };

  const rt = store.getRuntime();
  const convId = msg.convId || '';
  if (convId) {
    for (const [tid, info] of Object.entries(rt.activeTabs || {})) {
      if (Number(tid) !== tabId && info && info.convId === convId) {
        store.addLog('warn', `标签页 ${tabId} 与 ${tid} 处于同一对话，跳过派发以避免抢消息`);
        return { ok: false, reason: 'conv-conflict' };
      }
    }
  }
  return orch.claim(tabId, convId, msg.itemId);
}

async function onOutcome(msg, sender) {
  const tabId = sender.tab ? sender.tab.id : null;
  const res = await orch.handleOutcome(msg, tabId);
  // 处理完立即尝试唤醒空闲标签页，避免 Pull 模型下的空转等待
  orch.wakeAll().catch(() => {});
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
      dl.pushChunk(msg.index, msg.seq, msg.total, msg.data);
      return { ok: true };
    case CGR.MSG.DL_COMMIT: {
      const res = await store.withLock(() => dl.commitChunks(msg.index, msg.mime, msg.ext));
      orch.wakeAll().catch(() => {});
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
    case CGR.CMD.ADD_ITEM:
      return orch.addItem(p.prompt, p.refImages, p.batchName);
    case CGR.CMD.ENQUEUE:
      return orch.enqueue(p.prompts, { batchName: p.batchName });
    case CGR.CMD.START:
      return orch.start();
    case CGR.CMD.PAUSE:
      return orch.pause();
    case CGR.CMD.RESUME:
      return orch.resume();
    case CGR.CMD.STOP:
      return orch.stop();
    case CGR.CMD.SET_CONFIG: {
      const cfg = await store.withLock(async () => {
        const next = await store.setCfg(p);
        await store.publishView();
        return next;
      });
      return { ok: true, cfg };
    }
    case CGR.CMD.RESET_ITEM:
      return orch.resetItem(p.index);
    case CGR.CMD.SKIP_ITEM:
      return orch.skipItem(p.index);
    case CGR.CMD.DELETE_ITEMS:
      return orch.deleteItems(p.indexes || (p.index != null ? [p.index] : []));
    case CGR.CMD.RUN_ONE:
      return orch.runOne(p.index);
    case CGR.CMD.CLEAR_FINISHED:
      return orch.clearFinished();
    case CGR.CMD.CLEAR_ALL: {
      await store.withLock(async () => {
        await lease.releaseAll('stop');
        await store.clearBatchStorage();
        await store.setRuntime({ status: G.IDLE, activeTabs: {}, limitUntil: 0, stats: { done: 0, failed: 0, needsReview: 0, skipped: 0 } });
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
      const items = store.allItems();
      const item = items.find((i) => i.index === p.index);
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
      // 一键修复：把当前所有 ChatGPT 标签页重新接管（多半是因为扩展重载后页面里还是旧脚本）
      const list = await tabs.usableTabs();
      if (!list.length) return { ok: false, error: '没有打开的 ChatGPT 标签页，请先打开并登录 chatgpt.com' };

      const fixed = [];
      for (const t of list) {
        const ok = await tabs.ensureContentScript(t.id);
        if (ok) fixed.push(t.id);
      }
      if (!fixed.length) return { ok: false, error: '接管失败，请手动刷新 ChatGPT 页面后再试' };

      await store.withLock(async () => {
        const rt = store.getRuntime();
        const activeTabs = Object.assign({}, rt.activeTabs);
        for (const id of fixed) {
          activeTabs[id] = Object.assign({}, activeTabs[id], { state: 'idle', at: Date.now() });
        }
        const patch = { activeTabs };
        const hasPending = store.allItems().some((it) => it.status === CGR.STATUS.PENDING);
        if (hasPending && rt.status !== G.RUNNING) {
          patch.status = G.RUNNING;
          patch.startedAt = rt.startedAt || Date.now();
          patch.limitUntil = 0;
          patch.lastError = null;
        }
        await store.setRuntime(patch);
      });

      for (const id of fixed) await tabs.send(id, { type: CGR.MSG.WAKE });
      store.addLog('info', `已重新接管标签页：${fixed.join(', ')}`);
      return { ok: true, fixed };
    }
    case CGR.CMD.EXPORT_LOGS: {
      return { ok: true, logs: store.getLogs(), batch: store.getBatch(), items: store.allItems().map((i) => ({
        index: i.index,
        status: i.status,
        attempt: i.attempt,
        filename: i.filename,
        error: i.error,
        prompt: i.prompt
      })) };
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
      if (msg.cmd) {
        const res = await handleCommand(msg);
        return sendResponse(res);
      }
      const res = await handleContent(msg, sender);
      return sendResponse(res);
    } catch (e) {
      console.error('[CGR] handler error', e);
      return sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true; // 异步响应
});

/* ---------------- 浏览器事件 ---------------- */

chrome.downloads.onChanged.addListener((delta) => {
  store
    .withLock(async () => {
      await store.ensureLoaded();
      await dl.handleChanged(delta);
      await store.publishView();
    })
    .then(() => orch.wakeAll().catch(() => {}))
    .catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  store
    .withLock(async () => {
      await store.ensureLoaded();
      const rt = store.getRuntime();
      if (!rt.activeTabs || !rt.activeTabs[tabId]) {
        await lease.reclaimByTab(tabId, 'tab-closed');
        return;
      }
      const activeTabs = Object.assign({}, rt.activeTabs);
      delete activeTabs[tabId];
      await store.setRuntime({ activeTabs });
      const touched = await lease.reclaimByTab(tabId, 'tab-closed');
      if (touched.length) store.addLog('warn', `标签页被关闭，${touched.length} 条任务已退回队列`);
      await orch.maybeFinish();
      await orch.wakeAll();
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
        const t = await chrome.tabs.get(tabId).catch(() => null);
        if (t) {
          try {
            await chrome.tabs.update(tabId, { autoDiscardable: false });
            await chrome.tabs.reload(tabId);
            store.addLog('warn', `标签页 ${tabId} 被浏览器休眠，已自动重载`);
          } catch (e) {
            /* ignore */
          }
        }
      }
    })
    .catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  sched.onAlarm(alarm);
});

// SW 冷启动时也执行一次自愈
boot().catch(() => {});
