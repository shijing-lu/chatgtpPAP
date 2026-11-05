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

  /** 页面本身还活着吗（和「有没有内容脚本」是两件事） */
  async function pageAlive(tabId) {
    try {
      const r = await chrome.scripting.executeScript({ target: { tabId }, func: () => 1 });
      return !!(r && r[0] && r[0].result === 1);
    } catch (e) {
      return false;
    }
  }

  /**
   * 硬恢复：页面活着就补注入脚本；页面本身就死了（错误页/进程崩溃）才重载。
   * 返回 'ok' | 'reinjected' | 'reloaded' | 'gone' | 'failed'
   */
  async function reviveTab(tabId) {
    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (e) {
      return 'gone';
    }
    if (!tab) return 'gone';

    if (await pageAlive(tabId)) {
      if (await ensureContentScript(tabId)) return 'reinjected';
      return 'failed';
    }

    // 页面已经死掉（比如加载失败停在错误页），只能重新加载
    try {
      await chrome.tabs.reload(tabId);
      return 'reloaded';
    } catch (e) {
      return 'failed';
    }
  }

  /** 兜底：这个标签页怎么都救不回来时，换一个新的（同一窗口）继续干活 */
  async function replaceTab(oldTabId) {
    try {
      const t = await chrome.tabs.get(oldTabId);
      const created = await chrome.tabs.create({ windowId: t.windowId, url: 'https://chatgpt.com/', active: false });
      try {
        await chrome.tabs.remove(oldTabId);
      } catch (e) {
        /* 关不掉就算了 */
      }
      if (created && created.id != null) await harden(created.id);
      return created ? created.id : null;
    } catch (e) {
      return null;
    }
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
  /**
   * 为批次准备执行标签页：优先复用你已经开着的 ChatGPT 标签页，
   * 不再动不动就新建窗口。只有确实没有可用标签页时才新建一个。
   */
  async function ensureBatchTabs(batch, desired, focus) {
    const want = Math.max(1, Math.min(desired || 1, CGR.LIMITS.hardMaxConcurrency));
    const rt = store.getRuntime();

    // ① 这个批次已经登记过的标签页，只要还活着就继续用
    const mine = Object.entries(rt.activeTabs || {})
      .filter(([, v]) => v && v.batchId === batch.id)
      .map(([k]) => Number(k));

    const live = [];
    let windowId = null;
    for (const id of mine) {
      try {
        const t = await chrome.tabs.get(id);
        if (t && /chatgpt\.com|chat\.openai\.com/.test(String(t.url || ''))) {
          live.push(t.id);
          if (windowId == null) windowId = t.windowId;
        }
      } catch (e) {
        /* 已关闭 */
      }
    }

    if (live.length >= want) {
      const picked = live.slice(0, want);
      for (const id of picked) await harden(id);
      return { ids: picked, windowId };
    }

    // ② 复用用户已经打开、且没被别的批次占用的 ChatGPT 标签页（优先当前活动的那个）
    const all = await chrome.tabs.query({ url: MATCH });
    const used = new Set(Object.keys(rt.activeTabs || {}).map(Number));
    const free = all
      .filter((t) => t && !used.has(t.id) && !t.discarded && !live.includes(t.id))
      .sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));

    for (const t of free) {
      if (live.length >= want) break;
      live.push(t.id);
      if (windowId == null) windowId = t.windowId;
    }

    // ③ 还不够才新建标签页（建在同一个窗口里，不另开窗口）
    for (let i = live.length; i < want; i++) {
      const opts = { url: 'https://chatgpt.com/', active: false };
      if (windowId != null) opts.windowId = windowId;
      const t = await chrome.tabs.create(opts);
      live.push(t.id);
      if (windowId == null) windowId = t.windowId;
    }

    const picked = live.slice(0, want);
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

  root.CGR_TABS = { listTabs, usableTabs, ensureBatchTabs, resetWindow, send, ping, pageAlive, reviveTab, replaceTab, ensureContentScript };
})(typeof globalThis !== 'undefined' ? globalThis : self);
