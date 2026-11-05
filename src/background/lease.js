/* 租约：保证同一条任务不会被两个标签页同时执行。
 * 所有函数都必须在 store.withLock 内部调用（由 orchestrator 负责加锁）。 */
(function (root) {
  const CGR = root.CGR;
  const store = root.CGR_STORE;

  const ACTIVE = ['claimed', 'sending', 'generating', 'downloading'];

  function isLeased(item, now) {
    return !!(item && item.lease && item.lease.expiresAt > (now || Date.now()));
  }

  function findClaimable() {
    const cfg = store.getCfg();
    const now = Date.now();
    let best = null;
    for (const it of store.allItems()) {
      if (it.status !== CGR.STATUS.PENDING) continue;
      if (it.lease && it.lease.expiresAt > now) continue;
      if ((it.attempt || 0) >= (it.maxAttempts || cfg.maxAttempts || 2)) continue;
      if (!best || it.index < best.index) best = it;
    }
    return best;
  }

  async function grant(tabId, convId) {
    const item = findClaimable();
    if (!item) return null;
    const now = Date.now();
    const token = CGR.uuid();
    item.lease = { token, tabId, convId: convId || '', acquiredAt: now, renewedAt: now, expiresAt: now + CGR.LIMITS.leaseTtlMs };
    item.status = CGR.STATUS.CLAIMED;
    item.tabId = tabId;
    await store.putItem(item);
    return item;
  }

  function itemsByTab(tabId) {
    return store.allItems().filter((it) => it.lease && it.lease.tabId === tabId);
  }

  async function renewByTab(tabId) {
    const now = Date.now();
    const list = itemsByTab(tabId);
    for (const it of list) {
      it.lease.renewedAt = now;
      it.lease.expiresAt = now + CGR.LIMITS.leaseTtlMs;
      await store.putItem(it);
    }
    return list.length;
  }

  async function renewByToken(token) {
    const now = Date.now();
    for (const it of store.allItems()) {
      if (it.lease && it.lease.token === token) {
        it.lease.renewedAt = now;
        it.lease.expiresAt = now + CGR.LIMITS.leaseTtlMs;
        await store.putItem(it);
        return it;
      }
    }
    return null;
  }

  function findByToken(token) {
    for (const it of store.allItems()) {
      if (it.lease && it.lease.token === token) return it;
    }
    return null;
  }

  /** 回收某标签页的所有租约。reason='tab-closed' 时不惩罚 attempt。 */
  async function reclaimByTab(tabId, reason) {
    const list = itemsByTab(tabId);
    const touched = [];
    for (const it of list) {
      const wasGenerating = it.status === CGR.STATUS.GENERATING || it.status === CGR.STATUS.DOWNLOADING;
      it.lease = null;
      it.tabId = null;
      // 生成到一半执行端消失（页面刷新、崩溃、失联），保守起见转「待确认」而不是自动重发，避免重复消耗配额
      if (wasGenerating && (reason === 'tab-reloaded' || reason === 'tab-dead')) {
        it.status = CGR.STATUS.NEEDS_REVIEW;
        it.error = { code: 'TAB_RELOADED', message: '页面刷新/关闭时正在生成，请确认是否已出图' };
      } else {
        it.status = CGR.STATUS.PENDING;
        if (reason === 'timeout') it.attempt = (it.attempt || 0) + 1;
      }
      await store.putItem(it);
      touched.push(it);
    }
    if (touched.length) {
      store.addLog('warn', `回收标签页 ${tabId} 的 ${touched.length} 条任务（${reason}）`);
    }
    return touched;
  }

  async function sweepExpired() {
    const now = Date.now();
    const touched = [];
    for (const it of store.allItems()) {
      if (it.lease && it.lease.expiresAt <= now) {
        it.lease = null;
        it.tabId = null;
        if (it.status === CGR.STATUS.GENERATING || it.status === CGR.STATUS.DOWNLOADING) {
          it.status = CGR.STATUS.NEEDS_REVIEW;
          it.error = { code: 'LEASE_EXPIRED', message: '执行超时或执行端失联，请确认是否已出图' };
        } else {
          it.status = CGR.STATUS.PENDING;
        }
        await store.putItem(it);
        touched.push(it);
      }
    }
    if (touched.length) store.addLog('warn', `清扫 ${touched.length} 条过期租约`);
    return touched;
  }

  async function releaseAll(reason) {
    const touched = [];
    for (const it of store.allItems()) {
      if (it.lease || ACTIVE.includes(it.status)) {
        it.lease = null;
        it.tabId = null;
        if (ACTIVE.includes(it.status)) {
          it.status = CGR.STATUS.PENDING;
          if (reason === 'stop') it.attempt = 0;
        }
        await store.putItem(it);
        touched.push(it);
      }
    }
    return touched;
  }

  root.CGR_LEASE = {
    ACTIVE,
    isLeased,
    findClaimable,
    grant,
    itemsByTab,
    renewByTab,
    renewByToken,
    findByToken,
    reclaimByTab,
    sweepExpired,
    releaseAll
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
