/* 全部 DOM 选择器集中于此。站点前端改版时，只改这一个文件。
 * 每一项是「候选链」，按顺序尝试，取第一个命中的元素。
 *
 * 结构：CHATGPT_SEL / GEMINI_SEL 是站点专属候选，COMMON_SEL 是跨站点兜底。
 * 运行时按当前站点合并成 CGR.SEL（专属优先 → 通用兜底 → ChatGPT 老候选最后兜底），
 * 所以内容脚本 / 探测层的所有代码都不需要知道自己跑在哪个网站。
 * 站点 URL 事实（域名、首页、对话 ID）在 sites.js，这里只管 DOM。 */
(function (root) {
  const CGR = (root.CGR = root.CGR || {});

  const CHATGPT_SEL = {
    main: ['main'],
    composer: [
      '#prompt-textarea',
      'div.ProseMirror[contenteditable="true"]',
      'form [contenteditable="true"]',
      'textarea[data-id="root"]'
    ],
    sendButton: [
      'button[data-testid="send-button"]',
      'button[data-testid*="send-button"]',
      '#composer-submit-button',
      'form button[type="submit"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="发送"]'
    ],
    stopButton: [
      'button[data-testid="stop-button"]',
      'button[data-testid*="stop-button"]',
      'button[data-testid*="stop" i]',
      'button[aria-label*="Stop generating"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="停止"]',
      'button[data-state="stop"]'
    ],
    newChat: [
      'a[data-testid="create-new-chat-button"]',
      'button[data-testid="create-new-chat-button"]',
      'a[href="/"][data-testid]',
      'nav a[href="/"]',
      'a[aria-label="New chat"]',
      'a[aria-label*="新对话"]'
    ],
    assistantMsg: ['[data-message-author-role="assistant"]'],
    allMsg: ['[data-message-author-role]'],
    userArea: ['[data-message-author-role="user"]'],
    loginWall: [
      'a[href*="auth/login"]',
      'button[data-testid="login-button"]',
      'form[action*="login"]'
    ],
    alert: ['[role="alert"]', '.text-token-text-error', '[data-testid*="toast"]'],
    generatedImage: [],
    generatedImageBox: [],
    imageDownloadButton: [],
    uploadMenu: [],
    artifactLink: ['a[href]'],
    fileCard: [
      '[data-testid*="file" i]',
      '[data-testid*="attachment" i]',
      '[role="button"]',
      'button'
    ]
  };

  /* Gemini 网页端（2026 版）用的是 Angular + Quill 编辑器：
   *  - 输入框是 rich-textarea 里的 .ql-editor / [role=textbox]
   *  - 空输入框时右侧是麦克风，输入文字后才出现「Send message」按钮
   *  - 回复节点是自定义元素 <model-response>，用户消息是 <user-query>
   *  - 生成图片是 <generated-image> 里的 <img src="blob:...">（1024px 预览），
   *    同一容器内另有「Download full size image」按钮，能拿到全尺寸图 */
  const GEMINI_SEL = {
    main: ['main', '.conversation-container', '[role="main"]'],
    composer: [
      'div[role="textbox"][aria-label*="Enter a prompt" i]',
      'div.ql-editor[contenteditable="true"]',
      'rich-textarea [contenteditable="true"]',
      'rich-textarea .ql-editor',
      '[aria-label="Enter a prompt here"]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea[aria-label*="prompt" i]'
    ],
    sendButton: [
      'button[aria-label="Send message"]',
      'button[aria-label*="Send prompt" i]',
      'button.send-button',
      '.send-button',
      'button[mattooltip*="Send" i]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="发送" i]'
    ],
    stopButton: [
      'button[aria-label="Stop response"]',
      'button[aria-label="Stop generation"]',
      'button[aria-label*="Stop response" i]',
      'button[aria-label*="Stop" i]',
      'button[aria-label*="停止" i]'
    ],
    newChat: [
      'a[aria-label="New chat"]',
      'button[aria-label="New chat"]',
      'a[href="/app"]',
      'button[aria-label*="新对话" i]',
      'a[aria-label*="新对话" i]'
    ],
    assistantMsg: ['model-response', '[data-test-id*="model-response" i]', 'div[class*="model-response" i]'],
    allMsg: ['model-response', 'user-query', '[data-test-id*="model-response" i]', '[data-test-id*="user-query" i]'],
    userArea: ['user-query', '[data-test-id*="user-query" i]'],
    loginWall: ['a[href*="accounts.google.com/ServiceLogin"]', 'button[aria-label*="Sign in" i]'],
    alert: ['[role="alert"]', '[data-test-id*="toast" i]', '.error-message'],
    generatedImage: [
      'generated-image img',
      '[data-test-id*="generated-image" i] img',
      '[class*="generated-image" i] img',
      'img[src^="blob:"]'
    ],
    // 容器（不是 img 本身）：用来定位同一容器里的「下载全尺寸图片」按钮，
    // 同时把 Gemini 页面上的头像 / 工具栏图标排除在产物之外。
    generatedImageBox: [
      'generated-image',
      '[data-test-id*="generated-image" i]',
      '[class*="generated-image" i]'
    ],
    imageDownloadButton: [
      'button[aria-label="Download full size image"]',
      'button[aria-label*="Download full" i]',
      'button[aria-label*="Download" i]',
      'button[aria-label*="下载" i]',
      'button[data-test-id*="download" i]',
      '[role="button"][aria-label*="下载" i]'
    ],
    uploadMenu: [
      'button[aria-label="Upload & tools"]',
      'button[aria-label*="Upload" i]',
      'button[aria-label*="上传" i]',
      '[data-test-id="local-images-files-uploader-button"]'
    ],
    artifactLink: ['a[href]'],
    fileCard: ['[data-test-id*="file" i]', '[role="button"]', 'button']
  };

  /* 跨站点兜底：站点专属候选都失效时，靠语义化属性而不是 class 名 */
  const COMMON_SEL = {
    main: ['[role="main"]'],
    composer: ['div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]', 'textarea'],
    sendButton: ['button[type="submit"]', 'button[aria-label*="Send" i]', 'button[aria-label*="发送" i]'],
    stopButton: ['button[aria-label*="Stop" i]', 'button[aria-label*="停止" i]'],
    newChat: ['a[aria-label="New chat"]', 'button[aria-label="New chat"]'],
    assistantMsg: ['[data-role="assistant"]', '[data-message-author-role="assistant"]'],
    allMsg: ['[data-message-author-role]', '[data-role="assistant"]', '[data-role="user"]'],
    userArea: ['[data-message-author-role="user"]', '[data-role="user"]'],
    loginWall: [],
    alert: ['[role="alert"]'],
    generatedImage: [],
    generatedImageBox: [],
    imageDownloadButton: ['button[aria-label*="Download" i]', 'button[aria-label*="下载" i]'],
    uploadMenu: [],
    artifactLink: ['a[href]'],
    fileCard: ['[role="button"]', 'button']
  };

  const siteId = typeof CGR.currentSiteId === 'function' ? CGR.currentSiteId() : '';
  const own = siteId === 'gemini' ? GEMINI_SEL : CHATGPT_SEL;

  function chain(key) {
    const out = [];
    for (const part of [own[key] || [], COMMON_SEL[key] || [], CHATGPT_SEL[key] || []]) {
      for (const sel of part) if (sel && !out.includes(sel)) out.push(sel);
    }
    return out;
  }

  CGR.SEL = {};
  for (const key of new Set([...Object.keys(own), ...Object.keys(COMMON_SEL), ...Object.keys(CHATGPT_SEL)])) {
    CGR.SEL[key] = chain(key);
  }
  CGR.SEL_GEMINI = GEMINI_SEL;
  CGR.SEL_CHATGPT = CHATGPT_SEL;

  /* 「页面里哪些区域绝不算产物」——站点用户消息 + 通用导航区 */
  CGR.EXCLUDE_AREA = [
    'nav', 'aside', 'header', 'footer',
    '[data-testid*="sidebar" i]', '[data-testid*="nav" i]',
    '[data-message-author-role="user"]', 'user-query', '[data-test-id*="user-query" i]'
  ].join(', ');

  /* 生成图 URL 的「高置信」特征，只用于排序与诊断，不再作为「是不是图」的硬门槛。
   * 前端改版时图片域名/路径随时会变，靠白名单判图必然漏检 —— 真正可靠的是
   * 「发送前快照 -> 发送后新出现的大图」这个差集，见 probes.js。 */
  CGR.IMG_PATTERNS = [
    /backend-api\/estuary\/content/,
    /\/files\/download/,
    /oaiusercontent\.com/,
    /backend-api\/files?\//i,
    /\/backend-api\/.*(?:image|attachment|asset)/i,
    /\/attachments?\//i,
    /cdn\.openai\.com/i,
    /cdn\.oaiusercontent/i,
    /image[-_]?gen/i,
    /\/assets?\/.*(?:image|img)/i,
    // Gemini：生成图预览多为 blob:，历史版本也用过 googleusercontent / lh3
    /googleusercontent\.com/i,
    /lh3\./i,
    /gstatic\.com/i,
    /contrib_service/i,
    /generated[-_]?image/i
  ];

  /* 文件产物判定用的内容规则。刻意不依赖具体 testid —— 稳定的只有「扩展名 / 文件服务 URL / 图片语义文字」。 */
  CGR.FILE_EXT_RE = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?)(?:[?#]|$)/i;
  CGR.FILE_URL_RE = /(^sandbox:|\/mnt\/data\/|backend-api\/(?:.*\/)?(?:download|content|estuary|files?)|\/files?\/download|oaiusercontent\.com|\/attachments?\/|googleusercontent\.com|lh3\.|contrib_service)/i;
  CGR.IMAGE_WORD_RE = /(png|jpe?g|webp|gif|avif|图像|图片|原图|高清|image)/i;
  CGR.VIEW_IMAGE_RE = /(查看|高清|原图|放大|下载|download|view (?:full|original)|open (?:full|original)|\d{3,4}\s*[×x]\s*\d{3,4})/i;

  /** 元素可能在 shadow root 里（Gemini 的 rich-textarea 就包了一层）。
   * 普通查询失败时才深挖，且限制宿主数量与深度，避免拖慢长对话页面。 */
  function deepFind(rootEl, sel, wantAll, depth) {
    const out = [];
    if (!rootEl || !sel || (depth || 0) > 3) return out;
    let hosts = [];
    try {
      hosts = rootEl.querySelectorAll ? Array.from(rootEl.querySelectorAll('*')).slice(0, 600) : [];
    } catch (e) {
      hosts = [];
    }
    for (const h of hosts) {
      const sr = h && h.shadowRoot;
      if (!sr) continue;
      try {
        if (wantAll) out.push(...Array.from(sr.querySelectorAll(sel)));
        else {
          const hit = sr.querySelector(sel);
          if (hit) out.push(hit);
        }
      } catch (e) {
        /* ignore */
      }
      if (out.length) {
        out.push(...deepFind(sr, sel, wantAll, (depth || 0) + 1));
        break; // 与 pickAll 语义一致：取第一个命中的候选链，不把多个 selector 的结果混在一起
      }
    }
    return out;
  }

  CGR.pick = function (candidates, scope) {
    const rootEl = scope || (typeof document !== 'undefined' ? document : null);
    if (!rootEl) return null;
    for (const sel of candidates || []) {
      try {
        const el = rootEl.querySelector(sel);
        if (el) return el;
      } catch (e) {
        /* 无效选择器忽略 */
      }
    }
    // 全部候选都没命中时才尝试 shadow root
    for (const sel of candidates || []) {
      const found = deepFind(rootEl, sel, false, 0);
      if (found.length) return found[0];
    }
    return null;
  };

  CGR.pickAll = function (candidates, scope) {
    const rootEl = scope || (typeof document !== 'undefined' ? document : null);
    if (!rootEl) return [];
    for (const sel of candidates || []) {
      try {
        const list = rootEl.querySelectorAll(sel);
        if (list && list.length) return Array.from(list);
      } catch (e) {
        /* ignore */
      }
    }
    for (const sel of candidates || []) {
      const found = deepFind(rootEl, sel, true, 0);
      if (found.length) return found;
    }
    return [];
  };

  CGR.getMain = function () {
    return CGR.pick(CGR.SEL.main) || (typeof document !== 'undefined' ? document.body : null);
  };

  CGR.currentSiteLabel = function () {
    const s = typeof CGR.currentSite === 'function' ? CGR.currentSite() : null;
    return s ? s.label : '未知站点';
  };

  /* 兼容垫片：旧加载顺序 / 零依赖测试桩可能只加载 selectors.js 而不加载 sites.js。
   * 生产环境 sites.js 会先加载并覆盖这两个实现（getConvId 支持全部站点）。 */
  if (typeof CGR.getConvId !== 'function') {
    CGR.getConvId = function () {
      try {
        const m = String(root.location && root.location.pathname || '').match(/\/c\/([a-zA-Z0-9-]+)/);
        return m ? m[1] : '';
      } catch (e) {
        return '';
      }
    };
  }
  if (typeof CGR.isChatSite !== 'function') {
    CGR.isChatSite = function () {
      try {
        return /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/i.test(root.location.hostname || '');
      } catch (e) {
        return false;
      }
    };
    CGR.isChatGPT = CGR.isChatSite;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
