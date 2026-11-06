/* 页面状态探测：生成中 / 图片快照 / 限额 / 报错 / 登录墙。
 *
 * 重要：不要把「URL 白名单」当成「图片是不是生成图」的硬门槛。
 * ChatGPT 前端改版时图片域名、路径、渲染方式（blob / data / 签名 CDN）随时会变，
 * 白名单一定漏检，而漏检会直接导致「明明出图了却判未出图 → 重发提示词 → 重复生图」。
 * 真正稳定可靠的判据是：发送前拍一张全页面快照，发送后只认「新出现的大图」，
 * 再用尺寸、位置、alt 排除头像/图标/装饰图。URL 白名单只用于排序与诊断。 */
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

  /** 只判断「这个 src 像不像一张位图」，不再用来决定要不要下载 */
  function isImageSrc(src) {
    if (!src) return false;
    if (/^blob:/i.test(src)) return true;
    if (/^data:/i.test(src)) return /^data:image\/(?!svg)/i.test(src);
    if (CGR.IMG_PATTERNS.some((re) => re.test(src))) return true;
    return /^https?:\/\//i.test(src) && /\.(png|jpe?g|webp|gif|avif|bmp)(?:[?#]|$)/i.test(src);
  }

  const CHROME_RE = /(^|[\s_-])(avatar|icon|logo|sprite|emoji|spinner)([\s_-]|$)/i;

  /** 差集用归一化 src：签名 URL 的 query 每次重渲染都变，
   * 用完整 URL 比较会把「旧图换了签名」误当成「新生成了一张图」。 */
  function normSrc(src) {
    if (/^data:/i.test(src)) return `data:${src.length}:${src.slice(0, 64)}`;
    return String(src).split('#')[0].split('?')[0];
  }

  /**
   * 是不是「本次生成出来的图」。loose=true 时连 URL 白名单也不看，
   * 只靠「新出现 + 尺寸够大 + 不在用户气泡/导航区」判断，用于出图前的最后兜底。
   */
  function isLikelyGenerated(img, loose) {
    const src = img.currentSrc || img.src || '';
    if (!src) return false;
    if (/^data:image\/svg/i.test(src) || /\.svg(?:[?#]|$)/i.test(src)) return false;

    const tag = [img.getAttribute && img.getAttribute('alt'), img.getAttribute && img.getAttribute('aria-label'), img.className]
      .filter(Boolean)
      .join(' ');
    if (CHROME_RE.test(String(tag))) return false;

    if (!loose && !isImageSrc(src)) return false;

    const nw = img.naturalWidth || 0;
    const nh = img.naturalHeight || 0;
    const minN = loose ? 128 : 96;
    if (nw && nh && (nw < minN || nh < minN)) return false;

    const r = img.getBoundingClientRect ? img.getBoundingClientRect() : { width: 0, height: 0 };
    const minR = loose ? 96 : 48;
    if (r.width && r.height && (r.width < minR || r.height < minR)) return false;
    // 既没有固有尺寸、也没有布局尺寸：图还没开始渲染，这一轮先不算
    if (!nw && !r.width) return false;

    if (img.closest) {
      if (img.closest('[data-message-author-role="user"]')) return false;
      if (img.closest('nav, aside, header, footer, [data-testid*="sidebar" i], [data-testid*="nav" i]')) return false;
    }
    return true;
  }

  /** 快照：记录整个 document 的所有 img src，而不是只记「白名单命中的图」。
   * 否则新图的 URL 一旦不在白名单里，差集会失效或误把旧图算成新图。 */
  function snapshot() {
    const imgs = new Set();
    for (const img of document.querySelectorAll('img')) {
      const src = img.currentSrc || img.src || '';
      if (src) imgs.add(normSrc(src));
    }
    return { imgs, msgCount: allMsgCount(), assistantCount: assistantCount(), convId: CGR.getConvId() };
  }

  /**
   * 与快照做差集，返回新出现的候选图。扫描范围是整个 document（很多新版 UI 把
   * 生成图 portal 到 main 之外），靠尺寸/位置规则降噪。
   * afterNode 非空时只接受出现在该节点之后的图片 —— 用来排除用户上传的参考图。
   */
  function freshImages(before, afterNode, loose) {
    const out = [];
    const seen = new Set();
    for (const img of document.querySelectorAll('img')) {
      const src = img.currentSrc || img.src || '';
      if (!src) continue;
      const key = normSrc(src);
      if (seen.has(key)) continue;
      if (before && before.imgs && before.imgs.has(key)) continue;
      if (!isLikelyGenerated(img, loose)) continue;
      if (afterNode && document.contains(afterNode)) {
        const pos = afterNode.compareDocumentPosition(img);
        if (!(pos & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      }
      seen.add(key);
      out.push({
        src,
        w: img.naturalWidth || 0,
        h: img.naturalHeight || 0,
        loose: !!loose,
        known: isImageSrc(src)
      });
    }
    return out;
  }

  /** 判「未出图」之前，把页面实况留证，日志里能一眼看出是识别问题还是真没出图 */
  function diagnose(before) {
    const all = Array.from(document.querySelectorAll('img'));
    const freshAll = [];
    let largeFresh = 0;
    for (const img of all) {
      const src = img.currentSrc || img.src || '';
      if (!src || (before && before.imgs && before.imgs.has(normSrc(src)))) continue;
      if (isLikelyGenerated(img, true)) largeFresh += 1;
      const r = img.getBoundingClientRect ? img.getBoundingClientRect() : { width: 0 };
      freshAll.push({ src, nw: img.naturalWidth || 0, nh: img.naturalHeight || 0, rw: Math.round(r.width || 0) });
    }
    const short = (s) => {
      try {
        const u = new URL(s, location.href);
        return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 90);
      } catch (e) {
        return String(s).slice(0, 90);
      }
    };
    return {
      totalImgs: all.length,
      freshImgs: freshAll.length,
      largeFresh,
      strictHits: freshAll.filter((f) => isImageSrc(f.src)).length,
      canvases: document.querySelectorAll('canvas').length,
      assistantMsgs: assistantCount(),
      msgNodes: allMsgCount(),
      generating: isGenerating(),
      stopHit: !!CGR.pick(CGR.SEL.stopButton),
      samples: freshAll.slice(0, 4).map((f) => `${f.nw}x${f.nh} ${f.rw}px ${short(f.src)}`)
    };
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

  /* 只保留「确实是生图/网络失败」的说法。原来包含「出错了 / 生成失败」这类泛化词，
   * 页面上任意一个无关 toast 都会把一条明明出了图的任务判成失败并重发。 */
  const ERROR_RE = /(something went wrong|an error occurred|network error|failed to generate|image generation (failed|error)|生成图片失败|无法生成图片|图片生成失败)/i;

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
    normSrc,
    isLikelyGenerated,
    snapshot,
    freshImages,
    diagnose,
    detectLimit,
    detectPageError
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
