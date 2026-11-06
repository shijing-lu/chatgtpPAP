/* 输入与发送：ChatGPT 的输入框是 ProseMirror 的 contenteditable，
 * 直接改 value / textContent 不会被 React 识别，必须派发真实输入事件。
 *
 * 两条容易踩的坑（这次修复的核心）：
 * ① ChatGPT 流式输出时，「发送按钮」会变成「停止生成」按钮，且往往仍是 form 里的
 *    button[type="submit"]。此时点它只会中止回复，文字仍留在输入框 → 三次重试全失败。
 *    所以发送前必须先把页面恢复到「可发送」状态，并且永远不要把停止按钮当发送按钮。
 * ② 提交成功后 React 会重新挂载输入框，旧 el 变成脱离文档的节点但仍保留文本。
 *    判定「输入框已清空」时必须每次重新取当前节点，否则消息明明发出去了也会误判失败。 */
(function (root) {
  const CGR = root.CGR;
  const probe = root.CGR_PROBE;

  function normalizeText(text, preserveNewlines) {
    let t = String(text || '');
    if (!preserveNewlines) t = t.replace(/\s*\n+\s*/g, ' ').trim();
    return t.replace(/[ \t]{2,}/g, ' ');
  }

  function getComposer() {
    return CGR.pick(CGR.SEL.composer) || null;
  }

  function focusComposer(el) {
    el.focus();
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {
      /* ignore */
    }
  }

  function readText(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return String(el.value || '');
    return String(el.innerText || el.textContent || '');
  }

  /** 清空输入框：优先走原生编辑命令，尽量不破坏 ProseMirror 内部状态。
   * 直接 textContent='' 只是最后手段，且必须补发输入事件让 React 同步。 */
  function clearComposer(el) {
    focusComposer(el);
    try {
      if (document.execCommand('selectAll', false, null)) document.execCommand('delete', false, null);
    } catch (e) {
      /* ignore */
    }
    if (readText(el).trim()) {
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount) sel.deleteFromDocument();
      } catch (e) {
        /* ignore */
      }
    }
    if (readText(el).trim()) {
      el.textContent = '';
      try {
        el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward' }));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      } catch (e) {
        /* ignore */
      }
    }
  }

  /** 三级插入：execCommand → paste 事件 → beforeinput/input 事件 */
  function insertText(el, text) {
    focusComposer(el);
    const head = text.slice(0, 12);

    try {
      const ok = document.execCommand('insertText', false, text);
      if (ok && readText(el).includes(head)) return true;
    } catch (e) {
      /* ignore */
    }

    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      if (readText(el).includes(head)) return true;
    } catch (e) {
      /* ignore */
    }

    try {
      el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true }));
      el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true }));
    } catch (e) {
      /* ignore */
    }
    return readText(el).includes(head);
  }

  function pressEnter(el) {
    const opts = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window
    };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  /** 当前可见的停止生成按钮 */
  function pickStopButton() {
    for (const sel of CGR.SEL.stopButton) {
      try {
        const list = Array.from(document.querySelectorAll(sel)).filter(
          (b) => b.getClientRects().length > 0 || b.offsetParent !== null
        );
        if (list.length) return list[0];
      } catch (e) {
        /* 无效选择器忽略 */
      }
    }
    return null;
  }

  function visibleStopSet() {
    const set = new Set();
    for (const sel of CGR.SEL.stopButton) {
      try {
        for (const b of document.querySelectorAll(sel)) {
          if (b.getClientRects().length > 0 || b.offsetParent !== null) set.add(b);
        }
      } catch (e) {
        /* ignore */
      }
    }
    return set;
  }

  function btnUsable(b) {
    if (!b) return false;
    if (b.disabled) return false;
    if (b.getAttribute('aria-disabled') === 'true') return false;
    if (b.getAttribute('data-disabled') === 'true') return false;
    if (b.hidden) return false;
    try {
      const r = b.getBoundingClientRect();
      if (r && r.width === 0 && r.height === 0) return false;
    } catch (e) {
      /* ignore */
    }
    return true;
  }

  /** 找可点的发送按钮。返回诊断信息，绝不返回 disabled 或「停止生成」按钮。 */
  function findSendButton() {
    const el = getComposer();
    const form = el && el.closest('form');
    const scopes = form ? [form, document] : [document];
    const stops = visibleStopSet();
    let total = 0;
    let disabled = 0;
    let excludedStop = 0;
    let usable = null;

    for (const scope of scopes) {
      for (const sel of CGR.SEL.sendButton) {
        let list = [];
        try {
          list = Array.from(scope.querySelectorAll(sel));
        } catch (e) {
          continue;
        }
        for (const b of list) {
          if (stops.has(b)) {
            excludedStop += 1;
            continue;
          }
          if (!btnUsable(b)) {
            disabled += 1;
            continue;
          }
          total += 1;
          if (!usable) usable = b;
        }
        if (usable) return { btn: usable, total, disabled, excludedStop };
      }
    }
    return { btn: null, total, disabled, excludedStop };
  }

  /** 页面当前「能不能发消息」的实况，失败时写进日志供定位 */
  function sendState() {
    const el = getComposer();
    const s = findSendButton();
    return {
      composer: !!el,
      boxLen: el ? readText(el).trim().length : -1,
      btnUsable: !!s.btn,
      btnTotal: s.total,
      btnDisabled: s.disabled,
      stopExcluded: s.excludedStop,
      generating: probe.isGenerating(),
      msgCount: probe.allMsgCount(),
      convId: CGR.getConvId()
    };
  }

  function stateText(st) {
    return `输入框=${st.composer ? '有' : '无'}/框内${st.boxLen}字/可用发送按钮=${st.btnUsable ? '有' : '无'}(候选${st.btnTotal},禁用${st.btnDisabled},停止按钮已排除${st.stopExcluded})/生成中=${st.generating ? '是' : '否'}/消息数=${st.msgCount}`;
  }

  /** 光 click() 有时不触发，补一套指针事件 */
  function realClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    try {
      el.click();
    } catch (e) {
      /* ignore */
    }
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * 发送前恢复到「可发送」状态。
   * 前提阶段 allowStop=true：不等回复，直接停止当前文本回复（用户消息已在对话历史里，
   * 回复内容无所谓），立刻腾出输入框；正式生图阶段不主动停止，避免截断正在生成的图片。
   */
  async function waitSendable(opts) {
    const o = opts || {};
    const allowStop = !!o.allowStop;
    const naturalWait = o.naturalWaitMs != null ? o.naturalWaitMs : allowStop ? 1500 : 12000;
    const maxWait = o.maxWaitMs != null ? o.maxWaitMs : allowStop ? 10000 : 60000;
    const t0 = Date.now();

    if (!probe.isGenerating()) return { ok: true, waited: 0, stopped: false, reason: 'idle' };

    await CGR.pollUntil(() => !probe.isGenerating(), naturalWait, 200);
    if (!probe.isGenerating()) {
      return { ok: true, waited: Date.now() - t0, stopped: false, reason: 'reply-finished' };
    }

    if (allowStop) {
      const stop = pickStopButton();
      if (stop) realClick(stop);
      if (await CGR.pollUntil(() => !probe.isGenerating(), 5000, 200)) {
        return { ok: true, waited: Date.now() - t0, stopped: true, reason: 'stopped-text-reply' };
      }
    }

    const ok = await CGR.pollUntil(() => !probe.isGenerating(), maxWait, 300);
    return { ok, waited: Date.now() - t0, stopped: false, reason: ok ? 'waited' : 'still-generating' };
  }

  /**
   * 提交：等按钮可用 → 点按钮 → 回车 → 表单提交 → 再点一次。
   * 成功判据全部基于「发送前基线」，且每次重新取当前输入框节点。
   */
  async function submit(el, base) {
    const beforeN = base.msgCount;
    const wasGenerating = base.generating;
    const cleared = () => {
      const cur = getComposer() || el;
      return (
        probe.allMsgCount() > beforeN ||
        (!wasGenerating && probe.isGenerating()) ||
        readText(cur).trim() === ''
      );
    };

    await CGR.pollUntil(() => !!findSendButton().btn, 3000, 120);

    let s = findSendButton();
    if (s.btn) {
      realClick(s.btn);
      if (await CGR.pollUntil(cleared, 1800, 150)) return 'click';
    }

    pressEnter(getComposer() || el);
    if (await CGR.pollUntil(cleared, 2000, 150)) return 'enter';

    const cur = getComposer() || el;
    const form = cur.closest && cur.closest('form');
    if (form && typeof form.requestSubmit === 'function') {
      try {
        form.requestSubmit();
      } catch (e) {
        /* ignore */
      }
      if (await CGR.pollUntil(cleared, 2000, 150)) return 'requestSubmit';
    }

    s = findSendButton();
    if (s.btn) {
      realClick(s.btn);
      if (await CGR.pollUntil(cleared, 1800, 150)) return 'click-retry';
    }
    return '';
  }

  /**
   * 发送一条提示词。
   * @returns {Promise<{ok:boolean, code?:string, method?:string, sent?:string, diagnostic:string[]}>}
   *   diagnostic 是逐次尝试的页面实况，失败时由上层写进日志，能直接看出卡在哪一步。
   */
  async function sendPrompt(rawText, cfg, opts) {
    const text = normalizeText(rawText, cfg && cfg.preserveNewlines);
    if (!text) return { ok: false, code: 'empty-prompt', diagnostic: [] };

    const o = opts || {};
    const diagnostic = [];
    const waitOpts = { allowStop: !!o.allowStop, naturalWaitMs: o.naturalWaitMs, maxWaitMs: o.maxWaitMs };

    const ready = await waitSendable(waitOpts);
    diagnostic.push(
      `发送前：${ready.ok ? '页面可发送' : '页面仍在生成中'}（${ready.reason}，等待 ${Math.round(ready.waited / 1000)} 秒${ready.stopped ? '，已停止文本回复' : ''}）`
    );

    let lastCode = 'unknown';
    const minLen = Math.min(12, text.length);

    for (let attempt = 0; attempt < 3; attempt++) {
      // 上一轮可能实际上已经发出去、模型又开始输出：重试前再确认一次页面状态
      if (attempt > 0 && probe.isGenerating()) {
        const r2 = await waitSendable(waitOpts);
        diagnostic.push(`第${attempt + 1}次前：页面重新进入生成中，${r2.ok ? '已恢复可发送' : '仍不可发送'}（${r2.reason}）`);
      }

      const el = getComposer();
      if (!el) {
        return { ok: false, code: 'no-composer', diagnostic: diagnostic.concat(`找不到输入框：${stateText(sendState())}`) };
      }

      const base = { msgCount: probe.allMsgCount(), generating: probe.isGenerating() };
      const beforeMsgs = base.msgCount;

      clearComposer(el);
      await CGR.sleep(120);

      const cur0 = getComposer() || el;
      const inserted = insertText(cur0, text);
      await CGR.sleep(260);

      const inBox = readText(getComposer() || cur0).length;
      if (!inserted || inBox < minLen) {
        lastCode = 'insert-failed';
        diagnostic.push(`第${attempt + 1}次：文字没插进输入框（框内 ${inBox} 字，期望 ≥${minLen}）｜${stateText(sendState())}`);
        await CGR.sleep(400 + attempt * 500);
        continue;
      }

      const btnState = findSendButton();
      const method = await submit(cur0, base);
      const ok = await CGR.pollUntil(() => {
        const cur = getComposer() || cur0;
        return (
          probe.allMsgCount() > beforeMsgs ||
          (!base.generating && probe.isGenerating()) ||
          readText(cur).trim() === ''
        );
      }, 5000, 200);

      if (ok) return { ok: true, sent: text, method: method || 'unknown', diagnostic };

      lastCode = btnState.btn
        ? 'submit-failed'
        : btnState.disabled
          ? 'send-button-disabled'
          : btnState.excludedStop
            ? 'only-stop-button'
            : 'send-button-missing';
      diagnostic.push(
        `第${attempt + 1}次：提交未生效（${lastCode}，方式 ${method || '无'}）｜${stateText(sendState())}`
      );
      await CGR.sleep(700 + attempt * 800);
    }

    return { ok: false, code: lastCode, diagnostic };
  }

  /** 打开一个新对话（SPA 内点击，尽量避免整页刷新） */
  async function newChat() {
    if (!CGR.getConvId()) {
      const okEmpty = await CGR.pollUntil(() => !!CGR.pick(CGR.SEL.composer), 8000, 250);
      if (okEmpty) return true;
    }
    const btn = CGR.pick(CGR.SEL.newChat);
    if (btn) {
      try {
        btn.click();
        // 严格条件：URL 回到根路径 且 对话区没有残留消息，确保不会把提示词发进上一个对话
        const strict = await CGR.pollUntil(
          () => !CGR.getConvId() && CGR.pickAll(CGR.SEL.allMsg).length === 0 && !!CGR.pick(CGR.SEL.composer),
          12000,
          250
        );
        if (strict) return true;
        const loose = await CGR.pollUntil(() => !CGR.getConvId() && !!CGR.pick(CGR.SEL.composer), 3000, 250);
        if (loose) return true;
      } catch (e) {
        /* ignore */
      }
    }
    // 兜底：直接跳转到根路径（会触发页面重载，租约由后台按「刷新」规则回收后重派）
    location.assign('https://chatgpt.com/');
    return false;
  }

  /* ---------------- 参考图附加 ---------------- */

  function findFileInput() {
    const el = getComposer();
    const scope = (el && el.closest('form')) || document;
    const inputs = Array.from(scope.querySelectorAll('input[type="file"]'));
    if (!inputs.length) return null;
    return inputs.find((i) => i.multiple) || inputs[0];
  }

  /** 输入区里已经挂上的附件数量（缩略图 / 文件条）。缩略图可能是 blob: 也可能是签名地址，所以按尺寸过滤图标 */
  function countAttachments() {
    const el = getComposer();
    const scope = (el && el.closest('form')) || document;
    let n = 0;
    for (const img of scope.querySelectorAll('img')) {
      const w = img.naturalWidth || img.getBoundingClientRect().width || 0;
      if (w >= 32) n += 1;
    }
    n += scope.querySelectorAll('[data-testid*="attachment"], [data-testid*="file"]').length;
    return n;
  }

  /**
   * 把参考图塞进 ChatGPT 的隐藏 file input，再等缩略图出现。
   * 图片数据存在 chrome.storage 的 img:<id> 里（内容脚本可直接读）。
   */
  async function attachImages(refs) {
    if (!refs || !refs.length) return { ok: true, count: 0 };

    const input = findFileInput();
    if (!input) return { ok: false, reason: 'no-file-input' };

    const files = [];
    for (const ref of refs) {
      try {
        const key = 'img:' + ref.id;
        const rec = await chrome.storage.local.get(key);
        const data = rec[key];
        if (!data || !data.dataUrl) continue;
        const blob = await (await fetch(data.dataUrl)).blob();
        const name = data.name || `ref-${files.length + 1}.png`;
        files.push(new File([blob], name, { type: blob.type || data.type || 'image/png' }));
      } catch (e) {
        /* 单张失败不影响其他 */
      }
    }
    if (!files.length) return { ok: false, reason: 'image-data-missing' };

    const before = countAttachments();
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    try {
      input.files = dt.files;
    } catch (e) {
      return { ok: false, reason: 'assign-failed' };
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));

    const ok = await CGR.pollUntil(() => countAttachments() > before, 30000, 400);
    return ok ? { ok: true, count: files.length } : { ok: false, reason: 'upload-timeout' };
  }

  /** 当前输入框里已挂上的附件缩略图地址 */
  function attachmentSrcs() {
    const el = getComposer();
    const scope = (el && el.closest('form')) || document;
    return Array.from(scope.querySelectorAll('img'))
      .filter((i) => (i.naturalWidth || i.getBoundingClientRect().width || 0) >= 32)
      .map((i) => i.currentSrc || i.src)
      .filter(Boolean);
  }

  root.CGR_COMPOSER = {
    sendPrompt,
    newChat,
    getComposer,
    readText,
    insertText,
    clearComposer,
    attachImages,
    countAttachments,
    attachmentSrcs,
    waitSendable,
    sendState,
    stateText,
    findSendButton
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
