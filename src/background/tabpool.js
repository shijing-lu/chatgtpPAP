/* 标签页池：复用已打开的对话标签页；并行模式可开 N 个 runner tab。
 * 站点 URL 事实统一由 sites.js 提供：一个批次只绑定它自己工作站点上的标签页，
 * 否则 Gemini 批次会抢到 ChatGPT 标签页，表现为「已接管」却永远不发提示词。
 * 注意：不需要 tabs.update({active:true})。DOM focus / execCommand 是 per-document 的，
 * 后台标签页同样有效，强行激活只会抢用户焦点。 */
(function (root) {
  const CGR = root.CGR;
  const store = root.CGR_STORE;

  const MATCH = typeof CGR.allMatchPatterns === 'function'
    ? CGR.allMatchPatterns()
    : ['https://chatgpt.com/*', 'https://chat.openai.com/*', 'https://gemini.google.com/*'];

  function defaultSite() {
    return (CGR.SITE_IDS && CGR.SITE_IDS[0]) || 'chatgpt';
  }

  function siteHome(site) {
    return typeof CGR.siteHome === 'function' ? CGR.siteHome(site || defaultSite()) : 'https://chatgpt.com/';
  }

  function siteOfTab(t) {
    return typeof CGR.siteOf === 'function' ? CGR.siteOf(t && t.url) : '';
  }

  function tabMatches(t, site) {
    if (!t) return false;
    const s = siteOfTab(t);
    if (!s) return false;
    return !site || s === site;
  }

  async function listTabs(site) {
    try {
      const all = await chrome.tabs.query({ url: MATCH });
      return (all || []).filter((t) => tabMatches(t, site));
    } catch (e) {
      return [];
    }
  }

  async function usableTabs(site) {
    const tabs = await listTabs(site);
    return tabs.filter((t) => !t.discarded && t.status !== 'unloaded');
  }

  /** 用户此刻正在看的那个对话标签页（侧边栏就附着在它所在的窗口） */
  async function currentActiveChatTab(site) {
    try {
      const list = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: MATCH });
      return (list || []).find((t) => tabMatches(t, site) && !t.discarded && t.status !== 'unloaded') || null;
    } catch (e) {
      return null;
    }
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
      const created = await chrome.tabs.create({
        windowId: t.windowId,
        url: siteHome(siteOfTab(t) || defaultSite()),
        active: false
      });
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
  async function ensureContentScript(tabId, opts) {
    // force：页面 PING 得通但主循环已经停摆时，必须绕过 ping 短路强制换掉旧实例
    const force = !!(opts && opts.force);
    if (!force && (await ping(tabId))) return true;
    try {
      const files = chrome.runtime.getManifest().content_scripts[0].js;
      // 旧实例可能把 __CGR_LOADED__ 留在页面里，先清掉再注入，否则新脚本会直接 return。
      // 同时递增实例代次：旧实例的 loop / 心跳 / 等待日志定时器仍挂在页面上，
      // 不主动让它退出，就会和新实例一起领任务、重复发提示词（旧监听器也会抢答 PING）。
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          window.__CGR_LOADED__ = false;
          window.__CGR_INSTANCE__ = (Number(window.__CGR_INSTANCE__) || 0) + 1;
        }
      });
      await chrome.scripting.executeScript({ target: { tabId }, files });
    } catch (e) {
      store.addLog('error', `无法向标签页 ${tabId} 注入脚本：${(e && e.message) || e}`);
      return false;
    }
    // 刚注入时 onMessage 可能还没注册，给几次短重试，别把「正在就绪」误判成「接管失败」
    for (let i = 0; i < 4; i++) {
      if (await ping(tabId)) return true;
      await CGR.sleep(300);
    }
    return false;
  }

  /**
   * 为某个批次准备它自己的窗口与标签页。
   * 一个批次 = 一个独立窗口，互不干扰；窗口 id 记在批次上，下次直接复用。
   */
  /**
   * 为批次准备执行标签页：优先复用你已经开着的 ChatGPT 标签页，
   * 不再动不动就新建窗口。只有确实没有可用标签页时才新建一个。
   */
  async function ensureBatchTabs(batch, desired, focus, preferActive) {
    const want = Math.max(1, Math.min(desired || 1, CGR.LIMITS.hardMaxConcurrency));
    // 老批次没有 site 字段，按 ChatGPT 处理；新建批次在批次设置里指定工作站点。
    const site = (batch && batch.site) || defaultSite();
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
        if (tabMatches(t, site)) {
          live.push(t.id);
          if (windowId == null) windowId = t.windowId;
        }
      } catch (e) {
        /* 已关闭 */
      }
    }

    // 手动「开始 / 立即修复」时优先用用户此刻正在看的 ChatGPT 标签页。
    // 旧版只复用 mine（上次运行遗留的登记），常常选中一个后台/已冻结的标签页，
    // 用户看到的就是「说在跑，但当前页面毫无动静」。这里只换选谁当执行页，
    // 不激活标签页、也不新建窗口。
    if (preferActive) {
      const here = await currentActiveChatTab(site);
      if (here && !live.includes(here.id)) {
        live.unshift(here.id);
        if (windowId == null) windowId = here.windowId;
      }
    }

    if (live.length >= want) {
      const picked = live.slice(0, want);
      for (const id of picked) await harden(id);
      return { ids: picked, windowId };
    }

    // ② 复用用户已经打开、站点一致、且没被别的批次占用的标签页（优先当前活动的那个）
    const all = await listTabs(site);
    // 只有「其它批次此刻仍在运行」才算真的占用这个标签页。
    // 旧批次已经停止/完成/空闲时，它的历史归属不该挡路，否则换一个批次点「开始」
    // 就会误判成没有可用标签页，转头新建一个 —— 用户看到的「又开新标签页」多半来自这里。
    // 没有 batchId 的条目是历史僵尸记录，同样不能占位置。
    const used = new Set(
      Object.entries(rt.activeTabs || {})
        .filter(([, v]) => {
          if (!v || !v.batchId) return false;
          const other = store.getBatch(v.batchId);
          return !!other && other.status === CGR.GLOBAL.RUNNING;
        })
        .map(([k]) => Number(k))
    );
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
      const opts = { url: siteHome(site), active: false };
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

  root.CGR_TABS = {
    MATCH,
    siteOfTab,
    tabMatches,
    siteHome,
    listTabs,
    usableTabs,
    currentActiveChatTab,
    ensureBatchTabs,
    resetWindow,
    send,
    ping,
    pageAlive,
    reviveTab,
    replaceTab,
    ensureContentScript
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
