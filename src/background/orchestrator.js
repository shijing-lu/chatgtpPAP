/* 队列编排：任务入队、全局状态机、租约派发、结果处理。
 * 所有对 store 的写操作都经 store.withLock()，保证「同一条任务不会被两个标签页领取」。 */
(function (root) {
  const CGR = root.CGR;
  const store = root.CGR_STORE;
  const lease = root.CGR_LEASE;
  const dl = root.CGR_DL;
  const tabs = root.CGR_TABS;

  const G = CGR.GLOBAL;

  let sendFailStreak = 0;

  /* ---------------- 工具 ---------------- */

  function stampName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `批次_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  }

  function effectiveConcurrency() {
    const cfg = store.getCfg();
    if (cfg.mode === CGR.MODE.PARALLEL) {
      return Math.max(1, Math.min(cfg.concurrency || 1, CGR.LIMITS.maxConcurrency));
    }
    return 1;
  }

  function needsFreshChat(item, cfg) {
    if (cfg.mode === CGR.MODE.SINGLE) return false;
    return !item.chatPrepared;
  }

  function remaining(items) {
    return items.filter((it) => [CGR.STATUS.PENDING, CGR.STATUS.CLAIMED, CGR.STATUS.SENDING, CGR.STATUS.GENERATING, CGR.STATUS.DOWNLOADING].includes(it.status)).length;
  }

  async function maybeFinish() {
    const rt = store.getRuntime();
    if (rt.status !== G.RUNNING && rt.status !== G.PAUSED) return;
    const items = store.allItems();
    if (!items.length) return;
    if (remaining(items) === 0) {
      await store.setRuntime({ status: G.FINISHED });
      const done = items.filter((i) => i.status === CGR.STATUS.DONE).length;
      store.addLog('info', `全部处理完毕：成功 ${done} / 共 ${items.length}`);
    }
  }

  async function wakeAll() {
    const rt = store.getRuntime();
    const ids = Object.keys(rt.activeTabs || {}).map(Number);
    for (const id of ids) {
      await tabs.send(id, { type: CGR.MSG.WAKE });
    }
  }

  /* ---------------- 入队 ---------------- */

  async function enqueue(prompts, opts) {
    return store.withLock(async () => {
      await store.ensureLoaded();
      const list = (prompts || []).map((p) => String(p || '').trim()).filter(Boolean);
      if (!list.length) return { ok: false, error: '没有可用的提示词' };
      if (list.length > CGR.LIMITS.maxPromptsPerBatch) {
        return { ok: false, error: `一次最多 ${CGR.LIMITS.maxPromptsPerBatch} 条` };
      }

      await lease.releaseAll('stop');
      await store.clearBatchStorage();

      const cfg = store.getCfg();
      const batchName = (opts && opts.batchName ? String(opts.batchName).trim() : '') || stampName();
      const id = CGR.uuid();
      const now = Date.now();

      for (let i = 0; i < list.length; i++) {
        const item = {
          index: i,
          prompt: list[i],
          status: CGR.STATUS.PENDING,
          attempt: 0,
          maxAttempts: cfg.maxAttempts || 2,
          rev: 0,
          lease: null,
          tabId: null,
          image: null,
          download: null,
          error: null,
          filename: '',
          chatPrepared: false,
          ts: { queuedAt: now }
        };
        await store.putItem(item);
      }

      await store.setBatch({ id, name: batchName, createdAt: now, count: list.length });
      await store.setRuntime({ status: G.IDLE, startedAt: 0, limitUntil: 0, lastError: null, activeTabs: {}, hintIndex: null, singleShot: false, stats: { done: 0, failed: 0, needsReview: 0, skipped: 0 } });
      store.addLog('info', `已加入 ${list.length} 条提示词（批次：${batchName}）`);
      await store.publishView();
      return { ok: true, count: list.length, batchName };
    });
  }

  /* ---------------- 全局控制 ---------------- */

  async function start() {
    return store.withLock(async () => {
      await store.ensureLoaded();
      const items = store.allItems();
      if (!items.length) return { ok: false, error: '队列为空，请先添加提示词' };

      const pending = items.filter((it) => it.status === CGR.STATUS.PENDING).length;
      if (!pending) return { ok: false, error: '没有待生成的任务' };

      const n = effectiveConcurrency();
      const ids = await tabs.ensureTabs(n);
      const activeTabs = {};
      for (const id of ids) {
        let convId = '';
        try {
          const t = await chrome.tabs.get(id);
          const m = String(t.url || '').match(/\/c\/([a-zA-Z0-9-]+)/);
          convId = m ? m[1] : '';
        } catch (e) {
          convId = '';
        }
        activeTabs[id] = { convId, state: 'idle', at: Date.now() };
      }

      await store.setRuntime({ status: G.RUNNING, startedAt: Date.now(), limitUntil: 0, lastError: null, pausedByUser: false, activeTabs, lastClaimAt: 0 });

      // 注入/校验内容脚本。扩展重载后已打开的标签页里是旧脚本，这一步是「看起来在跑但毫无反应」的根因
      const ready = [];
      const dead = [];
      for (const id of ids) {
        const ok = await tabs.ensureContentScript(id);
        (ok ? ready : dead).push(id);
      }

      store.addLog('info', `开始执行，并发 ${n}（${CGR.MODE_LABEL[store.getCfg().mode]}），接管标签页：${ready.join(', ') || '无'}`);
      for (const id of ready) await tabs.send(id, { type: CGR.MSG.WAKE });
      await store.publishView();

      if (dead.length) {
        return {
          ok: true,
          tabs: ready.length,
          warning: `标签页 ${dead.join(', ')} 无法接管（可能不是 chatgpt.com 或页面未加载完成）。请刷新该页面后点「继续」`
        };
      }
      return { ok: true, tabs: ready.length };
    });
  }

  async function pause() {
    return store.withLock(async () => {
      const rt = store.getRuntime();
      if (rt.status !== G.RUNNING) return { ok: false, error: '当前不在运行中' };
      await store.setRuntime({ status: G.PAUSED, pausedByUser: true });
      store.addLog('info', '已暂停：当前这张图跑完后不再继续');
      return { ok: true };
    });
  }

  async function resume() {
    return store.withLock(async () => {
      const items = store.allItems();
      if (!items.some((it) => it.status === CGR.STATUS.PENDING)) return { ok: false, error: '没有待生成的任务' };
      await store.setRuntime({ status: G.RUNNING, pausedByUser: false, limitUntil: 0 });
      await wakeAll();
      store.addLog('info', '继续执行');
      return { ok: true };
    });
  }

  async function stop() {
    return store.withLock(async () => {
      const rt = store.getRuntime();
      const ids = Object.keys(rt.activeTabs || {}).map(Number);
      await lease.releaseAll('stop');
      await store.setRuntime({ status: G.IDLE, startedAt: 0, limitUntil: 0, activeTabs: {} });
      for (const id of ids) await tabs.send(id, { type: CGR.MSG.ABORT });
      store.addLog('info', '已停止，所有任务已退回待生成');
      await store.publishView();
      return { ok: true };
    });
  }

  /* ---------------- 租约派发 ---------------- */

  async function claim(tabId, convId, itemHint) {
    return store.withLock(async () => {
      await store.ensureLoaded();
      const cfg = store.getCfg();
      const rt = store.getRuntime();
      if (rt.status !== G.RUNNING) {
        return { ok: false, reason: rt.status };
      }

      let item = null;
      const hint = itemHint != null ? itemHint : store.getRuntime().hintIndex;
      if (hint != null) {
        if (itemHint == null) await store.setRuntime({ hintIndex: null });
        const it = store.getItem(hint);
        if (it && (it.status === CGR.STATUS.PENDING || it.status === CGR.STATUS.NEEDS_REVIEW)) {
          const now = Date.now();
          const token = CGR.uuid();
          it.lease = { token, tabId, convId: convId || '', acquiredAt: now, renewedAt: now, expiresAt: now + CGR.LIMITS.leaseTtlMs };
          it.status = CGR.STATUS.CLAIMED;
          it.tabId = tabId;
          it.attempt = 0;
          it.error = null;
          await store.putItem(it);
          item = it;
        }
      }
      if (!item) item = await lease.grant(tabId, convId);
      if (!item) {
        const rt2 = store.getRuntime();
        if (rt2.activeTabs && rt2.activeTabs[tabId]) rt2.activeTabs[tabId].state = 'idle';
        return { ok: false, reason: 'drained' };
      }

      const rt3 = store.getRuntime();
      const activeTabs = Object.assign({}, rt3.activeTabs);
      activeTabs[tabId] = Object.assign({}, activeTabs[tabId], { convId: convId || '', state: 'busy', at: Date.now() });
      await store.setRuntime({ activeTabs, lastClaimAt: Date.now() });

      // 单条试跑：派发这一条后立刻转为暂停，不再继续领取后续任务
      if (rt3.singleShot) await store.setRuntime({ status: G.PAUSED, singleShot: false });

      return {
        ok: true,
        leaseToken: item.lease.token,
        cfg,
        premises: cfg.premiseEnabled && Array.isArray(cfg.premises) ? cfg.premises : [],
        item: {
          index: item.index,
          prompt: item.prompt,
          attempt: item.attempt,
          chatPrepared: item.chatPrepared,
          needFreshChat: needsFreshChat(item, cfg)
        }
      };
    });
  }

  /* ---------------- 结果处理 ---------------- */

  async function finalize(item, nextStatus, patch) {
    item.lease = null;
    item.tabId = null;
    item.status = nextStatus;
    if (patch) Object.assign(item, patch);
    await store.putItem(item);
  }

  async function handleLimit(item, raw) {
    const cfg = store.getCfg();
    const rt = store.getRuntime();
    const until = Date.now() + Math.max(1, cfg.limitCooldownMin || 60) * 60000;
    await lease.releaseAll('limit');
    await store.setRuntime({ status: G.LIMIT_WAITING, limitUntil: until, lastError: null });
    store.addLog('warn', `触发生图限额，已自动暂停，${cfg.limitCooldownMin} 分钟后可继续。原始提示：${String(raw || '').slice(0, 80)}`);
    const rtab = Object.keys(rt.activeTabs || {}).map(Number);
    for (const id of rtab) await tabs.send(id, { type: CGR.MSG.ABORT });
    return item;
  }

  async function handleOutcome(msg, senderTabId) {
    return store.withLock(async () => {
      await store.ensureLoaded();
      const token = msg.leaseToken;
      const item = token ? lease.findByToken(token) : null;
      if (!item) return { ok: false, error: 'lease-not-found' };

      const cfg = store.getCfg();
      const status = msg.status;
      const data = msg.data || {};

      if (status === 'LIMIT') {
        await handleLimit(item, data.raw);
        return { ok: true };
      }

      if (status === 'AUTH_REQUIRED') {
        await finalize(item, CGR.STATUS.PENDING);
        await store.setRuntime({ status: G.ERROR, lastError: 'ChatGPT 未登录或登录已失效，请先在该标签页登录' });
        store.addLog('error', '检测到登录失效，任务已中止');
        return { ok: true };
      }

      if (status === 'IMAGE_READY') {
        const imgs = Array.isArray(data.images) ? data.images : [];
        const best = imgs.slice().sort((a, b) => (b.w || 0) * (b.h || 0) - (a.w || 0) * (a.h || 0))[0];
        if (!best || !best.src) {
          return handleRetryable(item, 'NO_IMAGE', cfg);
        }
        item.image = { src: best.src, w: best.w || 0, h: best.h || 0, kind: best.src.startsWith('blob:') ? 'blob' : 'https' };
        item.ts = Object.assign({}, item.ts, { imageAt: Date.now() });
        sendFailStreak = 0;
        if (item.image.kind === 'blob') {
          await finalize(item, CGR.STATUS.DOWNLOADING);
          item.tabId = senderTabId;
          await store.putItem(item);
          await dl.requestFallback(item, 'blob-url');
        } else {
          const ext = CGR.extFromUrl(best.src);
          await dl.startUrlDownload(item, best.src, ext);
        }
        return { ok: true };
      }

      if (status === 'NO_IMAGE') {
        store.addLog('warn', `#${item.index + 1} 未检测到图片（可能被拒答或只返回了文字）`);
        return handleRetryable(item, 'NO_IMAGE', cfg);
      }

      if (status === 'TIMEOUT') {
        if (data.stillGenerating) {
          await finalize(item, CGR.STATUS.NEEDS_REVIEW, {
            error: { code: 'TIMEOUT_GENERATING', message: '超时但仍在生成，请人工确认' }
          });
          store.addLog('warn', `#${item.index + 1} 超时且仍在生成，标记为待确认`);
        } else {
          await handleRetryable(item, 'TIMEOUT', cfg);
        }
        return { ok: true };
      }

      if (status === 'PREMISE_FAILED') {
        await finalize(item, CGR.STATUS.PENDING, { chatPrepared: false });
        const reason = data.reason || '未知原因';
        await store.setRuntime({
          status: G.ERROR,
          lastError: `前提设定发送失败（${reason}）。请检查前提内容是否需要先手动确认，或稍后点「开始」重试`
        });
        store.addLog('error', `前提设定发送失败：${reason}，任务已暂停`);
        return { ok: true };
      }

      if (status === 'ABORTED' || status === 'NAVIGATED') {
        await finalize(item, CGR.STATUS.PENDING);
        return { ok: true };
      }

      if (status === 'SEND_FAILED') {
        sendFailStreak += 1;
        await handleRetryable(item, 'SEND_FAILED', cfg);
        if (sendFailStreak >= 2) {
          await lease.releaseAll('stop');
          await store.setRuntime({ status: G.ERROR, lastError: '连续发送失败，页面结构可能已变化，请点「自检」排查' });
          store.addLog('error', '连续 2 次发送失败，已中止。建议运行自检');
        }
        return { ok: true };
      }

      if (status === 'CHAT_FAILED' || status === 'PAGE_ERROR') {
        return handleRetryable(item, status, cfg);
      }

      // 未知结果：退回待生成，不消耗重试次数
      await finalize(item, CGR.STATUS.PENDING);
      return { ok: true };
    });
  }

  async function handleRetryable(item, code, cfg) {
    item.attempt = (item.attempt || 0) + 1;
    const max = item.maxAttempts || cfg.maxAttempts || 2;

    if (code === 'NO_IMAGE' && cfg.onNoImage === 'skip') {
      await finalize(item, CGR.STATUS.SKIPPED, { error: { code, message: '未出图，按设置跳过' } });
      return { ok: true };
    }
    if (code === 'NO_IMAGE' && cfg.onNoImage === 'fail') {
      await finalize(item, CGR.STATUS.FAILED, { error: { code, message: '未出图' } });
      const rt = store.getRuntime();
      await store.setRuntime({ stats: Object.assign({}, rt.stats, { failed: (rt.stats.failed || 0) + 1 }) });
      return { ok: true };
    }

    if (item.attempt < max) {
      await finalize(item, CGR.STATUS.PENDING, { error: { code, message: '重试中' }, chatPrepared: false });
    } else {
      await finalize(item, CGR.STATUS.FAILED, { error: { code, message: `重试 ${max} 次仍失败` } });
      const rt = store.getRuntime();
      await store.setRuntime({ stats: Object.assign({}, rt.stats, { failed: (rt.stats.failed || 0) + 1 }) });
      store.addLog('error', `#${item.index + 1} 失败（${code}），已重试 ${max} 次`);
    }
    return { ok: true };
  }

  /* ---------------- 心跳 / 标记 ---------------- */

  async function heartbeat(token) {
    return store.withLock(async () => {
      const it = await lease.renewByToken(token);
      return { ok: !!it };
    });
  }

  async function markProgress(tabId, token, phase) {
    return store.withLock(async () => {
      const item = lease.findByToken(token);
      if (!item) return { ok: false };
      if (phase === 'chat-ready') item.chatPrepared = true;
      if (phase === 'sending') item.status = CGR.STATUS.SENDING;
      if (phase === 'sent') {
        item.status = CGR.STATUS.GENERATING;
        item.ts = Object.assign({}, item.ts, { sentAt: Date.now() });
      }
      if (item.lease) {
        item.lease.renewedAt = Date.now();
        item.lease.expiresAt = Date.now() + CGR.LIMITS.leaseTtlMs;
      }
      await store.putItem(item);
      return { ok: true };
    });
  }

  /* ---------------- 单条操作 ---------------- */

  async function runOne(index) {
    return store.withLock(async () => {
      await store.ensureLoaded();
      const item = store.getItem(index);
      if (!item) return { ok: false, error: '任务不存在' };
      if (lease.ACTIVE.includes(item.status)) return { ok: false, error: '该条正在执行中' };

      const ids = await tabs.ensureTabs(1);
      const tabId = ids[0];

      const ready = await tabs.ensureContentScript(tabId);
      if (!ready) return { ok: false, error: '标签页未就绪，请刷新 ChatGPT 页面后重试' };

      const rt0 = store.getRuntime();
      const activeTabs = Object.assign({}, rt0.activeTabs, { [tabId]: { convId: '', state: 'busy', at: Date.now() } });
      await store.setRuntime({
        activeTabs,
        hintIndex: index,
        singleShot: true,
        status: G.RUNNING,
        startedAt: rt0.startedAt || Date.now(),
        limitUntil: 0,
        lastClaimAt: 0
      });
      await tabs.send(tabId, { type: CGR.MSG.WAKE });
      return { ok: true, tabId, itemId: index };
    });
  }

  async function resetItem(index) {
    return store.withLock(async () => {
      const item = store.getItem(index);
      if (!item) return { ok: false };
      item.status = CGR.STATUS.PENDING;
      item.attempt = 0;
      item.lease = null;
      item.error = null;
      item.chatPrepared = false;
      await store.putItem(item);

      // 队列已经跑完（finished）时点「重试」应当能继续跑，而不是傻等
      const rt = store.getRuntime();
      if (rt.status === G.FINISHED || rt.status === G.IDLE) {
        const ids = await tabs.ensureTabs(1);
        const activeTabs = Object.assign({}, rt.activeTabs);
        for (const id of ids) {
          activeTabs[id] = Object.assign({}, activeTabs[id], { state: 'idle', at: Date.now() });
        }
        await store.setRuntime({ status: G.RUNNING, startedAt: rt.startedAt || Date.now(), activeTabs });
      }
      await wakeAll();
      return { ok: true };
    });
  }

  async function skipItem(index) {
    return store.withLock(async () => {
      const item = store.getItem(index);
      if (!item) return { ok: false };
      if (lease.ACTIVE.includes(item.status)) return { ok: false, error: '正在执行，无法跳过' };
      item.status = CGR.STATUS.SKIPPED;
      item.lease = null;
      await store.putItem(item);
      await maybeFinish();
      return { ok: true };
    });
  }

  /** 删除/清理后重建索引：保留项按原顺序重排为 0..n-1，并同步修正下载映射 */
  async function remapDownloadIndexes(remap) {
    try {
      const all = await chrome.storage.local.get(null);
      const updates = {};
      const removes = [];
      for (const [k, v] of Object.entries(all)) {
        if (!k.startsWith('dl:') || !v || v.index == null) continue;
        const ni = remap.get(v.index);
        if (ni == null) removes.push(k);
        else if (ni !== v.index) updates[k] = { index: ni };
      }
      if (Object.keys(updates).length) await chrome.storage.local.set(updates);
      if (removes.length) await chrome.storage.local.remove(removes);
    } catch (e) {
      /* 映射修正失败不影响主流程，最坏情况是该条下载结果落到旧索引上 */
    }
  }

  async function applyKept(kept) {
    const prev = store.allItems();
    const keepSet = new Set(kept.map((k) => k.index));
    const remap = new Map();
    let n = 0;
    for (const it of prev) {
      if (keepSet.has(it.index)) remap.set(it.index, n++);
    }

    const batch = store.getBatch();
    await store.clearBatchStorage();
    for (let i = 0; i < kept.length; i++) {
      // 注意保留 lease：正在执行的任务靠 token 定位，清掉会让它的结果回来时找不到归属
      const it = Object.assign({}, kept[i], { index: i });
      await store.putItem(it);
    }
    await store.setBatch(Object.assign({}, batch, { count: kept.length }));
    await remapDownloadIndexes(remap);
    if (dl && dl.clearCache) dl.clearCache();

    const stats = { done: 0, failed: 0, needsReview: 0, skipped: 0 };
    for (const it of kept) {
      if (it.status === CGR.STATUS.DONE) stats.done += 1;
      else if (it.status === CGR.STATUS.FAILED) stats.failed += 1;
      else if (it.status === CGR.STATUS.NEEDS_REVIEW) stats.needsReview += 1;
      else if (it.status === CGR.STATUS.SKIPPED) stats.skipped += 1;
    }

    if (!kept.length) {
      await store.setRuntime({
        status: G.IDLE,
        activeTabs: {},
        limitUntil: 0,
        hintIndex: null,
        singleShot: false,
        startedAt: 0,
        stats
      });
    } else {
      await store.setRuntime({ stats });
    }
    await store.publishView();
  }

  /** 批量删除：正在执行（生成/下载中）的条目会被保留，避免任务突然失主 */
  async function deleteItems(indexes) {
    return store.withLock(async () => {
      await store.ensureLoaded();
      const del = new Set((indexes || []).map(Number));
      if (!del.size) return { ok: true, deleted: 0, skipped: 0 };

      const items = store.allItems();
      const kept = [];
      let skipped = 0;
      for (const it of items) {
        if (!del.has(it.index)) {
          kept.push(it);
          continue;
        }
        if (lease.ACTIVE.includes(it.status)) {
          skipped += 1;
          kept.push(it);
          continue;
        }
        // 被删的条目如果还挂着租约，先摘掉再丢
        if (it.lease) it.lease = null;
      }

      const deleted = items.length - kept.length;
      if (!deleted) return { ok: true, deleted: 0, skipped };

      await applyKept(kept);
      store.addLog('info', `已删除 ${deleted} 条提示词${skipped ? `（${skipped} 条正在执行，已保留）` : ''}`);
      return { ok: true, deleted, skipped };
    });
  }

  async function clearFinished() {
    return store.withLock(async () => {
      const items = store.allItems();
      const keep = items.filter((it) => ![CGR.STATUS.DONE, CGR.STATUS.SKIPPED, CGR.STATUS.FAILED].includes(it.status));
      const removed = items.length - keep.length;
      if (!removed) return { ok: true, removed: 0 };
      await applyKept(keep);
      return { ok: true, removed };
    });
  }

  root.CGR_ORCH = {
    enqueue,
    start,
    pause,
    resume,
    stop,
    claim,
    handleOutcome,
    heartbeat,
    markProgress,
    runOne,
    resetItem,
    skipItem,
    deleteItems,
    clearFinished,
    wakeAll,
    maybeFinish,
    effectiveConcurrency
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
