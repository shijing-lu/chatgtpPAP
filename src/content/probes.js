/* 页面状态探测：生成中 / 图片快照 / 限额 / 报错 / 登录墙。 */
(function (root) {
  const CGR = root.CGR;

  function isGenerating() {
    return !!CGR.pick(CGR.SEL.stopButton);
  }

  function allMsgCount() {
    return CGR.pickAll(CGR.SEL.allMsg).length;
  }

  function assistantCount() {
    return CGR.pickAll(CGR.SEL.assistantMsg).length;
  }

  function lastAssistantText() {
    const list = CGR.pickAll(CGR.SEL.assistantMsg);
    const el = list[list.length - 1];
    return el ? String(el.innerText || '').slice(0, 500) : '';
  }

  function hasLoginWall() {
    if (CGR.getConvId()) return false;
    return !!CGR.pick(CGR.SEL.loginWall);
  }

  function isImageSrc(src) {
    if (!src) return false;
    if (src.startsWith('blob:')) return true;
    return CGR.IMG_PATTERNS.some((re) => re.test(src));
  }

  /** 过滤掉头像、图标、小缩略图 */
  function isLikelyGenerated(img) {
    const src = img.currentSrc || img.src || '';
    if (!isImageSrc(src)) return false;
    if (img.naturalWidth && img.naturalWidth < 200) return false;
    const r = img.getBoundingClientRect();
    if (r.width && r.width < 120) return false;
    if (img.closest('[data-message-author-role="user"]')) return false;
    return true;
  }

  /** 快照：只扫 main，避免抓到其他标签页的完成通知缩略图 */
  function snapshot() {
    const rootEl = CGR.getMain();
    const imgs = new Set();
    for (const img of rootEl.querySelectorAll('img')) {
      const src = img.currentSrc || img.src || '';
      if (isImageSrc(src)) imgs.add(src);
    }
    return { imgs, msgCount: allMsgCount(), assistantCount: assistantCount(), convId: CGR.getConvId() };
  }

  /** 与快照做差集，返回新出现的候选图 */
  function freshImages(before) {
    const rootEl = CGR.getMain();
    const out = [];
    for (const img of rootEl.querySelectorAll('img')) {
      const src = img.currentSrc || img.src || '';
      if (!src) continue;
      if (before.imgs.has(src)) continue;
      if (!isLikelyGenerated(img)) continue;
      out.push({ src, w: img.naturalWidth || 0, h: img.naturalHeight || 0 });
    }
    return out;
  }

  const LIMIT_RE = /(you['’]ve reached|reached (your|the) (limit|cap)|usage limit|too many (requests|images)|image limit|上限|已达|额度|配额|限制|稍后再试|明天再)/i;

  function detectLimit() {
    const nodes = CGR.pickAll(CGR.SEL.alert).slice(0, 12);
    for (const n of nodes) {
      const txt = String(n.innerText || '').trim();
      if (!txt || txt.length > 300) continue;
      if (LIMIT_RE.test(txt) && /(image|图片|画|generate|生成|limit|上限|额度)/i.test(txt)) return txt;
    }
    return '';
  }

  const ERROR_RE = /(something went wrong|an error occurred|network error|failed to generate|出现问题|出错了|网络错误|生成失败)/i;

  function detectPageError() {
    const nodes = CGR.pickAll(CGR.SEL.alert).slice(0, 12);
    for (const n of nodes) {
      const txt = String(n.innerText || '').trim();
      if (!txt || txt.length > 300) continue;
      if (ERROR_RE.test(txt)) return txt;
    }
    return '';
  }

  root.CGR_PROBE = {
    isGenerating,
    allMsgCount,
    assistantCount,
    lastAssistantText,
    hasLoginWall,
    isImageSrc,
    isLikelyGenerated,
    snapshot,
    freshImages,
    detectLimit,
    detectPageError
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
