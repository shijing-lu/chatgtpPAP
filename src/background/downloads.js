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
    const batch = store.getBatch();
    const folder = CGR.normalizeFolder(cfg.folder);
    const batchName = String(cfg.batchName || batch.name || '').trim();
    const sub = batchName ? CGR.normalizeFolder(batchName, '') : '';
    const slug = CGR.slug(item.prompt, 40);
    const name = CGR.renderName(cfg.template, {
      index: item.index + 1,
      slug,
      ext,
      batch: batchName || 'batch'
    });
    const dir = sub ? `${folder}/${sub}` : folder;
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

    dlIndex.set(dlId, item.index);
    await chrome.storage.local.set({ [`dl:${dlId}`]: { index: item.index } });
    item.download.id = dlId;
    await store.putItem(item);
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
      await store.putItem(item);
      return item;
    }

    dlIndex.set(dlId, item.index);
    await chrome.storage.local.set({ [`dl:${dlId}`]: { index: item.index } });
    item.download.id = dlId;
    await store.putItem(item);
    return item;
  }

  /** 让内容脚本在页面内取流（blob: 或直链 401 时） */
  async function requestFallback(item, reason) {
    const tabId = item.tabId || (item.lease && item.lease.tabId);
    item.download = Object.assign({}, item.download, { tier: 'B', state: 'fetching' });
    await store.putItem(item);
    store.addLog('warn', `#${item.index + 1} 转用页面内取流（${reason}）`);
    if (!tabId) {
      item.status = CGR.STATUS.NEEDS_REVIEW;
      item.error = { code: 'NO_TAB_FOR_FALLBACK', message: '图片已生成但无法找到取流标签页' };
      await store.putItem(item);
      return;
    }
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'FETCH_IMAGE', index: item.index, src: item.image && item.image.src });
    } catch (e) {
      item.status = CGR.STATUS.NEEDS_REVIEW;
      item.error = { code: 'FALLBACK_UNREACHABLE', message: '取流标签页已失联，图片未保存' };
      await store.putItem(item);
    }
  }

  function pushChunk(index, seq, total, data) {
    let buf = chunkBuf.get(index);
    if (!buf || buf.total !== total) {
      buf = { parts: new Array(total).fill(''), total, received: 0 };
      chunkBuf.set(index, buf);
    }
    if (buf.parts[seq] == null || buf.parts[seq] === '') {
      buf.parts[seq] = data;
      buf.received += 1;
    }
    return buf;
  }

  async function commitChunks(index, mime, ext) {
    const buf = chunkBuf.get(index);
    chunkBuf.delete(index);
    if (!buf) return null;
    const b64 = buf.parts.join('');
    const type = mime || 'image/png';
    const dataUrl = `data:${type};base64,${b64}`;
    const item = store.getItem(index);
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
    let index = null;
    const rec = await chrome.storage.local.get(`dl:${id}`);
    const val = rec[`dl:${id}`];
    if (val && val.index != null) index = val.index;
    if (index == null && dlIndex.has(id)) index = dlIndex.get(id);
    if (index == null) return;

    const item = store.getItem(index);
    if (!item) return;

    await chrome.storage.local.remove(`dl:${id}`);
    dlIndex.delete(id);

    if (state === 'complete') {
      item.status = CGR.STATUS.DONE;
      item.download = Object.assign({}, item.download, { state: 'complete' });
      item.error = null;
      item.ts = Object.assign({}, item.ts, { doneAt: Date.now() });
      await store.putItem(item);
      const rt = store.getRuntime();
      await store.setRuntime({ stats: Object.assign({}, rt.stats, { done: (rt.stats.done || 0) + 1 }) });
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
        await store.putItem(item);
        const rt = store.getRuntime();
        await store.setRuntime({ stats: Object.assign({}, rt.stats, { needsReview: (rt.stats.needsReview || 0) + 1 }) });
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
