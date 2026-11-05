/* 下载：三级降级链 + 下载状态事件推进。
 * A: 直接把签名 https URL 交给 chrome.downloads（浏览器自动带 cookie）
 * B: 由内容脚本在页面内 fetch（同源，必然带 cookie）→ base64 分片回传 → data URL 下载
 * 下载完成事件必须由 service-worker.js 顶层注册后转发进来。 */
(function (root) {
  const CGR = root.CGR;
  const store = root.CGR_STORE;

  const dlIndex = new Map(); // downloadId -> index
  const chunkBuf = new Map(); // index -> { parts:[], total:0 }

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
    await store.putItem(item.batchId, item);
    return item;
  }

  /** 让内容脚本在页面内取流（blob: 或直链 401 时） */
  async function requestFallback(item, reason) {
    const tabId = item.tabId || (item.lease && item.lease.tabId);
    item.download = Object.assign({}, item.download, { tier: 'B', state: 'fetching' });
    await store.putItem(item.batchId, item);
    store.addLog('warn', `#${item.index + 1} 转用页面内取流（${reason}）`);
    if (!tabId) {
      item.status = CGR.STATUS.NEEDS_REVIEW;
      item.error = { code: 'NO_TAB_FOR_FALLBACK', message: '图片已生成但无法找到取流标签页' };
      await store.putItem(item.batchId, item);
      return;
    }
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'FETCH_IMAGE', index: item.index, batchId: item.batchId, src: item.image && item.image.src });
    } catch (e) {
      item.status = CGR.STATUS.NEEDS_REVIEW;
      item.error = { code: 'FALLBACK_UNREACHABLE', message: '取流标签页已失联，图片未保存' };
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
    requestFallback,
    pushChunk,
    commitChunks,
    handleChanged,
    clearCache() {
      dlIndex.clear();
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
