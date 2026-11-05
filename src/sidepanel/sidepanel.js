(function () {
  const CGR = window.CGR;
  const $ = (id) => document.getElementById(id);

  let view = null;
  let tickTimer = 0;
  let listSignature = '';
  let advSignature = '';

  const ACTIVE_STATUS = ['claimed', 'sending', 'generating', 'downloading'];
  function isActiveStatus(s) {
    return ACTIVE_STATUS.includes(s);
  }

  /* 多选：按队列索引记录，删除后索引会前移，因此每次渲染都要校验一遍 */
  const selected = new Set();

  /* 高级页待提交的参考图（已写入 storage，内容脚本可直接取） */
  let pendingRefs = [];
  const MAX_REFS = 4;

  function updateSelBar() {
    const items = (view && view.items) || [];
    const selectable = items.filter((it) => !isActiveStatus(it.s));
    const count = selected.size;
    $('selCount').textContent = `已选 ${count} 条 / 共 ${items.length} 条`;
    $('btnDeleteSelected').disabled = count === 0;
    const all = $('chkAll');
    all.disabled = selectable.length === 0;
    all.checked = selectable.length > 0 && selectable.every((it) => selected.has(it.i));
  }

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

  /** 两步确认：不用 confirm()，因为侧边栏里的模态框可能不显示 */
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
    const pill = $('statusPill');
    const status = v.status || 'idle';
    pill.className = 'status-pill ' + (PILL_CLASS[status] || '');
    let label = CGR.GLOBAL_LABEL[status] || status;
    if (status === 'limit_waiting' && v.limitUntil > Date.now()) {
      const left = Math.max(0, Math.ceil((v.limitUntil - Date.now()) / 60000));
      label = `限额冷却 ${left} 分钟`;
    }
    if (status === 'error' && v.lastError) label = '异常中断';
    pill.textContent = label;
    pill.title = v.lastError || '';

    $('batchName').textContent = v.batch && v.batch.name ? `${v.batch.name} · ${v.batch.count} 条` : '尚未建立批次';
  }

  function renderProgress(v) {
    const c = v.counts || { total: 0 };
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
    if (['claimed', 'sending', 'generating', 'downloading'].includes(status)) return 'active';
    if (status === 'done') return 'done';
    if (status === 'failed') return 'failed';
    if (status === 'needs_review') return 'needs_review';
    if (status === 'skipped') return 'skipped';
    return 'pending';
  }

  function statusLabel(status) {
    return CGR.STATUS_LABEL[status] || status;
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
    badge.textContent = statusLabel(it.s) + (it.a ? ` ${it.a}` : '');

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

    if (it.s === 'needs_review' || it.s === 'failed') {
      meta.append(
        call('重试', '', async () => {
          const r = await send(CGR.CMD.RESET_ITEM, { index: it.i });
          toast(r.ok ? '已重新加入队列' : r.error || '操作失败');
        })
      );
    }
    if (it.s === 'pending') {
      meta.append(
        call('跑这条', '', async () => {
          const r = await send(CGR.CMD.RUN_ONE, { index: it.i });
          toast(r.ok ? '已开始这一条' : r.error || '操作失败');
        })
      );
    }
    if (!['done', 'skipped'].includes(it.s) && !isActiveStatus(it.s)) {
      meta.append(
        call('跳过', 'muted', async () => {
          const r = await send(CGR.CMD.SKIP_ITEM, { index: it.i });
          toast(r.ok ? '已跳过' : r.error || '操作失败');
        })
      );
    }

    row.append(top, meta);
    return row;
  }

  function renderList(v) {
    const items = v.items || [];

    // 索引可能因删除而前移，清掉已不存在或已在执行的选中项
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
    const sig = adv.map((x) => `${x.i}:${x.s}:${x.a}:${x.f}:${x.e}`).join('|');
    if (sig === advSignature) return;
    advSignature = sig;

    const box = $('advList');
    box.textContent = '';
    $('advEmpty').style.display = adv.length ? 'none' : 'block';
    const frag = document.createDocumentFragment();
    for (const it of adv) frag.append(buildItem(it, { checkbox: false }));
    box.append(frag);
  }

  /** 「说在跑但页面没动静」的提示 */
  function renderStuck(v) {
    const c = v.counts || {};
    const status = v.status || 'idle';
    const base = v.lastClaimAt || v.startedAt || 0;
    const idleFor = base ? Date.now() - base : 0;
    const stuck = status === 'running' && !c.active && c.pending > 0 && idleFor > 15000;

    const bar = $('stuckBar');
    bar.style.display = stuck ? 'flex' : 'none';
    if (stuck) {
      $('stuckText').textContent = `已开始 ${Math.round(idleFor / 1000)} 秒，但 ChatGPT 页面还没开始执行。多数是扩展更新后页面里仍是旧脚本，点「立即修复」即可。`;
    }
  }

  function renderButtons(v) {
    const c = v.counts || {};
    const status = v.status || 'idle';
    $('btnStart').disabled = !(c.pending > 0) || ['running', 'paused'].includes(status);
    $('btnPause').textContent = status === 'paused' ? '继续' : '暂停';
    $('btnPause').disabled = !['running', 'paused', 'limit_waiting'].includes(status);
    $('btnStop').disabled = !['running', 'paused', 'limit_waiting'].includes(status);
    $('btnClearFinished').disabled = !((c.done || 0) + (c.failed || 0) + (c.skipped || 0) > 0);
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
    renderProgress(v);
    renderList(v);
    renderButtons(v);
    renderStuck(v);
    renderLogs(v);
    renderPremise(v.cfg || CGR.DEFAULTS);
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
    if (hintEl) hintEl.textContent = `已加入，当前队列 ${res.count == null ? '' : res.count + ' 条'}`;
    return true;
  }

  async function addSimple() {
    const text = ($('promptInput').value || '').trim();
    if (!text) return toast('先输入提示词');
    const btn = $('btnAddPrompt');
    btn.disabled = true;
    const res = await send(CGR.CMD.ADD_ITEM, {
      prompt: text,
      batchName: $('batchNameInput').value.trim(),
      refImages: []
    });
    btn.disabled = false;
    if (afterAdd(res, $('enqueueHint'), $('promptInput'))) toast('已加入队列');
  }

  async function addAdvanced() {
    const text = ($('advPrompt').value || '').trim();
    if (!text) return toast('先输入提示词');
    const btn = $('btnAddAdvanced');
    btn.disabled = true;
    const res = await send(CGR.CMD.ADD_ITEM, {
      prompt: text,
      batchName: $('batchNameInput').value.trim(),
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

  /** 手机照片动辄 8MB，压到 1600px 再存，避免 storage 与消息体积过大 */
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
      del.title = '移除';
      del.addEventListener('click', () => {
        pendingRefs.splice(i, 1);
        renderRefList();
      });

      thumb.append(img, del);
      box.append(thumb);
    });

    $('refHint').textContent = pendingRefs.length
      ? `已选 ${pendingRefs.length} 张，点 ＋ 加入队列后清空`
      : '支持多选，随提示词一起入队';
  }

  /* ---------------- 前提设定 ---------------- */

  let premiseInited = false;
  let premiseSig = '';

  function renderPremiseList(list) {
    const sig = list.join('\u0001');
    if (sig === premiseSig) return;
    premiseSig = sig;

    const box = $('premiseList');
    box.textContent = '';
    $('premiseEmpty').style.display = list.length ? 'none' : 'block';

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
  }

  function renderPremiseNote(cfg) {
    const note = $('premiseNote');
    const n = (cfg.premises || []).length;
    if (cfg.premiseEnabled !== false && n > 0) {
      note.style.display = 'block';
      note.textContent = `已启用 ${n} 条前提：每条新对话会先发送并等模型回复，再开始生图`;
    } else {
      note.style.display = 'none';
    }
  }

  function renderPremise(cfg) {
    if (!premiseInited) {
      premiseInited = true;
      $('premiseEnabled').checked = cfg.premiseEnabled !== false;
    }
    $('premiseHint').textContent = `当前 ${(cfg.premises || []).length} 条`;
    renderPremiseList(cfg.premises || []);
    renderPremiseNote(cfg);
  }

  async function savePremises(list, silent) {
    const res = await send(CGR.CMD.SET_CONFIG, {
      premises: list,
      premiseEnabled: $('premiseEnabled').checked
    });
    if (!res.ok) {
      toast(res.error || '保存失败');
      return false;
    }
    premiseSig = '';
    if (!silent) toast(list.length ? `已保存 ${list.length} 条前提` : '前提已清空');
    return true;
  }

  async function addPremise() {
    const text = ($('premiseInput').value || '').trim();
    if (!text) return toast('先输入前提内容');
    const list = (((view && view.cfg) || {}).premises || []).slice();
    list.push(text);
    const ok = await savePremises(list, true);
    if (ok) {
      $('premiseInput').value = '';
      toast(`已添加第 ${list.length} 条前提`);
    }
  }

  async function removePremise(i) {
    const list = (((view && view.cfg) || {}).premises || []).slice();
    list.splice(i, 1);
    await savePremises(list, true);
    toast('已删除一条前提');
  }

  /* ---------------- 设置 ---------------- */

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

    // 简单队列：＋ 与 Ctrl/⌘+Enter
    $('btnAddPrompt').addEventListener('click', addSimple);
    $('promptInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        addSimple();
      }
    });

    // 高级：＋ 、选图、Ctrl/⌘+Enter
    $('btnAddAdvanced').addEventListener('click', addAdvanced);
    $('advPrompt').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        addAdvanced();
      }
    });

    $('btnPickImages').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (e) => handleFiles(e.target.files));

    // 拖拽图片到高级输入框
    const advPane = $('pane-advanced');
    ['dragover', 'drop'].forEach((evt) => {
      advPane.addEventListener(evt, (e) => {
        e.preventDefault();
        if (evt === 'drop' && e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
      });
    });

    // 前提：＋
    $('btnAddPremise').addEventListener('click', addPremise);
    $('premiseInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        addPremise();
      }
    });
    $('premiseEnabled').addEventListener('change', async () => {
      const list = (((view && view.cfg) || {}).premises || []).slice();
      await savePremises(list, true);
      toast($('premiseEnabled').checked ? '前提已启用' : '前提已停用');
    });
    $('premiseNote').addEventListener('click', () => {
      const tab = document.querySelector('.tab[data-tab="premise"]');
      if (tab) tab.click();
    });

    // 控制按钮
    $('btnStart').addEventListener('click', async () => {
      const res = await send(CGR.CMD.START);
      if (!res.ok) toast(res.error || '启动失败');
      else if (res.warning) toast(res.warning);
      else toast('已开始，请保持 ChatGPT 标签页运行');
    });

    $('btnPause').addEventListener('click', async () => {
      const paused = view && view.status === 'paused';
      const res = await send(paused ? CGR.CMD.RESUME : CGR.CMD.PAUSE);
      if (!res.ok) toast(res.error || '操作失败');
    });

    $('btnStop').addEventListener('click', () => {
      armConfirm($('btnStop'), async () => {
        const res = await send(CGR.CMD.STOP);
        if (!res.ok) toast(res.error || '操作失败');
        else toast('已停止');
      });
    });

    $('btnClearFinished').addEventListener('click', async () => {
      const res = await send(CGR.CMD.CLEAR_FINISHED);
      toast(res.ok ? `已清理 ${res.removed || 0} 条` : res.error || '操作失败');
    });

    $('btnFixTabs').addEventListener('click', async () => {
      const btn = $('btnFixTabs');
      btn.disabled = true;
      btn.textContent = '修复中…';
      const res = await send(CGR.CMD.FIX_TABS);
      btn.disabled = false;
      btn.textContent = '立即修复';
      if (res.ok) toast(`已重新接管 ${res.fixed.length} 个标签页，任务是接着跑的`);
      else toast(res.error || '修复失败，请手动刷新 ChatGPT 页面');
    });

    // 多选
    $('chkAll').addEventListener('change', () => {
      const items = (view && view.items) || [];
      if ($('chkAll').checked) {
        for (const it of items) if (!isActiveStatus(it.s)) selected.add(it.i);
      } else {
        selected.clear();
      }
      listSignature = '';
      renderList(view || { items: [] });
    });

    $('btnDeleteSelected').addEventListener('click', () => {
      if (!selected.size) return;
      const count = selected.size;
      armConfirm($('btnDeleteSelected'), async () => {
        const indexes = Array.from(selected);
        const res = await send(CGR.CMD.DELETE_ITEMS, { indexes });
        if (res.ok) {
          selected.clear();
          listSignature = '';
          toast(`已删除 ${res.deleted} 条${res.skipped ? `，${res.skipped} 条正在执行已保留` : ''}`);
        } else {
          toast(res.error || '删除失败');
        }
      });
      toast(`将删除 ${count} 条，再点一次确认`);
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
      const cfg = collectSettings();
      const res = await send(CGR.CMD.SET_CONFIG, cfg);
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
      const res = await send(CGR.CMD.SELFCHECK);
      $('btnSelfcheck').disabled = false;
      $('btnSelfcheck').textContent = '运行自检';
      if (!res.ok) return toast(res.error || '自检失败');
      renderReport(res.report || []);
    });

    $('btnExportLogs').addEventListener('click', async () => {
      const res = await send(CGR.CMD.EXPORT_LOGS);
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

  async function loadView() {
    const data = await chrome.storage.local.get('view');
    if (data.view) {
      render(data.view);
    } else {
      render({
        status: 'idle',
        limitUntil: 0,
        counts: { total: 0, pending: 0, active: 0, done: 0, failed: 0, needs_review: 0, skipped: 0 },
        items: [],
        logs: [],
        batch: { name: '', count: 0 },
        cfg: CGR.DEFAULTS
      });
      $('emptyTip').style.display = 'block';
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.view && changes.view.newValue) {
      render(changes.view.newValue);
    }
  });

  // 限额倒计时与卡住提示需要每秒刷新
  function startTicker() {
    if (tickTimer) return;
    tickTimer = setInterval(() => {
      if (!view) return;
      if (view.status === 'limit_waiting') renderHeader(view);
      if (view.status === 'running') renderStuck(view);
    }, 1000);
  }

  bind();
  renderRefList();
  loadView();
  startTicker();
})();
