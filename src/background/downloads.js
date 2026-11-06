/* 下载：三级降级链 + 下载状态事件推进。
 * A: 直接把签名 https URL 交给 chrome.downloads（浏览器自动带 cookie）
 * B: 由内容脚本在页面内 fetch（同源，必然带 cookie）→ base64 分片回传 → data URL 下载
 * 下载完成事件必须由 service-worker.js 顶层注册后转发进来。 */
(function (root) {
  const CGR = root.CGR;
  const store = root.CGR_STORE;

  const dlIndex = new Map(); // downloadId -> index
  const chunkBuf = new Map(); // index -> { parts:[], total:0 }
  // 「点击附件卡片让 ChatGPT 自己下载」时，页面触发的下载不属于扩展，
  // 需要在 onDeterminingFilename 里改文件名并登记归属，否则文件会落到默认下载目录。
  const PENDING_KEY = 'dl:pending-click';
  let pendingClick = null;

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

  /** 预备接管「页面点击产生的下载」。filename 按批次目录/命名模板算好。 */
  async function armClick(item, ext, art) {
    const filename = assignFilename(item, ext);
    pendingClick = {
      batchId: item.batchId,
      index: item.index,
      filename,
      label: (art && art.label) || '',
      src: (art && art.src) || (item.image && item.image.src) || '',
      expiresAt: Date.now() + 45000
    };
    try {
      await chrome.storage.local.set({ [PENDING_KEY]: pendingClick });
    } catch (e) {
      /* storage 不可用时内存表仍然有效 */
    }
    item.status = CGR.STATUS.DOWNLOADING;
    item.lease = null;
    await store.putItem(item.batchId, item);
    store.addLog('info', `#${item.index + 1} 文件附件产物，已准备下载并归位到 ${filename}`, { index: item.index });
    return pendingClick;
  }

  /** 由 service-worker 顶层同步注册。扩展自己发起的下载不干预。 */
  function onDeterminingFilename(d, suggest) {
    const p = pendingClick;
    if (!p || Date.now() > p.expiresAt || (d && d.byExtensionId)) {
      try {
        suggest();
      } catch (e) {
        /* ignore */
      }
      return;
    }
    try {
      suggest({ filename: p.filename, conflictAction: 'uniquify' });
    } catch (e) {
      return;
    }
    pendingClick = null;
    const rec = { index: p.index, batchId: p.batchId };
    // suggest 已经调用过了，这里的任何副作用都不能把异常抛回监听器，
    // 否则 service-worker 的兜底会再调一次 suggest()。
    try {
      dlIndex.set(d.id, rec);
      store.addLog('info', `#${p.index + 1} 页面附件下载已归位 → ${p.filename}`, { index: p.index });
      chrome.storage.local.remove(PENDING_KEY);
      chrome.storage.local.set({ [`dl:${d.id}`]: rec });
    } catch (e) {
      /* ignore */
    }
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
    try {
      await chrome.storage.local.remove(PENDING_KEY);
    } catch (e) {
      /* ignore */
    }
    const item = store.getItem(p.batchId, p.index);
    if (item && item.status === CGR.STATUS.DOWNLOADING) {
      item.status = CGR.STATUS.NEEDS_REVIEW;
      item.error = { code: 'ATTACHMENT_CLICK_TIMEOUT', message: '页面上已有图片文件，但点击附件后没有产生下载；请手动保存或检查下载权限' };
      await store.putItem(p.batchId, item);
      store.addLog('error', `#${p.index + 1} 附件点击未产生下载，已标记待确认（不重发提示词）`, { index: p.index });
    }
  }

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

  async function startUrlDownload(item, url, ext) {
    const filename = assignFilename(item, ext);
    item.status = CGR.STATUS.DOWNLOADING;
    item.lease = null; // 进入下载阶段后不再需要租约，避免被过期清扫误判
    item.download = { tier: 'A', state: 'pending', filename, url: url.slice(0, 2048) };

    let dlId;
    try {
      dlId = await chrome.downloads.download({
        url,
        filename,
        conflictAction: 'uniquify',
        saveAs: false
      });
    } catch (e) {
      dlId = null;
      store.addLog('warn', `直链下载调用失败，转页面内取流：${e && e.message}`, { index: item.index });
    }

    if (dlId == null) {
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

  /** 让内容脚本在页面内取流（blob: / sandbox: / 直链 401 / 附件卡片） */
  async function requestFallback(item, reason, opts) {
    const detail = opts || {};
    const img = item.image || {};
    const tabId = item.tabId || (item.lease && item.lease.tabId);
    const needClick = !!(detail.click || img.click || img.artifactKind === 'card');
    if (needClick && !pendingClick) {
      await armClick(item, artifactExt({ src: img.src, label: detail.label || img.label }), img);
    }
    item.download = Object.assign({}, item.download, { tier: 'B', state: 'fetching' });
    await store.putItem(item.batchId, item);
    store.addLog('warn', `#${item.index + 1} 转用页面内取流（${reason}）${needClick ? '，取流失败将点击附件下载' : ''}`);
    if (!tabId) {
      item.status = CGR.STATUS.NEEDS_REVIEW;
      item.error = { code: 'NO_TAB_FOR_FALLBACK', message: '图片已生成但无法找到取流标签页' };
      await store.putItem(item.batchId, item);
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
        click: needClick
      });
    } catch (e) {
      item.status = CGR.STATUS.NEEDS_REVIEW;
      item.error = { code: 'FALLBACK_UNREACHABLE', message: '取流标签页已失联，图片未保存' };
      store.addLog('error', `#${item.index + 1} 图片已生成但取流失败：${String((e && e.message) || e)}`, { index: item.index });
      await store.putItem(item.batchId, item);
    }
  }

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
    const b64 = buf.parts.join('');
    const type = mime || 'image/png';
    const dataUrl = `data:${type};base64,${b64}`;
    const item = store.getItem(bid, index);
    if (!item) return null;
    item.image = Object.assign({}, item.image, { kind: 'data', src: '' });
    return startDataDownload(item, dataUrl, ext || CGR.extFromUrl('', type));
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

    if (state === 'complete') {
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
    requestFallback,
    onDeterminingFilename,
    checkPendingClicks,
    pushChunk,
    commitChunks,
    handleChanged,
    clearCache() {
      dlIndex.clear();
      pendingClick = null;
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
