/* 定时任务：每 30 秒做一次全面扫描（service worker 另有每 5 秒的轻量唤醒兜底）。
 * ① 批次限额冷却到点自动恢复
 * ② 给所有活跃标签页发 PING/EVALUATE（绕过后台标签页的定时器节流）
 * ③ 续租 / 回收失联标签页的租约
 * ④ 某个批次「显示运行中却没动静」时自动重建页面连接
 */
(function (root) {
  const CGR = root.CGR;
  const store = root.CGR_STORE;
  const lease = root.CGR_LEASE;
  const tabs = root.CGR_TABS;
  const orch = root.CGR_ORCH;
  const G = CGR.GLOBAL;
  const S = CGR.STATUS;

  const ALARM = 'cgr-scan';
  const misses = new Map(); // tabId -> 连续 ping 失败次数
  const healAt = new Map(); // batchId -> 上次自愈时间

  function ensure() {
    try {
      chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    } catch (e) {
      /* ignore */
    }
  }

  async function scan() {
    await store.withLock(async () => {
      await store.ensureLoaded();
      const rt = store.getRuntime();

      // ① 限额冷却到点 → 自动恢复
      for (const b of store.listBatches()) {
        if (b.status === G.LIMIT_WAITING && b.limitUntil && Date.now() >= b.limitUntil) {
          b.status = G.RUNNING;
          b.limitUntil = 0;
          await store.putBatch(b);
          store.addLog('info', `批次「${b.name}」限额冷却结束，自动恢复执行`);
          await orch.wakeBatch(b.id);
        }
      }

      // ② ping 活跃标签页（只处理真正绑定了批次的，没有 batchId 的是历史垃圾记录）
      const ids = Object.entries(rt.activeTabs || {})
        .filter(([, v]) => v && v.batchId)
        .map(([k]) => Number(k));
      const alive = {};
      for (const id of ids) {
        try {
          const res = await CGR.withTimeout(tabs.send(id, { type: CGR.MSG.PING }), 5000, null);
          if (res && res.ok) {
            alive[id] = rt.activeTabs[id];
            misses.delete(id);
            await lease.renewByTab(id);
            await CGR.withTimeout(tabs.send(id, { type: CGR.MSG.EVALUATE }), 5000, null);
            continue;
          }

          const n = (misses.get(id) || 0) + 1;
          misses.set(id, n);
          if (n < 2) {
            alive[id] = rt.activeTabs[id];
            continue;
          }

          misses.delete(id);
          await lease.reclaimByTab(id, 'tab-dead');
          // 保留归属关系（标记 stale），否则这个标签页就再也唤不回来了
          alive[id] = Object.assign({}, rt.activeTabs[id], { stale: true });

          let url = '';
          try {
            const t = await chrome.tabs.get(id);
            url = t.url || '';
          } catch (e) {
            url = '';
          }
          if (!url) {
            delete alive[id];
            store.addLog('warn', `标签页 ${id} 已不存在，已从批次中移除`);
            continue;
          }

          const how = await tabs.reviveTab(id);
          if (how === 'reinjected' || how === 'reloaded') {
            store.addLog('warn', `标签页 ${id} 连续无响应（${url.slice(0, 50)}）→ ${how === 'reinjected' ? '已重新注入脚本' : '已重载页面'}`);
          } else {
            // 彻底救不回来：换一个新的标签页顶替，别让整个批次停在这
            const nid = await tabs.replaceTab(id);
            if (nid) {
              delete alive[id];
              // 继承旧标签页的批次归属。原来这里引用了未定义的 info，
              // 一抛 ReferenceError 整轮扫描就中断，后面的自愈和视图刷新全都不执行。
              alive[nid] = Object.assign({}, rt.activeTabs[id] || {}, { stale: false, at: Date.now() });
              store.addLog('warn', `标签页 ${id} 无法恢复，已换用新标签页 ${nid} 继续`);
            } else {
              store.addLog('error', `标签页 ${id} 无法恢复且无法替换，请手动刷新该批次的窗口`);
            }
          }
        } catch (e) {
          // 单个标签页出问题不能拖垮整轮扫描（自愈、视图刷新还得继续跑）
          alive[id] = rt.activeTabs[id];
          store.addLog('warn', `扫描标签页 ${id} 出错：${String((e && e.message) || e)}`);
        }
      }
      if (ids.length) await store.setRuntime({ activeTabs: alive });

      // ③ 批次在跑，但它的标签页全都无响应（多半被浏览器冻结了）→ 把窗口切到前台解冻
      for (const b of store.listBatches()) {
        if (b.status !== G.RUNNING) continue;
        const mine = Object.entries(alive).filter(([, v]) => v && v.batchId === b.id);
        const anyFresh = mine.some(([tid]) => !alive[tid].stale);
        if (mine.length && anyFresh) continue;
        if (b.windowId == null) continue;
        if (Date.now() - (healAt.get(b.id) || 0) < 60000) continue;
        healAt.set(b.id, Date.now());
        try {
          await chrome.windows.update(b.windowId, { focused: true });
          store.addLog('warn', `批次「${b.name}」的窗口失去响应（可能被浏览器冻结），已切到前台尝试恢复`);
        } catch (e) {
          /* 窗口可能已被关闭，交给下面的自愈处理 */
        }
      }

      // ④ 自愈：批次在跑但没有任务被执行、还有待办
      for (const b of store.listBatches()) {
        if (b.status !== G.RUNNING) continue;
        const items = store.getItems(b.id);
        const anyActive = items.some((it) => lease.ACTIVE.includes(it.status));
        const anyPending = items.some((it) => it.status === S.PENDING);
        const idleFor = Date.now() - (b.lastClaimAt || b.startedAt || Date.now());
        if (anyActive || !anyPending || idleFor < 20000) continue;
        if (Date.now() - (healAt.get(b.id) || 0) < 25000) continue;
        healAt.set(b.id, Date.now());

        const cur = store.getRuntime();
        const mine = Object.entries(cur.activeTabs || {}).filter(([, info]) => info && info.batchId === b.id);
        let injected = 0;
        for (const [tid] of mine) {
          const id = Number(tid);
          if (await tabs.ping(id)) continue;
          const how = await tabs.reviveTab(id);
          if (how === 'reinjected' || how === 'reloaded') {
            injected += 1;
            await tabs.send(id, { type: CGR.MSG.WAKE });
          }
        }
        if (injected) {
          store.addLog('warn', `批次「${b.name}」页面连接已断开，已自动重建 ${injected} 个标签页`);
          continue;
        }

        // 一个绑定标签页都没有，或脚本活着却始终不领任务：直接重新绑定并唤醒。
        // 以前这里只写一条「请刷新窗口」的日志，批次就一直挂在「运行中」不动。
        const r = await orch.rebindBatch(b.id);
        if (r.ok) {
          store.addLog('warn', `批次「${b.name}」没有页面在领任务，已重新接管 ${r.tabs} 个标签页并唤醒`);
        } else {
          store.addLog('error', `批次「${b.name}」找不到可用的 ChatGPT 标签页，请打开/刷新 chatgpt.com 后点「立即修复」`);
        }
      }

      await lease.sweepExpired();
      for (const b of store.listBatches()) await orch.maybeFinish(b.id);
      await store.publishView();
    });
  }

  function onAlarm(alarm) {
    if (alarm.name !== ALARM) return;
    scan().catch((e) => {
      // 以前异常被静默吞掉，扫描一崩就再也看不到任何自愈日志
      try {
        store.addLog('error', `定时扫描异常：${String((e && e.message) || e)}（本轮自愈未完成，下轮会自动重试）`);
        store.publishView().catch(() => {});
      } catch (_) {
        /* ignore */
      }
    });
  }

  /** 一键重置时清掉标签页失联计数与自愈节留，避免旧状态立刻又把批次拉回去 */
  function reset() {
    misses.clear();
    healAt.clear();
  }

  root.CGR_SCHED = { ALARM, ensure, scan, onAlarm, reset };
})(typeof globalThis !== 'undefined' ? globalThis : self);
