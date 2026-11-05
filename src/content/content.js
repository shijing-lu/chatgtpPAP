/* 内容脚本入口：向后台领取任务 → 新开对话 → 发送 → 等待出图 → 上报结果 → 领下一条。 */
(function (root) {
  if (window.__CGR_LOADED__) return;
  window.__CGR_LOADED__ = true;

  const CGR = root.CGR;
  const probe = root.CGR_PROBE;
  const composer = root.CGR_COMPOSER;
  const watch = root.CGR_WATCH;
  const selfcheck = root.CGR_SELFCHECK;

  const MSG = CGR.MSG;
  let loopBusy = false;
  let current = null;
  let wakeResolve = null;
  let heartbeatTimer = 0;
  let premisesApplied = false; // 当前对话是否已经发过前提设定
  let contextDead = false; // 扩展上下文已失效（页面需要刷新），此时静默退出
  let idleWait = 15000; // 空闲轮询间隔，会被逐步退避
  let noComposerHits = 0;
  let lastIdleReason = '';
  let lastIdleLogAt = 0;

  function send(msg) {
    if (contextDead) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) {
            const err = String(chrome.runtime.lastError.message || '');
            // 只有「扩展上下文失效」才是致命的（扩展被更新/重载，旧脚本作废）。
            // 注意：'message port closed' 是 MV3 里 service worker 被回收时的常态，
            // 绝不能当成致命错误 —— 否则一次正常的回收就会让整个队列永久停摆。
            if (/context invalidated/i.test(err)) contextDead = true;
            resolve(null);
          } else {
            resolve(res);
          }
        });
      } catch (e) {
        if (/context invalidated/i.test(String((e && e.message) || ''))) contextDead = true;
        resolve(null);
      }
    });
  }

  function waitForWork(ms) {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        wakeResolve = null;
        resolve();
      };
      wakeResolve = done;
      setTimeout(done, ms);
    });
  }

  /** 后台每 30 秒扫描时会发 PING/EVALUATE，用来打断空闲等待，避免被浏览器节流拖成分钟级 */
  function pokeIdle() {
    if (wakeResolve) wakeResolve();
  }

  function startHeartbeat(token) {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      send({ type: MSG.LEASE_HEARTBEAT, leaseToken: token });
    }, CGR.LIMITS.heartbeatMs);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = 0;
  }

  async function report(leaseToken, status, data) {
    const res = await send({ type: MSG.OUTCOME, leaseToken, status, data: data || {} });
    return res;
  }

  /* ---------------- 前提设定 ---------------- */

  /** 逐条发送前提，等模型答完再发下一条。不取图、不计入队列。 */
  async function applyPremises(list, cfg, leaseToken, isAborted) {
    for (let i = 0; i < list.length; i++) {
      if (isAborted()) return { ok: false, reason: 'aborted' };

      send({ type: MSG.LOG, level: 'info', message: `发送前提 ${i + 1}/${list.length}…` });
      await send({ type: MSG.PROGRESS, leaseToken, phase: 'sending' });

      // 只关心「有没有新的一条 assistant 回复」，不看图片、也不等图片
      const beforeN = probe.assistantCount();
      const sent = await composer.sendPrompt(list[i], cfg);
      if (!sent.ok) return { ok: false, reason: `send-failed(${sent.code})` };

      const ack = await watch.waitForAck(beforeN, cfg, isAborted);
      if (ack === 'aborted') return { ok: false, reason: 'aborted' };
      if (ack === 'limit') return { ok: false, reason: 'limit' };
      if (ack !== 'ok') return { ok: false, reason: `no-reply(${ack})` };
    }

    // 前提阶段可能顺带出图，等界面彻底静止再给正式任务拍快照，避免把前提的图认成结果
    await CGR.sleep(1200);
    return { ok: true };
  }

  /* ---------------- 单条任务 ---------------- */

  async function runLease(grant) {
    const item = grant.item;
    const leaseToken = grant.leaseToken;
    const cfg = grant.cfg || CGR.DEFAULTS;
    const ctx = { token: leaseToken, aborted: false, index: item.index };
    current = ctx;
    const isAborted = () => ctx.aborted;

    startHeartbeat(leaseToken);
    try {
      if (!CGR.isChatGPT()) {
        await report(leaseToken, 'NAVIGATED');
        return;
      }

      if (probe.hasLoginWall()) {
        await report(leaseToken, 'AUTH_REQUIRED');
        return;
      }

      if (!composer.getComposer()) {
        await CGR.pollUntil(() => !!composer.getComposer(), 10000, 300);
      }
      if (!composer.getComposer()) {
        await report(leaseToken, 'CHAT_FAILED', { reason: 'no-composer' });
        return;
      }

      if (item.needFreshChat) {
        const ok = await composer.newChat();
        if (!ok) {
          // 已触发整页跳转。先把这条退了再走，别让租约白等 90 秒过期
          await report(leaseToken, 'NAVIGATED');
          return;
        }
        premisesApplied = false; // 新对话，前提需要重新发送
        await send({ type: MSG.PROGRESS, leaseToken, phase: 'chat-ready' });
      }

      if (ctx.aborted) {
        await report(leaseToken, 'ABORTED');
        return;
      }

      // 前提设定：只在当前对话没发过时发送（同一对话跑多条时只发一次）
      const premises = Array.isArray(grant.premises) ? grant.premises : [];
      if (!premisesApplied && premises.length) {
        const pr = await applyPremises(premises, cfg, leaseToken, isAborted);
        if (!pr.ok) {
          if (pr.reason === 'limit') {
            await report(leaseToken, 'LIMIT', {});
          } else if (pr.reason === 'aborted') {
            await report(leaseToken, 'ABORTED');
          } else {
            await report(leaseToken, 'PREMISE_FAILED', { reason: pr.reason });
          }
          return;
        }
        premisesApplied = true;
        send({ type: MSG.LOG, level: 'info', message: `前提已就绪（${premises.length} 条）` });
      }

      // 参考图：必须在发送前挂到输入框，且要等缩略图出现（上传完成）
      const refs = Array.isArray(item.refImages) ? item.refImages : [];
      if (refs.length) {
        send({ type: MSG.LOG, level: 'info', message: `#${item.index + 1} 附加 ${refs.length} 张参考图…` });
        const attached = await composer.attachImages(refs);
        if (!attached.ok) {
          await report(leaseToken, 'ATTACH_FAILED', { reason: attached.reason });
          return;
        }
        await CGR.sleep(600);
      }

      // 发送前快照
      const before = probe.snapshot();
      if (refs.length) {
        before.hasRefs = true;
        // 输入框里已挂的缩略图算作「既有图片」，不参与差集
        for (const src of composer.attachmentSrcs()) before.imgs.add(src);
      }
      await send({ type: MSG.PROGRESS, leaseToken, phase: 'sending' });

      const sent = await composer.sendPrompt(item.prompt, cfg);
      if (!sent.ok) {
        await report(leaseToken, 'SEND_FAILED', { code: sent.code });
        return;
      }

      await send({ type: MSG.PROGRESS, leaseToken, phase: 'sent' });
      send({ type: MSG.LOG, level: 'info', message: `#${item.index + 1} 已发送（${sent.method || 'auto'}），等待出图…` });

      const res = await watch.waitForOutcome(before, cfg, isAborted);
      await report(leaseToken, res.status, {
        images: res.images,
        text: res.text,
        raw: res.raw,
        stillGenerating: res.stillGenerating,
        phase: res.phase
      });
    } catch (e) {
      send({ type: MSG.LOG, level: 'error', message: `执行异常：${String((e && e.message) || e)}` });
      await report(leaseToken, 'PAGE_ERROR', { raw: String((e && e.message) || e) });
    } finally {
      stopHeartbeat();
      if (current === ctx) current = null;
    }
  }

  /* ---------------- 主循环 ---------------- */

  async function loop() {
    if (loopBusy) return;
    loopBusy = true;
    try {
      while (true) {
        if (contextDead) return; // 扩展已重载，本实例作废
        try {
          await loopOnce();
        } catch (e) {
          send({ type: MSG.LOG, level: 'error', message: `主循环异常：${String((e && e.message) || e)}` });
          await waitForWork(3000);
        }
      }
    } finally {
      loopBusy = false;
    }
  }

  /** 循环体的一次迭代；用 return 代替 continue，异常由外层兜住 */
  async function loopOnce() {
    if (!CGR.isChatGPT()) {
      await waitForWork(idleWait);
      return;
    }

    if (!composer.getComposer()) {
      // 页面还没就绪（或被导航到别的页面），等一等再问；持续找不到就报一次，别让用户干等
      noComposerHits += 1;
      if (noComposerHits === 5 || noComposerHits % 15 === 0) {
        send({
          type: MSG.LOG,
          level: 'warn',
          message: `当前页面找不到输入框（第 ${noComposerHits} 次），任务无法开始。请确认停在 chatgpt.com 的对话页，必要时刷新页面`
        });
      }
      await waitForWork(4000);
      return;
    }
    noComposerHits = 0;

    const grant = await send({ type: MSG.LEASE_REQUEST, convId: CGR.getConvId() });
    if (!grant || !grant.ok) {
      const reason = (grant && grant.reason) || 'no-response';
      const now = Date.now();
      if (reason !== lastIdleReason || now - lastIdleLogAt > 30000) {
        lastIdleReason = reason;
        lastIdleLogAt = now;
        const label = {
          drained: '队列里没有可领的任务',
          idle: '批次未启动',
          paused: '批次已暂停',
          error: '批次处于异常状态，需要处理',
          'limit_waiting': '限额冷却中',
          finished: '批次已完成',
          'no-batch': '这个标签页没有绑定批次',
          'conv-conflict': '与另一个标签页抢同一个对话',
          'no-response': '后台无响应（扩展可能正在重启）'
        }[reason] || reason;
        send({ type: MSG.LOG, level: 'info', message: `等待派发：${label}` });
      }
      await waitForWork(idleWait);
      idleWait = Math.min(idleWait * 2, 120000);
      return;
    }
    idleWait = CGR.LIMITS.idlePollMs;
    lastIdleReason = '';
    lastIdleLogAt = 0;

    await runLease(grant);
    send({ type: MSG.LOG, level: 'info', message: `#${grant.item.index + 1} 本轮结束，请求下一条` });

    const cfg = grant.cfg || CGR.DEFAULTS;
    const wait = CGR.randBetween(cfg.minDelayMs || 3000, cfg.maxDelayMs || 7000);
    await waitForWork(wait);
  }

  /* ---------------- 图片取流（下载降级用） ---------------- */

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(new Error('read-failed'));
      fr.readAsDataURL(blob);
    });
  }

  function canvasExtract(src) {
    const rootEl = CGR.getMain();
    for (const img of rootEl.querySelectorAll('img')) {
      if ((img.currentSrc || img.src) !== src) continue;
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        return c.toDataURL('image/png');
      } catch (e) {
        return '';
      }
    }
    return '';
  }

  async function fetchAndUpload(index, src, batchId) {
    try {
      let dataUrl = '';
      let mime = 'image/png';
      try {
        const res = await fetch(src, { credentials: 'include' });
        const blob = await res.blob();
        mime = blob.type || mime;
        dataUrl = await blobToDataUrl(blob);
      } catch (e) {
        dataUrl = canvasExtract(src);
        if (!dataUrl) throw e;
      }

      const b64 = dataUrl.split(',')[1] || '';
      if (!b64) throw new Error('empty-base64');
      const CHUNK = 1200000;
      const total = Math.ceil(b64.length / CHUNK);
      for (let i = 0; i < total; i++) {
        await send({
          type: MSG.DL_CHUNK,
          index,
          batchId,
          seq: i,
          total,
          data: b64.slice(i * CHUNK, (i + 1) * CHUNK)
        });
      }
      await send({
        type: MSG.DL_COMMIT,
        index,
        batchId,
        mime,
        ext: CGR.extFromUrl('', mime)
      });
    } catch (e) {
      send({ type: MSG.LOG, level: 'error', message: `页面内取流失败：${String((e && e.message) || e)}` });
    }
  }

  /* ---------------- 消息路由 ---------------- */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    switch (msg.type) {
      case MSG.PING:
        pokeIdle();
        sendResponse({ ok: true, ts: Date.now() });
        return false;
      case MSG.WAKE:
        pokeIdle();
        sendResponse({ ok: true });
        return false;
      case MSG.EVALUATE:
        pokeIdle();
        watch.triggerEvaluate();
        sendResponse({ ok: true });
        return false;
      case MSG.ABORT:
        if (current) current.aborted = true;
        sendResponse({ ok: true });
        return false;
      case 'FETCH_IMAGE':
        fetchAndUpload(msg.index, msg.src, msg.batchId);
        sendResponse({ ok: true });
        return false;
      case MSG.SELFCHECK:
        selfcheck
          .run()
          .then((reportRes) => sendResponse({ ok: true, report: reportRes }))
          .catch((e) => sendResponse({ ok: false, error: String(e && e.message) }));
        return true;
      default:
        return false;
    }
  });

  /* ---------------- 启动 ---------------- */

  async function boot() {
    await send({ type: MSG.HELLO, url: location.href, convId: CGR.getConvId() });
    setTimeout(loop, 800);
  }

  boot();
})(typeof globalThis !== 'undefined' ? globalThis : self);
