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

      // ② ping 活跃标签页
      const ids = Object.keys(rt.activeTabs || {}).map(Number);
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
            store.addLog('warn', `标签页 ${id} 连续无响应，已回收其任务`);
          } else {
            alive[id] = rt.activeTabs[id];
          }
        }
      }
      if (ids.length) await store.setRuntime({ activeTabs: alive });

      // ③ 自愈：批次在跑但没有任务被执行、还有待办
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
          if (await tabs.ensureContentScript(id)) {
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
