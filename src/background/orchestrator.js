/* 队列编排（多批次）：批次增删改、任务入队、按批次的运行状态机、租约派发、结果处理。
 * 所有对 store 的写操作都经 store.withLock()。 */
(function (root) {
  const CGR = root.CGR;
  const store = root.CGR_STORE;
  const lease = root.CGR_LEASE;
  const dl = root.CGR_DL;
  const tabs = root.CGR_TABS;

  const G = CGR.GLOBAL;
  const S = CGR.STATUS;

  let sendFailStreak = 0;

  /* ---------------- 工具 ---------------- */

  function stampName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `批次_${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
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

  function batchLabel(b) {
    return b ? `「${b.name}」` : '';
  }

  async function maybeFinish(bid) {
    const b = store.getBatch(bid);
    if (!b) return;
    if (b.status !== G.RUNNING && b.status !== G.PAUSED) return;
    const items = store.getItems(bid);
    if (!items.length) return;
    const remaining = items.filter((it) => [S.PENDING, S.CLAIMED, S.SENDING, S.GENERATING, S.DOWNLOADING].includes(it.status)).length;
    if (remaining === 0) {
      b.status = G.FINISHED;
      await store.putBatch(b);
      const done = items.filter((i) => i.status === S.DONE).length;
      store.addLog('info', `${batchLabel(b)}全部处理完毕：成功 ${done} / 共 ${items.length}`);
    }
  }

  async function tabsOfBatch(bid) {
    const rt = store.getRuntime();
    return Object.entries(rt.activeTabs || {})
      .filter(([, v]) => v && v.batchId === bid)
      .map(([k]) => Number(k));
  }

  async function wakeBatch(bid) {
    const ids = await tabsOfBatch(bid);
    for (const id of ids) await tabs.send(id, { type: CGR.MSG.WAKE });
  }

  /* ---------------- 批次管理 ---------------- */

  async function createBatch(name) {
    return store.withLock(async () => {
      await store.ensureLoaded();
      const rec = await store.createBatch(String(name || '').trim() || stampName());
      store.addLog('info', `新建批次${batchLabel(rec)}`);
      await store.publishView();
      return { ok: true, batch: { id: rec.id, name: rec.name } };
    });
  }

  async function updateBatch(id, patch) {
    return store.withLock(async () => {
      await store.ensureLoaded();
      const b = store.getBatch(id);
      if (!b) return { ok: false, error: '批次不存在' };
      if (patch && typeof patch.name === 'string' && patch.name.trim()) b.name = patch.name.trim();
      if (patch && typeof patch.folder === 'string') b.folder = CGR.normalizeFolder(patch.folder, '');
      if (patch && Array.isArray(patch.premises)) b.premises = patch.premises.map((s) => String(s || '').trim()).filter(Boolean);
      if (patch && typeof patch.premiseEnabled === 'boolean') b.premiseEnabled = patch.premiseEnabled;
      await store.putBatch(b);
      await store.publishView();
      return {
        ok: true,
        batch: { id: b.id, name: b.name, folder: b.folder, premises: b.premises, premiseEnabled: b.premiseEnabled }
      };
    });
  }

  async function deleteBatch(id) {
    return store.withLock(async () => {
      await store.ensureLoaded();
      const b = store.getBatch(id);
      if (!b) return { ok: false, error: '批次不存在' };
      const ids = await tabsOfBatch(id);
      await lease.releaseBatch(id, 'stop');
      for (const tid of ids) await tabs.send(tid, { type: CGR.MSG.ABORT });

      const rt = store.getRuntime();
      const activeTabs = Object.assign({}, rt.activeTabs);
      for (const tid of ids) delete activeTabs[tid];
      await store.setRuntime({ activeTabs });

      await store.removeBatch(id);
      await gcImages();
      store.addLog('info', `已删除批次${batchLabel(b)}`);
      await store.publishView();
      return { ok: true };
    });
  }

  async function selectBatch(id) {
    return store.withLock(async () => {
      await store.setRuntime({ selectedBatchId: id });
      await store.publishView();
      return { ok: true };
    });
  }

  /* ---------------- 入队 ---------------- */

  async function addItem(bid, prompt, refImages) {
    return store.withLock(async () => {
      await store.ensureLoaded();
      let batch = store.getBatch(bid);
      if (!batch) {
        const first = store.listBatches()[0];
        if (!first) return { ok: false, error: '还没有批次，请先新建一个' };
        batch = first;
        bid = first.id;
      }

      const text = String(prompt || '').trim();
      if (!text) return { ok: false, error: '提示词不能为空' };

      const items = store.getItems(bid);
      if (items.length >= CGR.LIMITS.maxPromptsPerBatch) {
        return { ok: false, error: `单个批次最多 ${CGR.LIMITS.maxPromptsPerBatch} 条` };
      }

      const cfg = store.getCfg();
      const refs = (Array.isArray(refImages) ? refImages : [])
        .filter((r) => r && r.id)
        .map((r) => ({ id: r.id, name: r.name || '', type: r.type || '' }));

      const item = {
        index: items.length,
        batchId: bid,
        prompt: text,
        refImages: refs,
        status: S.PENDING,
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
        ts: { queuedAt: Date.now() }
      };
      await store.putItem(bid, item);
      batch.count = items.length + 1;
      await store.putBatch(batch);
      await store.publishView();
      return { ok: true, index: item.index, count: batch.count, refCount: refs.length, batchName: batch.name };
    });
  }

  /**
   * 批量入队（Markdown 导入用）。整批在一个锁里写完，只发布一次视图。
   * @param {string} bid 批次 id
   * @param {Array<{prompt:string}>} list
   */
  async function addItems(bid, list) {
    return store.withLock(async () => {
      await store.ensureLoaded();
      let batch = store.getBatch(bid);
      if (!batch) {
        const first = store.listBatches()[0];
        if (!first) return { ok: false, error: '还没有批次，请先新建一个' };
        batch = first;
        bid = first.id;
      }

      const incoming = Array.isArray(list) ? list : [];
      if (!incoming.length) return { ok: false, error: '没有可导入的提示词' };

      const cfg = store.getCfg();
      const items = store.getItems(bid);
      const room = Math.max(0, CGR.LIMITS.maxPromptsPerBatch - items.length);
      const now = Date.now();

      let added = 0;
      let empty = 0;
      let overLimit = 0;

      for (const raw of incoming) {
        const text = String((raw && raw.prompt) || '').trim();
        if (!text) {
          empty += 1;
          continue;
        }
        if (added >= room) {
          overLimit += 1;
          continue;
        }
        const item = {
          index: items.length + added,
          batchId: bid,
          prompt: text,
          refImages: [],
          status: S.PENDING,
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
        await store.putItem(bid, item);
        added += 1;
      }

      if (added) {
        batch.count = items.length + added;
        await store.putBatch(batch);
      }
      await store.publishView();

      if (added) {
        store.addLog(
          'info',
          `从 Markdown 导入 ${added} 条到「${batch.name}」${overLimit ? `，${overLimit} 条超出上限未加入` : ''}`
        );
      }
      return {
        ok: added > 0,
        added,
        empty,
        overLimit,
        count: items.length + added,
        batchName: batch.name,
        error: added ? undefined : `单个批次最多 ${CGR.LIMITS.maxPromptsPerBatch} 条，没有空间再加入`
      };
    });
  }

  /* ---------------- 运行控制 ---------------- */

  /**
   * 给批次绑定执行标签页并接管页面（优先复用当前 ChatGPT 标签页）。
   * 不加锁：调用方必须已经持有 store.withLock，否则与 scan/claim 会互相踩。
   */
  async function bindTabs(b, desired, focus, switchSelection) {
    const secured = await tabs.ensureBatchTabs(b, desired, focus);

    const rt = store.getRuntime();
    const activeTabs = Object.assign({}, rt.activeTabs);
    for (const id of secured.ids) {
      activeTabs[id] = Object.assign({}, activeTabs[id], {
        batchId: b.id, state: 'idle', stale: false, at: Date.now()
      });
    }
    const patch = { activeTabs };
    if (switchSelection) patch.selectedBatchId = b.id;
    await store.setRuntime(patch);

    const ready = [];
    const dead = [];
    for (const id of secured.ids) {
      const ok = await tabs.ensureContentScript(id);
      (ok ? ready : dead).push(id);
    }

    // 刚打开的页面 content script 可能还没挂上，隔一会儿再确认一次，
    // 别把「页面还在加载」误判成「这个标签页废了」。
    if (dead.length) {
      await CGR.sleep(1200);
      for (let i = dead.length - 1; i >= 0; i--) {
        const id = dead[i];
        if (await tabs.ensureContentScript(id)) {
          dead.splice(i, 1);
          ready.push(id);
        }
      }
    }

    b.windowId = secured.windowId;
    return { ready, dead };
  }

  async function start(bid) {
    return store.withLock(async () => {
      await store.ensureLoaded();
      const b = store.getBatch(bid);
      if (!b) return { ok: false, error: '批次不存在' };

      const items = store.getItems(bid);
      if (!items.length) return { ok: false, error: `批次${batchLabel(b)}还没有提示词` };
      if (!items.some((it) => it.status === S.PENDING)) return { ok: false, error: '这个批次没有待生成的任务' };

      const n = effectiveConcurrency();
      const othersRunning = store.listBatches().some((x) => x.id !== bid && x.status === G.RUNNING);
      const bound = await bindTabs(b, n, !othersRunning, true);

      // 一个标签页都接管不了时，绝不能把状态留在「运行中」——那就是「点了开始永远没反应」。
      if (!bound.ready.length) {
        b.status = G.ERROR;
        b.startedAt = 0;
        b.lastError = '没有可接管的 ChatGPT 标签页，请打开或刷新 chatgpt.com 后点「开始」';
        await store.putBatch(b);
        store.addLog('error', `开始${batchLabel(b)}失败：${bound.dead.length} 个标签页都无法接管`);
        await store.publishView();
        return { ok: false, error: b.lastError };
      }

      b.status = G.RUNNING;
      b.startedAt = Date.now();
      b.lastClaimAt = 0;
      b.limitUntil = 0;
      b.lastError = null;
      await store.putBatch(b);

      store.addLog('info', `开始${batchLabel(b)}，并发 ${n}，已接管标签页：${bound.ready.join(', ')}`);
      for (const id of bound.ready) await tabs.send(id, { type: CGR.MSG.WAKE });
      await store.publishView();

      if (bound.dead.length) {
        return { ok: true, tabs: bound.ready.length, warning: `批次${batchLabel(b)}有 ${bound.dead.length} 个标签页无法接管，请刷新对应页面后点「继续」` };
      }
      return { ok: true, tabs: bound.ready.length };
    });
  }

  /**
   * 自愈：批次显示运行中、却没有标签页在领任务时，重新绑定并唤醒页面。
   * 不加锁，由 scheduler.scan / FIX_TABS 在锁内调用。
   */
  async function rebindBatch(bid) {
    const b = store.getBatch(bid);
    if (!b || b.status !== G.RUNNING) return { ok: false, reason: 'not-running' };
    const bound = await bindTabs(b, effectiveConcurrency(), false, false);
    if (!bound.ready.length) return { ok: false, reason: 'no-tab' };
    b.lastClaimAt = 0;
    await store.putBatch(b);
    for (const id of bound.ready) await tabs.send(id, { type: CGR.MSG.WAKE });
    return { ok: true, tabs: bound.ready.length };
  }

  async function pause(bid) {
    return store.withLock(async () => {
      const b = store.getBatch(bid);
      if (!b) return { ok: false, error: '批次不存在' };
      if (b.status !== G.RUNNING) return { ok: false, error: '当前不在运行中' };
      b.status = G.PAUSED;
      await store.putBatch(b);
      store.addLog('info', `${batchLabel(b)}已暂停：当前这张跑完后不再继续`);
      return { ok: true };
    });
  }

  async function resume(bid) {
    return store.withLock(async () => {
      const b = store.getBatch(bid);
      if (!b) return { ok: false, error: '批次不存在' };
      if (!store.getItems(bid).some((it) => it.status === S.PENDING)) return { ok: false, error: '没有待生成的任务' };
      b.status = G.RUNNING;
      b.limitUntil = 0;
      await store.putBatch(b);
      await wakeBatch(bid);
      store.addLog('info', `${batchLabel(b)}继续执行`);
      return { ok: true };
    });
  }

  async function stop(bid) {
    return store.withLock(async () => {
      const b = store.getBatch(bid);
      if (!b) return { ok: false, error: '批次不存在' };
      const ids = await tabsOfBatch(bid);
      await lease.releaseBatch(bid, 'stop');
      b.status = G.IDLE;
      b.startedAt = 0;
      b.limitUntil = 0;
      await store.putBatch(b);

      // 保留标签页归属：下次「开始」直接复用这个窗口，不重复开新窗口
      const rt = store.getRuntime();
      const activeTabs = Object.assign({}, rt.activeTabs);
      for (const tid of ids) {
        if (activeTabs[tid]) activeTabs[tid] = Object.assign({}, activeTabs[tid], { state: 'idle', at: Date.now() });
      }
      await store.setRuntime({ activeTabs });

      for (const tid of ids) await tabs.send(tid, { type: CGR.MSG.ABORT });
      store.addLog('info', `${batchLabel(b)}已停止，任务已退回待生成`);
      await store.publishView();
      return { ok: true };
    });
  }

  /* ---------------- 租约派发 ---------------- */

  async function claim(tabId, convId) {
    return store.withLock(async () => {
      await store.ensureLoaded();
      const rt = store.getRuntime();
      const info = (rt.activeTabs || {})[tabId];
      const bid = info && info.batchId;
      if (!bid) return { ok: false, reason: 'no-batch' };

      const b = store.getBatch(bid);
      if (!b) return { ok: false, reason: 'no-batch' };
      if (b.status !== G.RUNNING) return { ok: false, reason: b.status };

      const cfg = store.getCfg();
      let item = null;

      if (b.hintIndex != null) {
        const hint = b.hintIndex;
        b.hintIndex = null;
        const it = store.getItem(bid, hint);
        if (it && (it.status === S.PENDING || it.status === S.NEEDS_REVIEW)) {
          const now = Date.now();
          it.lease = {
            token: CGR.uuid(),
            tabId,
            batchId: bid,
            convId: convId || '',
            acquiredAt: now,
            renewedAt: now,
            expiresAt: now + CGR.LIMITS.leaseTtlMs
          };
          it.status = S.CLAIMED;
          it.tabId = tabId;
          it.attempt = 0;
          it.error = null;
          await store.putItem(bid, it);
          item = it;
        }
      }
      if (!item) item = await lease.grant(bid, tabId, convId);

      if (!item) {
        const activeTabs = Object.assign({}, store.getRuntime().activeTabs);
        if (activeTabs[tabId]) activeTabs[tabId].state = 'idle';
        await store.setRuntime({ activeTabs });
        await store.putBatch(b);
        return { ok: false, reason: 'drained' };
      }

      const activeTabs = Object.assign({}, store.getRuntime().activeTabs);
      activeTabs[tabId] = Object.assign({}, activeTabs[tabId], { batchId: bid, convId: convId || '', state: 'busy', at: Date.now() });
      await store.setRuntime({ activeTabs });

      b.lastClaimAt = Date.now();
      if (b.singleShot) {
        b.singleShot = false;
        b.status = G.PAUSED;
      }
      await store.putBatch(b);

      return {
        ok: true,
        leaseToken: item.lease.token,
        cfg,
        premises: b.premiseEnabled !== false && Array.isArray(b.premises) ? b.premises : [],
        item: {
          index: item.index,
          prompt: item.prompt,
          attempt: item.attempt,
          chatPrepared: item.chatPrepared,
          refImages: item.refImages || [],
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
    await store.putItem(item.batchId, item);
  }

  async function bumpStat(bid, key) {
    const b = store.getBatch(bid);
    if (!b) return;
    b.stats = Object.assign({}, b.stats, { [key]: ((b.stats && b.stats[key]) || 0) + 1 });
    await store.putBatch(b);
  }

  async function handleLimit(item, raw) {
    const b = store.getBatch(item.batchId);
    const cfg = store.getCfg();
    const until = Date.now() + Math.max(1, cfg.limitCooldownMin || 60) * 60000;
    await lease.releaseBatch(item.batchId, 'limit');
    if (b) {
      b.status = G.LIMIT_WAITING;
      b.limitUntil = until;
      b.lastError = null;
      await store.putBatch(b);
      store.addLog('warn', `${batchLabel(b)}触发生图限额，已自动暂停，${cfg.limitCooldownMin} 分钟后可继续。${String(raw || '').slice(0, 60)}`);
    }
    const ids = await tabsOfBatch(item.batchId);
    for (const id of ids) await tabs.send(id, { type: CGR.MSG.ABORT });
    return item;
  }

  async function handleRetryable(item, code, cfg) {
    item.attempt = (item.attempt || 0) + 1;
    const max = item.maxAttempts || cfg.maxAttempts || 2;

    if (code === 'NO_IMAGE' && cfg.onNoImage === 'skip') {
      await finalize(item, S.SKIPPED, { error: { code, message: '未出图，按设置跳过' } });
      await bumpStat(item.batchId, 'skipped');
      return { ok: true };
    }
    if (code === 'NO_IMAGE' && cfg.onNoImage === 'fail') {
      await finalize(item, S.FAILED, { error: { code, message: '未出图' } });
      await bumpStat(item.batchId, 'failed');
      return { ok: true };
    }

    if (item.attempt < max) {
      await finalize(item, S.PENDING, { error: { code, message: '重试中' }, chatPrepared: false });
    } else {
      await finalize(item, S.FAILED, { error: { code, message: `重试 ${max} 次仍失败` } });
      await bumpStat(item.batchId, 'failed');
      store.addLog('error', `#${item.index + 1} 失败（${code}），已重试 ${max} 次`);
    }
    return { ok: true };
  }

  async function handleOutcome(msg, senderTabId) {
    return store.withLock(async () => {
      await store.ensureLoaded();
      const token = msg.leaseToken;
      const item = token ? lease.findByToken(token) : null;
      if (!item) return { ok: false, error: 'lease-not-found' };

      const bid = item.batchId;
      const cfg = store.getCfg();
      const status = msg.status;
      const data = msg.data || {};

      if (status === 'LIMIT') {
        await handleLimit(item, data.raw);
        return { ok: true };
      }

      if (status === 'AUTH_REQUIRED') {
        await finalize(item, S.PENDING);
        const b = store.getBatch(bid);
        if (b) {
          b.status = G.ERROR;
          b.lastError = 'ChatGPT 未登录或登录已失效，请先在该标签页登录';
          await store.putBatch(b);
        }
        store.addLog('error', '检测到登录失效，任务已中止');
        return { ok: true };
      }

      if (status === 'IMAGE_READY') {
        const imgs = Array.isArray(data.images) ? data.images : [];
        const best = imgs.slice().sort((a, b) => (b.w || 0) * (b.h || 0) - (a.w || 0) * (a.h || 0))[0];
        if (!best || !best.src) return handleRetryable(item, 'NO_IMAGE', cfg);

        item.image = { src: best.src, w: best.w || 0, h: best.h || 0, kind: best.src.startsWith('blob:') ? 'blob' : 'https' };
        item.ts = Object.assign({}, item.ts, { imageAt: Date.now() });
        sendFailStreak = 0;

        if (item.image.kind === 'blob') {
          await finalize(item, S.DOWNLOADING);
          item.tabId = senderTabId;
          await store.putItem(bid, item);
          await dl.requestFallback(item, 'blob-url');
        } else {
          await dl.startUrlDownload(item, best.src, CGR.extFromUrl(best.src));
        }
        return { ok: true };
      }

      if (status === 'NO_IMAGE') {
        store.addLog('warn', `#${item.index + 1} 未检测到图片（可能被拒答或只返回了文字）`);
        return handleRetryable(item, 'NO_IMAGE', cfg);
      }

      if (status === 'TIMEOUT') {
        if (data.stillGenerating) {
          await finalize(item, S.NEEDS_REVIEW, { error: { code: 'TIMEOUT_GENERATING', message: '超时但仍在生成，请人工确认' } });
          await bumpStat(bid, 'needsReview');
          store.addLog('warn', `#${item.index + 1} 超时且仍在生成，标记为待确认`);
        } else {
          await handleRetryable(item, 'TIMEOUT', cfg);
        }
        return { ok: true };
      }

      if (status === 'ATTACH_FAILED') {
        store.addLog('warn', `#${item.index + 1} 参考图附加失败：${data.reason || '未知原因'}，本条将重试`);
        return handleRetryable(item, 'ATTACH_FAILED', cfg);
      }

      if (status === 'PREMISE_FAILED') {
        await finalize(item, S.PENDING, { chatPrepared: false });
        const b = store.getBatch(bid);
        if (b) {
          b.status = G.ERROR;
          b.lastError = `前提设定发送失败（${data.reason || '未知原因'}），请检查前提内容后点「开始」重试`;
          await store.putBatch(b);
        }
        store.addLog('error', `前提设定发送失败：${data.reason || ''}，${batchLabel(store.getBatch(bid))}已暂停`);
        return { ok: true };
      }

      if (status === 'ABORTED' || status === 'NAVIGATED') {
        await finalize(item, S.PENDING);
        return { ok: true };
      }

      if (status === 'SEND_FAILED') {
        sendFailStreak += 1;
        await handleRetryable(item, 'SEND_FAILED', cfg);
        if (sendFailStreak >= 2) {
          await lease.releaseBatch(bid, 'stop');
          const b = store.getBatch(bid);
          if (b) {
            b.status = G.ERROR;
            b.lastError = '连续发送失败，页面结构可能已变化，请点「自检」排查';
            await store.putBatch(b);
          }
          store.addLog('error', '连续 2 次发送失败，已中止。建议运行自检');
        }
        return { ok: true };
      }

      if (status === 'CHAT_FAILED' || status === 'PAGE_ERROR') {
        return handleRetryable(item, status, cfg);
      }

      await finalize(item, S.PENDING);
      return { ok: true };
    });
  }

  /* ---------------- 心跳 / 单条操作 ---------------- */

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
      if (phase === 'sending') item.status = S.SENDING;
      if (phase === 'sent') {
        item.status = S.GENERATING;
        item.ts = Object.assign({}, item.ts, { sentAt: Date.now() });
      }
      if (item.lease) {
        item.lease.renewedAt = Date.now();
        item.lease.expiresAt = Date.now() + CGR.LIMITS.leaseTtlMs;
      }
      await store.putItem(item.batchId, item);
      return { ok: true };
    });
  }

  async function runOne(bid, index) {
    return store.withLock(async () => {
      await store.ensureLoaded();
      const b = store.getBatch(bid);
      if (!b) return { ok: false, error: '批次不存在' };
      const item = store.getItem(bid, index);
      if (!item) return { ok: false, error: '任务不存在' };
      if (lease.ACTIVE.includes(item.status)) return { ok: false, error: '该条正在执行中' };

      const secured = await tabs.ensureBatchTabs(b, 1, true);
      const tabId = secured.ids[0];
      const ready = await tabs.ensureContentScript(tabId);
      if (!ready) return { ok: false, error: '标签页未就绪，请刷新 ChatGPT 页面后重试' };

      const rt0 = store.getRuntime();
      const activeTabs = Object.assign({}, rt0.activeTabs);
      activeTabs[tabId] = Object.assign({}, activeTabs[tabId], { batchId: bid, state: 'busy', at: Date.now() });
      await store.setRuntime({ activeTabs, selectedBatchId: bid });

      b.windowId = secured.windowId;
      b.hintIndex = index;
      b.singleShot = true;
      b.status = G.RUNNING;
      b.startedAt = b.startedAt || Date.now();
      b.limitUntil = 0;
      await store.putBatch(b);

      await tabs.send(tabId, { type: CGR.MSG.WAKE });
      return { ok: true, tabId, itemId: index };
    });
  }

  async function resetItem(bid, index) {
    return store.withLock(async () => {
      const b = store.getBatch(bid);
      const item = store.getItem(bid, index);
      if (!b || !item) return { ok: false };
      item.status = S.PENDING;
      item.attempt = 0;
      item.lease = null;
      item.error = null;
      item.chatPrepared = false;
      await store.putItem(bid, item);

      if (b.status === G.FINISHED || b.status === G.IDLE || b.status === G.ERROR) {
        const secured = await tabs.ensureBatchTabs(b, 1, true);
        const rt = store.getRuntime();
        const activeTabs = Object.assign({}, rt.activeTabs);
        for (const id of secured.ids) activeTabs[id] = Object.assign({}, activeTabs[id], { batchId: bid, state: 'idle', at: Date.now() });
        await store.setRuntime({ activeTabs, selectedBatchId: bid });
        b.windowId = secured.windowId;
        b.status = G.RUNNING;
        b.startedAt = b.startedAt || Date.now();
        b.lastError = null;
        await store.putBatch(b);
      }
      await wakeBatch(bid);
      return { ok: true };
    });
  }

  async function skipItem(bid, index) {
    return store.withLock(async () => {
      const item = store.getItem(bid, index);
      if (!item) return { ok: false };
      if (lease.ACTIVE.includes(item.status)) return { ok: false, error: '正在执行，无法跳过' };
      item.status = S.SKIPPED;
      item.lease = null;
      await store.putItem(bid, item);
      await bumpStat(bid, 'skipped');
      await maybeFinish(bid);
      return { ok: true };
    });
  }

  /* ---------------- 删除 / 清理 ---------------- */

  async function remapDownloadIndexes(remap, bid) {
    try {
      const all = await chrome.storage.local.get(null);
      const updates = {};
      const removes = [];
      for (const [k, v] of Object.entries(all)) {
        if (!k.startsWith('dl:') || !v || v.index == null) continue;
        if (v.batchId && v.batchId !== bid) continue;
        const ni = remap.get(v.index);
        if (ni == null) removes.push(k);
        else if (ni !== v.index) updates[k] = { index: ni, batchId: bid };
      }
      if (Object.keys(updates).length) await chrome.storage.local.set(updates);
      if (removes.length) await chrome.storage.local.remove(removes);
    } catch (e) {
      /* ignore */
    }
  }

  async function applyKept(bid, kept) {
    const prev = store.getItems(bid);
    const keepSet = new Set(kept.map((k) => k.index));
    const remap = new Map();
    let n = 0;
    for (const it of prev) if (keepSet.has(it.index)) remap.set(it.index, n++);

    const b = store.getBatch(bid);
    await store.clearItems(bid);
    for (let i = 0; i < kept.length; i++) {
      const it = Object.assign({}, kept[i], { index: i, batchId: bid });
      await store.putItem(bid, it);
    }
    if (b) {
      b.count = kept.length;
      const stats = { done: 0, failed: 0, needsReview: 0, skipped: 0 };
      for (const it of kept) {
        if (it.status === S.DONE) stats.done += 1;
        else if (it.status === S.FAILED) stats.failed += 1;
        else if (it.status === S.NEEDS_REVIEW) stats.needsReview += 1;
        else if (it.status === S.SKIPPED) stats.skipped += 1;
      }
      b.stats = stats;
      if (!kept.length && (b.status === G.RUNNING || b.status === G.PAUSED)) b.status = G.IDLE;
      await store.putBatch(b);
    }
    await remapDownloadIndexes(remap, bid);
    if (dl && dl.clearCache) dl.clearCache();
    await gcImages();
    await store.publishView();
  }

  async function deleteItems(bid, indexes) {
    return store.withLock(async () => {
      await store.ensureLoaded();
      const del = new Set((indexes || []).map(Number));
      if (!del.size) return { ok: true, deleted: 0, skipped: 0 };

      const items = store.getItems(bid);
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
        if (it.lease) it.lease = null;
      }

      const deleted = items.length - kept.length;
      if (!deleted) return { ok: true, deleted: 0, skipped };
      await applyKept(bid, kept);
      store.addLog('info', `已删除 ${deleted} 条提示词${skipped ? `（${skipped} 条正在执行，已保留）` : ''}`);
      return { ok: true, deleted, skipped };
    });
  }

  async function clearFinished(bid) {
    return store.withLock(async () => {
      const items = store.getItems(bid);
      const keep = items.filter((it) => ![S.DONE, S.SKIPPED, S.FAILED].includes(it.status));
      const removed = items.length - keep.length;
      if (!removed) return { ok: true, removed: 0 };
      await applyKept(bid, keep);
      return { ok: true, removed };
    });
  }

  /** 回收没有被任何批次引用的参考图（10 分钟内新写入的先留着，避免误删刚选好的） */
  async function gcImages() {
    try {
      const all = await chrome.storage.local.get(null);
      const used = new Set();
      for (const it of store.allItems()) {
        for (const r of it.refImages || []) used.add(r.id);
      }
      const now = Date.now();
      const removes = Object.keys(all).filter((k) => {
        if (!k.startsWith('img:')) return false;
        if (used.has(k.slice(4))) return false;
        const rec = all[k];
        return !(rec && rec.createdAt && now - rec.createdAt < 10 * 60 * 1000);
      });
      if (removes.length) await chrome.storage.local.remove(removes);
      return removes.length;
    } catch (e) {
      return 0;
    }
  }

  root.CGR_ORCH = {
    createBatch,
    updateBatch,
    deleteBatch,
    selectBatch,
    addItem,
    addItems,
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
    gcImages,
    wakeBatch,
    rebindBatch,
    maybeFinish,
    effectiveConcurrency
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
