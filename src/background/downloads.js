/* 下载：三级降级链 + 下载状态事件推进。
 * A: 直接把签名 https URL 交给 chrome.downloads（浏览器自动带 cookie）
 * B: 由内容脚本在页面内 fetch（同源，必然带 cookie）→ base64 分片回传 → data URL 下载
 * C: 页面点击附件卡片产生的下载，由 onDeterminingFilename 改到批次目录
 *
 * ★ 关键前提（Chromium issue 579563）：只要任意一个扩展注册了
 *   chrome.downloads.onDeterminingFilename，Chrome 就会忽略 downloads.download()
 *   传进去的 filename —— 注意是「任意一个」，包括本扩展自己注册的监听器。
 *   所以不能只靠 filename 参数：所有下载都必须先在「下载意图表」里登记目标路径，
 *   再由监听器同步 suggest({filename}) 把名字和子目录真正写回去。
 *   监听器若裸调 suggest()，文件就会变成默认「下载.png」落到下载根目录。
 *
 * 下载完成事件必须由 service-worker.js 顶层注册后转发进来。 */
(function (root) {
  const CGR = root.CGR;
  const store = root.CGR_STORE;

  const dlIndex = new Map(); // downloadId -> { index, batchId }
  const chunkBuf = new Map(); // index -> { parts:[], total:0 }
  const PENDING_KEY = 'dl:pending-click';
  const INTENTS_KEY = 'dl:intents';
  const CLICK_TTL = 45000;
  const INTENT_TTL = 300000;
  const ASYNC_SUGGEST_MS = 2500;

  let pendingClick = null;
  let intents = []; // [{ key, filename, url, origin, index, batchId, expiresAt }]
  let intentSeq = 0;
  let restored = false;

  function ownExtensionId() {
    try {
      return (chrome.runtime && chrome.runtime.id) || '';
    } catch (e) {
      return '';
    }
  }

  function nowLive(list) {
    return (list || []).filter((x) => x && x.filename && x.expiresAt > Date.now());
  }

  /* ---------------- 目标路径 ---------------- */

  function buildPath(item, ext) {
    const cfg = store.getCfg();
    const batch = store.getBatch(item.batchId);
    const dir = store.resolveFolder(batch);
    const slug = CGR.slug(item.prompt, 40);
    const name = CGR.renderName(cfg.template || '{index:03}_{slug}', {
      index: item.index + 1,
      slug,
      ext,
      batch: (batch && batch.name) || 'batch'
    });
    return `${dir}/${name}.${ext}`;
  }

  function assignFilename(item, ext) {
    if (!item.filename) item.filename = buildPath(item, ext);
    return item.filename;
  }

  /** 附件的扩展名优先取卡片上的文件名（static_linked_list_4k.png），URL 没扩展名时也能对 */
  function artifactExt(art) {
    const m = String((art && art.label) || '').match(/\.(png|jpe?g|webp|gif|avif)(?:[?#\s]|$)/i);
    if (m) return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    return CGR.extFromUrl((art && (art.src || art.raw)) || '');
  }

  /* ---------------- 下载意图表（内存 + storage 双写，防 SW 冷启动） ---------------- */

  async function persistIntents() {
    intents = nowLive(intents).slice(-12);
    try {
      if (intents.length) await chrome.storage.local.set({ [INTENTS_KEY]: intents });
      else await chrome.storage.local.remove(INTENTS_KEY);
    } catch (e) {
      /* storage 不可用时内存表仍然有效 */
    }
  }

  async function armIntent(item, filename, url, origin) {
    const key = `i${Date.now().toString(36)}-${++intentSeq}`;
    const rec = {
      key,
      filename,
      url: String(url || '').slice(0, 2048),
      origin: origin === 'click' ? 'click' : 'extension',
      index: item.index,
      batchId: item.batchId,
      expiresAt: Date.now() + (origin === 'click' ? CLICK_TTL : INTENT_TTL)
    };
    intents.push(rec);
    await persistIntents();
    return rec;
  }

  async function dropIntent(key) {
    if (!key) return;
    intents = intents.filter((x) => x.key !== key);
    await persistIntents();
  }

  /** SW 冷启动时把还没落地的下载意图读回内存；boot() 里调用一次即可。 */
  async function restore() {
    try {
      const rec = await chrome.storage.local.get([INTENTS_KEY, PENDING_KEY]);
      if (!intents.length && Array.isArray(rec[INTENTS_KEY])) intents = nowLive(rec[INTENTS_KEY]);
      const p = rec[PENDING_KEY];
      if (!pendingClick && p && p.filename && p.expiresAt > Date.now()) pendingClick = p;
    } catch (e) {
      /* ignore */
    }
    restored = true;
  }

  /** 清掉内存辅助状态。true = 模拟 SW 冷启动（保留 storage，仅供测试）。 */
  function clearCache(restart) {
    dlIndex.clear();
    chunkBuf.clear();
    pendingClick = null;
    if (restart === true) {
      intents = [];
      restored = false;
    }
  }

  /** 一键重置 / 出厂设置：连 storage 里的意图一起清，避免旧路径劫持之后的下载。 */
  function purge() {
    clearCache(true);
    try {
      const r = chrome.storage.local.remove([PENDING_KEY, INTENTS_KEY]);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (e) {
      /* ignore */
    }
  }

  /* ---------------- 文件名判定事件 ---------------- */

  function classify(d) {
    const by = d && d.byExtensionId;
    if (!by) return 'page';
    const own = ownExtensionId();
    return own && by === own ? 'own' : 'other';
  }

  function pickIntent(d, list, pageInitiated) {
    const live = nowLive(list);
    if (!live.length) return null;
    const url = String((d && d.url) || '');
    const exact = live.find((x) => x.url && url && x.url === url);
    if (exact) return exact;
    const fuzzy = live.find((x) => x.url && url && (url.startsWith(x.url) || x.url.startsWith(url)));
    if (fuzzy) return fuzzy;
    const preferred = live.filter((x) => (pageInitiated ? x.origin === 'click' : x.origin !== 'click'));
    return preferred[0] || live[0];
  }

  function toHit(rec, click) {
    if (!rec) return null;
    return {
      filename: rec.filename,
      index: rec.index,
      batchId: rec.batchId,
      click: !!click,
      intentKey: rec.intentKey || rec.key || ''
    };
  }

  function resolveMemory(d, kind) {
    if (kind === 'page') {
      const p = pendingClick;
      if (p && p.filename && Date.now() <= p.expiresAt) {
        return { filename: p.filename, index: p.index, batchId: p.batchId, click: true, intentKey: p.intentKey || '' };
      }
    }
    return toHit(pickIntent(d, intents, kind === 'page'), false);
  }

  async function resolveStorage(d, kind) {
    let rec = {};
    try {
      rec = await chrome.storage.local.get([PENDING_KEY, INTENTS_KEY]);
    } catch (e) {
      return null;
    }
    if (Array.isArray(rec[INTENTS_KEY])) intents = nowLive(rec[INTENTS_KEY]);
    if (kind === 'page') {
      const p = rec[PENDING_KEY];
      if (p && p.filename && Date.now() <= p.expiresAt) {
        pendingClick = p;
        return { filename: p.filename, index: p.index, batchId: p.batchId, click: true, intentKey: p.intentKey || '' };
      }
    }
    return toHit(pickIntent(d, intents, kind === 'page'), false);
  }

  function consume(hit, d) {
    // suggest 已经调用过了，这里的任何副作用都不能把异常抛回监听器，
    // 否则 service-worker 的兜底会再调一次 suggest()。
    // 归属登记必须同步完成：监听器返回后紧接着的 onChanged / 测试断言都要能立刻读到。
    const rec = { index: hit.index, batchId: hit.batchId };
    try {
      dlIndex.set(d.id, rec);
      const p = chrome.storage.local.set({ [`dl:${d.id}`]: rec });
      if (p && typeof p.catch === 'function') p.catch(() => {});
      store.addLog('info', `#${hit.index + 1} ${hit.click ? '页面附件下载' : '下载'}已归位 → ${hit.filename}`, {
        index: hit.index
      });
    } catch (e) {
      /* ignore */
    }
    if (hit.click) {
      pendingClick = null;
      try {
        const p = chrome.storage.local.remove(PENDING_KEY);
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (e) {
        /* ignore */
      }
    }
    dropIntent(hit.intentKey).catch(() => {});
  }

  /**
   * 由 service-worker 顶层同步注册。
   * 返回值：false = 已同步 suggest；true = 正在异步读 storage 后再 suggest（监听器必须返回 true）。
   * 注意：自己发起的下载也必须 suggest 目标路径，不能因为 byExtensionId 就跳过。
   */
  function onDeterminingFilename(d, suggest) {
    let called = false;
    const once = (arg) => {
      if (called) return;
      called = true;
      try {
        if (arg) suggest(arg);
        else suggest();
      } catch (e) {
        /* ignore */
      }
    };

    const kind = classify(d);
    if (kind === 'other') {
      once();
      return false;
    }

    let hit = null;
    try {
      hit = resolveMemory(d, kind);
    } catch (e) {
      hit = null;
    }

    // 内存没有、且 boot() 已经确认过 storage 也没东西：与本次任务无关，同步放行。
    if (!hit && restored && !pendingClick && !intents.length) {
      once();
      return false;
    }

    if (!hit) {
      // SW 可能为这个下载事件刚刚冷启动，内存表是空的：异步从 storage 恢复。
      let timer = null;
      const finish = (h) => {
        if (called) return;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (!h) {
          once();
          return;
        }
        once({ filename: h.filename, conflictAction: 'uniquify' });
        consume(h, d);
      };
      timer = setTimeout(() => finish(null), ASYNC_SUGGEST_MS);
      resolveStorage(d, kind).then(finish, () => finish(null));
      return true;
    }

    once({ filename: hit.filename, conflictAction: 'uniquify' });
    consume(hit, d);
    return false;
  }

  /* ---------------- 附件点击（C 级） ---------------- */

  /** 预备接管「页面点击产生的下载」。filename 按批次目录/命名模板算好。 */
  async function armClick(item, ext, art) {
    const filename = assignFilename(item, ext);
    const src = (art && art.src) || (item.image && item.image.src) || '';
    const intent = await armIntent(item, filename, src, 'click');
    pendingClick = {
      batchId: item.batchId,
      index: item.index,
      filename,
      intentKey: intent.key,
      label: (art && art.label) || '',
      src,
      expiresAt: Date.now() + CLICK_TTL
    };
    try {
      await chrome.storage.local.set({ [PENDING_KEY]: pendingClick });
    } catch (e) {
      /* storage 不可用时内存表仍然有效 */
    }
    item.status = CGR.STATUS.DOWNLOADING;
    item.lease = null;
    await store.putItem(item.batchId, item);
    store.addLog('info', `#${item.index + 1} 已登记下载归位目标 → ${filename}`, { index: item.index });
    return pendingClick;
  }

  /** 大图走页面 blob 点击时，先由后台把目标路径登记好再让页面点，
   * 否则 onDeterminingFilename 没有 pendingClick，文件又会变成默认名落到下载根目录。 */
  async function armBlobClick(bid, index, ext) {
    const item = store.getItem(bid, index);
    if (!item) return { ok: false, error: 'item-not-found' };
    const pending = await armClick(item, ext || artifactExt(item.image || {}), item.image || {});
    item.download = Object.assign({}, item.download, {
      tier: 'B', state: 'clicking', filename: pending.filename,
      startedAt: Date.now(), tabId: item.tabId != null ? item.tabId : null
    });
    await store.putItem(bid, item);
    return { ok: true, filename: pending.filename };
  }

  /** 点击后没产生下载时别把任务永远挂在「下载中」。由后台周期检查调用。 */
  async function checkPendingClicks() {
    let p = pendingClick;
    if (!p) {
      try {
        const rec = await chrome.storage.local.get(PENDING_KEY);
        p = rec[PENDING_KEY];
      } catch (e) {
        return;
      }
    }
    if (!p || Date.now() <= p.expiresAt) return;
    pendingClick = null;
    await dropIntent(p.intentKey);
    try {
      await chrome.storage.local.remove(PENDING_KEY);
    } catch (e) {
      /* ignore */
    }
    const item = store.getItem(p.batchId, p.index);
    if (item && item.status === CGR.STATUS.DOWNLOADING) {
      item.status = CGR.STATUS.NEEDS_REVIEW;
      const tier = item.download && item.download.tier;
      const isSite = tier === 'D';
      item.error = {
        code: isSite ? 'SITE_DOWNLOAD_CLICK_TIMEOUT' : 'ATTACHMENT_CLICK_TIMEOUT',
        message: isSite
          ? '站点全尺寸下载按钮点了没产生下载；请手动保存或检查下载权限'
          : '页面上已有图片文件，但点击附件后没有产生下载；请手动保存或检查下载权限'
      };
      await store.putItem(p.batchId, item);
      store.addLog('error', `#${p.index + 1} ${isSite ? '全尺寸下载按钮' : '附件点击'}未产生下载，已标记待确认（不重发提示词）`, { index: p.index });
    }
  }

  /* ---------------- A / B / C 三级入口 ---------------- */

  /**
   * 文件类产物的下载入口：
   *  - http(s) 直链 → A（chrome.downloads），失败自动降级 B
   *  - sandbox: / 卡片 / 需要点击 → 页面内取流，取流失败再模拟点击附件，
   *    由 onDeterminingFilename 把页面下载改到批次目录。
   */
  async function startFileDownload(item, art, tabId) {
    const ext = artifactExt(art);
    const src = (art && art.src) || '';
    if (/^https?:\/\//i.test(src) && !art.click) {
      await startUrlDownload(item, src, ext);
      return item;
    }
    await armClick(item, ext, art);
    if (tabId != null) item.tabId = tabId;
    item.download = Object.assign({}, item.download, { tier: 'C', state: 'pending', filename: item.filename });
    await store.putItem(item.batchId, item);
    await requestFallback(item, 'file-artifact', { label: art.label, click: true });
    return item;
  }

  /** D 级：点站点自带的「下载全尺寸图片」按钮（Gemini）。
   * 页面里显示的是 blob: 预览，取流只能拿到缩图；按钮产生的下载由
   * onDeterminingFilename 用 pendingClick 里的目标文件名归位到批次目录。
   * 和 C 级一样有 45 秒看门狗：点了没下载就标「待确认」，绝不重发生图。 */
  async function startSiteDownload(item, art, tabId) {
    const ext = artifactExt(art) || 'png';
    const pending = await armClick(item, ext, art);
    item.download = Object.assign({}, item.download, {
      tier: 'D', state: 'pending', filename: pending.filename, siteDownload: true
    });
    await store.putItem(item.batchId, item);
    if (tabId == null) {
      item.status = CGR.STATUS.NEEDS_REVIEW;
      item.error = { code: 'NO_TAB_FOR_SITE_DOWNLOAD', message: '图片已生成但找不到执行标签页，请手动保存' };
      await store.putItem(item.batchId, item);
      return item;
    }
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: CGR.MSG.CLICK_SITE_DOWNLOAD,
        index: item.index,
        batchId: item.batchId,
        src: (art && art.src) || '',
        label: (art && (art.downloadLabel || art.label)) || '',
        filename: pending.filename
      });
      store.addLog('info', `#${item.index + 1} 已请求${CGR.siteLabel ? CGR.siteLabel('gemini') : '站点'}全尺寸下载 → ${pending.filename}`, { index: item.index });
    } catch (e) {
      item.status = CGR.STATUS.NEEDS_REVIEW;
      item.error = { code: 'SITE_DOWNLOAD_UNREACHABLE', message: '全尺寸下载按钮无法触发，图片已生成请手动保存' };
      store.addLog('error', `#${item.index + 1} 站点下载按钮触发失败：${String((e && e.message) || e)}`, { index: item.index });
      await store.putItem(item.batchId, item);
    }
    return item;
  }

  async function startUrlDownload(item, url, ext) {
    const filename = assignFilename(item, ext);
    const intent = await armIntent(item, filename, url, 'extension');
    item.status = CGR.STATUS.DOWNLOADING;
    // 只清租约（DOWNLOADING 不该被 lease 过期清扫误判），绝不能清 tabId：
    // A 级直链被服务端拒绝时，降级取流必须还能找到当初那个页面。
    item.lease = null;
    item.download = {
      tier: 'A', state: 'pending', filename,
      url: String(url).slice(0, 2048),
      tabId: item.tabId != null ? item.tabId : null,
      startedAt: Date.now()
    };

    let dlId;
    try {
      dlId = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
    } catch (e) {
      dlId = null;
      store.addLog('warn', `直链下载调用失败，转页面内取流：${e && e.message}`, { index: item.index });
    }

    if (dlId == null) {
      await dropIntent(intent.key);
      await requestFallback(item, 'download-api-error');
      return item;
    }

    dlIndex.set(dlId, { index: item.index, batchId: item.batchId });
    await chrome.storage.local.set({ [`dl:${dlId}`]: { index: item.index, batchId: item.batchId } });
    item.download.id = dlId;
    store.addLog('info', `#${item.index + 1} 已发起下载（直链 A，id=${dlId}）→ ${filename}`, { index: item.index });
    await store.putItem(item.batchId, item);
    return item;
  }

  async function startDataDownload(item, dataUrl, ext) {
    const filename = assignFilename(item, ext);
    const intent = await armIntent(item, filename, dataUrl, 'extension');
    item.status = CGR.STATUS.DOWNLOADING;
    item.lease = null;
    item.download = Object.assign({}, item.download, { tier: 'B', state: 'pending', filename });

    let dlId;
    try {
      dlId = await chrome.downloads.download({
        url: dataUrl,
        filename,
        conflictAction: 'uniquify',
        saveAs: false
      });
    } catch (e) {
      dlId = null;
      store.addLog('error', `data URL 下载失败：${e && e.message}`, { index: item.index });
    }

    if (dlId == null) {
      await dropIntent(intent.key);
      item.status = CGR.STATUS.NEEDS_REVIEW;
      item.error = { code: 'DOWNLOAD_FAILED', message: '图片已生成但下载失败' };
      await store.putItem(item.batchId, item);
      return item;
    }

    dlIndex.set(dlId, { index: item.index, batchId: item.batchId });
    await chrome.storage.local.set({ [`dl:${dlId}`]: { index: item.index, batchId: item.batchId } });
    item.download.id = dlId;
    store.addLog('info', `#${item.index + 1} 已发起下载（数据 B，id=${dlId}）→ ${filename}`, { index: item.index });
    await store.putItem(item.batchId, item);
    return item;
  }

  /** 找执行页：A 级降级时租约已被清掉，必须从 item / download / runtime 三处兜底。
   * 以前只认 item.tabId，而 A 级分支从来不写它 —— 直链一旦被拒，降级必然
   * NO_TAB_FOR_FALLBACK，页面上明明有图却判「下载失败」。 */
  function resolveTabId(item) {
    if (item.tabId != null) return item.tabId;
    if (item.lease && item.lease.tabId != null) return item.lease.tabId;
    if (item.download && item.download.tabId != null) return item.download.tabId;
    const rt = typeof store.getRuntime === 'function' ? store.getRuntime() : null;
    const ids = Object.entries((rt && rt.activeTabs) || {})
      .filter(([, v]) => v && v.batchId === item.batchId && !v.stale)
      .map(([k]) => Number(k));
    return ids.length ? ids[0] : null;
  }

  /** 让内容脚本在页面内取流（blob: / sandbox: / 直链 401 / 附件卡片） */
  async function requestFallback(item, reason, opts) {
    const detail = opts || {};
    const img = item.image || {};
    const tabId = resolveTabId(item);
    const needClick = !!(detail.click || img.click || img.artifactKind === 'card');
    if (needClick && !pendingClick) {
      await armClick(item, artifactExt({ src: img.src, label: detail.label || img.label }), img);
    }
    item.tabId = tabId;
    item.download = Object.assign({}, item.download, {
      tier: 'B', state: 'fetching', tabId, startedAt: Date.now()
    });
    await store.putItem(item.batchId, item);
    store.addLog('warn', `#${item.index + 1} 转用页面内取流（${reason}）${needClick ? '，取流失败将点击附件下载' : ''}`);
    if (tabId == null) {
      item.status = CGR.STATUS.NEEDS_REVIEW;
      item.error = {
        code: 'NO_TAB_FOR_FALLBACK',
        message: '图片已生成但找不到可保存的执行页；请回到该标签页手动保存，本条不会重发提示词'
      };
      await store.putItem(item.batchId, item);
      store.addLog('error', `#${item.index + 1} 找不到执行页，图片仍在页面上，可手动保存`);
      return;
    }
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'FETCH_IMAGE',
        index: item.index,
        batchId: item.batchId,
        src: img.src,
        label: detail.label || img.label || '',
        kind: img.artifactKind || 'img',
        filename: item.filename || '',
        click: needClick
      });
    } catch (e) {
      item.status = CGR.STATUS.NEEDS_REVIEW;
      item.error = { code: 'FALLBACK_UNREACHABLE', message: '取流标签页已失联，图片未保存' };
      store.addLog('error', `#${item.index + 1} 图片已生成但取流失败：${String((e && e.message) || e)}`, { index: item.index });
      await store.putItem(item.batchId, item);
    }
  }

  /* ---------------- 分片与下载完成事件 ---------------- */

  function chunkKey(bid, index) {
    return `${bid}:${index}`;
  }

  function pushChunk(bid, index, seq, total, data) {
    const key = chunkKey(bid, index);
    let buf = chunkBuf.get(key);
    if (!buf || buf.total !== total) {
      buf = { parts: new Array(total).fill(''), total, received: 0 };
      chunkBuf.set(key, buf);
    }
    if (buf.parts[seq] == null || buf.parts[seq] === '') {
      buf.parts[seq] = data;
      buf.received += 1;
    }
    return buf;
  }

  async function commitChunks(bid, index, mime, ext) {
    const key = chunkKey(bid, index);
    const buf = chunkBuf.get(key);
    chunkBuf.delete(key);
    if (!buf) return null;
    // 分片经 sendMessage 逐条回传，SW 冷启动/消息超时都可能丢一片。
    // 以前缺片也照样 join 出去，结果是一个「下载成功」但打不开的损坏文件。
    const intact = buf.total > 0 && buf.received === buf.total &&
      buf.parts.every((p) => typeof p === 'string' && p.length > 0);
    const item = store.getItem(bid, index);
    if (!intact) {
      store.addLog('error', `#${index + 1} 图片分片不完整（${buf.received}/${buf.total}），已放弃本次下载，避免保存损坏文件`);
      if (item) {
        item.status = CGR.STATUS.NEEDS_REVIEW;
        item.download = Object.assign({}, item.download, { state: 'incomplete' });
        item.error = {
          code: 'DL_CHUNK_INCOMPLETE',
          message: '图片数据回传不完整，未保存损坏文件；图片仍在页面上，请手动保存，本条不会重发提示词'
        };
        await store.putItem(bid, item);
      }
      return null;
    }
    const b64 = buf.parts.join('');
    const type = mime || 'image/png';
    const dataUrl = `data:${type};base64,${b64}`;
    if (!item) return null;
    item.image = Object.assign({}, item.image, { kind: 'data', src: '' });
    return startDataDownload(item, dataUrl, ext || CGR.extFromUrl('', type));
  }

  /** 页面侧明确报告「取流失败」时立刻收敛，不必等看门狗 */
  async function failFetch(bid, index, reason) {
    const item = store.getItem(bid, index);
    if (!item || item.status === CGR.STATUS.DONE) return false;
    chunkBuf.delete(chunkKey(bid, index));
    item.status = CGR.STATUS.NEEDS_REVIEW;
    item.download = Object.assign({}, item.download, { state: 'failed' });
    item.error = {
      code: 'FETCH_FAILED',
      message: `图片已生成但页面内取流失败（${String(reason || 'unknown').slice(0, 60)}）；请在该标签页手动保存，本条不会重发提示词`
    };
    await store.putItem(bid, item);
    store.addLog('error', `#${index + 1} 页面内取流失败（${String(reason || 'unknown').slice(0, 60)}），图片仍在页面上，可手动保存`);
    return true;
  }

  /** DOWNLOADING 阶段刻意没有租约，sweepExpired 管不到；取流失败/丢分片时
   * 不能让任务永远挂在 ACTIVE 上，否则整批队列都被这一条拖死。 */
  async function checkPendingFetches() {
    const ttl = CGR.LIMITS.fetchTimeoutMs || 60000;
    const now = Date.now();
    for (const b of store.listBatches()) {
      for (const item of store.getItems(b.id)) {
        if (item.status !== CGR.STATUS.DOWNLOADING) continue;
        const d = item.download || {};
        if (d.state !== 'fetching' && d.state !== 'clicking') continue;
        if (!d.startedAt || now - d.startedAt < ttl) continue;
        chunkBuf.delete(chunkKey(b.id, item.index));
        item.status = CGR.STATUS.NEEDS_REVIEW;
        item.download = Object.assign({}, d, { state: 'timeout' });
        item.error = {
          code: 'FETCH_TIMEOUT',
          message: '图片已生成但保存超时，请在该标签页手动保存；本条不会重发提示词'
        };
        await store.putItem(b.id, item);
        store.addLog('error', `#${item.index + 1} 保存环节超时（${Math.round(ttl / 1000)} 秒无结果），已标记待确认，队列继续下一条`);
      }
    }
  }

  /** 下载一旦有终态，清掉同条目的点击意图，免得 45 秒看门狗再补一条误报 */
  async function clearPendingClickFor(bid, index) {
    if (!pendingClick || pendingClick.batchId !== bid || pendingClick.index !== index) return;
    const key = pendingClick.intentKey;
    pendingClick = null;
    try {
      await chrome.storage.local.remove(PENDING_KEY);
    } catch (e) {
      /* ignore */
    }
    await dropIntent(key);
  }

  /** 下载完成/中断事件。必须在 withLock 内执行 */
  async function handleChanged(delta) {
    const state = delta.state && delta.state.current;
    if (state !== 'complete' && state !== 'interrupted') return;

    const id = delta.id;
    // storage 里的映射是权威的（删除条目后会重排索引），内存表只做兜底
    const rec = await chrome.storage.local.get(`dl:${id}`);
    const val = rec[`dl:${id}`];
    let index = val && val.index != null ? val.index : null;
    let bid = val && val.batchId ? val.batchId : null;
    if (index == null && dlIndex.has(id)) {
      const mem = dlIndex.get(id);
      index = mem.index;
      bid = mem.batchId;
    }
    if (index == null || !bid) return;

    const item = store.getItem(bid, index);
    if (!item) return;

    await chrome.storage.local.remove(`dl:${id}`);
    dlIndex.delete(id);
    await clearPendingClickFor(bid, index);

    if (state === 'complete') {
      // 落盘路径自检：Chrome 若又忽略 filename（例如装了别的下载管理扩展），
      // 这里立刻在日志里说出来，不再让用户只看到「下载.png」却不知道原因。
      const actual = delta.filename && delta.filename.current;
      if (actual && item.filename && !String(actual).replace(/\\/g, '/').endsWith(item.filename)) {
        store.addLog('warn', `#${index + 1} 实际落盘路径与设定不一致：${actual}（期望 ${item.filename}）`, {
          index
        });
      }
      item.status = CGR.STATUS.DONE;
      item.download = Object.assign({}, item.download, { state: 'complete' });
      item.error = null;
      item.ts = Object.assign({}, item.ts, { doneAt: Date.now() });
      await store.putItem(bid, item);
      const b = store.getBatch(bid);
      if (b) {
        b.stats = Object.assign({}, b.stats, { done: ((b.stats && b.stats.done) || 0) + 1 });
        await store.putBatch(b);
      }
      store.addLog('info', `#${index + 1} 已保存：${item.filename}`);
    } else {
      const err = (delta.error && delta.error.current) || 'INTERRUPTED';
      if (item.download && item.download.tier === 'A') {
        store.addLog('warn', `#${index + 1} 直链下载失败（${err}），转页面内取流`);
        await requestFallback(item, err);
      } else {
        item.status = CGR.STATUS.NEEDS_REVIEW;
        item.download = Object.assign({}, item.download, { state: 'interrupted' });
        item.error = { code: 'DOWNLOAD_INTERRUPTED', message: `下载失败：${err}` };
        await store.putItem(bid, item);
        const b = store.getBatch(bid);
        if (b) {
          b.stats = Object.assign({}, b.stats, { needsReview: ((b.stats && b.stats.needsReview) || 0) + 1 });
          await store.putBatch(b);
        }
        store.addLog('error', `#${index + 1} 下载中断：${err}`);
      }
    }
  }

  root.CGR_DL = {
    buildPath,
    startUrlDownload,
    startDataDownload,
    startFileDownload,
    startSiteDownload,
    requestFallback,
    armBlobClick,
    failFetch,
    onDeterminingFilename,
    checkPendingClicks,
    checkPendingFetches,
    restore,
    pushChunk,
    commitChunks,
    handleChanged,
    clearCache,
    purge
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
