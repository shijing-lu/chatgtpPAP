/* 存储层：chrome.storage.local 是唯一真相源。
 * 铁律 1：所有写操作必须经 withLock() 串行，绝不做并发 read-modify-write。
 * 铁律 2：内存里的 S 只是可重建的缓存，SW 重启后从 storage 完整重建。
 * 写粒度：单条 item 独立 key，避免整表覆盖。 */
(function (root) {
  const CGR = root.CGR;
  const K = {
    CFG: 'cfg',
    RUNTIME: 'runtime',
    BATCH: 'batch',
    VIEW: 'view',
    LOG: 'log'
  };
  const itemKey = (i) => `item:${i}`;

  const S = { cfg: null, runtime: null, batch: null, items: new Map(), logs: [], loaded: false };

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
    return {
      status: CGR.GLOBAL.IDLE,
      limitUntil: 0,
      startedAt: 0,
      pausedByUser: false,
      lastError: null,
      activeTabs: {},
      stats: { done: 0, failed: 0, needsReview: 0, skipped: 0 }
    };
  }

  function defaultBatch() {
    return { id: '', name: '', createdAt: 0, count: 0 };
  }

  let loadPromise = null;

  async function load() {
    if (S.loaded) return;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const data = await chrome.storage.local.get([K.CFG, K.RUNTIME, K.BATCH, K.LOG]);
      S.cfg = Object.assign({}, CGR.DEFAULTS, data[K.CFG] || {});
      S.runtime = Object.assign(defaultRuntime(), data[K.RUNTIME] || {});
      S.batch = Object.assign(defaultBatch(), data[K.BATCH] || {});
      S.logs = Array.isArray(data[K.LOG]) ? data[K.LOG] : [];
      S.items.clear();

      if (S.batch && S.batch.count > 0) {
        const keys = [];
        for (let i = 0; i < S.batch.count; i++) keys.push(itemKey(i));
        const items = await chrome.storage.local.get(keys);
        for (let i = 0; i < S.batch.count; i++) {
          const it = items[itemKey(i)];
          if (it) S.items.set(i, it);
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

  async function ensureLoaded() {
    if (!S.loaded) await load();
  }

  function getCfg() {
    return S.cfg || Object.assign({}, CGR.DEFAULTS);
  }

  async function setCfg(patch) {
    await ensureLoaded();
    S.cfg = Object.assign({}, S.cfg, patch || {});
    await chrome.storage.local.set({ [K.CFG]: S.cfg });
    return S.cfg;
  }

  function getRuntime() {
    return S.runtime || defaultRuntime();
  }

  async function setRuntime(patch) {
    await ensureLoaded();
    S.runtime = Object.assign({}, S.runtime, patch || {});
    await chrome.storage.local.set({ [K.RUNTIME]: S.runtime });
    return S.runtime;
  }

  function getBatch() {
    return S.batch || defaultBatch();
  }

  async function setBatch(batch) {
    await ensureLoaded();
    S.batch = Object.assign(defaultBatch(), batch || {});
    await chrome.storage.local.set({ [K.BATCH]: S.batch });
    return S.batch;
  }

  function allItems() {
    return Array.from(S.items.values()).sort((a, b) => a.index - b.index);
  }

  function getItem(i) {
    return S.items.get(i) || null;
  }

  async function putItem(item) {
    await ensureLoaded();
    item.rev = (item.rev || 0) + 1;
    S.items.set(item.index, item);
    await chrome.storage.local.set({ [itemKey(item.index)]: item });
    scheduleView();
    return item;
  }

  async function clearBatchStorage() {
    await ensureLoaded();
    const keys = [K.BATCH];
    for (let i = 0; i < S.batch.count; i++) keys.push(itemKey(i));
    keys.push(K.LOG);
    S.items.clear();
    S.logs = [];
    S.batch = defaultBatch();
    await chrome.storage.local.remove(keys);
    await chrome.storage.local.set({ [K.BATCH]: S.batch, [K.LOG]: [] });
  }

  /* ---------- 日志 ---------- */
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

  /* ---------- 视图（供侧边栏渲染，减少 storage 读放大） ---------- */
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

  async function publishView() {
    const items = allItems();
    const counts = {
      total: items.length,
      pending: 0,
      active: 0,
      done: 0,
      failed: 0,
      needs_review: 0,
      skipped: 0
    };
    const compact = items.map((it) => {
      if (counts[it.status] != null) counts[it.status] += 1;
      if (['claimed', 'sending', 'generating', 'downloading'].includes(it.status)) counts.active += 1;
      return {
        i: it.index,
        s: it.status,
        a: it.attempt || 0,
        f: it.filename || '',
        e: it.error ? String(it.error.code || it.error.message || '').slice(0, 40) : '',
        p: String(it.prompt || '').slice(0, 240),
        d: it.download && it.download.state ? it.download.state : ''
      };
    });

    const view = {
      status: getRuntime().status,
      limitUntil: getRuntime().limitUntil || 0,
      lastError: getRuntime().lastError || null,
      startedAt: getRuntime().startedAt || 0,
      lastClaimAt: getRuntime().lastClaimAt || 0,
      runningTabIds: Object.keys(getRuntime().activeTabs || {}).map(Number),
      batch: { name: getBatch().name || '', count: getBatch().count || 0, id: getBatch().id || '' },
      cfg: getCfg(),
      counts,
      items: compact,
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
    getBatch,
    setBatch,
    allItems,
    getItem,
    putItem,
    clearBatchStorage,
    addLog,
    getLogs,
    publishView,
    scheduleView,
    itemKey
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
