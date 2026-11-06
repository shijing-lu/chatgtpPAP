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
        const strict = probe.freshImages(before, anchor, false);
        const loose = probe.freshImages(before, anchor, true);
        const bySrc = new Map();
        for (const f of strict) bySrc.set(f.src, f);
        for (const f of loose) if (!bySrc.has(f.src)) bySrc.set(f.src, f);
        return Array.from(bySrc.values());
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
        const replied =
          probe.allMsgCount() > baseMsgs || probe.assistantCount() > baseAssistant || !!candidate;

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
        if (fresh.length) {
          const sig = fresh.map((f) => sigOf(f.src)).sort().join('|');
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
          // 图都稳定 15 秒以上了，就不该再被一个失效的状态选择器拖到超时
          const settledAnyway = !generating && stableFor >= Math.max(15000, stableMs * 5);
          if (candidate.hits >= 2 && stableFor >= stableMs && (replyEnded || settledAnyway)) {
            return finish({
              status: 'IMAGE_READY',
              images: candidate.srcs,
              loose: candidate.srcs.some((f) => f.loose),
              sigChanges: candidate.sigChanges
            });
          }
        } else if (candidate && now - candidate.lastSeenAt > 10000) {
          // 重渲染时图片会短暂消失，别把它当成「没出图」，但也别无限等
          candidate = null;
        }

        // 判「未出图」前，已经给过图片足够时间，并做最后一次宽松扫描
        if (!fresh.length && !candidate && replyEnded) {
          const sinceEnd = genEndAt ? now - genEndAt : quietFor;
          if (sinceEnd >= imageGraceMs) {
            return finish({
              status: 'NO_IMAGE',
              text: probe.lastAssistantText(),
              diagnostic: probe.diagnose(before),
              phase: sawGenerating ? 'after-generation' : 'dom-quiet'
            });
          }
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
