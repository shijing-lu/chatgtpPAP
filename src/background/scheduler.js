/* 定时任务：每 30 秒扫描一次。
 * 作用：① 给所有活跃标签页发 PING/EVALUATE（绕过后台标签页的定时器节流）
 *      ② 续租 / 回收失联标签页的租约 ③ 限额冷却到点自动恢复。 */
(function (root) {
  const CGR = root.CGR;
  const store = root.CGR_STORE;
  const lease = root.CGR_LEASE;
  const tabs = root.CGR_TABS;
  const orch = root.CGR_ORCH;
  const G = CGR.GLOBAL;

  const ALARM = 'cgr-scan';
  const misses = new Map(); // tabId -> 连续 ping 失败次数
  let lastHealAt = 0;

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

      if (rt.status === G.LIMIT_WAITING && rt.limitUntil && Date.now() >= rt.limitUntil) {
        await store.setRuntime({ status: G.RUNNING, limitUntil: 0 });
        store.addLog('info', '限额冷却结束，自动恢复执行');
        await orch.wakeAll();
      }

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
          // 连续两次失联才回收，避免页面瞬时卡顿导致误判
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

      // 自愈：显示「运行中」却长时间没有任何任务被领走，且没有任务在执行 —— 页面连接断了。
      // 注意要用「当前所有 ChatGPT 标签页」而不是 activeTabs：失联的标签页刚才已经被上面的
      // ping 循环从 activeTabs 里剔掉了，用它就正好漏掉需要修的那些。
      const rtNow = store.getRuntime();
      if (rtNow.status === G.RUNNING) {
        const items = store.allItems();
        const anyActive = items.some((it) => lease.ACTIVE.includes(it.status));
        const anyPending = items.some((it) => it.status === CGR.STATUS.PENDING);
        const idleFor = Date.now() - (rtNow.lastClaimAt || rtNow.startedAt || Date.now());

        if (!anyActive && anyPending && idleFor > 20000 && Date.now() - lastHealAt > 45000) {
          lastHealAt = Date.now();
          const candidates = await tabs.usableTabs();
          const activeTabs = Object.assign({}, rtNow.activeTabs);
          let injected = 0;
          let alreadyAlive = 0;

          for (const t of candidates) {
            if (await tabs.ping(t.id)) {
              alreadyAlive += 1;
              if (!activeTabs[t.id]) activeTabs[t.id] = { convId: '', state: 'idle', at: Date.now() };
              continue;
            }
            // 扩展重载后旧脚本已死，重新注入一份新的
            if (await tabs.ensureContentScript(t.id)) {
              injected += 1;
              activeTabs[t.id] = Object.assign({}, activeTabs[t.id], { state: 'idle', at: Date.now() });
              await tabs.send(t.id, { type: CGR.MSG.WAKE });
            }
          }

          if (injected) {
            await store.setRuntime({ activeTabs });
            store.addLog('warn', `检测到页面连接已断开，已自动重建 ${injected} 个标签页，任务继续`);
          } else if (alreadyAlive) {
            store.addLog('warn', '任务已开始但页面没有领取任务：请确认 ChatGPT 标签页停在对话页面，必要时刷新一次');
          } else {
            store.addLog('error', '检测到页面失联且无法自动恢复，请手动刷新 ChatGPT 页面后点「开始」');
          }
        }
      }
      await lease.sweepExpired();
      await orch.maybeFinish();
      await store.publishView();
    });
  }

  function onAlarm(alarm) {
    if (alarm.name === ALARM) scan().catch(() => {});
  }

  root.CGR_SCHED = { ALARM, ensure, scan, onAlarm };
})(typeof globalThis !== 'undefined' ? globalThis : self);
