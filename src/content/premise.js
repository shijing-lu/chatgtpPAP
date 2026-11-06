/* 前提设定的发送节奏。
 *
 * 修的是「前提一发完，第一条生图提示词立刻就发出去了，ChatGPT 没时间接收」：
 * 旧逻辑把「输入框清空 / 气泡挂上 DOM」当成发送完成 —— 这是 ChatGPT 的乐观 UI，
 * 只说明前端把消息画出来了，请求可能还在路上、会话里还没写入这条消息。
 * 紧接着发下一条，上一条前提就被挤掉（或和生图提示词合成一轮），表现为前提完全没生效。
 * 更糟的是旧逻辑最后一条之后只等 600ms，而前提模式 1.5 秒就会点「停止生成」，
 * 连服务端对前提的处理都一起截断了。
 *
 * 这里的原则仍然是用户要的「不等回复」：不读回复内容、不等回复结束、不看图、不下载。
 * 只确认「服务端已接收」这一个信号，并且无论如何都留一个物理上的最小间隔。
 * 每条前提之后都做，**包括最后一条** —— 这样第一条生图提示词才不会贴着前提发出去。
 * 等不到 ack 信号只记警告并继续，绝不重发、绝不把批次置异常（重发会消耗生图额度）。
 */
(function (root) {
  const CGR = root.CGR;

  const GAP_DEFAULT = 4000;
  const GAP_MIN = 1500;
  const GAP_MAX = 30000;
  const ACK_DEFAULT = 8000;
  const ACK_MIN = 1000;
  const ACK_MAX = 30000;

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
      ackMs: clampMs(c.premiseAckMs != null ? c.premiseAckMs : ACK_DEFAULT, ACK_MIN, ACK_MAX, ACK_DEFAULT)
    };
  }

  function snapshotState(probe) {
    return {
      msgCount: probe.allMsgCount(),
      assistantCount: probe.assistantCount(),
      generating: probe.isGenerating()
    };
  }

  /**
   * 一条消息发出后，给它留出被服务端接收的窗口。
   * @param base 发送前的页面基线（snapshotState），用来区分「上一条还在生成」和「新请求已开始」
   * @param deps { probe, cfg, pollUntil, sleep, now, log } —— 全部可注入，方便零依赖回归测试
   * @returns {{acked:boolean, waitedMs:number, gapMs:number, ackMs:number}}
   */
  async function settle(base, deps) {
    const d = deps || {};
    const probe = d.probe;
    const p = pacing(d.cfg);
    const poll = d.pollUntil || CGR.pollUntil;
    const sleep = d.sleep || CGR.sleep;
    const now = d.now || Date.now;
    const t0 = now();

    // 强信号：后端已经响应这条消息。只用「停止生成按钮出现 / 新回复节点 / 新消息且进入生成」，
    // 不读回复文字、不判断回复是否写完。
    const accepted = () => {
      if (!probe || !base) return true;
      try {
        if (probe.assistantCount() > base.assistantCount) return true;
        if (!base.generating && probe.isGenerating()) return true;
        if (probe.allMsgCount() > base.msgCount && probe.isGenerating()) return true;
      } catch (e) {
        /* 页面节点短暂不可读，下一轮再看 */
      }
      return false;
    };

    const acked = p.ackMs > 0 ? await poll(accepted, p.ackMs, 200) : false;

    // 关键：哪怕 ack 立刻命中，也补足最小间隔。乐观 UI 的 ack 早于服务端落库，
    // 这段物理时间是给会话写入的硬窗口，不能被跳过。
    const waited = now() - t0;
    const left = p.gapMs - waited;
    if (left > 0) await sleep(left);

    return { acked, waitedMs: now() - t0, gapMs: p.gapMs, ackMs: p.ackMs };
  }

  /**
   * 逐条发送前提并控制节奏。
   * deps: { cfg, probe, sendPrompt, waitSendable, log, progress, isAborted, pollUntil, sleep, now }
   * log 形如 (level, message)，progress 形如 (phase) => Promise。
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

      // 上一条前提的文本回复还在流式输出时，先腾出输入框。
      // 这只会发生在「上一条已过完整个接收窗口」之后，停掉的只是无关的文字回复。
      if (probe.isGenerating()) {
        // 先给一秒自然结束的机会，避免粗暴截断页面上本来就在收尾的回复
        await d.waitSendable({ allowStop: true, naturalWaitMs: Math.min(1000, p.gapMs), maxWaitMs: 8000 });
      }

      const base = snapshotState(probe);
      const sent = await d.sendPrompt(items[i], cfg, {
        allowStop: true,
        // 前提模式默认 1.5 秒就点停止生成，会把服务端对上一条的处理一起截断。
        // 抬到接收窗口长度，保证停止动作永远晚于「服务端已接住消息」。
        naturalWaitMs: p.gapMs,
        maxWaitMs: Math.max(p.gapMs + 8000, 12000)
      });
      if (!sent.ok) {
        for (const line of sent.diagnostic || []) log('warn', `前提 ${i + 1} ${line}`);
        return { ok: false, reason: `send-failed(${sent.code})`, diagnostic: sent.diagnostic || [] };
      }

      // 最后一条同样执行：不给这段窗口，第一条生图提示词就会贴着前提发出去。
      const st = await settle(base, { probe, cfg, pollUntil, sleep, now });
      gaps.push(st);
      const sec = (st.waitedMs / 1000).toFixed(1);
      log(
        st.acked ? 'info' : 'warn',
        `前提 ${i + 1}/${items.length} 已就绪（留了 ${sec} 秒接收窗口，${st.acked ? '服务端已开始响应' : '未收到响应信号，按最小间隔放行'}；不读回复、不等生成结束）`
      );
    }

    // 全部前提都接收完之后，如果还在输出文字回复，直接停掉：
    // 否则正式生图提示词的 waitSendable（不主动停止）会干等十几秒到一分钟。
    if (probe.isGenerating()) {
      const r = await d.waitSendable({ allowStop: true, naturalWaitMs: Math.min(1000, p.gapMs), maxWaitMs: 8000 });
      if (r && r.stopped) log('info', '已跳过前提的文本回复，输入框恢复可用');
    }

    return { ok: true, gaps, gapMs: p.gapMs, ackMs: p.ackMs };
  }

  root.CGR_PREMISE = { pacing, snapshotState, settle, apply };
})(typeof globalThis !== 'undefined' ? globalThis : self);
