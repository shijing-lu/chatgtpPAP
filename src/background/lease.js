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

  function overLimit(it, cfg) {
    const max = it.maxAttempts || (cfg && cfg.maxAttempts) || 2;
    return (it.attempt || 0) >= max;
  }

  /** 回收某标签页的所有租约。reason='tab-reloaded' 时正在生成的任务转「待确认」 */
  async function reclaimByTab(tabId, reason) {
    const list = itemsByTab(tabId);
    const cfg = store.getCfg();
    const touched = [];
    for (const it of list) {
      const wasGenerating = it.status === CGR.STATUS.GENERATING || it.status === CGR.STATUS.DOWNLOADING;
      it.lease = null;
      it.tabId = null;
      if (wasGenerating && (reason === 'tab-reloaded' || reason === 'tab-dead')) {
        it.status = CGR.STATUS.NEEDS_REVIEW;
        it.error = { code: 'TAB_RELOADED', message: '页面刷新/关闭时正在生成，请确认是否已出图' };
      } else if (reason === 'stop') {
        it.status = CGR.STATUS.PENDING;
        it.attempt = 0;
      } else {
        // 任何形式的退回都意味着可能已经发出过提示词，必须计数，
        // 否则任务能被无限次重新领取、反复生成图片
        it.attempt = (it.attempt || 0) + 1;
        it.status = CGR.STATUS.PENDING;
        if (overLimit(it, cfg)) {
          it.status = CGR.STATUS.NEEDS_REVIEW;
          it.error = { code: 'LEASE_RECLAIMED', message: '执行端多次失联，已停止自动重试以免重复生图' };
        }
      }
      await store.putItem(it.batchId, it);
      touched.push(it);
    }
    if (touched.length) store.addLog('warn', `回收标签页 ${tabId} 的 ${touched.length} 条任务（${reason}）`);
    return touched;
  }

  /** 单条任务的总时长上限。取 max(常量, 等出图超时 + 2 分钟)，用户调大超时也不误伤。 */
  function itemDeadlineMs() {
    const cfg = store.getCfg() || {};
    return Math.max(CGR.LIMITS.itemDeadlineMs || 600000, (cfg.timeoutMs || 300000) + 120000);
  }

  /** 计时起点：领取时间与「真的发出去」的时间取较晚的一个。 */
  function startedAtOf(it) {
    const leaseAt = (it.lease && it.lease.acquiredAt) || 0;
    const sentAt = (it.ts && it.ts.sentAt) || 0;
    const dlAt = (it.download && it.download.startedAt) || 0;
    return Math.max(leaseAt, sentAt, dlAt);
  }

  /**
   * 看门狗：收敛长时间停在 ACTIVE 的任务。
   *
   * 为什么 sweepExpired 不够：页面心跳每 20 秒续一次租约，卡死的任务永远不会「过期」。
   * 而 scan() 的自愈看到 anyActive 直接跳过，于是整批队列被一条任务无限期占住——
   * 表现就是「执行到一半就不执行了」：批次还写着运行中，却再也不发下一条。
   *
   * 收敛策略（绝不重发已经发出的提示词）：
   *  - 生成中 / 下载中：转「待确认」，attempt 不变，用户可自行确认是否已出图；
   *  - 已分配 / 发送中：退回队列重试一次，超过重试上限转「待确认」。
   */
  async function sweepStuck() {
    const now = Date.now();
    const maxAge = itemDeadlineMs();
    const cfg = store.getCfg();
    const mins = Math.round(maxAge / 60000);
    const touched = [];
    let quiet = 0;
    for (const b of store.listBatches()) {
      for (const it of store.getItems(b.id)) {
        if (!ACTIVE.includes(it.status)) continue;
        const startedAt = startedAtOf(it);
        if (!startedAt || now - startedAt < maxAge) continue;

        const sent =
          !!(it.ts && it.ts.sentAt) ||
          it.status === CGR.STATUS.GENERATING ||
          it.status === CGR.STATUS.DOWNLOADING;
        it.lease = null;
        it.tabId = null;
        if (sent) {
          it.status = CGR.STATUS.NEEDS_REVIEW;
          it.error = {
            code: 'ITEM_STALLED',
            message: `单条任务超过 ${mins} 分钟没结果，已停止等待（不会重发提示词，请确认是否已出图）`
          };
        } else {
          it.attempt = (it.attempt || 0) + 1;
          if (overLimit(it, cfg)) {
            it.status = CGR.STATUS.NEEDS_REVIEW;
            it.error = { code: 'ITEM_STALLED', message: `单条任务超过 ${mins} 分钟没能发出，已重试 ${it.attempt} 次` };
          } else {
            it.status = CGR.STATUS.PENDING;
            it.error = { code: 'ITEM_STALLED', message: '执行超时，已退回队列重试' };
          }
        }
        await store.putItem(b.id, it);
        touched.push(it);
        if (touched.length <= 5) {
          const toReview = it.status === CGR.STATUS.NEEDS_REVIEW;
          const tail = sent ? '，不会重发提示词' : toReview ? '，不再自动重试' : '，稍后自动重试';
          store.addLog(
            'warn',
            `#${it.index + 1} 单条任务超过 ${mins} 分钟没结果（${sent ? '已发出提示词' : '还没发出去'}），看门狗已收敛为「${
              toReview ? '待确认' : '待生成'
            }」${tail}`
          );
        } else {
          quiet += 1;
        }
      }
    }
    if (quiet) store.addLog('warn', `另有 ${quiet} 条超时任务被看门狗收敛为待确认/待生成`);
    return touched;
  }

  /** 重试次数已用尽、却还挂在「待生成」的条目要转成待确认。
   * findClaimable 会静默跳过它们（不改状态），导致 maybeFinish 永远认为还有剩余，
   * 批次卡在「运行中」而页面只回「队列里没有可领的任务」——看起来就是跑一半停了。 */
  async function normalizeExhausted() {
    const cfg = store.getCfg();
    const now = Date.now();
    const touched = [];
    for (const b of store.listBatches()) {
      for (const it of store.getItems(b.id)) {
        if (it.status !== CGR.STATUS.PENDING) continue;
        if (it.lease && it.lease.expiresAt > now) continue;
        if (!overLimit(it, cfg)) continue;
        it.lease = null;
        it.status = CGR.STATUS.NEEDS_REVIEW;
        it.error = {
          code: 'RETRY_EXHAUSTED',
          message: `已重试 ${it.attempt} 次仍没成功，已转到待确认，不再占用队列`
        };
        await store.putItem(b.id, it);
        touched.push(it);
      }
    }
    if (touched.length) {
      store.addLog('warn', `${touched.length} 条任务重试次数已用尽，已转「待确认」，避免队列空转`);
    }
    return touched;
  }

  async function sweepExpired() {
    const now = Date.now();
    const cfg = store.getCfg();
    const touched = [];
    for (const b of store.listBatches()) {
      for (const it of store.getItems(b.id)) {
        if (!it.lease || it.lease.expiresAt > now) continue;
        it.lease = null;
        it.tabId = null;
        if (it.status === CGR.STATUS.GENERATING || it.status === CGR.STATUS.DOWNLOADING) {
          // 已经发出过提示词，图可能已经生成，绝不能退回队列重新跑
          it.status = CGR.STATUS.NEEDS_REVIEW;
          it.error = { code: 'LEASE_EXPIRED', message: '执行超时或执行端失联，请确认是否已出图' };
        } else if (ACTIVE.includes(it.status)) {
          it.attempt = (it.attempt || 0) + 1;
          it.status = CGR.STATUS.PENDING;
          if (overLimit(it, cfg)) {
            it.status = CGR.STATUS.NEEDS_REVIEW;
            it.error = { code: 'LEASE_EXPIRED', message: '执行端多次失联，已停止自动重试以免重复生图' };
          }
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
    const cfg = store.getCfg();
    const touched = [];
    for (const it of store.getItems(bid)) {
      if (!it.lease && !ACTIVE.includes(it.status)) continue;
      it.lease = null;
      it.tabId = null;
      if (ACTIVE.includes(it.status)) {
        it.status = CGR.STATUS.PENDING;
        if (reason === 'stop') {
          it.attempt = 0; // 用户主动停止：允许之后手动重新跑
        } else {
          // 限额恢复等自动退回也会重发提示词，必须计入次数
          it.attempt = (it.attempt || 0) + 1;
          if (overLimit(it, cfg)) {
            it.status = CGR.STATUS.NEEDS_REVIEW;
            it.error = { code: 'BATCH_RELEASED', message: '批次多次自动退回，已停止自动重试以免重复生图' };
          }
        }
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
    sweepStuck,
    normalizeExhausted,
    sweepExpired,
    releaseBatch
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
