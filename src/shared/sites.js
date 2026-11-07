/* 站点注册表：后台、内容脚本、侧边栏共用的「唯一站点事实来源」。
 *
 * 为什么要有这一层：以前 chatgpt.com 的域名、首页地址、对话 ID 规则散落在
 * tabpool / composer / selectors / service-worker 里，加第二个站点时任何一处漏改
 * 都会表现为「标签页被抢到另一个网站」「新对话跳回旧站」「批次卡在等待派发」。
 * 现在站点相关的 URL 事实只在这里定义，DOM 选择器在 selectors.js 里按站点合并。
 *
 * 注意：service worker 里 location 指向扩展自身，所以后台只能用 siteOf(url)；
 *       currentSite() / isChatSite() / getConvId() 只在内容脚本里有意义。
 */
(function (root) {
  const CGR = (root.CGR = root.CGR || {});

  const SITES = [
    {
      id: 'chatgpt',
      label: 'ChatGPT',
      hosts: [/(^|\.)chatgpt\.com$/i, /(^|\.)chat\.openai\.com$/i],
      match: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
      hostPermissions: [
        'https://chatgpt.com/*',
        'https://chat.openai.com/*',
        'https://*.oaiusercontent.com/*'
      ],
      homeUrl: 'https://chatgpt.com/',
      convId: (url) => {
        const m = String(url || '').match(/\/c\/([a-zA-Z0-9-]+)/);
        return m ? m[1] : '';
      }
    },
    {
      id: 'gemini',
      label: 'Gemini',
      hosts: [/(^|\.)gemini\.google\.com$/i],
      match: ['https://gemini.google.com/*'],
      hostPermissions: [
        'https://gemini.google.com/*',
        'https://*.googleusercontent.com/*'
      ],
      homeUrl: 'https://gemini.google.com/app',
      // /app/<id> 与 /chat/<id> 都出现过；根节点 /app 表示新对话，返回空串
      convId: (url) => {
        const m = String(url || '').match(/\/(?:app|chat)\/([a-zA-Z0-9_-]{8,})/);
        return m ? m[1] : '';
      }
    }
  ];

  const BY_ID = Object.fromEntries(SITES.map((s) => [s.id, s]));

  /** 从完整 URL / hostname 判断站点。url 为空或不是受支持站点时返回 '' */
  function siteOf(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    let host = raw;
    try {
      host = /^[a-z]+:\/\//i.test(raw) ? new URL(raw).hostname : raw.split('/')[0].split(':')[0];
    } catch (e) {
      host = raw.split('/')[0].split(':')[0];
    }
    for (const s of SITES) {
      if (s.hosts.some((re) => re.test(host))) return s.id;
    }
    return '';
  }

  function siteMeta(id) {
    return BY_ID[id] || null;
  }

  function siteLabel(id) {
    const s = siteMeta(id);
    return s ? s.label : '自动';
  }

  function siteHome(id) {
    const s = siteMeta(id);
    return s ? s.homeUrl : (SITES[0] && SITES[0].homeUrl) || '';
  }

  function allMatchPatterns() {
    const out = [];
    for (const s of SITES) for (const p of s.match) if (!out.includes(p)) out.push(p);
    return out;
  }

  function allHostPermissions() {
    const out = [];
    for (const s of SITES) for (const p of s.hostPermissions) if (!out.includes(p)) out.push(p);
    return out;
  }

  /** 当前页面所在站点（仅内容脚本用；后台/侧边栏返回 null） */
  function currentSite() {
    let href = '';
    try {
      href = root.location && root.location.href ? root.location.href : '';
    } catch (e) {
      href = '';
    }
    const id = siteOf(href);
    return id ? BY_ID[id] : null;
  }

  function currentSiteId() {
    const s = currentSite();
    return s ? s.id : '';
  }

  /** 当前页面是否是受支持的对话站点 */
  function isChatSite() {
    return !!currentSite();
  }

  /** 兼容旧调用点：语义已改为「受支持的对话站点」，新代码请用 isChatSite() */
  function isChatGPT() {
    return isChatSite();
  }

  /** 当前页面的对话 ID；按站点解析，站点未知时返回 '' */
  function getConvId() {
    const s = currentSite();
    if (!s) return '';
    let href = '';
    try {
      href = root.location && root.location.href ? root.location.href : '';
    } catch (e) {
      href = '';
    }
    return s.convId(href) || '';
  }

  /** 给后台用：从任意 URL 解析对话 ID */
  function convIdOf(url) {
    const id = siteOf(url);
    const s = id ? BY_ID[id] : null;
    return s ? s.convId(String(url || '')) || '' : '';
  }

  CGR.SITES = SITES;
  CGR.SITE_IDS = SITES.map((s) => s.id);
  CGR.siteOf = siteOf;
  CGR.siteMeta = siteMeta;
  CGR.siteLabel = siteLabel;
  CGR.siteHome = siteHome;
  CGR.allMatchPatterns = allMatchPatterns;
  CGR.allHostPermissions = allHostPermissions;
  CGR.currentSite = currentSite;
  CGR.currentSiteId = currentSiteId;
  CGR.isChatSite = isChatSite;
  CGR.isChatGPT = isChatGPT;
  CGR.getConvId = getConvId;
  CGR.convIdOf = convIdOf;
})(typeof globalThis !== 'undefined' ? globalThis : self);
