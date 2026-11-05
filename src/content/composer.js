/* 输入与发送：ChatGPT 的输入框是 ProseMirror 的 contenteditable，
 * 直接改 value / textContent 不会被 React 识别，必须派发真实输入事件。 */
(function (root) {
  const CGR = root.CGR;
  const probe = root.CGR_PROBE;

  function normalizeText(text, preserveNewlines) {
    let t = String(text || '');
    if (!preserveNewlines) t = t.replace(/\s*\n+\s*/g, ' ').trim();
    return t.replace(/[ \t]{2,}/g, ' ');
  }

  function getComposer() {
    const el = CGR.pick(CGR.SEL.composer);
    if (!el) return null;
    return el;
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

  function clearComposer(el) {
    focusComposer(el);
    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    } catch (e) {
      /* ignore */
    }
    if ((el.innerText || '').trim()) {
      // 兜底：直接清空并触发 input
      el.textContent = '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    }
  }

  function readText(el) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return String(el.value || '');
    return String(el.innerText || el.textContent || '');
  }

  /** 三级插入：execCommand → paste 事件 → beforeinput/input 事件 */
  function insertText(el, text) {
    focusComposer(el);

    try {
      const ok = document.execCommand('insertText', false, text);
      if (ok && readText(el).includes(text.slice(0, 12))) return true;
    } catch (e) {
      /* ignore */
    }

    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      if (readText(el).includes(text.slice(0, 12))) return true;
    } catch (e) {
      /* ignore */
    }

    try {
      el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true }));
      el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true }));
    } catch (e) {
      /* ignore */
    }
    return readText(el).includes(text.slice(0, 12));
  }

  function pressEnter(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  function clickSend() {
    const btn = CGR.pick(CGR.SEL.sendButton);
    if (!btn) return false;
    if (btn.disabled) return false;
    btn.click();
    return true;
  }

  /** 发送一条提示词，返回 { ok, code } */
  async function sendPrompt(rawText, cfg) {
    const text = normalizeText(rawText, cfg && cfg.preserveNewlines);
    if (!text) return { ok: false, code: 'empty-prompt' };

    for (let attempt = 0; attempt < 3; attempt++) {
      const el = getComposer();
      if (!el) return { ok: false, code: 'no-composer' };

      const beforeMsgs = probe.allMsgCount();
      clearComposer(el);
      await CGR.sleep(120);

      const inserted = insertText(el, text);
      await CGR.sleep(200);

      const inBox = readText(el).length;
      if (!inserted || inBox < Math.min(12, text.length)) {
        await CGR.sleep(400 + attempt * 500);
        continue;
      }

      // 优先点发送按钮；按钮不可用时用 Enter
      const clicked = clickSend();
      if (!clicked) {
        pressEnter(el);
      }

      const ok = await CGR.pollUntil(
        () => probe.allMsgCount() > beforeMsgs || probe.isGenerating() || readText(getComposer() || el).trim() === '',
        6000,
        200
      );

      if (ok) return { ok: true, sent: text };

      // 提交没生效，清空重来
      await CGR.sleep(800 + attempt * 900);
    }
    return { ok: false, code: 'send-failed-3x' };
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

  root.CGR_COMPOSER = { sendPrompt, newChat, getComposer, readText, insertText, clearComposer };
})(typeof globalThis !== 'undefined' ? globalThis : self);
