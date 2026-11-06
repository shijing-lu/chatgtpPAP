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
  let idleWait = CGR.LIMITS.idlePollMs; // 空闲轮询间隔，只在小范围内退避，绝不拖到分钟级
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

  /** 结果上报必须确认送达：丢一条 OUTCOME，后台就会在租约过期后把任务退回队列，
   * 重新发一次提示词、重新生成一张图。SW 冷启动/回收时的丢包是常态。 */
  async function report(leaseToken, status, data) {
    const msg = { type: MSG.OUTCOME, leaseToken, status, data: data || {} };
    for (let i = 0; i < 4; i++) {
      const res = await send(msg);
      if (res && res.ok !== false) return res;
      if (contextDead) return null;
      await CGR.sleep(600 * (i + 1));
    }
    const idx = current && current.index != null ? current.index + 1 : '?';
    send({ type: MSG.LOG, level: 'error', message: `#${idx} 结果上报失败（${status}），请检查后台日志` });
    return null;
  }

  /* ---------------- 前提设定 ---------------- */

  /** 把发送链路的逐次页面实况写进日志，失败时能直接看出卡在哪一步 */
  function logSendDiagnostic(prefix, sent) {
    for (const line of (sent && sent.diagnostic) || []) {
      send({ type: MSG.LOG, level: 'warn', message: `${prefix} ${line}` });
    }
  }

  /** 逐条发送前提，发出去就算完成：不等回复、不取图、不计入队列。
   * 关键点：ChatGPT 输出回复时发送按钮会变成「停止生成」，所以每条前提发送前
   * 都要把输入框恢复到可发送状态；前提阶段直接跳过文本回复，不做任何等待。 */
  async function applyPremises(list, cfg, leaseToken, isAborted) {
    for (let i = 0; i < list.length; i++) {
      if (isAborted()) return { ok: false, reason: 'aborted' };

      send({ type: MSG.LOG, level: 'info', message: `发送前提 ${i + 1}/${list.length}…` });
      await send({ type: MSG.PROGRESS, leaseToken, phase: 'sending' });

      const sent = await composer.sendPrompt(list[i], cfg, { allowStop: true });
      if (!sent.ok) {
        logSendDiagnostic(`前提 ${i + 1}`, sent);
        return { ok: false, reason: `send-failed(${sent.code})`, diagnostic: sent.diagnostic };
      }

      // 前提只是把上下文塞进对话，发出去就算完成，不等任何回复、也不看图
      send({ type: MSG.LOG, level: 'info', message: `前提 ${i + 1} 已发送（${sent.method || 'auto'}，不等回复）` });
      if (i < list.length - 1) await CGR.sleep(1200);
    }

    // 最后一条前提之后模型多半还在输出文字。这里只腾出输入框，不读回复、不看图、不等生成结束。
    if (probe.isGenerating()) {
      const r = await composer.waitSendable({ allowStop: true, naturalWaitMs: 800, maxWaitMs: 3000 });
      if (r.stopped) send({ type: MSG.LOG, level: 'info', message: '已跳过前提的文本回复，输入框恢复可用' });
    }

    await CGR.sleep(600);
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
    let waitingTimer = 0;
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
            await report(leaseToken, 'PREMISE_FAILED', { reason: pr.reason, diagnostic: pr.diagnostic || [] });
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
        logSendDiagnostic(`#${item.index + 1}`, sent);
        await report(leaseToken, 'SEND_FAILED', { code: sent.code, diagnostic: sent.diagnostic || [] });
        return;
      }

      await send({ type: MSG.PROGRESS, leaseToken, phase: 'sent' });
      send({ type: MSG.LOG, level: 'info', message: `#${item.index + 1} 已发送（${sent.method || 'auto'}），等待出图…` });

      // 图片生成慢时持续报进度，用户能分清「还在等」和「卡死了」
      const sentAt = Date.now();
      waitingTimer = setInterval(() => {
        send({
          type: MSG.LOG,
          level: 'info',
          message: `#${item.index + 1} 仍在等待出图（已等 ${Math.round((Date.now() - sentAt) / 1000)} 秒）…`
        });
      }, 30000);

      const res = await watch.waitForOutcome(before, cfg, isAborted);
      clearInterval(waitingTimer);
      waitingTimer = 0;

      if (res.status === 'IMAGE_READY') {
        const n = (res.images || []).length;
        const kinds = Array.isArray(res.kinds) ? Array.from(new Set(res.kinds)).join('/') : '';
        send({
          type: MSG.LOG,
          level: 'info',
          message: `#${item.index + 1} 检测到 ${n} 个产物（${kinds || 'img'}${res.loose ? '，含宽松规则命中' : ''}），交给后台下载`
        });
      } else if (res.diagnostic) {
        const d = res.diagnostic;
        send({
          type: MSG.LOG,
          level: 'warn',
          message: `#${item.index + 1} ${res.status} 页面实况：img ${d.totalImgs} / 新增 ${d.freshImgs} / 规则命中 ${d.strictHits} / 链接 ${d.freshLinks || 0} / 附件 ${d.fileCards || 0} / canvas ${d.canvases} / 消息 ${d.msgNodes} / 停止按钮 ${d.stopHit ? '命中' : '未命中'}`
        });
        for (const s of d.samples || []) {
          send({ type: MSG.LOG, level: 'warn', message: `  ↳ ${s}` });
        }
      }

      await report(leaseToken, res.status, {
        images: res.images,
        text: res.text,
        raw: res.raw,
        stillGenerating: res.stillGenerating,
        phase: res.phase,
        loose: res.loose,
        sigChanges: res.sigChanges,
        diagnostic: res.diagnostic
      });
    } catch (e) {
      send({ type: MSG.LOG, level: 'error', message: `执行异常：${String((e && e.message) || e)}` });
      await report(leaseToken, 'PAGE_ERROR', { raw: String((e && e.message) || e) });
    } finally {
      if (waitingTimer) clearInterval(waitingTimer);
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

    // SW 冷启动时的第一条消息容易丢，立刻补一次；丢包不再被当成「要退避」的信号
    let grant = await send({ type: MSG.LEASE_REQUEST, convId: CGR.getConvId() });
    if (!grant) {
      await CGR.sleep(400);
      grant = await send({ type: MSG.LEASE_REQUEST, convId: CGR.getConvId() });
    }
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
          'no-batch': '这个标签页未绑定批次（多标签页时以执行页为准）',
          'conv-conflict': '与另一个标签页抢同一个对话',
          'no-response': '后台无响应（扩展可能正在重启）'
        }[reason] || reason;
        const extra = reason === 'no-batch' && grant && grant.activeBatch ? `（「${grant.activeBatch}」在另一个标签页执行）` : '';
        send({ type: MSG.LOG, level: 'info', message: `等待派发：${label}${extra}` });
      }
      await waitForWork(idleWait);
      // 只做小幅退避并封顶 8 秒：既不会刷屏，也保证 SW 一直被消息喂着、不会被回收
      idleWait = Math.min(idleWait + 1500, CGR.LIMITS.idleMaxPollMs);
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

  /** 让 ChatGPT 自己下载附件文件。绝不点「查看原图」这类 http 外链：
   * 那会在当前页导航或开新标签页，用户明确不允许。sandbox: / 卡片按钮才走这里。 */
  function clickAttachment(src, label) {
    if (/^https?:\/\//i.test(src || '')) return false;
    const el = probe.findClickTarget(src, label);
    if (!el || !el.click) return false;
    try {
      if (el.setAttribute) {
        el.setAttribute('target', '_self');
        // 让 <a> 走下载而不是预览/导航；对 button 无副作用
        if (el.tagName === 'A' && !(el.hasAttribute && el.hasAttribute('download'))) el.setAttribute('download', '');
      }
      el.click();
      return true;
    } catch (e) {
      return false;
    }
  }

  async function fetchAndUpload(index, src, batchId, opts) {
    const detail = opts || {};
    try {
      let dataUrl = '';
      let mime = 'image/png';
      try {
        // sandbox: / card: 这类伪协议 fetch 不了，直接跳到点击兜底
        if (!/^(blob:|https?:|data:)/i.test(src || '')) throw new Error('unsupported-scheme');
        const res = await fetch(src, { credentials: 'include' });
        if (res.ok === false) throw new Error(`http-${res.status}`);
        const blob = await res.blob();
        mime = blob.type || mime;
        dataUrl = await blobToDataUrl(blob);
      } catch (e) {
        if (detail.click && clickAttachment(src, detail.label)) {
          send({
            type: MSG.LOG,
            level: 'info',
            message: `#${index + 1} 已点击页面附件，由后台把下载归位到批次目录（不会新开标签页）`
          });
          return;
        }
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
        fetchAndUpload(msg.index, msg.src, msg.batchId, {
          label: msg.label,
          kind: msg.kind,
          click: msg.click
        });
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
    // HELLO 必须先于主循环完成：它会回收页面刷新前遗留的旧租约。
    // 若让 loop 先领了任务、HELLO 才到，刚领到的新任务会被当成旧租约退回。
    // 加 3 秒上限，避免 SW 冷启动丢消息时把启动卡死。
    await CGR.withTimeout(
      send({ type: MSG.HELLO, url: location.href, convId: CGR.getConvId() }),
      3000,
      null
    );
    loop();
  }

  boot();
})(typeof globalThis !== 'undefined' ? globalThis : self);
