/* 定时任务：每 30 秒扫描一次。
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
        const res = await CGR.withTimeout(tabs.send(id, { type: CGR.MSG.PING }), 5000, null);
        if (res && res.ok) {
          alive[id] = rt.activeTabs[id];
          misses.delete(id);
          await lease.renewByTab(id);
          await CGR.withTimeout(tabs.send(id, { type: CGR.MSG.EVALUATE }), 5000, null);
        } else {
          const n = (misses.get(id) || 0) + 1;
          misses.set(id, n);
          if (n >= 2) {
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
            } else {
              const how = await tabs.reviveTab(id);
              if (how === 'reinjected' || how === 'reloaded') {
                store.addLog('warn', `标签页 ${id} 连续无响应（${url.slice(0, 50)}）→ ${how === 'reinjected' ? '已重新注入脚本' : '已重载页面'}`);
              } else {
                // 彻底救不回来：换一个新的标签页顶替，别让整个批次停在这
                const nid = await tabs.replaceTab(id);
                if (nid) {
                  delete alive[id];
                  alive[nid] = Object.assign({}, info, { stale: false, at: Date.now() });
                  store.addLog('warn', `标签页 ${id} 无法恢复，已换用新标签页 ${nid} 继续`);
                } else {
                  store.addLog('error', `标签页 ${id} 无法恢复且无法替换，请手动刷新该批次的窗口`);
                }
              }
            }
          } else {
            alive[id] = rt.activeTabs[id];
          }
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
        if (Date.now() - (healAt.get(b.id) || 0) < 45000) continue;
        healAt.set(b.id, Date.now());

        const cur = store.getRuntime();
        let injected = 0;
        for (const [tid, info] of Object.entries(cur.activeTabs || {})) {
          if (!info || info.batchId !== b.id) continue;
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
        } else {
          store.addLog('warn', `批次「${b.name}」已开始但页面没有领取任务，请刷新它的窗口后点「继续」`);
        }
      }

      await lease.sweepExpired();
      for (const b of store.listBatches()) await orch.maybeFinish(b.id);
      await store.publishView();
    });
  }

  function onAlarm(alarm) {
    if (alarm.name === ALARM) scan().catch(() => {});
  }

  root.CGR_SCHED = { ALARM, ensure, scan, onAlarm };
})(typeof globalThis !== 'undefined' ? globalThis : self);
