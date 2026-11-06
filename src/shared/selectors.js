/* 全部 DOM 选择器集中于此。ChatGPT 前端改版时，只改这一个文件。
 * 每一项是「候选链」，按顺序尝试，取第一个命中的元素。 */
(function (root) {
  const CGR = (root.CGR = root.CGR || {});

  CGR.SEL = {
    // 对话主容器：所有图片扫描必须限定在这里，避免抓到其他标签页的完成通知缩略图
    main: ['main'],

    // 输入框（ProseMirror contenteditable）
    composer: [
      '#prompt-textarea',
      'div.ProseMirror[contenteditable="true"]',
      'form [contenteditable="true"]',
      'textarea[data-id="root"]'
    ],

    // 发送按钮
    sendButton: [
      'button[data-testid="send-button"]',
      'button[data-testid*="send-button"]',
      '#composer-submit-button',
      'form button[type="submit"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="发送"]'
    ],

    // 停止生成按钮（存在即表示正在生成）。前端改版时按钮 testid 常变，多留几个候选
    stopButton: [
      'button[data-testid="stop-button"]',
      'button[data-testid*="stop-button"]',
      'button[data-testid*="stop" i]',
      'button[aria-label*="Stop generating"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="停止"]',
      'button[data-state="stop"]'
    ],

    // 新建对话
    newChat: [
      'a[data-testid="create-new-chat-button"]',
      'button[data-testid="create-new-chat-button"]',
      'a[href="/"][data-testid]',
      'nav a[href="/"]',
      'a[aria-label="New chat"]',
      'a[aria-label*="新对话"]'
    ],

    // 消息节点
    assistantMsg: ['[data-message-author-role="assistant"]'],
    allMsg: ['[data-message-author-role]'],

    // 登录墙
    loginWall: [
      'a[href*="auth/login"]',
      'button[data-testid="login-button"]',
      'form[action*="login"]'
    ],

    // 提示/报错容器
    alert: ['[role="alert"]', '.text-token-text-error', '[data-testid*="toast"]'],

    // 文件产物：新版 ChatGPT 会把生成结果作为「文件附件卡片 / 查看原图链接」返回，
    // 页面上完全没有 <img>。这些只作为候选入口，是否算产物由 probes.js 的内容规则判定。
    artifactLink: ['a[href]'],
    fileCard: [
      '[data-testid*="file" i]',
      '[data-testid*="attachment" i]',
      '[role="button"]',
      'button'
    ]
  };

  /* 生成图 URL 的「高置信」特征，只用于排序与诊断，不再作为「是不是图」的硬门槛。
   * ChatGPT 改版时图片域名/路径随时会变，靠白名单判图必然漏检 —— 真正可靠的是
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
    /\/assets?\/.*(?:image|img)/i
  ];

  /* 文件产物判定用的内容规则。注意：这里刻意不依赖具体 testid ——
   * ChatGPT 的附件卡片结构每次改版都变，稳定的是「图片扩展名 / 文件服务 URL / 图片语义文字」。 */
  CGR.FILE_EXT_RE = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?)(?:[?#]|$)/i;
  CGR.FILE_URL_RE = /(^sandbox:|\/mnt\/data\/|backend-api\/(?:.*\/)?(?:download|content|estuary|files?)|\/files?\/download|oaiusercontent\.com|\/attachments?\/)/i;
  CGR.IMAGE_WORD_RE = /(png|jpe?g|webp|gif|avif|图像|图片|原图|高清|image)/i;
  CGR.VIEW_IMAGE_RE = /(查看|高清|原图|放大|下载|download|view (?:full|original)|open (?:full|original)|\d{3,4}\s*[×x]\s*\d{3,4})/i;

  CGR.pick = function (candidates, scope) {
    const rootEl = scope || document;
    for (const sel of candidates || []) {
      try {
        const el = rootEl.querySelector(sel);
        if (el) return el;
      } catch (e) {
        /* 无效选择器忽略 */
      }
    }
    return null;
  };

  CGR.pickAll = function (candidates, scope) {
    const rootEl = scope || document;
    for (const sel of candidates || []) {
      try {
        const list = rootEl.querySelectorAll(sel);
        if (list && list.length) return Array.from(list);
      } catch (e) {
        /* ignore */
      }
    }
    return [];
  };

  CGR.getMain = function () {
    return CGR.pick(CGR.SEL.main) || document.body;
  };

  CGR.getConvId = function () {
    const m = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/);
    return m ? m[1] : '';
  };

  CGR.isChatGPT = function () {
    return /(^|\.)chatgpt\.com$/.test(location.hostname) || /(^|\.)chat\.openai\.com$/.test(location.hostname);
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
