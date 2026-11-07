/* 出图检测：MutationObserver 事件驱动为主（后台标签页的 setTimeout 会被节流到约 1 次/分钟，
 * 但 MutationObserver 回调不受影响），5s 轮询与后台 EVALUATE 作为兜底。
 *
 * 判定原则（这里曾经是「已出图却判失败 → 重发提示词 → 重复生图」的发源地）：
 *  1. 只认「发送前快照里没有」的新大图，不靠图片 URL 白名单；
 *  2. 签名 URL 在重渲染时会变化，不能因为 src 变了就把稳定计时清零；
 *  3. 生成结束后图片可能晚到几十秒，必须留足宽限期，且结束判定不能押在
 *     stopButton 一个选择器上（前端改版就会全盘失效），用 DOM 静默做兜底；
 *  4. 判 NO_IMAGE 之前再做一次宽松扫描，并把页面实况写进结果供日志留证。 */
(function (root) {
  const CGR = root.CGR;
  const probe = root.CGR_PROBE;

  let currentEvaluate = null;

  function setEvaluateHook(fn) {
    currentEvaluate = fn;
  }

  function triggerEvaluate() {
    if (typeof currentEvaluate === 'function') {
      try {
        currentEvaluate();
      } catch (e) {
        /* ignore */
      }
    }
  }

  /** 签名 URL 的 query 每次重渲染都可能变，用主体做稳定标记 */
  function sigOf(src) {
    if (/^data:/i.test(src)) return `data:${src.length}:${src.slice(0, 48)}`;
    return String(src).split('#')[0].split('?')[0];
  }

  /**
   * @param {object} before  probe.snapshot() 的结果
   * @param {object} cfg     配置
   * @param {function} isAborted 返回 true 表示租约已被撤销
   * @returns {Promise<{status:string, images?:Array, text?:string, raw?:string, diagnostic?:object, stillGenerating?:boolean}>}
   */
  function waitForOutcome(before, cfg, isAborted) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const totalMs = Math.max(30000, cfg.timeoutMs || 300000);
      const firstSignalMs = Math.max(15000, cfg.firstSignalMs || 120000);
      const deadline = t0 + totalMs;
      const firstDeadline = t0 + firstSignalMs;
      const stableMs = Math.max(1000, cfg.stableMs || 3000);
      // 生成结束后允许图片晚到：ChatGPT 常先出文字/占位，图片稍后才插入
      const imageGraceMs = Math.max(20000, Math.min(45000, stableMs * 6));

      let candidate = null;
      let sawGenerating = false;
      let genEndAt = 0;
      let lastActivityAt = t0;
      let done = false;
      let target = CGR.getMain();

      const finish = (result) => {
        if (done) return;
        done = true;
        setEvaluateHook(null);
        try {
          mo.disconnect();
        } catch (e) {
          /* ignore */
        }
        clearInterval(iv);
        resolve(result);
      };

      const freshAll = (anchor) => {
        // 统一产物：内嵌 <img>、图片链接、文件附件卡片都在内。
        // 严格 + 宽松各扫一遍，按 kind+src 去重，严格结果优先，最后按页面顺序排好。
        const byKey = new Map();
        for (const loose of [false, true]) {
          for (const a of probe.freshArtifacts(before, anchor, loose)) {
            const key = a.kind + ':' + probe.normSrc(a.src);
            if (!byKey.has(key)) byKey.set(key, a);
          }
        }
        return probe.sortByDom(Array.from(byKey.values()));
      };

      // 「第一张」要跨轮询轮次稳定：图片可能一张张加载、重渲染时还会短暂消失。
      // 只认最后一轮列表的第一项会把先加载完的第 2/3 张当成第一张。
      const keyOf = (f) => f.kind + ':' + sigOf(f.src);
      let firstKey = null;
      let firstEl = null;
      let firstArtifact = null;

      /** 上报前的唯一出口：把首图放到第 1 位、重排 order、剥离 DOM 节点。 */
      const finalArtifacts = (srcs) => {
        const list = (srcs || []).slice();
        if (firstKey) {
          const idx = list.findIndex((f) => keyOf(f) === firstKey);
          if (idx > 0) list.unshift(list.splice(idx, 1)[0]);
          else if (idx < 0 && firstArtifact) list.unshift(firstArtifact);
        }
        const out = probe.cleanArtifacts(list);
        out.forEach((f, i) => {
          if (f && typeof f === 'object') f.order = i;
        });
        return out;
      };

      const evaluate = () => {
        if (done) return;
        const now = Date.now();

        // 页面容器被替换（SPA 重渲染）时重新绑定
        if (!document.contains(target)) {
          target = CGR.getMain();
          try {
            mo.observe(target, OBSERVE_OPTS);
          } catch (e) {
            /* ignore */
          }
        }

        if (isAborted && isAborted()) return finish({ status: 'ABORTED' });

        // 新对话发出第一条消息后，URL 会从 / 变成 /c/xxx，这属于正常流程而不是干扰；
        // 只有在「原本已在某个对话里」且跳到了别的对话时，才判定为被导航走。
        const nowConv = CGR.getConvId();
        if (before.convId && nowConv && nowConv !== before.convId) {
          return finish({ status: 'NAVIGATED' });
        }
        if (!before.convId && nowConv) before.convId = nowConv;

        const limit = probe.detectLimit();
        if (limit) return finish({ status: 'LIMIT', raw: limit });

        const generating = probe.isGenerating();
        if (generating) {
          sawGenerating = true;
          genEndAt = 0;
          lastActivityAt = now;
        } else if (sawGenerating && !genEndAt) {
          genEndAt = now;
        }

        const baseMsgs = before.msgCount || 0;
        const baseAssistant = before.assistantCount || 0;
        // 消息节点的选择器也可能改版（日志里出现过「消息=0」）。
        // 新链接 / 新附件卡片 / 正文明显变长，同样说明回复已经到了。
        const replied =
          probe.allMsgCount() > baseMsgs ||
          probe.assistantCount() > baseAssistant ||
          probe.artifactSignal(before) ||
          !!candidate;

        // 页面报错只在「确实没收到任何回复」时才当失败；出了新消息/新图就不能据此重发
        const pageErr = probe.detectPageError();
        if (pageErr && !generating && !replied) {
          return finish({ status: 'PAGE_ERROR', raw: pageErr, diagnostic: probe.diagnose(before) });
        }

        // stopButton 选择器万一失效，也不能让判定永远悬着：用 DOM 静默判断回复是否结束
        const quietFor = now - lastActivityAt;
        // 生成结束的确认期固定封顶 8 秒，不能跟着 stableMs 放大：
        // 图片稳定窗口调大时，不该把「回复是否结束」也一起拖长。
        const replyEnded = generating
          ? false
          : genEndAt
            ? now - genEndAt >= Math.max(3000, Math.min(8000, stableMs))
            : sawGenerating === false && replied && quietFor >= 8000;

        // 一直没进入生成态、没有任何新消息也没有新图 → 发送大概率没生效
        if (!sawGenerating && !candidate && !replied && now > firstDeadline) {
          return finish({ status: 'TIMEOUT', phase: 'no-first-byte', diagnostic: probe.diagnose(before) });
        }

        let anchor = null;
        if (before.hasRefs) {
          const list = CGR.pickAll(CGR.SEL.assistantMsg);
          anchor = list.length ? list[list.length - 1] : null;
        }

        const fresh = freshAll(anchor);
        // 文件链接 / 附件卡片 / 带「下载全尺寸」按钮的站点生成图一旦出现就是最终交付物，
        // 不需要等满图片的稳定窗口，但依然要等回复结束（避免抓到生成中的占位）。
        const hasFileArtifact = fresh.some((f) => f.kind !== 'img' || f.siteDownload);
        if (fresh.length) {
          const head = fresh[0];
          if (!firstEl) {
            firstKey = keyOf(head);
            firstEl = head._el || null;
            firstArtifact = probe.cleanArtifacts([head])[0];
          } else if (head._el && firstEl && probe.domCmp(head._el, firstEl) < 0) {
            // 页面上更靠前的图晚到了：它才是「第一张」，不能让先加载完的第二张顶替
            firstKey = keyOf(head);
            firstEl = head._el;
            firstArtifact = probe.cleanArtifacts([head])[0];
          }
          // 签名 URL 重渲染后可能变化，首图数据始终取最新一份，避免下载到过期链接
          if (firstKey) {
            const cur = fresh.find((f) => keyOf(f) === firstKey);
            if (cur) firstArtifact = probe.cleanArtifacts([cur])[0];
          }
          const sig = fresh.map((f) => f.kind + ':' + sigOf(f.src)).sort().join('|');
          if (!candidate) {
            candidate = { sig, srcs: fresh, firstSeenAt: now, lastSeenAt: now, hits: 1, sigChanges: 0 };
          } else {
            candidate.hits += 1;
            candidate.lastSeenAt = now;
            // 始终用最新一组（避免下载到中途的低清预览图）
            candidate.srcs = fresh;
            if (candidate.sig !== sig) {
              candidate.sigChanges += 1;
              candidate.sig = sig;
            }
          }
          const stableFor = now - candidate.firstSeenAt;
          const requiredStable = hasFileArtifact ? Math.min(stableMs, 2500) : stableMs;
          // 图都稳定 15 秒以上了，就不该再被一个失效的状态选择器拖到超时
          const settledAnyway = !generating && stableFor >= Math.max(15000, stableMs * 5);
          if (candidate.hits >= 2 && stableFor >= requiredStable && (replyEnded || settledAnyway)) {
            const images = finalArtifacts(candidate.srcs);
            return finish({
              status: 'IMAGE_READY',
              images,
              loose: images.some((f) => f.loose),
              kinds: images.map((f) => f.kind),
              sigChanges: candidate.sigChanges
            });
          }
        } else if (candidate && now - candidate.lastSeenAt > 10000) {
          // 重渲染时图片会短暂消失，别把它当成「没出图」，但也别无限等。
          // 候选整体作废时首图也要重新判定，否则会一直抱着已经脱离文档的旧节点。
          candidate = null;
          firstKey = null;
          firstEl = null;
          firstArtifact = null;
        }

        const sinceEnd = genEndAt ? now - genEndAt : quietFor;

        // 产物已经出现、回复也结束了，只是稳定条件一直没凑齐：
        // 宽限期一到就按「已出图」交付，绝不能拖到 TIMEOUT 或 NO_IMAGE。
        if (candidate && replyEnded && sinceEnd >= imageGraceMs) {
          const images = finalArtifacts(candidate.srcs);
          return finish({
            status: 'IMAGE_READY',
            images,
            loose: images.some((f) => f.loose),
            kinds: images.map((f) => f.kind),
            sigChanges: candidate.sigChanges,
            phase: 'grace-timeout'
          });
        }

        // 判「未出图」前，已经给过产物足够时间，并做最后一次宽松扫描（含链接与附件卡片）
        if (!fresh.length && !candidate && replyEnded && sinceEnd >= imageGraceMs) {
          const lastLook = freshAll(anchor);
          if (lastLook.length) {
            const images = finalArtifacts(lastLook);
            return finish({
              status: 'IMAGE_READY',
              images,
              loose: images.some((f) => f.loose),
              kinds: images.map((f) => f.kind),
              phase: 'final-loose-scan'
            });
          }
          return finish({
            status: 'NO_IMAGE',
            text: probe.lastAssistantText(),
            diagnostic: probe.diagnose(before),
            phase: sawGenerating ? 'after-generation' : 'dom-quiet'
          });
        }

        if (now > deadline) {
          return finish({
            status: 'TIMEOUT',
            stillGenerating: generating,
            diagnostic: probe.diagnose(before),
            imageHint: candidate ? candidate.srcs.length : 0
          });
        }
      };

      const OBSERVE_OPTS = {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'disabled', 'aria-label', 'data-testid', 'data-state', 'class']
      };

      let lastRun = 0;
      const mo = new MutationObserver(() => {
        lastActivityAt = Date.now();
        // 回调内做时间戳节流，避免流式输出导致的高频重算
        if (Date.now() - lastRun < 250) return;
        lastRun = Date.now();
        evaluate();
      });

      try {
        mo.observe(target, OBSERVE_OPTS);
      } catch (e) {
        /* ignore */
      }

      const iv = setInterval(evaluate, 5000);
      setEvaluateHook(evaluate);
      evaluate();
    });
  }

  /**
   * 等待正式生图任务的出图结果（前提阶段不调用它）。
   * 以 MutationObserver 为主驱动，避免后台标签页定时器被节流。
   */
  root.CGR_WATCH = { waitForOutcome, setEvaluateHook, triggerEvaluate };
})(typeof globalThis !== 'undefined' ? globalThis : self);
