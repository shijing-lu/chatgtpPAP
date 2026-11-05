/* 租约：保证同一条任务不会被两个标签页同时执行（按批次隔离）。
 * 所有函数都必须在 store.withLock 内部调用。 */
(function (root) {
  const CGR = root.CGR;
  const store = root.CGR_STORE;

  const ACTIVE = ['claimed', 'sending', 'generating', 'downloading'];

  function isLeased(item, now) {
    return !!(item && item.lease && item.lease.expiresAt > (now || Date.now()));
  }

  function findClaimable(bid) {
    const b = store.getBatch(bid);
    if (!b) return null;
    const cfg = store.getCfg();
    const now = Date.now();
    let best = null;
    for (const it of store.getItems(bid)) {
      if (it.status !== CGR.STATUS.PENDING) continue;
      if (it.lease && it.lease.expiresAt > now) continue;
      if ((it.attempt || 0) >= (it.maxAttempts || cfg.maxAttempts || 2)) continue;
      if (!best || it.index < best.index) best = it;
    }
    return best;
  }

  async function grant(bid, tabId, convId) {
    const item = findClaimable(bid);
    if (!item) return null;
    const now = Date.now();
    const token = CGR.uuid();
    item.lease = {
      token,
      tabId,
      batchId: bid,
      convId: convId || '',
      acquiredAt: now,
      renewedAt: now,
      expiresAt: now + CGR.LIMITS.leaseTtlMs
    };
    item.status = CGR.STATUS.CLAIMED;
    item.tabId = tabId;
    await store.putItem(bid, item);
    return item;
  }

  function itemsByTab(tabId) {
    const out = [];
    for (const b of store.listBatches()) {
      for (const it of store.getItems(b.id)) {
        if (it.lease && it.lease.tabId === tabId) out.push(it);
      }
    }
    return out;
  }

  async function renewByTab(tabId) {
    const now = Date.now();
    const list = itemsByTab(tabId);
    for (const it of list) {
      it.lease.renewedAt = now;
      it.lease.expiresAt = now + CGR.LIMITS.leaseTtlMs;
      await store.putItem(it.batchId, it);
    }
    return list.length;
  }

  function findByToken(token) {
    for (const b of store.listBatches()) {
      for (const it of store.getItems(b.id)) {
        if (it.lease && it.lease.token === token) return it;
      }
    }
    return null;
  }

  async function renewByToken(token) {
    const it = findByToken(token);
    if (!it) return null;
    const now = Date.now();
    it.lease.renewedAt = now;
    it.lease.expiresAt = now + CGR.LIMITS.leaseTtlMs;
    await store.putItem(it.batchId, it);
    return it;
  }

  /** 回收某标签页的所有租约。reason='tab-reloaded' 时正在生成的任务转「待确认」 */
  async function reclaimByTab(tabId, reason) {
    const list = itemsByTab(tabId);
    const touched = [];
    for (const it of list) {
      const wasGenerating = it.status === CGR.STATUS.GENERATING || it.status === CGR.STATUS.DOWNLOADING;
      it.lease = null;
      it.tabId = null;
      if (wasGenerating && (reason === 'tab-reloaded' || reason === 'tab-dead')) {
        it.status = CGR.STATUS.NEEDS_REVIEW;
        it.error = { code: 'TAB_RELOADED', message: '页面刷新/关闭时正在生成，请确认是否已出图' };
      } else {
        it.status = CGR.STATUS.PENDING;
        if (reason === 'timeout') it.attempt = (it.attempt || 0) + 1;
      }
      await store.putItem(it.batchId, it);
      touched.push(it);
    }
    if (touched.length) store.addLog('warn', `回收标签页 ${tabId} 的 ${touched.length} 条任务（${reason}）`);
    return touched;
  }

  async function sweepExpired() {
    const now = Date.now();
    const touched = [];
    for (const b of store.listBatches()) {
      for (const it of store.getItems(b.id)) {
        if (!it.lease || it.lease.expiresAt > now) continue;
        it.lease = null;
        it.tabId = null;
        if (it.status === CGR.STATUS.GENERATING || it.status === CGR.STATUS.DOWNLOADING) {
          it.status = CGR.STATUS.NEEDS_REVIEW;
          it.error = { code: 'LEASE_EXPIRED', message: '执行超时或执行端失联，请确认是否已出图' };
        } else if (ACTIVE.includes(it.status)) {
          it.status = CGR.STATUS.PENDING;
        }
        await store.putItem(b.id, it);
        touched.push(it);
      }
    }
    if (touched.length) store.addLog('warn', `清扫 ${touched.length} 条过期租约`);
    return touched;
  }

  /** 释放单个批次的租约（不影响其他批次） */
  async function releaseBatch(bid, reason) {
    const touched = [];
    for (const it of store.getItems(bid)) {
      if (!it.lease && !ACTIVE.includes(it.status)) continue;
      it.lease = null;
      it.tabId = null;
      if (ACTIVE.includes(it.status)) {
        it.status = CGR.STATUS.PENDING;
        if (reason === 'stop') it.attempt = 0;
      }
      await store.putItem(bid, it);
      touched.push(it);
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
    releaseBatch
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
