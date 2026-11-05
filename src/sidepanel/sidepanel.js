(function () {
  const CGR = window.CGR;
  const $ = (id) => document.getElementById(id);

  let view = null;
  let tickTimer = 0;
  let listSignature = '';
  let advSignature = '';
  let batchSig = '';
  let batchDirty = false;
  let lastBatchId = '';

  const ACTIVE_STATUS = ['claimed', 'sending', 'generating', 'downloading'];
  const isActiveStatus = (s) => ACTIVE_STATUS.includes(s);

  /* 多选：按队列索引记录，删除后索引会前移，每次渲染都校验 */
  const selected = new Set();

  /* 高级页待提交的参考图 */
  let pendingRefs = [];
  const MAX_REFS = 4;

  const cur = () => (view && view.current) || null;
  const curId = () => (view && view.selectedId) || '';

  /* ---------------- 通信 ---------------- */

  function send(cmd, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ cmd, payload: payload || {} }, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, error: 'no-response' });
        });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  let toastTimer = 0;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function armConfirm(btn, onConfirm) {
    if (btn.dataset.armed === '1') {
      btn.dataset.armed = '';
      btn.textContent = btn.dataset.restore || btn.textContent;
      onConfirm();
      return true;
    }
    btn.dataset.armed = '1';
    btn.dataset.restore = btn.textContent;
    btn.textContent = '再点一次确认';
    setTimeout(() => {
      if (btn.dataset.armed === '1') {
        btn.dataset.armed = '';
        btn.textContent = btn.dataset.restore || btn.textContent;
      }
    }, 3500);
    return false;
  }

  /* ---------------- 渲染 ---------------- */

  const PILL_CLASS = {
    running: 'running',
    finished: 'running',
    paused: 'paused',
    limit_waiting: 'paused',
    error: 'error',
    idle: ''
  };

  function renderHeader(v) {
    const c = v.current;
    const pill = $('statusPill');
    const status = (c && c.status) || 'idle';
    pill.className = 'status-pill ' + (PILL_CLASS[status] || '');
    let label = CGR.GLOBAL_LABEL[status] || status;
    if (status === 'limit_waiting' && c.limitUntil > Date.now()) {
      label = `限额冷却 ${Math.max(0, Math.ceil((c.limitUntil - Date.now()) / 60000))} 分钟`;
    }
    if (status === 'error' && c.lastError) label = '异常中断';
    pill.textContent = label;
    pill.title = (c && c.lastError) || '';

    const running = (v.batches || []).filter((b) => b.status === 'running').length;
    if (!c) {
      $('hdrSub').textContent = '还没有批次';
    } else {
      $('hdrSub').textContent = `${c.name} · ${c.counts.total} 条${running > 1 ? ` · ${running} 个批次运行中` : ''}`;
    }
  }

  function renderBatchBar(v) {
    const list = v.batches || [];
    const sel = $('batchSelect');
    const sig = list.map((b) => `${b.id}:${b.name}:${b.count}:${b.status}`).join('|');
    if (sig !== batchSig) {
      batchSig = sig;
      sel.textContent = '';
      for (const b of list) {
        const o = document.createElement('option');
        o.value = b.id;
        const mark = b.status === 'running' ? '▶ ' : b.status === 'limit_waiting' ? '⏸ ' : '';
        o.textContent = `${mark}${b.name}（${b.count}）`;
        sel.append(o);
      }
      if (!list.length) {
        const o = document.createElement('option');
        o.value = '';
        o.textContent = '（无批次，点右侧新建）';
        sel.append(o);
      }
    }
    sel.value = v.selectedId || '';
    $('btnDeleteBatch').disabled = !list.length;
  }

  function renderBatchFields(v) {
    const c = v.current;
    if (!c) {
      $('batchNameInput').value = '';
      $('batchFolderInput').value = '';
      $('batchNameInput').disabled = true;
      $('batchFolderInput').disabled = true;
      $('btnSaveBatch').disabled = true;
      return;
    }
    $('batchNameInput').disabled = false;
    $('batchFolderInput').disabled = false;
    $('btnSaveBatch').disabled = false;

    if (c.id !== lastBatchId) {
      lastBatchId = c.id;
      batchDirty = false;
    }
    if (!batchDirty) {
      $('batchNameInput').value = c.name || '';
      $('batchFolderInput').value = c.folder || '';
      $('batchFolderInput').placeholder = `留空=基础目录/${c.name || '批次名'}`;
    }
  }

  function renderProgress(v) {
    const c = (v.current && v.current.counts) || { total: 0 };
    const processed = (c.done || 0) + (c.failed || 0) + (c.needs_review || 0) + (c.skipped || 0);
    const total = c.total || 0;
    const pct = total ? Math.min(100, Math.round((processed / total) * 100)) : 0;
    $('progressBar').style.width = pct + '%';
    $('progressText').textContent = `${processed} / ${total}`;

    const chips = [
      ['待生成', c.pending || 0],
      ['进行中', c.active || 0],
      ['完成', c.done || 0],
      ['失败', c.failed || 0],
      ['待确认', c.needs_review || 0],
      ['跳过', c.skipped || 0]
    ];
    const box = $('chips');
    box.textContent = '';
    for (const [name, val] of chips) {
      const d = document.createElement('span');
      d.className = 'chip';
      const b = document.createElement('b');
      b.textContent = String(val);
      d.append(name + ' ', b);
      box.append(d);
    }
  }

  function badgeClass(status) {
    if (isActiveStatus(status)) return 'active';
    if (status === 'done') return 'done';
    if (status === 'failed') return 'failed';
    if (status === 'needs_review') return 'needs_review';
    if (status === 'skipped') return 'skipped';
    return 'pending';
  }

  function buildItem(it, opts) {
    const withCheckbox = !opts || opts.checkbox !== false;
    const row = document.createElement('div');
    row.className = 'item';

    const top = document.createElement('div');
    top.className = 'item-top';

    const active = isActiveStatus(it.s);
    if (withCheckbox) {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'rowchk';
      box.disabled = active;
      box.checked = selected.has(it.i);
      box.title = active ? '正在执行，不能删除' : '选中后可批量删除';
      box.addEventListener('change', () => {
        if (box.checked) selected.add(it.i);
        else selected.delete(it.i);
        updateSelBar();
      });
      top.append(box);
    }

    const idx = document.createElement('div');
    idx.className = 'idx';
    idx.textContent = '#' + (it.i + 1);

    const prompt = document.createElement('div');
    prompt.className = 'prompt';
    prompt.textContent = it.p || '';
    prompt.title = it.p || '';

    const badge = document.createElement('span');
    badge.className = 'badge ' + badgeClass(it.s);
    badge.textContent = (CGR.STATUS_LABEL[it.s] || it.s) + (it.a ? ` ${it.a}` : '');

    top.append(idx, prompt, badge);

    if (it.r > 0) {
      const ref = document.createElement('span');
      ref.className = 'ref-badge';
      ref.textContent = `图 ${it.r}`;
      ref.title = `带 ${it.r} 张参考图`;
      top.append(ref);
    }

    const meta = document.createElement('div');
    meta.className = 'item-meta';

    const file = document.createElement('span');
    file.className = 'file';
    file.textContent = it.f || (it.e ? it.e : '—');
    file.title = it.f || '';
    meta.append(file);

    const call = (label, cls, fn) => {
      const b = document.createElement('button');
      b.className = 'mini ' + (cls || '');
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    };

    const bid = curId();

    if (it.s === 'needs_review' || it.s === 'failed') {
      meta.append(
        call('重试', '', async () => {
          const r = await send(CGR.CMD.RESET_ITEM, { batchId: bid, index: it.i });
          toast(r.ok ? '已重新加入队列' : r.error || '操作失败');
        })
      );
    }
    if (it.s === 'pending') {
      meta.append(
        call('跑这条', '', async () => {
          const r = await send(CGR.CMD.RUN_ONE, { batchId: bid, index: it.i });
          toast(r.ok ? '已开始这一条' : r.error || '操作失败');
        })
      );
    }
    if (!['done', 'skipped'].includes(it.s) && !active) {
      meta.append(
        call('跳过', 'muted', async () => {
          const r = await send(CGR.CMD.SKIP_ITEM, { batchId: bid, index: it.i });
          toast(r.ok ? '已跳过' : r.error || '操作失败');
        })
      );
    }

    row.append(top, meta);
    return row;
  }

  function updateSelBar() {
    const items = (cur() && cur().items) || [];
    const selectable = items.filter((it) => !isActiveStatus(it.s));
    $('selCount').textContent = `已选 ${selected.size} 条 / 共 ${items.length} 条`;
    $('btnDeleteSelected').disabled = selected.size === 0;
    const all = $('chkAll');
    all.disabled = selectable.length === 0;
    all.checked = selectable.length > 0 && selectable.every((it) => selected.has(it.i));
  }

  function renderList(v) {
    const items = (v.current && v.current.items) || [];

    const byIndex = new Map(items.map((x) => [x.i, x]));
    for (const i of Array.from(selected)) {
      const it = byIndex.get(i);
      if (!it || isActiveStatus(it.s)) selected.delete(i);
    }

    const sig = items.map((x) => `${x.i}:${x.s}:${x.a}:${x.f}:${x.e}:${x.r}`).join('|');
    if (sig === listSignature) {
      updateSelBar();
    } else {
      listSignature = sig;
      const box = $('itemList');
      box.textContent = '';
      $('emptyTip').style.display = items.length ? 'none' : 'block';
      const frag = document.createDocumentFragment();
      for (const it of items) frag.append(buildItem(it));
      box.append(frag);
      updateSelBar();
    }

    renderAdvList(items);
  }

  function renderAdvList(items) {
    const adv = items.filter((it) => it.r > 0);
    const sig = adv.map((x) => `${x.i}:${x.s}:${x.a}:${x.f}:${x.e}`).join('|') + '@' + curId();
    if (sig === advSignature) return;
    advSignature = sig;

    const box = $('advList');
    box.textContent = '';
    $('advEmpty').style.display = adv.length ? 'none' : 'block';
    const frag = document.createDocumentFragment();
    for (const it of adv) frag.append(buildItem(it, { checkbox: false }));
    box.append(frag);
  }

  function renderStuck(v) {
    const c = v.current;
    const bar = $('stuckBar');
    if (!c) {
      bar.style.display = 'none';
      return;
    }
    const counts = c.counts || {};
    const base = c.lastClaimAt || c.startedAt || 0;
    const idleFor = base ? Date.now() - base : 0;
    const stuck = c.status === 'running' && !counts.active && counts.pending > 0 && idleFor > 15000;
    bar.style.display = stuck ? 'flex' : 'none';
    if (stuck) {
      $('stuckText').textContent = `批次「${c.name}」已开始 ${Math.round(idleFor / 1000)} 秒但页面还没动静。多数是扩展更新后页面里仍是旧脚本，点「立即修复」即可。`;
    }
  }

  function renderButtons(v) {
    const c = (v.current && v.current.counts) || {};
    const status = (v.current && v.current.status) || 'idle';
    const hasBatch = !!v.current;
    $('btnStart').disabled = !hasBatch || !(c.pending > 0) || ['running', 'paused'].includes(status);
    $('btnPause').textContent = status === 'paused' ? '继续' : '暂停';
    $('btnPause').disabled = !hasBatch || !['running', 'paused', 'limit_waiting'].includes(status);
    $('btnStop').disabled = !hasBatch || !['running', 'paused', 'limit_waiting'].includes(status);
    $('btnClearFinished').disabled = !hasBatch || !((c.done || 0) + (c.failed || 0) + (c.skipped || 0) > 0);
  }

  function renderLogs(v) {
    const box = $('logList');
    const logs = (v.logs || []).slice().reverse();
    box.textContent = '';
    for (const l of logs) {
      const d = document.createElement('div');
      d.className = 'log ' + (l.level || '');
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = new Date(l.t).toLocaleTimeString('zh-CN', { hour12: false });
      d.append(t, document.createTextNode(l.message || ''));
      box.append(d);
    }
  }

  function render(v) {
    view = v;
    renderHeader(v);
    renderBatchBar(v);
    renderBatchFields(v);
    renderProgress(v);
    renderList(v);
    renderButtons(v);
    renderStuck(v);
    renderLogs(v);
    renderPremise(v);
    if (!settingsDirty) fillSettings(v.cfg || CGR.DEFAULTS);
  }

  /* ---------------- 队列：输入 + ＋ ---------------- */

  function afterAdd(res, hintEl, inputEl) {
    if (!res.ok) {
      toast(res.error || '加入失败');
      return false;
    }
    inputEl.value = '';
    inputEl.focus();
    if (hintEl) hintEl.textContent = `已加入，本批次共 ${res.count} 条`;
    return true;
  }

  async function ensureBatchId() {
    if (curId()) return curId();
    const res = await send(CGR.CMD.BATCH_CREATE, { name: '' });
    if (!res.ok) {
      toast(res.error || '新建批次失败');
      return '';
    }
    return res.batch.id;
  }

  async function addSimple() {
    const text = ($('promptInput').value || '').trim();
    if (!text) return toast('先输入提示词');
    const bid = await ensureBatchId();
    if (!bid) return;
    const btn = $('btnAddPrompt');
    btn.disabled = true;
    const res = await send(CGR.CMD.ADD_ITEM, { batchId: bid, prompt: text, refImages: [] });
    btn.disabled = false;
    if (afterAdd(res, $('enqueueHint'), $('promptInput'))) toast('已加入队列');
  }

  async function addAdvanced() {
    const text = ($('advPrompt').value || '').trim();
    if (!text) return toast('先输入提示词');
    const bid = await ensureBatchId();
    if (!bid) return;

    const btn = $('btnAddAdvanced');
    btn.disabled = true;
    const res = await send(CGR.CMD.ADD_ITEM, {
      batchId: bid,
      prompt: text,
      refImages: pendingRefs.map((r) => ({ id: r.id, name: r.name, type: r.type }))
    });
    btn.disabled = false;
    if (afterAdd(res, $('advHint'), $('advPrompt'))) {
      pendingRefs = [];
      renderRefList();
      toast('已加入队列（含参考图）');
    }
  }

  /* ---------------- 参考图 ---------------- */

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(new Error('读取失败'));
      fr.readAsDataURL(file);
    });
  }

  async function compressImage(file) {
    const raw = await fileToDataUrl(file);
    if (file.size < 1.2 * 1024 * 1024) return { dataUrl: raw, type: file.type, name: file.name };

    try {
      const bmp = await createImageBitmap(file);
      const max = 1600;
      const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * scale);
      const h = Math.round(bmp.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
      return { dataUrl, type: 'image/jpeg', name: file.name.replace(/\.[^.]+$/, '') + '.jpg' };
    } catch (e) {
      return { dataUrl: raw, type: file.type, name: file.name };
    }
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const f of files) {
      if (!/^image\//.test(f.type || '')) {
        toast('只支持图片文件');
        continue;
      }
      if (pendingRefs.length >= MAX_REFS) {
        toast(`最多 ${MAX_REFS} 张参考图`);
        break;
      }
      try {
        const img = await compressImage(f);
        const id = 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        await chrome.storage.local.set({
          ['img:' + id]: { id, name: img.name, type: img.type, dataUrl: img.dataUrl, createdAt: Date.now() }
        });
        pendingRefs.push({ id, name: img.name, type: img.type, dataUrl: img.dataUrl });
      } catch (e) {
        toast('图片读取失败');
      }
    }
    $('fileInput').value = '';
    renderRefList();
  }

  /** 从剪贴板里挑出图片文件 */
  function imageFilesFrom(data) {
    const files = [];
    if (data.items) {
      for (const it of data.items) {
        if (it.kind === 'file' && /^image\//.test(it.type || '')) {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
    }
    if (!files.length && data.files) {
      for (const f of data.files) if (/^image\//.test(f.type || '')) files.push(f);
    }
    return files;
  }

  function onPaste(e) {
    const dt = e.clipboardData;
    if (!dt) return;

    const files = imageFilesFrom(dt);
    if (!files.length) return;

    // 同时带文字时不抢：让浏览器按正常文本粘贴处理，避免复制图文时被劫持
    const el = document.activeElement;
    const inText = el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
    if (inText && (dt.getData('text/plain') || '').trim()) return;

    e.preventDefault();
    const advTab = document.querySelector('.tab[data-tab="advanced"]');
    if (advTab && !advTab.classList.contains('active')) advTab.click();
    handleFiles(files);
    toast(`已粘贴 ${files.length} 张图片`);
  }

  function renderRefList() {
    const box = $('refList');
    box.textContent = '';
    pendingRefs.forEach((r, i) => {
      const thumb = document.createElement('div');
      thumb.className = 'ref-thumb';

      const img = document.createElement('img');
      img.src = r.dataUrl;
      img.alt = r.name || '';
      img.title = r.name || '';

      const del = document.createElement('button');
      del.className = 'ref-del';
      del.textContent = '×';
      del.addEventListener('click', () => {
        pendingRefs.splice(i, 1);
        renderRefList();
      });

      thumb.append(img, del);
      box.append(thumb);
    });

    $('refHint').textContent = pendingRefs.length
      ? `已选 ${pendingRefs.length} 张，点 ＋ 加入队列后清空`
      : '可点选、拖拽，或直接 Ctrl+V 粘贴截图';
  }

  /* ---------------- 前提（按批次） ---------------- */

  function renderPremise(v) {
    const c = v.current;
    const list = (c && c.premises) || [];
    const box = $('premiseList');
    box.textContent = '';
    $('premiseEmpty').style.display = list.length ? 'none' : 'block';
    $('premiseScope').textContent = c ? `当前批次：${c.name}` : '当前批次：—';

    list.forEach((text, i) => {
      const row = document.createElement('div');
      row.className = 'premise-item';

      const idx = document.createElement('div');
      idx.className = 'idx';
      idx.textContent = '#P' + (i + 1);

      const t = document.createElement('div');
      t.className = 'txt';
      t.textContent = text;

      const del = document.createElement('button');
      del.className = 'mini muted';
      del.textContent = '删除';
      del.addEventListener('click', () => removePremise(i));

      row.append(idx, t, del);
      box.append(row);
    });

    $('premiseEnabled').checked = c ? c.premiseEnabled !== false : true;
    $('premiseEnabled').disabled = !c;
    $('premiseHint').textContent = `当前 ${list.length} 条`;

    const note = $('premiseNote');
    if (c && c.premiseEnabled !== false && list.length) {
      note.style.display = 'block';
      note.textContent = `本批次已启用 ${list.length} 条前提：每条新对话会先发送并等模型回复，再开始生图`;
    } else {
      note.style.display = 'none';
    }
  }

  async function savePremises(list, silent) {
    const bid = curId();
    if (!bid) return false;
    const res = await send(CGR.CMD.BATCH_UPDATE, {
      id: bid,
      patch: { premises: list, premiseEnabled: $('premiseEnabled').checked }
    });
    if (!res.ok) {
      toast(res.error || '保存失败');
      return false;
    }
    if (!silent) toast(list.length ? `已保存 ${list.length} 条前提` : '前提已清空');
    return true;
  }

  async function addPremise() {
    const text = ($('premiseInput').value || '').trim();
    if (!text) return toast('先输入前提内容');
    const list = ((cur() && cur().premises) || []).slice();
    list.push(text);
    if (await savePremises(list, true)) {
      $('premiseInput').value = '';
      toast(`已添加第 ${list.length} 条前提`);
    }
  }

  async function removePremise(i) {
    const list = ((cur() && cur().premises) || []).slice();
    list.splice(i, 1);
    await savePremises(list, true);
    toast('已删除一条前提');
  }

  /* ---------------- 批次 ---------------- */

  async function newBatch() {
    const res = await send(CGR.CMD.BATCH_CREATE, { name: '' });
    if (res.ok) {
      batchDirty = false;
      toast(`已新建「${res.batch.name}」，可在上方改名`);
    } else {
      toast(res.error || '新建失败');
    }
  }

  async function saveBatch() {
    const bid = curId();
    if (!bid) return;
    const name = $('batchNameInput').value.trim();
    const folder = $('batchFolderInput').value.trim();
    const res = await send(CGR.CMD.BATCH_UPDATE, { id: bid, patch: { name, folder } });
    if (res.ok) {
      batchDirty = false;
      $('batchHint').textContent = '已保存';
      setTimeout(() => ($('batchHint').textContent = ''), 1800);
      toast('批次设置已保存');
    } else {
      toast(res.error || '保存失败');
    }
  }

  /* ---------------- 设置（全局） ---------------- */

  let settingsDirty = false;

  function fillSettings(cfg) {
    $('mode').value = cfg.mode || 'new-chat-each';
    $('concurrency').value = cfg.concurrency || 1;
    $('folder').value = cfg.folder || 'chatgpt-images';
    $('template').value = cfg.template || '{index:03}_{slug}';
    $('minDelayMs').value = Math.round((cfg.minDelayMs || 3000) / 1000);
    $('maxDelayMs').value = Math.round((cfg.maxDelayMs || 7000) / 1000);
    $('timeoutMs').value = Math.round((cfg.timeoutMs || 300000) / 1000);
    $('maxAttempts').value = cfg.maxAttempts == null ? 2 : cfg.maxAttempts;
    $('onNoImage').value = cfg.onNoImage || 'retry';
    $('limitCooldownMin').value = cfg.limitCooldownMin || 60;
    toggleConcurrency();
    settingsDirty = false;
  }

  function toggleConcurrency() {
    const on = $('mode').value === 'parallel';
    $('concurrencyField').style.opacity = on ? '1' : '0.45';
    $('concurrency').disabled = !on;
  }

  function collectSettings() {
    const minSec = Math.max(1, Number($('minDelayMs').value) || 3);
    const maxSec = Math.max(minSec, Number($('maxDelayMs').value) || 7);
    return {
      mode: $('mode').value,
      concurrency: Math.max(1, Math.min(3, Number($('concurrency').value) || 1)),
      folder: $('folder').value.trim() || 'chatgpt-images',
      template: $('template').value.trim() || '{index:03}_{slug}',
      minDelayMs: minSec * 1000,
      maxDelayMs: maxSec * 1000,
      timeoutMs: Math.max(60, Number($('timeoutMs').value) || 300) * 1000,
      maxAttempts: Math.max(0, Math.min(5, Number($('maxAttempts').value) || 0)),
      onNoImage: $('onNoImage').value,
      limitCooldownMin: Math.max(1, Number($('limitCooldownMin').value) || 60)
    };
  }

  /* ---------------- 自检 ---------------- */

  function renderReport(report) {
    const box = $('selfcheckReport');
    box.textContent = '';
    const passed = report.filter((r) => r.ok).length;
    const head = document.createElement('div');
    head.className = 'hint';
    head.textContent = `自检结果：${passed} / ${report.length} 项通过`;
    box.append(head);

    for (const r of report) {
      const row = document.createElement('div');
      row.className = 'rep-row';
      const mark = document.createElement('div');
      mark.className = 'rep-mark ' + (r.ok ? 'ok' : 'bad');
      mark.textContent = r.ok ? '✓' : '✕';
      const label = document.createElement('div');
      label.className = 'rep-label';
      label.textContent = r.label;
      const detail = document.createElement('div');
      detail.className = 'rep-detail';
      detail.textContent = r.detail;
      row.append(mark, label, detail);
      if (!r.ok && r.hint) {
        const hint = document.createElement('div');
        hint.className = 'rep-hint';
        hint.textContent = '→ ' + r.hint;
        row.append(hint);
      }
      box.append(row);
    }
  }

  /* ---------------- 事件 ---------------- */

  function bind() {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        document.querySelectorAll('.pane').forEach((p) => p.classList.remove('active'));
        tab.classList.add('active');
        $('pane-' + tab.dataset.tab).classList.add('active');
      });
    });

    // 批次切换
    $('batchSelect').addEventListener('change', async (e) => {
      batchDirty = false;
      selected.clear();
      listSignature = '';
      advSignature = '';
      const res = await send(CGR.CMD.BATCH_SELECT, { id: e.target.value });
      if (!res.ok) toast(res.error || '切换失败');
    });
    $('btnNewBatch').addEventListener('click', newBatch);
    $('btnDeleteBatch').addEventListener('click', () => {
      const c = cur();
      if (!c) return;
      armConfirm($('btnDeleteBatch'), async () => {
        const res = await send(CGR.CMD.BATCH_DELETE, { id: c.id });
        if (res.ok) {
          selected.clear();
          listSignature = '';
          batchDirty = false;
          toast('批次已删除');
        } else {
          toast(res.error || '删除失败');
        }
      });
      toast(`将删除「${c.name}」及其全部提示词，再点一次确认`);
    });

    ['batchNameInput', 'batchFolderInput'].forEach((id) => {
      $(id).addEventListener('input', () => {
        batchDirty = true;
      });
    });
    $('btnSaveBatch').addEventListener('click', saveBatch);

    // 加入队列
    $('btnAddPrompt').addEventListener('click', addSimple);
    $('promptInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        addSimple();
      }
    });

    $('btnAddAdvanced').addEventListener('click', addAdvanced);
    $('advPrompt').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        addAdvanced();
      }
    });

    $('btnPickImages').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (e) => handleFiles(e.target.files));

    // 直接 Ctrl+V 粘贴截图/图片
    document.addEventListener('paste', onPaste);

    const advPane = $('pane-advanced');
    ['dragover', 'drop'].forEach((evt) => {
      advPane.addEventListener(evt, (e) => {
        e.preventDefault();
        if (evt === 'drop' && e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
      });
    });

    // 前提
    $('btnAddPremise').addEventListener('click', addPremise);
    $('premiseInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        addPremise();
      }
    });
    $('premiseEnabled').addEventListener('change', async () => {
      const list = ((cur() && cur().premises) || []).slice();
      await savePremises(list, true);
      toast($('premiseEnabled').checked ? '本批次前提已启用' : '本批次前提已停用');
    });
    $('premiseNote').addEventListener('click', () => {
      const tab = document.querySelector('.tab[data-tab="premise"]');
      if (tab) tab.click();
    });

    // 运行控制
    $('btnStart').addEventListener('click', async () => {
      const bid = curId();
      if (!bid) return toast('请先新建批次');
      const res = await send(CGR.CMD.START, { batchId: bid });
      if (!res.ok) toast(res.error || '启动失败');
      else if (res.warning) toast(res.warning);
      else toast('已开始，就在当前这个 ChatGPT 标签页里跑');
    });

    $('btnPause').addEventListener('click', async () => {
      const c = cur();
      if (!c) return;
      const res = await send(c.status === 'paused' ? CGR.CMD.RESUME : CGR.CMD.PAUSE, { batchId: c.id });
      if (!res.ok) toast(res.error || '操作失败');
    });

    $('btnStop').addEventListener('click', () => {
      const c = cur();
      if (!c) return;
      armConfirm($('btnStop'), async () => {
        const res = await send(CGR.CMD.STOP, { batchId: c.id });
        if (!res.ok) toast(res.error || '操作失败');
        else toast('已停止');
      });
    });

    $('btnClearFinished').addEventListener('click', async () => {
      const c = cur();
      if (!c) return;
      const res = await send(CGR.CMD.CLEAR_FINISHED, { batchId: c.id });
      toast(res.ok ? `已清理 ${res.removed || 0} 条` : res.error || '操作失败');
    });

    $('btnFixTabs').addEventListener('click', async () => {
      const btn = $('btnFixTabs');
      btn.disabled = true;
      btn.textContent = '修复中…';
      const res = await send(CGR.CMD.FIX_TABS, { batchId: curId() });
      btn.disabled = false;
      btn.textContent = '立即修复';
      if (res.ok) toast(`已重新接管 ${res.fixed.length} 个标签页，任务接着跑`);
      else toast(res.error || '修复失败，请手动刷新该批次的窗口');
    });

    // 多选
    $('chkAll').addEventListener('change', () => {
      const items = (cur() && cur().items) || [];
      if ($('chkAll').checked) {
        for (const it of items) if (!isActiveStatus(it.s)) selected.add(it.i);
      } else {
        selected.clear();
      }
      listSignature = '';
      renderList(view || { current: null });
    });

    $('btnDeleteSelected').addEventListener('click', () => {
      if (!selected.size) return;
      const n = selected.size;
      const bid = curId();
      armConfirm($('btnDeleteSelected'), async () => {
        const res = await send(CGR.CMD.DELETE_ITEMS, { batchId: bid, indexes: Array.from(selected) });
        if (res.ok) {
          selected.clear();
          listSignature = '';
          toast(`已删除 ${res.deleted} 条${res.skipped ? `，${res.skipped} 条正在执行已保留` : ''}`);
        } else {
          toast(res.error || '删除失败');
        }
      });
      toast(`将删除 ${n} 条，再点一次确认`);
    });

    // 设置
    ['mode', 'concurrency', 'folder', 'template', 'minDelayMs', 'maxDelayMs', 'timeoutMs', 'maxAttempts', 'onNoImage', 'limitCooldownMin'].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('input', () => {
        settingsDirty = true;
        if (id === 'mode') toggleConcurrency();
      });
      el.addEventListener('change', () => {
        settingsDirty = true;
        if (id === 'mode') toggleConcurrency();
      });
    });

    $('btnSaveCfg').addEventListener('click', async () => {
      const res = await send(CGR.CMD.SET_CONFIG, collectSettings());
      if (res.ok) {
        settingsDirty = false;
        $('cfgHint').textContent = '已保存';
        toast('设置已保存');
        setTimeout(() => ($('cfgHint').textContent = ''), 1800);
      } else {
        toast(res.error || '保存失败');
      }
    });

    $('btnResetCfg').addEventListener('click', () => {
      fillSettings(CGR.DEFAULTS);
      $('cfgHint').textContent = '已恢复默认值，记得点「保存设置」';
    });

    $('btnSelfcheck').addEventListener('click', async () => {
      $('btnSelfcheck').disabled = true;
      $('btnSelfcheck').textContent = '检测中…';
      const res = await send(CGR.CMD.SELFCHECK, {});
      $('btnSelfcheck').disabled = false;
      $('btnSelfcheck').textContent = '运行自检';
      if (!res.ok) return toast(res.error || '自检失败');
      renderReport(res.report || []);
    });

    $('btnExportLogs').addEventListener('click', async () => {
      const res = await send(CGR.CMD.EXPORT_LOGS, { batchId: curId() });
      if (!res.ok) return toast('导出失败');
      const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cg-batch-diagnose-${Date.now()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('诊断文件已导出');
    });
  }

  /* ---------------- 启动 ---------------- */

  const EMPTY_VIEW = {
    batches: [],
    selectedId: '',
    current: null,
    cfg: CGR.DEFAULTS,
    logs: []
  };

  async function loadView() {
    const data = await chrome.storage.local.get('view');
    render(data.view || EMPTY_VIEW);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.view && changes.view.newValue) {
      render(changes.view.newValue);
    }
  });

  function startTicker() {
    if (tickTimer) return;
    tickTimer = setInterval(() => {
      if (!view) return;
      const c = view.current;
      if (!c) return;
      if (c.status === 'limit_waiting') renderHeader(view);
      if (c.status === 'running') renderStuck(view);
    }, 1000);
  }

  bind();
  renderRefList();
  loadView();
  startTicker();
})();
