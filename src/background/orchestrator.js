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

  async function createBatch(name, site) {
    return store.withLock(async () => {
      await store.ensureLoaded();
      const rec = await store.createBatch(String(name || '').trim() || stampName(), site);
      store.addLog('info', `新建批次${batchLabel(rec)}（${CGR.siteLabel(rec.site)}）`);
      await store.publishView();
      return { ok: true, batch: { id: rec.id, name: rec.name, site: rec.site } };
    });
  }

  async function updateBatch(id, patch) {
    return store.withLock(async () => {
      await store.ensureLoaded();
      const b = store.getBatch(id);
      if (!b) return { ok: false, error: '批次不存在' };
      if (patch && typeof patch.name === 'string' && patch.name.trim()) b.name = patch.name.trim();
      // 工作站点只能在非运行态切换：运行中改站点会让已绑定的执行页与批次不匹配。
      // 侧边栏每次保存都会把当前站点一起提交，所以只有「真的变了」才拦截，
      // 否则运行中连改个批次名／下载目录都会被拒。
      if (patch && patch.site) {
        const next = store.normalizeSite(patch.site);
        if (next !== store.normalizeSite(b.site)) {
          if (b.status === G.RUNNING) return { ok: false, error: '批次运行中不能切换工作站点，请先暂停或停止' };
          b.site = next;
        }
      }
      if (patch && typeof patch.folder === 'string') b.folder = CGR.normalizeFolder(patch.folder, '');
      if (patch && Array.isArray(patch.premises)) b.premises = patch.premises.map((s) => String(s || '').trim()).filter(Boolean);
      if (patch && typeof patch.premiseEnabled === 'boolean') b.premiseEnabled = patch.premiseEnabled;
      await store.putBatch(b);
      await store.publishView();
      return {
        ok: true,
        batch: {
          id: b.id, name: b.name, site: b.site, folder: b.folder,
          premises: b.premises, premiseEnabled: b.premiseEnabled
        }
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
  async function bindTabs(b, desired, focus, switchSelection, preferActive) {
    const secured = await tabs.ensureBatchTabs(b, desired, focus, preferActive);

    const rt = store.getRuntime();
    const activeTabs = Object.assign({}, rt.activeTabs);
    const picked = secured.ids.map(String);
    // 清掉本批次残留的其它绑定。上次运行留下的后台标签页会一直占着「执行页」名额，
    // 让 claim 误以为还有人在领任务，其它标签页全被 no-batch 拒绝。
    for (const [tid, info] of Object.entries(activeTabs)) {
      if (info && info.batchId === b.id && !picked.includes(String(tid))) delete activeTabs[tid];
    }
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
      // 站点在「开始」时锁定：老批次没有 site 字段，回落到默认站点；
      // 之后 tabpool 只会挑同站点的标签页，claim 也会拒绝跨站点领任务。
      b.site = store.normalizeSite(b.site);
      await store.putBatch(b);
      const siteLabel = CGR.siteLabel(b.site);
      const othersRunning = store.listBatches().some((x) => x.id !== bid && x.status === G.RUNNING);
      const bound = await bindTabs(b, n, !othersRunning, true, true);

      // 一个标签页都接管不了时，绝不能把状态留在「运行中」——那就是「点了开始永远没反应」。
      if (!bound.ready.length) {
        b.status = G.ERROR;
        b.startedAt = 0;
        b.lastError = `没有可接管的 ${siteLabel} 标签页，请打开或刷新 ${siteLabel} 对话页后点「开始」`;
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
      // 手动点「开始/继续」是一次全新的尝试，清掉之前的连续失败计数
      b.premiseFailStreak = 0;
      sendFailStreak = 0;
      await store.putBatch(b);

      store.addLog('info', `开始${batchLabel(b)}（${siteLabel}），并发 ${n}，已接管标签页：${bound.ready.join(', ')}`);
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
    const bound = await bindTabs(b, effectiveConcurrency(), false, false, true);
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
      b.lastError = null;
      b.premiseFailStreak = 0;
      sendFailStreak = 0;
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

  /* ---------------- 一键重置 ---------------- */

  // 需要退回「待生成」的状态：进行中的、卡在待确认的、以及失败的。
  // 已完成 / 已跳过保持原样，避免重置把已经下载好的图又重跑一遍。
  const RESET_BACK = [S.CLAIMED, S.SENDING, S.GENERATING, S.DOWNLOADING, S.NEEDS_REVIEW, S.FAILED];

  /**
   * 一键重置。
   * runtime（默认）：只清运行态，批次 / 提示词 / 前提 / 下载目录 / 设置全部保留。
   * factory：清空 chrome.storage.local 全部数据，恢复默认设置并建一个空批次。
   */
  async function reset(opts) {
    const scope = opts && opts.scope === CGR.RESET_SCOPE.FACTORY ? CGR.RESET_SCOPE.FACTORY : CGR.RESET_SCOPE.RUNTIME;
    return store.withLock(async () => {
      await store.ensureLoaded();

      const rt = store.getRuntime();
      const boundIds = Object.keys(rt.activeTabs || {}).map(Number);
      const batches = store.listBatches();
      let totalItems = 0;
      for (const b of batches) totalItems += store.getItems(b.id).length;

      // ① 先让页面里正在跑的循环停下。之后即便旧结果上报回来，
      //    租约已清空，handleOutcome 找不到 token，不会把状态又改回去。
      const touched = new Set(boundIds);
      try {
        for (const t of await tabs.usableTabs()) touched.add(t.id);
      } catch (e) {
        /* ignore */
      }
      for (const id of touched) await tabs.send(id, { type: CGR.MSG.ABORT });

      // ② 内存里的辅助状态也要清，否则残留的下载映射 / 失联计数会立刻把旧状态「复活」。
      //    下载意图表连 storage 一起清，避免重置后旧路径劫持下一次下载的文件名。
      sendFailStreak = 0;
      try {
        if (dl.purge) dl.purge();
        else dl.clearCache();
      } catch (e) {
        /* ignore */
      }
      try {
        tabs.resetWindow();
      } catch (e) {
        /* ignore */
      }
      try {
        if (root.CGR_SCHED && root.CGR_SCHED.reset) root.CGR_SCHED.reset();
      } catch (e) {
        /* ignore */
      }
      try {
        const all = await chrome.storage.local.get(null);
        const dkeys = Object.keys(all).filter((k) => k.indexOf('dl:') === 0);
        if (dkeys.length) await chrome.storage.local.remove(dkeys);
      } catch (e) {
        /* ignore */
      }

      if (scope === CGR.RESET_SCOPE.FACTORY) {
        await store.factoryReset();
        const fresh = await store.createBatch('批次 1');
        store.addLog(
          'info',
          `已清空全部数据并恢复出厂设置：删除 ${batches.length} 个批次、${totalItems} 条提示词，已新建空批次「${fresh.name}」`
        );
        await store.publishView();
        return {
          ok: true,
          scope,
          deletedBatches: batches.length,
          deletedItems: totalItems,
          batch: { id: fresh.id, name: fresh.name }
        };
      }

      // ③ 只重置运行态。attempt 必须清零，否则 maxAttempts 会继续拦着，重置等于没重置。
      let requeued = 0;
      for (const b of batches) {
        for (const it of store.getItems(b.id)) {
          if (RESET_BACK.indexOf(it.status) >= 0) {
            it.status = S.PENDING;
            it.attempt = 0;
            it.lease = null;
            it.tabId = null;
            it.error = null;
            it.image = null;
            it.download = null;
            it.chatPrepared = false;
            it.lastOutcomeToken = null;
            it.ts = null;
            await store.putItem(b.id, it);
            requeued += 1;
          } else if (it.lease || it.tabId != null || it.lastOutcomeToken) {
            it.lease = null;
            it.tabId = null;
            it.lastOutcomeToken = null;
            await store.putItem(b.id, it);
          }
        }
        b.status = G.IDLE;
        b.startedAt = 0;
        b.lastClaimAt = 0;
        b.limitUntil = 0;
        b.lastError = null;
        b.windowId = null;
        b.premiseFailStreak = 0;
        b.stats = { done: 0, failed: 0, needsReview: 0, skipped: 0 };
        await store.putBatch(b);
      }

      await store.setRuntime({ activeTabs: {}, selectedBatchId: rt.selectedBatchId || '' });

      // ④ 顺手重新注入当前已打开的 ChatGPT 标签页（只复用，绝不新开），
      //    扩展重载后点一次重置就能直接点「开始」，不必再刷新页面或点「立即修复」。
      let ready = 0;
      try {
        for (const t of await tabs.usableTabs()) {
          if (await tabs.ensureContentScript(t.id)) ready += 1;
        }
      } catch (e) {
        /* ignore */
      }

      store.addLog(
        'info',
        `一键重置完成：${batches.length} 个批次回到空闲、${requeued} 条任务退回待生成、清除 ${boundIds.length} 个标签页绑定${ready ? `、已接管 ${ready} 个现有标签页` : ''}；提示词 / 前提 / 设置全部保留`
      );
      await store.publishView();
      return {
        ok: true,
        scope,
        batches: batches.length,
        items: totalItems,
        requeued,
        tabsCleared: boundIds.length,
        ready
      };
    });
  }

  /* ---------------- 租约派发 ---------------- */

  async function claim(tabId, convId, site) {
    return store.withLock(async () => {
      await store.ensureLoaded();
      // site 由页面 HELLO / LEASE_REQUEST 上报；缺省时不加站点限制（兼容旧调用点与回归测试）。
      const pageSite = site || '';
      const batchSite = (b) => store.normalizeSite(b && b.site);
      let rt = store.getRuntime();
      let bid = ((rt.activeTabs || {})[tabId] || {}).batchId;

      // 页面站点与已绑定批次的站点不一致时，绝不能把另一个网站的提示词发进这个页面。
      // 「立即修复」或切换工作站点后会重新绑定同类站点的标签页。
      if (bid && pageSite) {
        const boundBatch = store.getBatch(bid);
        if (boundBatch && batchSite(boundBatch) !== pageSite) {
          return {
            ok: false,
            reason: 'site-mismatch',
            expectedSite: batchSite(boundBatch),
            actualSite: pageSite
          };
        }
      }

      // 兜底：扩展重载 / runtime 归属丢失 / 执行页僵尸化，都别让用户等 30 秒的定时自愈。
      // 只认「恰好一个批次在跑、有待办」，避免用户随手多开的 ChatGPT 标签页一起抢同一批任务。
      //
      // 关键：以前只判断「activeTabs 里有没有 stale:false 的绑定」。那只是 storage 里的一个标记，
      // 绑定着的页面可能早就不来领任务了（停在错误页、脚本失效、后台被冻结、卡在 HELLO）。
      // 这时其它标签页来领任务全被 no-batch 拒绝，后台又只给那个死页发 WAKE —— 表现就是
      // 「已接管标签页 xxx」之后一直「等待派发」。改成按真实进度判定：超过正常间隔还没派发出
      // 一条任务、且没有任务正在执行，就让当前来领任务的标签页接管，并清掉旧绑定。
      if (!bid || !store.getBatch(bid)) {
        const running = store.listBatches().filter(
          (x) => x.status === G.RUNNING &&
            (!pageSite || batchSite(x) === pageSite) &&
            store.getItems(x.id).some((it) => it.status === S.PENDING)
        );
        if (running.length === 1) {
          const target = running[0];
          const bound = Object.entries(rt.activeTabs || {}).filter(([, v]) => v && v.batchId === target.id);
          const live = bound.filter(([, v]) => !v.stale);
          const items = store.getItems(target.id);
          const hasActive = items.some((it) => lease.ACTIVE.includes(it.status));
          // 两条任务之间本来就会等 maxDelayMs，再加一次页面轮询；低于这个时间绝不抢执行权。
          const cfgNow = store.getCfg();
          const takeoverMs = Math.max(
            CGR.LIMITS.claimTakeoverMs,
            (cfgNow.maxDelayMs || 7000) + CGR.LIMITS.idlePollMs
          );
          // 用「最近一次页面通信」而不是「最近一次领到任务」。一条任务包含
          // 前提等回复(60s)+等出图(120s+)，期间不会领新任务，用 lastClaimAt
          // 必然把正在干活的执行页算成失联。
          const activityAt = Math.max(target.lastPageAt || 0, target.lastClaimAt || 0, target.startedAt || 0);
          const quietFor = Date.now() - activityAt;
          const zombie = live.length > 0 && !hasActive && quietFor > takeoverMs;

          if (!live.length || zombie) {
            const activeTabs = Object.assign({}, rt.activeTabs);
            // 清掉失效归属：既避免它继续占位，也避免新旧两个执行页同时领任务
            for (const [tid] of bound) delete activeTabs[tid];
            activeTabs[tabId] = Object.assign({}, activeTabs[tabId], {
              batchId: target.id, state: 'idle', stale: false, at: Date.now()
            });
            await store.setRuntime({ activeTabs });
            bid = target.id;
            store.addLog('info', zombie
              ? `执行页 ${bound.map(([tid]) => tid).join(', ')} 已 ${Math.round(quietFor / 1000)} 秒没有任何页面通信，改由当前标签页 ${tabId} 接管${batchLabel(target)}（旧绑定已清除）`
              : `标签页 ${tabId} 未登记（原有绑定已失联），已自动归到${batchLabel(target)}继续执行`);
          }
        }
      }
      if (!bid) {
        const runningBatches = store.listBatches().filter((x) => x.status === G.RUNNING);
        return {
          ok: false,
          reason: 'no-batch',
          activeBatch: runningBatches.length === 1 ? runningBatches[0].name : '',
          activeSite: runningBatches.length === 1 ? batchSite(runningBatches[0]) : ''
        };
      }

      const b = store.getBatch(bid);
      if (!b) return { ok: false, reason: 'no-batch' };
      // 来领任务本身就证明这一页活着（哪怕这次没领到任务）
      await touchBatch(bid);
      if (b.status !== G.RUNNING) return { ok: false, reason: b.status };

      const cfg = store.getCfg();
      let item = null;
      let consumedHint = false;

      if (b.hintIndex != null) {
        const hint = b.hintIndex;
        b.hintIndex = null;
        consumedHint = true;
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
        // 空闲轮询现在是 3 秒一次，别每次都写 storage 触发无谓的视图刷新
        const cur = store.getRuntime();
        const here = (cur.activeTabs || {})[tabId];
        if (here && here.state !== 'idle') {
          const activeTabs = Object.assign({}, cur.activeTabs);
          activeTabs[tabId] = Object.assign({}, here, { state: 'idle' });
          await store.setRuntime({ activeTabs });
        }
        if (consumedHint) await store.putBatch(b);
        return { ok: false, reason: 'drained' };
      }

      const activeTabs = Object.assign({}, store.getRuntime().activeTabs);
      activeTabs[tabId] = Object.assign({}, activeTabs[tabId], { batchId: bid, convId: convId || '', state: 'busy', at: Date.now() });
      await store.setRuntime({ activeTabs });

      b.lastClaimAt = Date.now();
      b.lastPageAt = Date.now();
      if (b.singleShot) {
        b.singleShot = false;
        b.status = G.PAUSED;
      }
      await store.putBatch(b);

      return {
        ok: true,
        leaseToken: item.lease.token,
        cfg,
        site: batchSite(b),
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

  /** 上报重试时租约可能已被清掉，用 token 反查，避免前端无限重发 */
  function findByOutcomeToken(token) {
    if (!token) return null;
    for (const b of store.listBatches()) {
      for (const it of store.getItems(b.id)) {
        if (it.lastOutcomeToken === token) return it;
      }
    }
    return null;
  }

  function logDiagnostic(item, d, code) {
    if (!d || typeof d !== 'object') return;
    store.addLog(
      'warn',
      `#${item.index + 1} ${code} 诊断：img=${d.totalImgs || 0} 新增=${d.freshImgs || 0} 大图=${d.largeFresh || 0} 规则命中=${d.strictHits || 0} 链接=${d.freshLinks || 0} 附件=${d.fileCards || 0} 产物=${d.artifactHits || 0} canvas=${d.canvases || 0} 消息=${d.msgNodes || 0} 停止按钮=${d.stopHit ? 'Y' : 'N'}`,
      { index: item.index }
    );
    for (const s of d.samples || []) {
      store.addLog('warn', `#${item.index + 1}   ↳ ${s}`, { index: item.index });
    }
  }

  /** 旧策略：已知内嵌图 > 高清原图链接 > 宽松内嵌图 > 文件附件卡片。
   * 「页面里没有 <img>，只有 xxx.png 附件卡片」的场景必须能选出产物。 */
  function bestByScore(list) {
    let best = null;
    let rank = -1;
    for (const a of list) {
      if (!a || !a.src) continue;
      const k = a.kind || 'img';
      let r;
      if (k === 'img') r = (a.known ? 100 : 80) + Math.min(9, ((a.w || 0) * (a.h || 0)) / 1e7);
      else if (k === 'link') r = (/原图|高清|full|original|4k/i.test(a.label || '') ? 95 : 55) + (a.score || 0);
      else if (k === 'card') r = 40 + (a.score || 0);
      else r = 20;
      if (r > rank) {
        rank = r;
        best = a;
      }
    }
    return best;
  }

  /** 一次生成多张图时选哪一张下载。
   *  first（默认）：按页面顺序只取第一张，order 由 probes.sortByDom 写下；
   *  best：旧的评分策略，可在设置里切回去。
   * 没有 order 的旧上报数据按「内嵌图优先 + 原顺序」回落，保证附件场景仍能选到可下载产物。
   * 无论哪种策略，一条任务都只发起一次下载。 */
  function pickArtifact(list, strategy) {
    const arr = (list || []).filter((a) => a && a.src);
    if (!arr.length) return null;
    if (strategy === 'best') return bestByScore(arr);
    const ordered = arr.filter((a) => typeof a.order === 'number');
    if (ordered.length) return ordered.slice().sort((a, b) => a.order - b.order)[0];
    const weight = (a) => (a.kind === 'img' ? 0 : a.kind === 'link' ? 1 : a.kind === 'card' ? 2 : 3);
    return arr.slice().sort((a, b) => weight(a) - weight(b))[0];
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

  async function handleRetryable(item, code, cfg, opts) {
    const detail = opts || {};
    item.attempt = (item.attempt || 0) + 1;
    const max = item.maxAttempts || cfg.maxAttempts || 2;

    // 网页上已经出现新的大图，说明图其实生成了，只是没走完下载。
    // 此时重发提示词 = 再消耗一次生图额度、再多出一张图，必须停下来。
    if (detail.imagePresent) {
      await finalize(item, S.NEEDS_REVIEW, {
        error: { code: 'IMAGE_PRESENT_NOT_SAVED', message: '网页已出图但未保存，已停止自动重试以免重复生图' }
      });
      await bumpStat(item.batchId, 'needsReview');
      store.addLog('error', `#${item.index + 1} 网页已有新图却判 ${code}；已停止重发，请在侧边栏「待确认」里处理`);
      return { ok: true };
    }

    // 默认策略：不自动重发提示词。自动重试只适合「确认没出图」的场景，
    // 一旦误判就会把同一条提示词反复生成，代价是不可逆的额度消耗。
    const policy = cfg.onNoImage || 'review';
    const isImageMiss = code === 'NO_IMAGE' || code === 'TIMEOUT' || code === 'PAGE_ERROR';
    if (isImageMiss && policy === 'review') {
      await finalize(item, S.NEEDS_REVIEW, {
        error: { code, message: '未确认出图，已停止自动重试（避免重复生图）' }
      });
      await bumpStat(item.batchId, 'needsReview');
      store.addLog('warn', `#${item.index + 1} ${code}：已标记待确认，不会重发提示词；确认确实没出图后可在列表点「重试」`);
      return { ok: true };
    }

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
      if (!item) {
        // 一键重置已清掉租约；页面随后补发的 ABORTED / NAVIGATED 属于预期残留，
        // 直接确认即可，免得前端有限重试把日志刷屏。
        if (msg.status === 'ABORTED' || msg.status === 'NAVIGATED') return { ok: true, ignored: true };
        // 前端重试上报时，后台可能已处理完并清掉租约。必须回 ok，
        // 否则前端会一直重发到日志刷屏（也更不能重复触发下载）。
        return findByOutcomeToken(token) ? { ok: true, duplicate: true } : { ok: false, error: 'lease-not-found' };
      }
      if (item.lastOutcomeToken === token) return { ok: true, duplicate: true };
      item.lastOutcomeToken = token;
      await store.putItem(item.batchId, item);

      const bid = item.batchId;
      const cfg = store.getCfg();
      const status = msg.status;
      const data = msg.data || {};
      // 刚上报结果的执行页当然是活的：不记下来就会被紧接着的领取请求误判成僵尸
      await touchBatch(bid);

      if (status === 'LIMIT') {
        await handleLimit(item, data.raw);
        return { ok: true };
      }

      if (status === 'AUTH_REQUIRED') {
        await finalize(item, S.PENDING);
        const b = store.getBatch(bid);
        if (b) {
          b.status = G.ERROR;
          b.lastError = `${CGR.siteLabel(b.site)} 未登录或登录已失效，请先在该标签页登录`;
          await store.putBatch(b);
        }
        store.addLog('error', '检测到登录失效，任务已中止');
        return { ok: true };
      }

      if (status === 'IMAGE_READY') {
        const arts = Array.isArray(data.images) ? data.images : [];
        const strategy = cfg.multiImage === 'best' ? 'best' : 'first';
        const best = pickArtifact(arts, strategy);
        if (!best || !best.src) return handleRetryable(item, 'NO_IMAGE', cfg);

        const shape = best.kind || 'img';
        const label = best.label ? `「${String(best.label).slice(0, 40)}」` : '';
        const pickNote = strategy === 'first'
          ? (arts.length > 1 ? `按页面顺序只下载第 1 张（共 ${arts.length} 张）` : '只有 1 张产物')
          : '按评分取最优一张（设置里已切换）';
        store.addLog(
          'info',
          `#${item.index + 1} 已确认出图：${arts.length} 个产物，${pickNote}，采用 ${shape} ${label}${best.w ? ` ${best.w}×${best.h}` : ''}${data.loose ? '（含宽松规则命中）' : ''}，开始下载`,
          { index: item.index }
        );

        const src = best.src;
        const isBlob = /^blob:/i.test(src);
        const isData = /^data:/i.test(src);
        const isFile = !/^https?:\/\//i.test(src) && !isBlob && !isData;
        const kind = isBlob ? 'blob' : isData ? 'data' : isFile ? 'file' : 'https';
        item.image = {
          src,
          w: best.w || 0,
          h: best.h || 0,
          kind,
          artifactKind: shape,
          label: best.label || '',
          click: !!best.click,
          siteDownload: !!best.siteDownload
        };
        item.ts = Object.assign({}, item.ts, { imageAt: Date.now() });
        // 所有下载分支都要留下执行页：A 级直链被拒时会降级到页面内取流，
        // 没有 tabId 就只能判「下载失败」，页面上的图白白丢掉。
        if (senderTabId != null) {
          item.tabId = senderTabId;
          await store.putItem(bid, item);
        }
        sendFailStreak = 0;
        const okBatch = store.getBatch(bid);
        if (okBatch && okBatch.premiseFailStreak) {
          okBatch.premiseFailStreak = 0;
          await store.putBatch(okBatch);
        }

        // Gemini：生成图容器里有「下载全尺寸图片」按钮时优先点它，
        // 而不是把 blob: 预览图当作成品下载（那条路只能拿到 1024px 缩图）。
        const batch = store.getBatch(bid);
        const site = msg.site || data.site || (batch && batch.site) || '';
        if (best.siteDownload && site === 'gemini') {
          await finalize(item, S.DOWNLOADING);
          item.tabId = senderTabId;
          await store.putItem(bid, item);
          await dl.startSiteDownload(item, best, senderTabId);
        } else if (isBlob) {
          await finalize(item, S.DOWNLOADING);
          item.tabId = senderTabId;
          await store.putItem(bid, item);
          await dl.requestFallback(item, 'blob-url');
        } else if (isData) {
          const mime = (src.match(/^data:([^;,]+)/i) || [])[1] || 'image/png';
          await dl.startDataDownload(item, src, CGR.extFromUrl('', mime));
        } else if (isFile) {
          // sandbox: / 文件附件卡片：下载 API 用不了，走页面内取流 → 点击附件 → 归位到批次目录
          item.tabId = senderTabId;
          await store.putItem(bid, item);
          await dl.startFileDownload(item, best, senderTabId);
        } else {
          await dl.startUrlDownload(item, src, CGR.extFromUrl(src));
        }
        return { ok: true };
      }

      // 页面与服务端脱节：服务端很可能已经出图（手机端能看到就属此类），
      // 但这一页的 SSE / 渲染没跟上。此时重发提示词等于再消耗一次生图额度，
      // 必须直接标待确认，并让队列继续跑下一条，而不是把整批拖到总超时。
      if (status === 'PAGE_STALE') {
        logDiagnostic(item, data.diagnostic, 'PAGE_STALE');
        await finalize(item, S.NEEDS_REVIEW, {
          error: {
            code: 'PAGE_STALE',
            message: '页面长时间无更新，服务端可能已出图；请刷新标签页确认，本条不会重发提示词'
          }
        });
        await bumpStat(bid, 'needsReview');
        store.addLog('warn', `#${item.index + 1} 页面与服务端脱节（${data.phase || 'dom-frozen'}）：已标记待确认，绝不重发提示词；刷新该标签页通常就能看到图，队列继续下一条`);
        return { ok: true };
      }

      if (status === 'NO_IMAGE') {
        logDiagnostic(item, data.diagnostic, 'NO_IMAGE');
        const d = data.diagnostic || {};
        store.addLog('warn', `#${item.index + 1} 未检测到图片（可能被拒答、只返回文字，或图片晚于判定出现）`);
        return handleRetryable(item, 'NO_IMAGE', cfg, {
          // 页面上出现过新链接/附件卡片也算「已有产物」：宁可标待确认，也绝不重发提示词
          imagePresent:
            (d.largeFresh || 0) > 0 ||
            (d.freshImgs > 0 && d.strictHits > 0) ||
            (d.artifactHits || 0) > 0 ||
            (d.freshLinks || 0) > 0 ||
            (d.fileCards || 0) > 0
        });
      }

      if (status === 'TIMEOUT') {
        logDiagnostic(item, data.diagnostic, 'TIMEOUT');
        const d = data.diagnostic || {};
        if (data.stillGenerating) {
          await finalize(item, S.NEEDS_REVIEW, { error: { code: 'TIMEOUT_GENERATING', message: '超时但仍在生成，请人工确认' } });
          await bumpStat(bid, 'needsReview');
          store.addLog('warn', `#${item.index + 1} 超时且仍在生成，标记为待确认`);
        } else {
          await handleRetryable(item, 'TIMEOUT', cfg, {
            imagePresent:
              (d.largeFresh || 0) > 0 ||
              (data.imageHint || 0) > 0 ||
              (d.artifactHits || 0) > 0
          });
        }
        return { ok: true };
      }

      if (status === 'ATTACH_FAILED') {
        store.addLog('warn', `#${item.index + 1} 参考图附加失败：${data.reason || '未知原因'}，本条将重试`);
        return handleRetryable(item, 'ATTACH_FAILED', cfg);
      }

      if (status === 'PREMISE_FAILED') {
        // 前提只是文本上下文，不生图、不消耗额度：失败时自动退回收拾状态再重试，
        // 而不是一次失败就把整个批次打成「异常中断」让用户手动救。
        // 但必须限次，否则页面结构真坏了会无限重发前提、把对话塞满。
        const lines = Array.isArray(data.diagnostic) ? data.diagnostic : [];
        for (const line of lines.slice(-4)) {
          store.addLog('warn', `#${item.index + 1} 前提诊断：${line}`, { index: item.index });
        }
        const b = store.getBatch(bid);
        const streak = ((b && b.premiseFailStreak) || 0) + 1;

        if (streak >= 3) {
          await finalize(item, S.NEEDS_REVIEW, {
            chatPrepared: false,
            error: { code: 'PREMISE_FAILED', message: `前提连续 ${streak} 次发送失败，已停止自动重试` }
          });
          await bumpStat(bid, 'needsReview');
          if (b) {
            b.premiseFailStreak = streak;
            b.status = G.PAUSED;
            b.lastError = `前提发送失败：${data.reason || '未知原因'}；看日志里的「前提诊断」，处理后点「继续」`;
            await store.putBatch(b);
          }
          store.addLog('error', `前提连续 ${streak} 次发送失败（${data.reason || ''}），批次已暂停，不会无限重发`);
        } else {
          item.premiseAttempts = (item.premiseAttempts || 0) + 1;
          await finalize(item, S.PENDING, { chatPrepared: false });
          if (b) {
            b.premiseFailStreak = streak;
            await store.putBatch(b);
          }
          store.addLog('warn', `前提发送失败（${data.reason || ''}），第 ${streak}/3 次自动重试，批次保持运行`);
        }
        return { ok: true };
      }

      if (status === 'ABORTED' || status === 'NAVIGATED') {
        // 页面跳转/新开对话导致的退回也要计数，否则同样能无限重发提示词
        item.attempt = (item.attempt || 0) + 1;
        if (item.attempt >= (cfg.maxAttempts || 2)) {
          await finalize(item, S.NEEDS_REVIEW, {
            error: { code: status, message: '多次页面跳转，已停止自动重试以免重复生图' }
          });
          await bumpStat(bid, 'needsReview');
          store.addLog('warn', `#${item.index + 1} 连续 ${item.attempt} 次页面跳转，已标记待确认`);
        } else {
          await finalize(item, S.PENDING);
        }
        return { ok: true };
      }

      if (status === 'SEND_FAILED') {
        sendFailStreak += 1;
        const lines = Array.isArray(data.diagnostic) ? data.diagnostic : [];
        for (const line of lines.slice(-4)) {
          store.addLog('warn', `#${item.index + 1} 发送诊断：${line}`, { index: item.index });
        }
        await handleRetryable(item, 'SEND_FAILED', cfg);
        if (sendFailStreak >= 2) {
          await lease.releaseBatch(bid, 'stop');
          const b = store.getBatch(bid);
          if (b) {
            b.status = G.PAUSED;
            b.lastError = `连续 ${sendFailStreak} 次发送失败（${data.code || ''}）；看日志里的「发送诊断」，处理后点「继续」`;
            await store.putBatch(b);
          }
          store.addLog('error', `连续 ${sendFailStreak} 次发送失败，批次已暂停（可直接点「继续」，无需重建批次）`);
        }
        return { ok: true };
      }

      if (status === 'CHAT_FAILED' || status === 'PAGE_ERROR') {
        logDiagnostic(item, data.diagnostic, status);
        return handleRetryable(item, status, cfg, {
          imagePresent: ((data.diagnostic || {}).largeFresh || 0) > 0
        });
      }

      // 未知状态也不能悄悄把任务退回队列重跑
      store.addLog('warn', `#${item.index + 1} 收到未知结果 ${status}，标记待确认`);
      await finalize(item, S.NEEDS_REVIEW, {
        error: { code: 'UNKNOWN_OUTCOME', message: `未识别的结果：${status}` }
      });
      await bumpStat(bid, 'needsReview');
      return { ok: true };
    });
  }

  /* ---------------- 心跳 / 单条操作 ---------------- */

  /** 记下「这个批次的执行页刚刚还在和后台说话」。
   * 以前只有 lastClaimAt（成功领到任务才更新），一条任务跑 3~5 分钟时它会一直
   * 停在领取时刻；任务一结束、旁观页来领任务，就把刚跑完的执行页判成
   * 「200 多秒没来领任务」的僵尸并夺权，前提在另一个标签页重发、图片全丢。
   * 心跳 / 进度 / 结果 / 领取请求都算真实活跃，不能用「领到任务」代替。 */
  async function touchBatch(bid) {
    if (!bid) return;
    const b = store.getBatch(bid);
    if (!b) return;
    b.lastPageAt = Date.now();
    await store.putBatch(b);
  }

  async function heartbeat(token) {
    return store.withLock(async () => {
      const it = await lease.renewByToken(token);
      if (it) await touchBatch(it.batchId);
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
      await touchBatch(item.batchId);
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
    reset,
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
