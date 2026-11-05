/* 标签页池：串行模式复用已有 ChatGPT 标签页；并行模式在独立窗口里开 N 个 runner tab。
 * 注意：不需要 tabs.update({active:true})。DOM focus / execCommand 是 per-document 的，
 * 后台标签页同样有效，强行激活只会抢用户焦点。 */
(function (root) {
  const CGR = root.CGR;
  const store = root.CGR_STORE;

  const MATCH = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
  let runnerWindowId = null;

  async function listTabs() {
    try {
      return await chrome.tabs.query({ url: MATCH });
    } catch (e) {
      return [];
    }
  }

  async function usableTabs() {
    const tabs = await listTabs();
    return tabs.filter((t) => !t.discarded && t.status !== 'unloaded');
  }

  async function harden(tabId) {
    try {
      await chrome.tabs.update(tabId, { autoDiscardable: false });
    } catch (e) {
      /* ignore */
    }
  }

  /** 探测标签页里是否有活的内容脚本 */
  async function ping(tabId) {
    const res = await CGR.withTimeout(send(tabId, { type: CGR.MSG.PING }), 1500, null);
    return !!(res && res.ok);
  }

  /**
   * 确保标签页里跑着「当前这次」的内容脚本。
   * 关键场景：扩展重新加载后，已经打开的 ChatGPT 标签页里仍是旧脚本（甚至已失效），
   * 这时后台发什么消息都石沉大海 —— 表现就是「说在跑但页面毫无反应」。
   */
  async function ensureContentScript(tabId) {
    if (await ping(tabId)) return true;
    try {
      const files = chrome.runtime.getManifest().content_scripts[0].js;
      // 旧实例可能把 __CGR_LOADED__ 留在页面里，先清掉再注入，否则新脚本会直接 return
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          window.__CGR_LOADED__ = false;
        }
      });
      await chrome.scripting.executeScript({ target: { tabId }, files });
    } catch (e) {
      store.addLog('error', `无法向标签页 ${tabId} 注入脚本：${(e && e.message) || e}`);
      return false;
    }
    return await ping(tabId);
  }

  /**
   * 为某个批次准备它自己的窗口与标签页。
   * 一个批次 = 一个独立窗口，互不干扰；窗口 id 记在批次上，下次直接复用。
   */
  async function ensureBatchTabs(batch, desired, focus) {
    const want = Math.max(1, Math.min(desired || 1, CGR.LIMITS.hardMaxConcurrency));
    let windowId = batch.windowId == null ? null : batch.windowId;
    let tabsIn = [];

    if (windowId != null) {
      try {
        await chrome.windows.get(windowId);
        tabsIn = await chrome.tabs.query({ windowId, url: MATCH });
      } catch (e) {
        windowId = null;
        tabsIn = [];
      }
    }

    if (windowId == null) {
      const win = await chrome.windows.create({
        url: 'https://chatgpt.com/',
        focused: !!focus,
        type: 'normal',
        width: 1000,
        height: 820
      });
      windowId = win.id;
      tabsIn = (win.tabs || []).slice();
      if (!tabsIn.length) {
        try {
          tabsIn = await chrome.tabs.query({ windowId });
        } catch (e) {
          tabsIn = [];
        }
      }
      store.addLog('info', `已为批次「${batch.name}」打开独立窗口`);
    }

    const ids = tabsIn.filter((t) => !t.discarded).map((t) => t.id);

    for (let i = ids.length; i < want; i++) {
      const t = await chrome.tabs.create({ windowId, url: 'https://chatgpt.com/', active: false });
      ids.push(t.id);
    }

    const picked = ids.slice(0, want);
    for (const id of picked) await harden(id);
    return { ids: picked, windowId };
  }

  function resetWindow() {
    runnerWindowId = null;
  }

  async function send(tabId, msg) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (e) {
      return null;
    }
  }

  root.CGR_TABS = { listTabs, usableTabs, ensureBatchTabs, resetWindow, send, ping, ensureContentScript };
})(typeof globalThis !== 'undefined' ? globalThis : self);
