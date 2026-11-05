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

  /** 确保有 desired 个可执行标签页，返回 tabId 数组 */
  async function ensureTabs(desired) {
    const want = Math.max(1, Math.min(desired || 1, CGR.LIMITS.hardMaxConcurrency));
    const usable = await usableTabs();

    if (want === 1) {
      if (usable.length) {
        await harden(usable[0].id);
        return [usable[0].id];
      }
      const tab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: true });
      await harden(tab.id);
      return [tab.id];
    }

    // 并行：需要独立窗口，避免污染用户当前窗口
    if (runnerWindowId != null) {
      try {
        const winTabs = await chrome.tabs.query({ windowId: runnerWindowId, url: MATCH });
        const alive = winTabs.filter((t) => !t.discarded);
        if (alive.length >= want) return alive.slice(0, want).map((t) => t.id);
        const ids = alive.map((t) => t.id);
        for (let i = alive.length; i < want; i++) {
          const t = await chrome.tabs.create({ windowId: runnerWindowId, url: 'https://chatgpt.com/', active: false });
          await harden(t.id);
          ids.push(t.id);
        }
        return ids;
      } catch (e) {
        runnerWindowId = null;
      }
    }

    const first = await chrome.windows.create({
      url: 'https://chatgpt.com/',
      focused: false,
      type: 'normal',
      width: 1000,
      height: 820
    });
    runnerWindowId = first.id;
    const ids = (first.tabs || []).map((t) => t.id).filter((x) => x != null);
    for (let i = ids.length; i < want; i++) {
      const t = await chrome.tabs.create({ windowId: runnerWindowId, url: 'https://chatgpt.com/', active: false });
      ids.push(t.id);
    }
    for (const id of ids) await harden(id);
    store.addLog('info', `已创建并行执行窗口（${want} 个标签页）`);
    return ids.slice(0, want);
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

  root.CGR_TABS = { listTabs, usableTabs, ensureTabs, resetWindow, send, ping, ensureContentScript };
})(typeof globalThis !== 'undefined' ? globalThis : self);
