/* 出图检测：MutationObserver 事件驱动为主（后台标签页的 setTimeout 会被节流到约 1 次/分钟，
 * 但 MutationObserver 回调不受影响），5s 轮询与后台 EVALUATE 作为兜底。
 * 判定：停止按钮消失 + main 内出现快照中没有的新图 + src 连续稳定 >= stableMs。 */
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

  /**
   * @param {object} before  probe.snapshot() 的结果
   * @param {object} cfg     配置
   * @param {function} isAborted 返回 true 表示租约已被撤销
   * @returns {Promise<{status:string, images?:Array, text?:string, raw?:string, stillGenerating?:boolean}>}
   */
  function waitForOutcome(before, cfg, isAborted) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const totalMs = Math.max(30000, cfg.timeoutMs || 300000);
      const firstSignalMs = Math.max(15000, cfg.firstSignalMs || 120000);
      const deadline = t0 + totalMs;
      const firstDeadline = t0 + firstSignalMs;
      const stableMs = Math.max(1000, cfg.stableMs || 3000);

      let candidate = null;
      let stoppedSeen = false;
      let settleAt = 0;
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

      const evaluate = () => {
        if (done) return;
        const now = Date.now();

        // 页面容器被替换（SPA 重渲染）时重新绑定
        if (!document.contains(target)) {
          target = CGR.getMain();
          try {
            mo.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'disabled', 'aria-label', 'data-testid'] });
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

        const pageErr = probe.detectPageError();
        if (pageErr && !probe.isGenerating()) return finish({ status: 'PAGE_ERROR', raw: pageErr });

        const generating = probe.isGenerating();
        if (generating) {
          stoppedSeen = true;
          settleAt = 0;
        } else if (stoppedSeen && !settleAt) {
          settleAt = now + Math.max(6000, Math.min(12000, stableMs + 5000));
        }

        // 一直没进入生成态，也没有新消息 → 发送大概率没生效
        if (!stoppedSeen && now > firstDeadline && probe.allMsgCount() === before.msgCount) {
          return finish({ status: 'TIMEOUT', phase: 'no-first-byte' });
        }

        // 带参考图的任务：只认「最后一条 assistant 消息之后」出现的图，
        // 否则用户上传的参考图会被当成生成结果
        let anchor = null;
        if (before.hasRefs) {
          const list = CGR.pickAll(CGR.SEL.assistantMsg);
          anchor = list.length ? list[list.length - 1] : null;
        }

        const fresh = probe.freshImages(before, anchor);
        if (fresh.length) {
          const key = fresh
            .map((f) => f.src)
            .sort()
            .join('|');
          if (candidate && candidate.key === key) {
            candidate.hits += 1;
            candidate.stableMs = now - candidate.firstSeenAt;
          } else {
            candidate = { key, srcs: fresh.map((f) => f.src), firstSeenAt: now, hits: 1, stableMs: 0 };
          }
          if (candidate.hits >= 2 && candidate.stableMs >= stableMs && !generating) {
            return finish({ status: 'IMAGE_READY', images: fresh });
          }
        } else if (settleAt && now > settleAt && !generating) {
          return finish({ status: 'NO_IMAGE', text: probe.lastAssistantText() });
        }

        if (now > deadline) {
          return finish({ status: 'TIMEOUT', stillGenerating: generating });
        }
      };

      let lastRun = 0;
      const mo = new MutationObserver(() => {
        // 回调内做时间戳节流，避免流式输出导致的高频重算
        if (Date.now() - lastRun < 250) return;
        lastRun = Date.now();
        evaluate();
      });

      try {
        mo.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'disabled', 'aria-label', 'data-testid'] });
      } catch (e) {
        /* ignore */
      }

      const iv = setInterval(evaluate, 5000);
      setEvaluateHook(evaluate);
      evaluate();
    });
  }

  /**
   * 等待「前提设定」的回复。只关心模型有没有答完，不关心内容，也完全不看图片。
   * 同样以 MutationObserver 为主驱动，避免后台标签页定时器被节流。
   * @returns {Promise<'ok'|'timeout'|'limit'|'aborted'>}
   */
  function waitForAck(beforeAssistantCount, cfg, isAborted) {
    return new Promise((resolve) => {
      const deadline = Date.now() + Math.min(cfg.timeoutMs || 300000, cfg.premiseTimeoutMs || 120000);
      let done = false;
      let repliedAt = 0;
      let lastRun = 0;
      let target = CGR.getMain();

      const finish = (r) => {
        if (done) return;
        done = true;
        try {
          mo.disconnect();
        } catch (e) {
          /* ignore */
        }
        clearInterval(iv);
        resolve(r);
      };

      const evaluate = () => {
        if (done) return;
        const now = Date.now();

        if (!document.contains(target)) {
          target = CGR.getMain();
          try {
            mo.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-label', 'data-testid'] });
          } catch (e) {
            /* ignore */
          }
        }

        if (isAborted && isAborted()) return finish('aborted');
        if (probe.detectLimit()) return finish('limit');

        // 前提只要模型回话就继续，完全不关心有没有在画图
        const replied = probe.assistantCount() > beforeAssistantCount;
        if (replied) {
          if (!repliedAt) repliedAt = now;
          if (String(probe.lastAssistantText() || '').trim()) return finish('ok');
          // 只回了一张图、没有文字，也算回话
          if (now - repliedAt > 8000) return finish('ok');
        }

        if (now > deadline) return finish(replied ? 'ok' : 'timeout');
      };

      const mo = new MutationObserver(() => {
        if (Date.now() - lastRun < 250) return;
        lastRun = Date.now();
        evaluate();
      });

      try {
        mo.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-label', 'data-testid'] });
      } catch (e) {
        /* ignore */
      }

      const iv = setInterval(evaluate, 1000);
      evaluate();
    });
  }

  root.CGR_WATCH = { waitForOutcome, waitForAck, setEvaluateHook, triggerEvaluate };
})(typeof globalThis !== 'undefined' ? globalThis : self);
