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

    // 停止生成按钮（存在即表示正在生成）
    stopButton: [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop generating"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="停止"]'
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
    alert: ['[role="alert"]', '.text-token-text-error', '[data-testid*="toast"]']
  };

  // 生成图 src 的匹配规则
  CGR.IMG_PATTERNS = [
    /backend-api\/estuary\/content/,
    /\/files\/download/,
    /oaiusercontent\.com/
  ];

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
