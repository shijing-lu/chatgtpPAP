/* 版本与更新记录：设置页、Service Worker 共用的唯一显示逻辑。
 *
 * 版本号唯一真相源 = chrome.runtime.getManifest().version（即 manifest.json）。
 * 本文件不硬编码「当前版本」，只维护三件事：
 *   1. RELEASES：每个版本改了什么（发版时补一条）
 *   2. record()：把 onInstalled / SW 冷启动算成一条版本变化记录（纯函数，可零依赖测试）
 *   3. describe()：把 storage 里的记录整理成设置页要展示的数据
 *
 * 发版三步：manifest.json 版本 +1 → RELEASES 顶部补同版本号条目 → 跑 tests/version.test.js。
 * 只要这三步做完，扩展重载后设置页会自动显示新版本号，不需要改任何 UI 代码。
 */
(function (root) {
  const CGR = (root.CGR = root.CGR || {});

  const KEY = 'cgrVersion';
  const MAX_HISTORY = 12;

  /* 倒序，最新在最前。每条的 version 必须能在 manifest.json 的历史里找到；
   * 最新一条必须与 manifest.version 相同（tests/version.test.js 会强校验）。 */
  const RELEASES = [
    {
      version: '0.5.0',
      date: '2026-11-07',
      title: '设置页显示版本号与更新记录',
      changes: [
        '设置页顶部新增版本卡片：当前版本、上次更新版本、生效时间、本次更新说明与历史版本记录',
        '顶部版本号徽标可一键跳到设置页，随时确认扩展是否已重载到最新版',
        '新增「复制版本信息」，反馈问题时可直接贴出版本号与更新记录'
      ]
    },
    {
      version: '0.4.9',
      date: '2026-11-07',
      title: '前提真正等 ChatGPT 回复写完',
      changes: [
        '每条前提发出后检测回复文字出现、停止生成消失、回复文本稳定，三条齐了才发下一条',
        '最后一条前提的回复检测完成前不发第一条生图提示词；超时只警告继续，不重发',
        '设置页新增「等回复」开关、等回复超时与前提最小间隔'
      ]
    },
    {
      version: '0.4.8',
      date: '2026-11-07',
      title: '前提逐条留接收窗口',
      changes: [
        '修复前提刚发完就贴着发生图提示词、服务端来不及写入会话的问题',
        '每条前提（含最后一条）确认服务端已响应并补足最小间隔'
      ]
    },
    {
      version: '0.4.7',
      date: '2026-11-06',
      title: '附件图片下载与一键重置',
      changes: [
        '支持「xxx.png 图像」文件附件卡片与 4K 高清链接，下载归位到批次目录',
        '一键重置清掉卡住的租约与标签页绑定，提示词和设置全部保留',
        '有产物时绝不因 NO_IMAGE 重发提示词，避免重复生图'
      ]
    },
    {
      version: '0.4.6',
      date: '2026-11-06',
      title: '出图识别与结果护栏',
      changes: ['产物快照差集扩展到图片链接与附件卡片', '已出图不再误判失败、不再重复生成']
    }
  ];

  /** 当前真正运行着的扩展版本；UI 只认这个，不认缓存里的字符串 */
  function currentVersion() {
    try {
      const m = root.chrome && root.chrome.runtime && root.chrome.runtime.getManifest();
      return (m && m.version) || '';
    } catch (e) {
      return '';
    }
  }

  function noteFor(version) {
    return RELEASES.find((r) => r.version === version) || null;
  }

  function latest() {
    return RELEASES[0] || null;
  }

  /** 语义化版本比较：只比三段数字，返回 -1 / 0 / 1 */
  function compare(a, b) {
    const parts = (v) =>
      String(v || '')
        .replace(/^v/, '')
        .split('.')
        .map((n) => Number(n) || 0);
    const x = parts(a);
    const y = parts(b);
    for (let i = 0; i < Math.max(x.length, y.length, 3); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  /**
   * 依据 chrome.runtime.onInstalled 的 details 计算新的版本元数据。纯函数。
   * - 版本号变了（或第一次记录）→ 追加一条历史，记下 from / at
   * - 版本号没变（重载扩展、Chrome 重启）→ 只刷新「最近生效时间」，不重复记一条更新
   */
  function record(prev, version, now, details) {
    const meta = prev && typeof prev === 'object' ? prev : null;
    const at = Number(now) || 0;
    const reason = (details && details.reason) || (meta ? 'update' : 'install');
    const from = (meta && meta.version) || (details && details.previousVersion) || '';
    const history = Array.isArray(meta && meta.history) ? meta.history.slice() : [];

    if (meta && meta.version === version) {
      return Object.assign({}, meta, {
        reloadedAt: at,
        reloadCount: (Number(meta.reloadCount) || 0) + 1
      });
    }

    const entry = { version, from, reason, at };
    // onInstalled 与 SW 冷启动兜底可能在几毫秒内都跑一次，同版本同秒只留一条
    if (history[0] && history[0].version === version && Math.abs((Number(history[0].at) || 0) - at) < 1500) {
      history[0] = entry;
    } else {
      history.unshift(entry);
    }

    return {
      version,
      previousVersion: from,
      reason,
      installedAt: (meta && meta.installedAt) || at,
      updatedAt: at,
      reloadedAt: at,
      reloadCount: 0,
      history: history.slice(0, MAX_HISTORY)
    };
  }

  /** 整理成设置页要展示的数据 */
  function describe(version, meta) {
    const history = meta && Array.isArray(meta.history) ? meta.history.slice() : [];
    const last = history.find((h) => h && h.version === version) || null;
    return {
      version,
      note: noteFor(version),
      latestReleased: latest() ? latest().version : '',
      previousVersion: (last && last.from) || (meta && meta.previousVersion) || '',
      updatedAt: Number((last && last.at) || (meta && meta.updatedAt) || 0),
      reloadedAt: Number((meta && meta.reloadedAt) || 0),
      reloadCount: Number((meta && meta.reloadCount) || 0),
      history
    };
  }

  /** 复制给开发者排障用的纯文本 */
  function copyText(info) {
    const lines = [`ChatGPT 批量生图助手 v${info.version || '?'}`];
    if (info.previousVersion) lines.push(`上次更新：v${info.previousVersion} → v${info.version}`);
    if (info.updatedAt) lines.push(`更新生效：${new Date(info.updatedAt).toLocaleString('zh-CN', { hour12: false })}`);
    if (info.reloadedAt) lines.push(`最近重载：${new Date(info.reloadedAt).toLocaleString('zh-CN', { hour12: false })}`);
    if (info.note) {
      lines.push(`本次更新：${info.note.title}`);
      for (const c of info.note.changes) lines.push(`- ${c}`);
    } else {
      lines.push('（该版本暂无更新说明）');
    }
    if (info.history && info.history.length) {
      lines.push('版本记录：');
      for (const h of info.history) {
        lines.push(`- ${h.from ? `v${h.from} → ` : ''}v${h.version}  ${new Date(h.at).toLocaleString('zh-CN', { hour12: false })}`);
      }
    }
    return lines.join('\n');
  }

  CGR.VERSION = {
    KEY,
    MAX_HISTORY,
    RELEASES,
    currentVersion,
    noteFor,
    latest,
    compare,
    record,
    describe,
    copyText
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
