/* 页面状态探测：生成中 / 产物快照 / 限额 / 报错 / 登录墙。
 *
 * 「产物」不只是 <img>。ChatGPT 至少有三种交付生成结果的方式：
 *   ① 内嵌 <img>（DALL·E / 图片消息）
 *   ② 图片链接（「查看 4K 高清原图」、backend-api / oaiusercontent 直链）
 *   ③ 文件附件卡片（如 xxx.png / 「图像」，页面里连一个 <img> 都没有）
 * 只扫 <img> 会把 ②③ 判成「未出图」，进而重发提示词 → 重复生图。
 * 所以这里统一产出 artifact 数组，判定层与下载层共用同一种结构。
 *
 * 稳定判据仍然是「发送前快照 → 发送后新出现」，URL 白名单只用于排序与诊断。 */
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
    return /^https?:\/\//i.test(src) && CGR.FILE_EXT_RE.test(src);
  }

  const CHROME_RE = /(^|[\s_-])(avatar|icon|logo|sprite|emoji|spinner)([\s_-]|$)/i;

  /** 差集用归一化 src：签名 URL 的 query 每次重渲染都变，
   * 用完整 URL 比较会把「旧图换了签名」误当成「新生成了一张图」。 */
  function normSrc(src) {
    if (/^data:/i.test(src)) return `data:${src.length}:${src.slice(0, 64)}`;
    return String(src).split('#')[0].split('?')[0];
  }

  function bodyTextLen() {
    try {
      const t = document.body && document.body.innerText;
      return t ? String(t).length : 0;
    } catch (e) {
      return 0;
    }
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

  /* ---------------- 文件产物（链接 / 附件卡片） ---------------- */

  const BAD_SCHEME_RE = /^(javascript:|mailto:|about:|#|data:text\/)/i;
  // 卡片文本是「xxx.png 图像」——扩展名后面跟的是空格/中文，不是 URL 的 ?# 或结尾。
  // 用单独的文件名规则，否则截图里那种附件卡片会被 FILE_EXT_RE 直接漏掉。
  const FILE_NAME_RE = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?)(?:$|[^a-z0-9])/i;

  /** 收集候选链里的全部节点（不去重选择器链，避免第一个命中就丢掉后面的候选） */
  function allNodes(selList) {
    const out = [];
    for (const sel of selList || []) {
      if (out.length >= 400) break; // 长对话里 button 可能有几百个，封顶避免每次判定拖慢页面
      try {
        const list = document.querySelectorAll(sel);
        if (list && list.length) for (const el of list) {
          out.push(el);
          if (out.length >= 400) break;
        }
      } catch (e) {
        /* 无效选择器忽略 */
      }
    }
    return out;
  }

  function nodeText(el) {
    try {
      return String((el && (el.innerText || el.textContent)) || '').trim().slice(0, 200);
    } catch (e) {
      return '';
    }
  }

  function rawHref(el) {
    if (!el || !el.getAttribute) return '';
    try {
      return String(el.getAttribute('href') || '').trim();
    } catch (e) {
      return '';
    }
  }

  /** sandbox: 保持原样（页面自己会解析），其余相对路径补成绝对 URL 才能交给下载 API */
  function absoluteHref(raw) {
    if (!raw || /^sandbox:/i.test(raw)) return raw;
    try {
      return new URL(raw, location.href).href;
    } catch (e) {
      return raw;
    }
  }

  function inExcludedArea(el) {
    if (!el || !el.closest) return false;
    try {
      return (
        !!el.closest('[data-message-author-role="user"]') ||
        !!el.closest('nav, aside, header, footer, [data-testid*="sidebar" i], [data-testid*="nav" i]')
      );
    } catch (e) {
      return false;
    }
  }

  function afterAnchor(anchor, el) {
    if (!anchor || !document.contains || !document.contains(anchor)) return true;
    if (!el || !el.compareDocumentPosition || !anchor.compareDocumentPosition) return true;
    try {
      // FOLLOWING 表示 el 排在 anchor 之后 —— 用来排除用户上传的参考图和旧回复
      return !!(anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    } catch (e) {
      return true;
    }
  }

  /** 链接置信度：3=明确的图片文件，2=文件服务链接且带图片语义，1=「查看原图」类文字线索，0=不是产物 */
  function linkScore(href, text) {
    const h = String(href || '').trim();
    const t = String(text || '').trim();
    if (!h || BAD_SCHEME_RE.test(h)) return 0;
    const ext = CGR.FILE_EXT_RE.test(h);
    const fileUrl = CGR.FILE_URL_RE.test(h);
    const imageWord = CGR.IMAGE_WORD_RE.test(t) || CGR.IMAGE_WORD_RE.test(h);
    const viewHint = CGR.VIEW_IMAGE_RE.test(t);
    if (ext && (fileUrl || imageWord || viewHint || /^https?:\/\//i.test(h))) return 3;
    if (fileUrl && (imageWord || viewHint)) return 2;
    if (/^sandbox:/i.test(h) && imageWord) return 2;
    if (viewHint && imageWord && /^https?:\/\//i.test(h)) return 1;
    return 0;
  }

  function cardSig(text, href) {
    return `card:${normSrc(String(text || '').slice(0, 120))}:${normSrc(href || '')}`;
  }

  /** 卡片自身的 href，或它内部第一个链接的 href；快照与差集必须用同一套算法 */
  function cardHref(el) {
    let href = rawHref(el);
    if (href || !el.querySelector) return href;
    try {
      const inner = el.querySelector('a[href]');
      if (inner) href = rawHref(inner);
    } catch (e) {
      /* ignore */
    }
    return href;
  }

  /** 新出现的图片文件链接 */
  function linkArtifacts(before, afterNode, loose) {
    const out = [];
    const seen = new Set();
    const threshold = loose ? 1 : 2;
    for (const el of allNodes(CGR.SEL.artifactLink)) {
      const raw = rawHref(el);
      if (!raw || BAD_SCHEME_RE.test(raw)) continue;
      const score = linkScore(raw, nodeText(el));
      if (score < threshold) continue;
      if (inExcludedArea(el)) continue;
      const src = absoluteHref(raw);
      const key = normSrc(src);
      if (seen.has(key)) continue;
      if (before && before.links && before.links.has(key)) continue;
      if (!afterAnchor(afterNode, el)) continue;
      seen.add(key);
      out.push({
        _el: el,
        src,
        raw,
        w: 0,
        h: 0,
        kind: 'link',
        score,
        label: nodeText(el).slice(0, 100),
        known: isImageSrc(src),
        loose: score < 2,
        // 非 http(s) 的链接（sandbox:）下载 API 用不了，需要页面内取流或点击
        click: !/^https?:\/\//i.test(src)
      });
    }
    return out;
  }

  /** 新出现的文件附件卡片（截图里「static_linked_list_4k.png / 图像」那种） */
  function cardArtifacts(before, afterNode, loose) {
    const out = [];
    const seen = new Set();
    for (const el of allNodes(CGR.SEL.fileCard)) {
      const text = nodeText(el);
      if (!FILE_NAME_RE.test(text) || !CGR.IMAGE_WORD_RE.test(text)) continue;
      if (inExcludedArea(el)) continue;
      const href = cardHref(el);
      const sig = cardSig(text, href);
      if (seen.has(sig)) continue;
      if (before && before.cards && before.cards.has(sig)) continue;
      if (!afterAnchor(afterNode, el)) continue;
      seen.add(sig);
      const src = href ? absoluteHref(href) : `card:${encodeURIComponent(text.slice(0, 80))}`;
      out.push({
        _el: el,
        src,
        raw: href,
        w: 0,
        h: 0,
        kind: 'card',
        score: 2,
        label: text.slice(0, 100),
        known: isImageSrc(src),
        loose: !!loose,
        click: true
      });
    }
    return out;
  }

  /** 找可点击的附件目标，供页面内「点一下让 ChatGPT 自己下载」兜底使用。
   * 优先带 download / 指向图片文件的元素，避开「查看原图」这类会开新标签的外链。 */
  function findClickTarget(src, label) {
    const links = allNodes(CGR.SEL.artifactLink);
    const wanted = normSrc(src || '');
    if (wanted && wanted.indexOf('card:') !== 0) {
      const exact = links.find((el) => normSrc(absoluteHref(rawHref(el))) === wanted);
      if (exact && !inExcludedArea(exact) && !/(查看|view|open)/i.test(nodeText(exact))) return exact;
    }

    const cards = allNodes(CGR.SEL.fileCard).filter((el) => {
      const t = nodeText(el);
      return FILE_NAME_RE.test(t) && CGR.IMAGE_WORD_RE.test(t) && !inExcludedArea(el);
    });
    const byLabel = label ? cards.find((el) => nodeText(el).indexOf(label) >= 0) : null;
    const withDownload = cards.find((el) => el.hasAttribute && el.hasAttribute('download'));
    const withFileHref = cards.find((el) => CGR.FILE_EXT_RE.test(rawHref(el)) || CGR.FILE_URL_RE.test(rawHref(el)));
    const chosen = byLabel || withDownload || withFileHref || cards[0];
    if (!chosen) return null;
    if (chosen.tagName === 'A' || chosen.tagName === 'BUTTON' || (chosen.getAttribute && chosen.getAttribute('role') === 'button')) {
      return chosen;
    }
    try {
      const inner = chosen.querySelector && chosen.querySelector('a[href], button, [role="button"]');
      if (inner) return inner;
    } catch (e) {
      /* ignore */
    }
    return chosen;
  }

  /** 快照：记录整个 document 的 img / 链接 / 附件卡片签名，而不是只记「白名单命中的图」。 */
  function snapshot() {
    const imgs = new Set();
    for (const img of document.querySelectorAll('img')) {
      const src = img.currentSrc || img.src || '';
      if (src) imgs.add(normSrc(src));
    }
    const links = new Set();
    for (const el of allNodes(CGR.SEL.artifactLink)) {
      const raw = rawHref(el);
      if (raw) links.add(normSrc(absoluteHref(raw)));
    }
    const cards = new Set();
    for (const el of allNodes(CGR.SEL.fileCard)) {
      const text = nodeText(el);
      if (FILE_NAME_RE.test(text)) cards.add(cardSig(text, cardHref(el)));
    }
    return {
      imgs,
      links,
      cards,
      textLen: bodyTextLen(),
      msgCount: allMsgCount(),
      assistantCount: assistantCount(),
      convId: CGR.getConvId()
    };
  }

  /** 与快照做差集，返回新出现的内嵌图候选。扫描整个 document，
   * 靠尺寸/位置规则降噪；afterNode 非空时只接受出现在该节点之后的图片。 */
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
      if (!afterAnchor(afterNode, img)) continue;
      seen.add(key);
      out.push({
        _el: img,
        src,
        w: img.naturalWidth || 0,
        h: img.naturalHeight || 0,
        loose: !!loose,
        known: isImageSrc(src)
      });
    }
    return out;
  }

  /* ---------------- 页面顺序 ----------------
   * 「第一张」必须是页面上最靠前的那张，而不是评分最高或先加载完的那张。
   * 收集时按类型分批（img / link / card），只有 DOM 节点之间的先后关系能跨类型排序。 */

  // compareDocumentPosition 是反对称的：a 在 b 前时
  // a.compareDocumentPosition(b) 带 FOLLOWING(4)，b.compareDocumentPosition(a) 带 PRECEDING(2)。
  // 节点已脱离文档、或测试桩两个方向都返回同一个值时判为「不可比较」，保持原收集顺序。
  const DOC_FOLLOWING = 4;
  const DOC_PRECEDING = 2;

  function domCmp(elA, elB) {
    if (!elA || !elB || elA === elB ||
        typeof elA.compareDocumentPosition !== 'function' ||
        typeof elB.compareDocumentPosition !== 'function') return 0;
    let m1, m2;
    try {
      m1 = elA.compareDocumentPosition(elB);
      m2 = elB.compareDocumentPosition(elA);
    } catch (e) {
      return 0;
    }
    if ((m1 & DOC_FOLLOWING) && (m2 & DOC_PRECEDING)) return -1; // elA 在前
    if ((m1 & DOC_PRECEDING) && (m2 & DOC_FOLLOWING)) return 1;  // elA 在后
    return 0;
  }

  /** 按页面真实出现顺序排好，并写下 order（0 = 第一张）。
   * 只比较产物节点，n 通常不超过 10，不必遍历整个 document。 */
  function sortByDom(list) {
    const arr = (list || []).slice();
    arr.sort((x, y) => domCmp(x && x._el, y && y._el));
    arr.forEach((f, i) => {
      if (f && typeof f === 'object') f.order = i;
    });
    return arr;
  }

  /** 产物要经 chrome.runtime.sendMessage 的结构化克隆，DOM 节点不能带过去。
   * 上报前的最后一步必须调用它，否则整条 OUTCOME 会发送失败、任务被退回重发。 */
  function cleanArtifacts(list) {
    return (list || []).map((f) => {
      if (!f || typeof f !== 'object') return f;
      const out = {};
      for (const k of Object.keys(f)) {
        if (k !== '_el') out[k] = f[k];
      }
      return out;
    });
  }

  /** 统一产物入口：内嵌图 / 图片链接 / 文件卡片，按页面顺序输出。判定层只认这个。 */
  function freshArtifacts(before, afterNode, loose) {
    const out = [];
    const seen = new Set();
    const push = (a) => {
      if (!a || !a.src) return;
      const key = a.kind + ':' + normSrc(a.src);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(a);
    };
    for (const f of freshImages(before, afterNode, loose)) push(Object.assign({}, f, { kind: 'img', click: false }));
    for (const f of linkArtifacts(before, afterNode, loose)) push(f);
    for (const f of cardArtifacts(before, afterNode, loose)) push(f);
    return sortByDom(out);
  }

  /** 消息节点选择器改版时，仍要靠「新链接 / 新附件卡片 / 正文变长」判断回复已到达 */
  function artifactSignal(before) {
    if (!before) return false;
    const partial = { links: before.links, cards: before.cards };
    if (linkArtifacts(partial, null, false).length) return true;
    if (cardArtifacts(partial, null, false).length) return true;
    return before.textLen != null && bodyTextLen() - before.textLen > 80;
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
    const links = linkArtifacts(before, null, true);
    const cards = cardArtifacts(before, null, true);
    const artifacts = freshArtifacts(before, null, true);
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
      freshLinks: links.length,
      fileCards: cards.length,
      artifactHits: artifacts.length,
      samples: freshAll
        .slice(0, 4)
        .map((f) => `${f.nw}x${f.nh} ${f.rw}px ${short(f.src)}`)
        .concat(links.slice(0, 3).map((f) => `链接 s${f.score} ${short(f.src)} ${f.label}`))
        .concat(cards.slice(0, 3).map((f) => `附件 ${f.label} ${short(f.src)}`))
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
    bodyTextLen,
    hasLoginWall,
    isImageSrc,
    normSrc,
    isLikelyGenerated,
    linkScore,
    snapshot,
    freshImages,
    freshArtifacts,
    sortByDom,
    cleanArtifacts,
    domCmp,
    linkArtifacts,
    cardArtifacts,
    findClickTarget,
    artifactSignal,
    diagnose,
    detectLimit,
    detectPageError
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
