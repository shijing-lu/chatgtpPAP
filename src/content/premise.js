/* 前提设定的发送节奏。
 *
 * 用户要求：**前提发出去后要等 ChatGPT 回复，检测到回复后才能发下一条提示词**。
 * 尤其是第一条 —— 新对话里第一条消息还伴随着会话创建，最容易在服务端没接住时
 * 被紧接着发来的下一条挤掉，表现为「前提完全没生效」。
 *
 * 所以这里不再用「固定等几秒」来猜，而是事件驱动地等回复真正落地：
 *   ① 等到新的 assistant 回复文字出现（或消息选择器失效时靠正文变化兜底）
 *   ② 等到回复写完（停止生成按钮消失），回复文本连续稳定后才算完成
 *   ③ 回复秒回也补足一个最小间隔，防 ChatGPT 乐观 UI 的假完成
 * 每条前提之后都做，**包括最后一条** —— 否则第一条生图提示词会贴着前提发出去。
 *
 * 等不到回复只按超时放行并记警告，绝不重发、绝不把批次置异常（重发会消耗生图额度）。
 * 设置里可以关掉「等回复」回到固定窗口模式，也可以调超时时间。
 */
(function (root) {
  const CGR = root.CGR;

  const GAP_DEFAULT = 4000;
  const GAP_MIN = 1500;
  const GAP_MAX = 30000;
  const REPLY_DEFAULT = 60000;
  const REPLY_MIN = 5000;
  const REPLY_MAX = 300000;
  const ACK_DEFAULT = 8000;
  const ACK_MIN = 1000;
  const ACK_MAX = 30000;
  const POLL_MS = 200;

  function clampMs(value, lo, hi, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.max(lo, Math.min(hi, Math.round(n)));
  }

  /** 配置从后台来，老配置缺字段时自动回落到默认值；单位毫秒，设置页按秒展示 */
  function pacing(cfg) {
    const c = cfg || {};
    return {
      gapMs: clampMs(c.premiseGapMs != null ? c.premiseGapMs : GAP_DEFAULT, GAP_MIN, GAP_MAX, GAP_DEFAULT),
      replyMs: clampMs(c.premiseReplyMs != null ? c.premiseReplyMs : REPLY_DEFAULT, REPLY_MIN, REPLY_MAX, REPLY_DEFAULT),
      ackMs: clampMs(c.premiseAckMs != null ? c.premiseAckMs : ACK_DEFAULT, ACK_MIN, ACK_MAX, ACK_DEFAULT),
      waitReply: c.premiseWaitReply !== false
    };
  }

  /** 发送前的页面基线，用来区分「上一条的旧回复」和「这次新产生的回复」 */
  function snapshotState(probe) {
    return {
      msgCount: probe.allMsgCount(),
      assistantCount: probe.assistantCount(),
      generating: probe.isGenerating(),
      text: String(probe.lastAssistantText ? probe.lastAssistantText() : '').trim(),
      bodyLen: probe.bodyTextLen ? probe.bodyTextLen() : 0
    };
  }

  function readReplyState(probe) {
    return {
      generating: probe.isGenerating(),
      assistantCount: probe.assistantCount(),
      text: String(probe.lastAssistantText ? probe.lastAssistantText() : '').trim(),
      bodyLen: probe.bodyTextLen ? probe.bodyTextLen() : 0
    };
  }

  /**
   * 等 ChatGPT 把这条前提的回复写完，检测到完整回复才返回。
   * 判据是「回复文字出现 → 生成结束 → 文本连续稳定」，不是等一个拍脑袋的固定秒数。
   * deps { probe, cfg, sleep, now } 全部可注入，方便零依赖回归测试。
   */
  async function waitForReply(base, deps) {
    const d = deps || {};
    const probe = d.probe;
    const p = pacing(d.cfg);
    const sleep = d.sleep || CGR.sleep;
    const now = d.now || Date.now;
    const t0 = now();
    const deadline = t0 + p.replyMs;

    let sawGenerating = !!base.generating;
    let sawReply = false;
    let lastText = '';
    let stable = 0;
    let done = false;

    while (now() < deadline) {
      let st = null;
      try {
        st = readReplyState(probe);
      } catch (e) {
        /* 页面节点短暂不可读，下一轮再看 */
      }
      if (st) {
        if (st.generating) sawGenerating = true;

        // 回复到达：新 assistant 节点里有文字 / 回复文字相对基线变化。
        // 消息节点选择器失效时，靠正文增长兜底（此时 lastAssistantText 会是空）。
        const newAssistant = st.assistantCount > base.assistantCount && st.text.length > 0;
        const newText = st.text.length > 0 && st.text !== base.text;
        const fallback = !st.text && st.bodyLen - base.bodyLen > 120;
        if (newAssistant || newText || fallback) sawReply = true;

        if (sawReply && !st.generating) {
          stable = st.text === lastText ? stable + 1 : 0;
          lastText = st.text;
          // 见过「生成中」→ 停止按钮消失且文本稳定 600ms 就算回复写完；
          // 停止按钮选择器失效时，靠文本连续稳定 1.6 秒兜底。
          if ((sawGenerating && stable >= 3) || stable >= 8) {
            done = true;
            break;
          }
        } else {
          stable = 0;
          lastText = st.text;
        }
      }
      await sleep(POLL_MS);
    }

    // 乐观 UI 保护：哪怕回复秒回，也补足最小间隔再放行
    const waited = now() - t0;
    if (p.gapMs > waited) await sleep(p.gapMs - waited);

    return {
      replied: sawReply,
      finished: done,
      timedOut: !done,
      waitedMs: now() - t0,
      gapMs: p.gapMs,
      replyMs: p.replyMs
    };
  }

  /**
   * 固定窗口模式（关掉「等回复」时用）：只确认服务端已开始响应并补足最小间隔。
   * 不等回复内容、不判断回复是否写完。
   */
  async function settle(base, deps) {
    const d = deps || {};
    const probe = d.probe;
    const p = pacing(d.cfg);
    const poll = d.pollUntil || CGR.pollUntil;
    const sleep = d.sleep || CGR.sleep;
    const now = d.now || Date.now;
    const t0 = now();

    const accepted = () => {
      if (!probe || !base) return true;
      try {
        if (probe.assistantCount() > base.assistantCount) return true;
        if (!base.generating && probe.isGenerating()) return true;
        if (probe.allMsgCount() > base.msgCount && probe.isGenerating()) return true;
      } catch (e) {
        /* ignore */
      }
      return false;
    };

    const acked = p.ackMs > 0 ? await poll(accepted, p.ackMs, 200) : false;
    const waited = now() - t0;
    if (p.gapMs > waited) await sleep(p.gapMs - waited);
    return { acked, waitedMs: now() - t0, gapMs: p.gapMs, ackMs: p.ackMs };
  }

  /**
   * 逐条发送前提并控制节奏。
   * deps: { cfg, probe, sendPrompt, waitSendable, log, progress, isAborted, pollUntil, sleep, now }
   */
  async function apply(list, deps) {
    const d = deps || {};
    const items = Array.isArray(list) ? list : [];
    const cfg = d.cfg || CGR.DEFAULTS;
    const p = pacing(cfg);
    const probe = d.probe;
    const log = d.log || function () {};
    const progress = d.progress || function () { return Promise.resolve(); };
    const isAborted = d.isAborted || function () { return false; };
    const sleep = d.sleep || CGR.sleep;
    const pollUntil = d.pollUntil || CGR.pollUntil;
    const now = d.now || Date.now;
    const gaps = [];

    for (let i = 0; i < items.length; i++) {
      if (isAborted()) return { ok: false, reason: 'aborted' };
      log('info', `发送前提 ${i + 1}/${items.length}…`);
      await progress('sending');

      // 正常情况下上一条回复已经等完了，页面是空闲的；
      // 只有超时放行留下的残留生成才需要腾输入框，且停止动作晚于上一条的等待窗口。
      if (probe.isGenerating()) {
        await d.waitSendable({ allowStop: true, naturalWaitMs: Math.min(1000, p.gapMs), maxWaitMs: 8000 });
      }

      const base = snapshotState(probe);
      const sent = await d.sendPrompt(items[i], cfg, {
        allowStop: true,
        // 前提模式默认 1.5 秒就点停止生成，会把服务端对上一条的处理一起截断。
        naturalWaitMs: p.gapMs,
        maxWaitMs: Math.max(p.gapMs + 8000, 12000)
      });
      if (!sent.ok) {
        for (const line of sent.diagnostic || []) log('warn', `前提 ${i + 1} ${line}`);
        return { ok: false, reason: `send-failed(${sent.code})`, diagnostic: sent.diagnostic || [] };
      }

      // 最后一条同样要等：不给这段，第一条生图提示词就会贴着前提发出去。
      const st = p.waitReply
        ? await waitForReply(base, { probe, cfg, sleep, now })
        : await settle(base, { probe, cfg, pollUntil, sleep, now });
      gaps.push(st);
      const sec = (st.waitedMs / 1000).toFixed(1);

      if (p.waitReply) {
        if (st.finished) {
          log('info', `前提 ${i + 1}/${items.length} 已检测到 ChatGPT 回复并写完（等了 ${sec} 秒），现在才允许发下一条`);
        } else {
          log('warn', `前提 ${i + 1}/${items.length} 等了 ${sec} 秒仍没检测到完整回复，按超时放行（不重发、不判失败）；可在设置里调大「前提等回复超时」`);
        }
      } else {
        log(st.acked ? 'info' : 'warn', `前提 ${i + 1}/${items.length} 已就绪（固定窗口 ${sec} 秒，${st.acked ? '服务端已开始响应' : '未收到响应信号'}；未等回复）`);
      }
    }

    // 正常路径上回复已写完、页面空闲，这里不会触发。
    // 只有超时放行还留着「生成中」时才停掉它，避免正式生图提示词白等十几秒到一分钟。
    if (probe.isGenerating()) {
      const r = await d.waitSendable({ allowStop: true, naturalWaitMs: Math.min(1000, p.gapMs), maxWaitMs: 8000 });
      if (r && r.stopped) log('info', '前提等待超时，已跳过残留的文本回复，输入框恢复可用');
    }

    return { ok: true, gaps, gapMs: p.gapMs, replyMs: p.replyMs, ackMs: p.ackMs, waitReply: p.waitReply };
  }

  root.CGR_PREMISE = { pacing, snapshotState, waitForReply, settle, apply };
})(typeof globalThis !== 'undefined' ? globalThis : self);
