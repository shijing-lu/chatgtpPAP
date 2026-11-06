/* 存储层：chrome.storage.local 是唯一真相源。
 * 铁律 1：所有写操作必须经 withLock() 串行，绝不做并发 read-modify-write。
 * 铁律 2：内存里的 S 只是可重建的缓存，SW 重启后从 storage 完整重建。
 *
 * 多批次模型：
 *   batch:<id>            每个批次一条记录（名称、下载目录、前提、运行状态、统计）
 *   item:<batchId>:<idx>  批次内的单条任务
 *   runtime               选中的批次 + 各标签页当前服务的批次
 */
(function (root) {
  const CGR = root.CGR;
  const K = { CFG: 'cfg', RUNTIME: 'runtime', INDEX: 'batchIndex', LOG: 'log', VIEW: 'view' };
  const batchKey = (id) => `batch:${id}`;
  const itemKey = (bid, i) => `item:${bid}:${i}`;

  const S = {
    cfg: null,
    runtime: null,
    batches: new Map(),
    items: new Map(),
    logs: [],
    loaded: false
  };

  let chain = Promise.resolve();
  function withLock(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  function defaultRuntime() {
    return { selectedBatchId: '', activeTabs: {} };
  }

  function newBatchRecord(name) {
    return {
      id: '',
      name: name || '',
      createdAt: Date.now(),
      folder: '',
      premises: [],
      premiseEnabled: true,
      count: 0,
      windowId: null,
      status: CGR.GLOBAL.IDLE,
      limitUntil: 0,
      startedAt: 0,
      lastClaimAt: 0,
      lastError: null,
      stats: { done: 0, failed: 0, needsReview: 0, skipped: 0 }
    };
  }

  /* ---------------- 加载 ---------------- */

  async function load() {
    if (S.loaded) return;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const data = await chrome.storage.local.get([K.CFG, K.RUNTIME, K.INDEX, K.LOG, 'batch']);
      S.cfg = Object.assign({}, CGR.DEFAULTS, data[K.CFG] || {});
      // v0.4.4 之前默认「未出图时=自动重试」。一旦误判就会重发提示词、重复生图。
      // 对已保存的旧配置做一次性迁移，用户仍可在设置里主动改回自动重试。
      const savedCfg = data[K.CFG] || {};
      if (savedCfg.onNoImage === 'retry' && !savedCfg.noImagePolicyConfirmed) {
        S.cfg.onNoImage = 'review';
        S.cfg.noImagePolicyConfirmed = true;
        await chrome.storage.local.set({ [K.CFG]: S.cfg });
        // load() 还没结束时不要用 addLog（它会触发定时发布视图），直接进内存日志
        S.logs.push({
          t: Date.now(),
          level: 'warn',
          message: '已将「未出图时」改为「标记待确认，不重发」，避免误判导致重复生图；如需自动重试可在设置里改回',
          meta: null
        });
      }
      S.runtime = Object.assign(defaultRuntime(), data[K.RUNTIME] || {});
      S.logs = Array.isArray(data[K.LOG]) ? data[K.LOG] : [];
      S.batches.clear();
      S.items.clear();

      let ids = Array.isArray(data[K.INDEX]) ? data[K.INDEX] : [];

      // 兼容旧版单批次数据（batch + item:<i>）
      if (!ids.length && data.batch && data.batch.count > 0) {
        const migrated = await migrateLegacy(data.batch);
        if (migrated) ids = [migrated];
      }

      if (ids.length) {
        const recs = await chrome.storage.local.get(ids.map(batchKey));
        for (const id of ids) {
          const rec = recs[batchKey(id)];
          if (rec) {
            S.batches.set(id, Object.assign(newBatchRecord(), rec, { id }));
            S.items.set(id, new Map());
          }
        }

        // 一次性把所有批次的条目读进来
        const wanted = [];
        const map = [];
        for (const [id, b] of S.batches) {
          for (let i = 0; i < (b.count || 0); i++) {
            wanted.push(itemKey(id, i));
            map.push([id, i]);
          }
        }
        if (wanted.length) {
          const items = await chrome.storage.local.get(wanted);
          for (let k = 0; k < wanted.length; k++) {
            const it = items[wanted[k]];
            if (!it) continue;
            const [bid, idx] = map[k];
            const bag = S.items.get(bid) || new Map();
            bag.set(idx, it);
            S.items.set(bid, bag);
          }
        }
      }

      S.loaded = true;
    })();
    try {
      await loadPromise;
    } finally {
      loadPromise = null;
    }
  }

  let loadPromise = null;

  /** 把旧版的单批次数据搬到新结构里 */
  async function migrateLegacy(oldBatch) {
    try {
      const id = oldBatch.id || CGR.uuid();
      const keys = [];
      for (let i = 0; i < oldBatch.count; i++) keys.push(`item:${i}`);
      const items = await chrome.storage.local.get(keys);
      const rec = newBatchRecord(oldBatch.name || '批次');
      rec.id = id;
      rec.count = oldBatch.count;
      rec.createdAt = oldBatch.createdAt || Date.now();

      for (let i = 0; i < oldBatch.count; i++) {
        const it = items[`item:${i}`];
        if (it) await chrome.storage.local.set({ [itemKey(id, i)]: it });
      }
      await chrome.storage.local.set({ [batchKey(id)]: rec, [K.INDEX]: [id] });
      await chrome.storage.local.remove(keys.concat(['batch']));
      S.logs.push({ t: Date.now(), level: 'info', message: `已把旧队列迁移成批次「${rec.name}」`, meta: null });
      return id;
    } catch (e) {
      return '';
    }
  }

  async function ensureLoaded() {
    if (!S.loaded) await load();
  }

  /* ---------------- 配置 ---------------- */

  function getCfg() {
    return S.cfg || Object.assign({}, CGR.DEFAULTS);
  }

  async function setCfg(patch) {
    await ensureLoaded();
    S.cfg = Object.assign({}, S.cfg, patch || {});
    await chrome.storage.local.set({ [K.CFG]: S.cfg });
    return S.cfg;
  }

  /* ---------------- 运行时（选中批次 / 标签页归属） ---------------- */

  function getRuntime() {
    return S.runtime || defaultRuntime();
  }

  async function setRuntime(patch) {
    await ensureLoaded();
    S.runtime = Object.assign({}, S.runtime, patch || {});
    await chrome.storage.local.set({ [K.RUNTIME]: S.runtime });
    return S.runtime;
  }

  /* ---------------- 批次 ---------------- */

  function listBatches() {
    return Array.from(S.batches.values()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  function getBatch(id) {
    return S.batches.get(id) || null;
  }

  function getSelectedId() {
    const rt = getRuntime();
    if (rt.selectedBatchId && S.batches.has(rt.selectedBatchId)) return rt.selectedBatchId;
    const first = listBatches()[0];
    return first ? first.id : '';
  }

  async function putBatch(batch) {
    await ensureLoaded();
    S.batches.set(batch.id, batch);
    await chrome.storage.local.set({ [batchKey(batch.id)]: batch });
    scheduleView();
    return batch;
  }

  async function createBatch(name) {
    await ensureLoaded();
    const id = CGR.uuid();
    const rec = newBatchRecord(name || `批次 ${S.batches.size + 1}`);
    rec.id = id;
    rec.createdAt = Date.now();
    S.batches.set(id, rec);
    S.items.set(id, new Map());
    await chrome.storage.local.set({ [batchKey(id)]: rec, [K.INDEX]: Array.from(S.batches.keys()) });
    await setRuntime({ selectedBatchId: id });
    scheduleView();
    return rec;
  }

  async function removeBatch(id) {
    await ensureLoaded();
    const b = S.batches.get(id);
    if (!b) return false;
    const keys = [batchKey(id)];
    for (let i = 0; i < (b.count || 0); i++) keys.push(itemKey(id, i));
    await chrome.storage.local.remove(keys);
    S.batches.delete(id);
    S.items.delete(id);
    await chrome.storage.local.set({ [K.INDEX]: Array.from(S.batches.keys()) });

    const rt = getRuntime();
    const activeTabs = Object.assign({}, rt.activeTabs);
    for (const [tid, info] of Object.entries(activeTabs)) {
      if (info && info.batchId === id) delete activeTabs[tid];
    }
    await setRuntime({ activeTabs, selectedBatchId: rt.selectedBatchId === id ? '' : rt.selectedBatchId });
    scheduleView();
    return true;
  }

  /* ---------------- 条目 ---------------- */

  function getItems(bid) {
    const bag = S.items.get(bid);
    if (!bag) return [];
    return Array.from(bag.values()).sort((a, b) => a.index - b.index);
  }

  function getItem(bid, i) {
    const bag = S.items.get(bid);
    return (bag && bag.get(i)) || null;
  }

  async function putItem(bid, item) {
    await ensureLoaded();
    item.batchId = bid;
    item.rev = (item.rev || 0) + 1;
    let bag = S.items.get(bid);
    if (!bag) {
      bag = new Map();
      S.items.set(bid, bag);
    }
    bag.set(item.index, item);
    await chrome.storage.local.set({ [itemKey(bid, item.index)]: item });
    scheduleView();
    return item;
  }

  /** 清空某批次的全部条目（不动批次本身） */
  async function clearItems(bid) {
    await ensureLoaded();
    const b = S.batches.get(bid);
    const keys = [];
    for (let i = 0; i < (b ? b.count : 0); i++) keys.push(itemKey(bid, i));
    if (keys.length) await chrome.storage.local.remove(keys);
    S.items.set(bid, new Map());
    if (b) {
      b.count = 0;
      await putBatch(b);
    }
  }

  function allItems() {
    const out = [];
    for (const bag of S.items.values()) out.push(...bag.values());
    return out;
  }

  /** 批次的实际下载目录：显式设置优先，否则 基础目录/批次名 */
  function resolveFolder(b) {
    const cfg = getCfg();
    const base = CGR.normalizeFolder(cfg.folder || 'chatgpt-images', 'chatgpt-images');
    if (b && b.folder) return CGR.normalizeFolder(b.folder, base);
    const sub = b && b.name ? CGR.normalizeFolder(b.name, '') : '';
    return sub ? `${base}/${sub}` : base;
  }

  /* ---------------- 日志 ---------------- */

  let logTimer = 0;
  function addLog(level, message, meta) {
    const entry = { t: Date.now(), level: level || 'info', message: String(message || ''), meta: meta || null };
    S.logs.push(entry);
    if (S.logs.length > CGR.LIMITS.maxLogs) S.logs.splice(0, S.logs.length - CGR.LIMITS.maxLogs);
    if (level === 'error') console.error('[CGR]', message, meta || '');
    else if (level === 'warn') console.warn('[CGR]', message, meta || '');
    else console.log('[CGR]', message, meta || '');

    if (!logTimer) {
      logTimer = setTimeout(() => {
        logTimer = 0;
        chrome.storage.local.set({ [K.LOG]: S.logs }).catch(() => {});
        scheduleView();
      }, 1000);
    }
  }

  function getLogs() {
    return S.logs.slice();
  }

  function clearLogs() {
    if (logTimer) {
      clearTimeout(logTimer);
      logTimer = 0;
    }
    S.logs = [];
    return chrome.storage.local.remove(K.LOG);
  }

  /**
   * 恢复出厂设置：清掉 chrome.storage.local 里的全部数据，并把内存缓存一起重置。
   * 调用方必须持有 withLock，且之后要重新 publishView()。
   */
  async function factoryReset() {
    await chrome.storage.local.clear();
    await clearLogs(); // 同时取消尚未落盘的日志写入定时器，避免旧日志被写回来
    S.cfg = Object.assign({}, CGR.DEFAULTS);
    S.runtime = defaultRuntime();
    S.batches.clear();
    S.items.clear();
    S.loaded = true;
    await chrome.storage.local.set({
      [K.CFG]: S.cfg,
      [K.RUNTIME]: S.runtime,
      [K.INDEX]: []
    });
    return { ok: true };
  }

  /* ---------------- 视图 ---------------- */

  let viewTimer = 0;
  let viewPending = false;
  function scheduleView() {
    viewPending = true;
    if (viewTimer) return;
    viewTimer = setTimeout(() => {
      viewTimer = 0;
      if (!viewPending) return;
      viewPending = false;
      publishView().catch(() => {});
    }, 200);
  }

  function countsOf(items) {
    const c = { total: items.length, pending: 0, active: 0, done: 0, failed: 0, needs_review: 0, skipped: 0 };
    for (const it of items) {
      if (c[it.status] != null) c[it.status] += 1;
      if (['claimed', 'sending', 'generating', 'downloading'].includes(it.status)) c.active += 1;
    }
    return c;
  }

  function compact(it) {
    return {
      i: it.index,
      s: it.status,
      a: it.attempt || 0,
      f: it.filename || '',
      e: it.error ? String(it.error.code || it.error.message || '').slice(0, 40) : '',
      p: String(it.prompt || '').slice(0, 240),
      r: (it.refImages || []).length,
      d: it.download && it.download.state ? it.download.state : ''
    };
  }

  async function publishView() {
    const batches = listBatches();
    const selId = getSelectedId();
    const rt = getRuntime();

    const batchRows = batches.map((b) => {
      const items = getItems(b.id);
      const c = countsOf(items);
      return {
        id: b.id,
        name: b.name,
        count: b.count || items.length,
        folder: b.folder || '',
        status: b.status || 'idle',
        limitUntil: b.limitUntil || 0,
        lastError: b.lastError || null,
        premiseCount: (b.premises || []).length,
        premiseEnabled: b.premiseEnabled !== false,
        // 前提内容随视图一起下发，侧边栏「前提」页可直接按批次名称编辑任意批次
        premises: (b.premises || []).slice(),
        counts: c,
        active: b.id === selId
      };
    });

    const cur = S.batches.get(selId);
    const curItems = cur ? getItems(selId) : [];
    const curCounts = countsOf(curItems);

    const view = {
      batches: batchRows,
      selectedId: selId,
      current: cur
        ? {
            id: cur.id,
            name: cur.name,
            folder: cur.folder || '',
            premises: cur.premises || [],
            premiseEnabled: cur.premiseEnabled !== false,
            status: cur.status || 'idle',
            limitUntil: cur.limitUntil || 0,
            startedAt: cur.startedAt || 0,
            lastClaimAt: cur.lastClaimAt || 0,
            lastError: cur.lastError || null,
            counts: curCounts,
            items: curItems.map(compact)
          }
        : null,
      runningTabIds: Object.entries(rt.activeTabs || {})
        .filter(([, v]) => v && v.batchId === selId)
        .map(([k]) => Number(k)),
      cfg: getCfg(),
      logs: S.logs.slice(-80),
      updatedAt: Date.now()
    };
    await chrome.storage.local.set({ [K.VIEW]: view });
  }

  root.CGR_STORE = {
    K,
    S,
    withLock,
    load,
    ensureLoaded,
    getCfg,
    setCfg,
    getRuntime,
    setRuntime,
    listBatches,
    getBatch,
    getSelectedId,
    putBatch,
    createBatch,
    removeBatch,
    getItems,
    getItem,
    putItem,
    clearItems,
    allItems,
    addLog,
    getLogs,
    clearLogs,
    factoryReset,
    publishView,
    scheduleView,
    countsOf,
    resolveFolder
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
