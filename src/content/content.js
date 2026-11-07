/* 内容脚本入口：向后台领取任务 → 新开对话 → 发送 → 等待出图 → 上报结果 → 领下一条。 */
(function (root) {
  if (window.__CGR_LOADED__) return;
  window.__CGR_LOADED__ = true;

  /* 实例代次：后台强制重注入时把它 +1。旧实例的 loop / 心跳 / 等待日志定时器
   * 仍挂在页面里，不主动停掉就会和新实例一起领任务、重复发提示词。 */
  const instanceGen = (window.__CGR_INSTANCE__ = (Number(window.__CGR_INSTANCE__) || 0) + 1);
  function instanceDead() {
    return window.__CGR_INSTANCE__ !== instanceGen || contextDead;
  }

  const CGR = root.CGR;
  const probe = root.CGR_PROBE;
  const composer = root.CGR_COMPOSER;
  const watch = root.CGR_WATCH;
  const selfcheck = root.CGR_SELFCHECK;
  const premise = root.CGR_PREMISE;

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

  /* 主循环活性：后台 PING 会把它带回去。消息监听器活着 ≠ 主循环活着，
   * 后者才是「有没有继续往聊天框发提示词」的唯一事实。 */
  let loopAlive = false;
  let loopPhase = 'boot';
  let lastLoopAt = Date.now();

  function send(msg) {
    if (instanceDead()) return Promise.resolve(null);
    const raw = new Promise((resolve) => {
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
    // SW 回收 / 冷启动窗口里的一条消息可能永远不回调。没有这层超时，
    // 任何一个 await send() 都会把主循环永久挂起，而且不留异常日志：
    // 监听器还在（PING 照样回 ok），心跳还在续租，后台就一直以为任务正常执行中。
    return CGR.withTimeout(raw, CGR.LIMITS.msgTimeoutMs || 8000, null);
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

  /** 只在主循环自己的路径上调用；心跳定时器不算，否则「僵尸心跳」会伪装成活着的 loop */
  function touchLoop(phase) {
    lastLoopAt = Date.now();
    if (phase) loopPhase = phase;
  }

  function loopStatus() {
    const stallMs = CGR.LIMITS.loopStallMs || 90000;
    // lease 阶段（等出图）本来就可能几分钟，不能用空闲阶段的阈值去误判它停摆。
    const idleStall = loopPhase !== 'lease' && Date.now() - lastLoopAt > stallMs;
    return {
      alive: loopAlive && !instanceDead(),
      phase: loopPhase,
      lastLoopAt,
      stalled: !loopAlive || instanceDead() || idleStall,
      contextDead: !!contextDead,
      instance: instanceGen
    };
  }

  /** 借后台 PING 触发：页面 timer 在后台标签页会被节流到分钟级，看门狗不能只靠页面自己 */
  function ensureLoopAlive() {
    const st = loopStatus();
    if (!st.stalled || st.contextDead) return false;
    if (!st.alive && !loopBusy) {
      // 主循环已经退出、又不是扩展重载导致的：本地直接拉起来，恢复派发
      touchLoop('idle');
      send({ type: MSG.LOG, level: 'warn', message: '页面主循环已退出，已自动重启并继续派发' });
      loop();
      return true;
    }
    // 仍卡在某个 await：本地不好强杀，把 stalled 交给后台做强制重注入（不新开标签页）
    return false;
  }

  function startHeartbeat(token) {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      // 旧实例被强制重注入后必须闭嘴，否则它还会替一条早就没人执行的任务续租，
      // 后台所有自愈都会因为「有任务在跑」而集体跳过。
      if (instanceDead()) {
        stopHeartbeat();
        return;
      }
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
    // 带上页面站点：后台要据此选择「直链下载」还是「点站点按钮取全尺寸图」，
    // 也能发现标签页被导航到另一个站点后仍在领旧批次任务的情况。
    const msg = {
      type: MSG.OUTCOME,
      leaseToken,
      status,
      site: typeof CGR.currentSiteId === 'function' ? CGR.currentSiteId() : '',
      data: Object.assign({ site: typeof CGR.currentSiteId === 'function' ? CGR.currentSiteId() : '' }, data || {})
    };
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

  /** 逐条发送前提：每条都等 ChatGPT 回复写完、检测到回复后才发下一条；不取图、不计入队列。
   * 节奏逻辑在 premise.js（可零依赖回归测试）。这里只负责把日志/进度/页面能力接进去。
   * 最后一条前提之后同样要等回复，否则第一条生图提示词会贴着它发出去，前提等于没生效。 */
  async function applyPremises(list, cfg, leaseToken, isAborted) {
    return premise.apply(list, {
      cfg,
      probe,
      sendPrompt: composer.sendPrompt,
      waitSendable: composer.waitSendable,
      isAborted,
      log: (level, message) => send({ type: MSG.LOG, level, message }),
      progress: () => send({ type: MSG.PROGRESS, leaseToken, phase: 'sending' })
    });
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
      if (!CGR.isChatSite()) {
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
        if (instanceDead()) {
          clearInterval(waitingTimer);
          waitingTimer = 0;
          return;
        }
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
          message: `#${item.index + 1} 检测到 ${n} 个产物（${kinds || 'img'}${res.loose ? '，含宽松规则命中' : ''}），已按页面顺序交给后台，默认只下载第 1 张`
        });
      } else if (res.status === 'PAGE_STALE') {
        send({
          type: MSG.LOG,
          level: 'warn',
          message: `#${item.index + 1} 页面长时间没有任何更新，服务端可能已经出图（手机端能看到就属于这种）。刷新这个标签页通常立刻就能看到图；本条按「待确认」处理，绝不会重发提示词`
        });
      } else if (res.diagnostic) {
        const d = res.diagnostic;
        send({
          type: MSG.LOG,
          level: 'warn',
          message: `#${item.index + 1} ${res.status} 页面实况（站点 ${d.site || CGR.currentSiteLabel()}）：img ${d.totalImgs} / 新增 ${d.freshImgs} / 规则命中 ${d.strictHits} / 链接 ${d.freshLinks || 0} / 附件 ${d.fileCards || 0} / canvas ${d.canvases} / 消息 ${d.msgNodes} / 停止按钮 ${d.stopHit ? '命中' : '未命中'}${d.site === 'gemini' ? ` / 生成图容器 ${d.generatedBoxes || 0} / 全尺寸下载按钮 ${d.siteDownloadButtons || 0}` : ''}`
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
    loopAlive = true;
    touchLoop('idle');
    try {
      // 实例代次变了（后台强制重注入）或扩展重载：旧实例立刻退出，别和新实例抢任务
      while (!instanceDead()) {
        try {
          await loopOnce();
        } catch (e) {
          send({ type: MSG.LOG, level: 'error', message: `主循环异常：${String((e && e.message) || e)}` });
          await waitForWork(3000);
        }
      }
    } finally {
      loopBusy = false;
      loopAlive = false;
      if (instanceDead()) loopPhase = 'dead';
    }
  }

  /** 页面实况：后台 PING 时顺带带回，用于分辨「脚本还活着」和「这一页真的是对话页」。
   * 停在登录页/错误页/加载中的标签页同样能回 PING，但没有输入框也没有消息节点。 */
  function pageStatus() {
    let hasComposer = false;
    let msgCount = 0;
    try {
      hasComposer = !!composer.getComposer();
    } catch (e) {}
    try {
      msgCount = CGR.pickAll(CGR.SEL.allMsg || []).length;
    } catch (e) {}
    let ready = '';
    try {
      ready = document.readyState;
    } catch (e) {}
    return { hasComposer, msgCount, ready };
  }

  /** 循环体的一次迭代；用 return 代替 continue，异常由外层兜住 */
  async function loopOnce() {
    touchLoop('idle');
    if (!CGR.isChatSite()) {
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
          message: `当前页面找不到输入框（第 ${noComposerHits} 次），任务无法开始。请确认停在 ${CGR.currentSiteLabel()} 的对话页，必要时刷新页面`
        });
        // 让后台知道「这一页不是可用对话页」，别把它当成健康执行页一直等下去
        send({
          type: MSG.PAGE_NOT_READY,
          site: typeof CGR.currentSiteId === 'function' ? CGR.currentSiteId() : '',
          url: location.href,
          page: pageStatus(),
          hits: noComposerHits
        });
      }
      await waitForWork(4000);
      return;
    }
    noComposerHits = 0;

    // SW 冷启动时的第一条消息容易丢，立刻补一次；丢包不再被当成「要退避」的信号
    const leaseReq = () => ({
      type: MSG.LEASE_REQUEST,
      convId: CGR.getConvId(),
      site: typeof CGR.currentSiteId === 'function' ? CGR.currentSiteId() : ''
    });
    let grant = await send(leaseReq());
    if (!grant) {
      await CGR.sleep(400);
      grant = await send(leaseReq());
    }
    if (!grant || !grant.ok) {
      const reason = (grant && grant.reason) || 'no-response';
      const now = Date.now();
      // 旁观标签页每 3~8 秒就来领一次任务，30 秒一条会把真正有用的日志冲掉。
      // 这条纯状态噪音降到 2 分钟一次，其它状态变化仍按 30 秒。
      const logGap = reason === 'no-batch' ? 120000 : 30000;
      if (reason !== lastIdleReason || now - lastIdleLogAt > logGap) {
        lastIdleReason = reason;
        lastIdleLogAt = now;
        const label = {
          drained: '队列里没有可领的任务',
          idle: '批次未启动',
          paused: '批次已暂停',
          error: '批次处于异常状态，需要处理',
          'limit_waiting': '限额冷却中',
          finished: '批次已完成',
          'no-batch': '这是旁观标签页，批次在另一个标签页执行（本页不用操作；执行页失联时会自动接管）',
          'site-mismatch': '这个标签页的站点与批次绑定的站点不一致，请在批次设置里改「工作站点」',
          'conv-conflict': '与另一个标签页抢同一个对话',
          'no-response': '后台无响应（扩展可能正在重启）'
        }[reason] || reason;
        const extra = reason === 'no-batch' && grant && grant.activeBatch ? `（「${grant.activeBatch}」正在那个标签页执行）` : '';
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

    touchLoop('lease');
    await runLease(grant);
    touchLoop('idle');
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

  /** 大图直接在页面里用 blob: + <a download> 下载。
   * Chrome 对 data: 下载 URL 有长度限制，4K PNG 转 base64 很容易超限导致
   * 「下载失败」；blob 点击是浏览器原生路径，同源带 cookie、没有大小限制。
   * 名字和目录仍由后台的 onDeterminingFilename 归位，这里只保证不被默认命名。 */
  function blobClick(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = String(filename || '').split('/').pop() || 'image.png';
    a.target = '_self';
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    // 立刻 revoke 会让部分 Chrome 版本取消下载，留足时间再释放
    setTimeout(() => {
      try {
        a.remove();
      } catch (e) {}
      try {
        URL.revokeObjectURL(url);
      } catch (e) {}
    }, 60000);
    return true;
  }

  /** 让 ChatGPT 自己下载附件文件。绝不点「查看原图」这类 http 外链：
   * 那会在当前页导航或开新标签页，用户明确不允许。sandbox: / 卡片按钮才走这里。
   * filename 是批次目录/命名模板算好的目标名：即使后台归位监听器失效，
   * download 属性至少能让文件带上正确名字，而不是 Chrome 默认的「下载.png」。 */
  function clickAttachment(src, label, filename) {
    if (/^https?:\/\//i.test(src || '')) return false;
    const el = probe.findClickTarget(src, label);
    if (!el || !el.click) return false;
    try {
      if (el.setAttribute) {
        el.setAttribute('target', '_self');
        // 让 <a> 走下载而不是预览/导航；对 button 无副作用
        if (el.tagName === 'A') {
          const wanted = String(filename || '').split('/').pop();
          if (!(el.hasAttribute && el.hasAttribute('download')) || wanted) {
            el.setAttribute('download', wanted || '');
          }
        }
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

        // 大图别拼 data URL：Chrome 对 data: 下载 URL 有长度上限，
        // 4K PNG 走这条路经常直接失败。先用消息让后台登记归位目标再点 blob。
        const approxB64 = Math.ceil((blob.size || 0) * 4 / 3);
        if (approxB64 > (CGR.LIMITS.maxDataUrlB64 || 12000000)) {
          const ack = await send({
            type: MSG.DL_BLOB_CLICK,
            index,
            batchId,
            ext: CGR.extFromUrl('', mime),
            size: blob.size || 0
          });
          if (ack && ack.ok) {
            blobClick(blob, ack.filename);
            send({
              type: MSG.LOG,
              level: 'info',
              message: `#${index + 1} 图片较大（${Math.round((blob.size || 0) / 1024 / 1024 * 10) / 10} MB），已改用页面原生下载，不拼 data URL；由后台归位到批次目录`
            });
            return;
          }
        }
        dataUrl = await blobToDataUrl(blob);
      } catch (e) {
        if (detail.click && clickAttachment(src, detail.label, detail.filename)) {
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
      // 完整性由后台 commitChunks 校验：丢一片就标待确认，绝不保存损坏文件
      await send({
        type: MSG.DL_COMMIT,
        index,
        batchId,
        mime,
        ext: CGR.extFromUrl('', mime)
      });
    } catch (e) {
      const reason = String((e && e.message) || e);
      send({ type: MSG.LOG, level: 'error', message: `页面内取流失败：${reason}` });
      // 以前只写一条日志就结束，后台任务会永远挂在「下载中」并拖住整批队列。
      // 现在立刻告诉后台收敛为「待确认」，绝不重发提示词。
      send({ type: MSG.DL_FETCH_FAILED, index, batchId, reason });
    }
  }

  /* ---------------- 站点全尺寸下载（Gemini） ---------------- */

  /** Gemini 生成图在页面里是 1024px 预览（blob:），点容器里的
   * 「Download full size image」才会产出真正的全尺寸文件。
   * 后台已经登记好目标文件名（下载意图表），这里只负责点按钮：
   * 不导航、不开新标签页，下载由 onDeterminingFilename 归位到批次目录。 */
  function clickSiteDownload(msg) {
    const idx = msg.index != null ? msg.index + 1 : '?';
    const btn = probe.findSiteDownloadButton ? probe.findSiteDownloadButton(msg.src) : null;
    if (!btn || !btn.click) {
      send({
        type: MSG.LOG,
        level: 'error',
        message: `#${idx} 找不到「下载全尺寸图片」按钮，图片可能只剩预览；可在页面手动保存`
      });
      return false;
    }
    try {
      const inner = btn.tagName === 'A' ? btn : btn.querySelector && btn.querySelector('a');
      if (inner && inner.setAttribute) {
        inner.setAttribute('target', '_self');
        const wanted = String(msg.filename || '').split('/').pop();
        if (wanted) inner.setAttribute('download', wanted);
      }
      btn.click();
      send({
        type: MSG.LOG,
        level: 'info',
        message: `#${idx} 已点击${CGR.currentSiteLabel()}的全尺寸下载按钮，由后台归位到 ${msg.filename || '批次目录'}（不会新开标签页）`
      });
      return true;
    } catch (e) {
      send({ type: MSG.LOG, level: 'error', message: `#${idx} 点击全尺寸下载失败：${String((e && e.message) || e)}` });
      return false;
    }
  }

  /* ---------------- 消息路由 ---------------- */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    // 已被强制重注入的旧实例必须彻底闭嘴，否则两个监听器会同时应答同一条 PING，
    // 后台可能拿到旧实例的「停摆」状态，反而反复重注入。
    if (instanceDead()) return false;
    switch (msg.type) {
      case MSG.PING:
        // 后台每 30 秒必发一次：既打断空闲等待，也顺带做一次主循环看门狗检查
        ensureLoopAlive();
        pokeIdle();
        sendResponse({ ok: true, ts: Date.now(), loop: loopStatus(), page: pageStatus() });
        return false;
      case MSG.WAKE:
        ensureLoopAlive();
        pokeIdle();
        sendResponse({ ok: true, loop: loopStatus() });
        return false;
      case MSG.EVALUATE:
        pokeIdle();
        watch.triggerEvaluate();
        sendResponse({ ok: true, loop: loopStatus() });
        return false;
      case MSG.ABORT:
        if (current) current.aborted = true;
        sendResponse({ ok: true });
        return false;
      case MSG.CLICK_SITE_DOWNLOAD:
        sendResponse({ ok: clickSiteDownload(msg) });
        return false;
      case 'FETCH_IMAGE':
        fetchAndUpload(msg.index, msg.src, msg.batchId, {
          label: msg.label,
          kind: msg.kind,
          filename: msg.filename,
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
      send({
        type: MSG.HELLO,
        url: location.href,
        convId: CGR.getConvId(),
        site: typeof CGR.currentSiteId === 'function' ? CGR.currentSiteId() : ''
      }),
      3000,
      null
    );
    loop();
  }

  boot();
})(typeof globalThis !== 'undefined' ? globalThis : self);
