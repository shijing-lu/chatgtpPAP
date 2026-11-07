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
      version: '0.6.3',
      date: '2026-11-07',
      title: '修「执行到一半就不执行了」+ 复制提示词兜底',
      changes: [
        '根因一：租约被页面心跳每 20 秒续一次，sweepExpired 永远等不到过期；而定时扫描的自愈看到「有任务在执行」就直接跳过。于是一条卡死的任务能把整批队列冻住——批次还写着「运行中」，却再也不发下一条，日志也不报错',
        '新增单条任务看门狗：按 max(领取时间, 真正发出时间) 计龄，超过 10 分钟（等出图超时调大时自动放宽）强制收敛。已发出提示词的转「待确认」且绝不重发；还没发出的退回队列重试，超限转「待确认」。收敛后立刻唤醒页面继续下一条',
        '根因二：重试次数已用尽的任务会被静默跳过、状态却仍是「待生成」，批次因此永远挂在运行中，页面只回「队列里没有可领的任务」。现在这类条目统一转「待确认」并写清原因，批次能正常收尾',
        '根因三：连续发送失败计数只在「成功出图」时清零，两次不相邻的失败（中间夹着几条成功任务）也会累计到 2 把整批误暂停。改为「发出成功即清零」',
        '暂停 / 异常中断 / 限额冷却的原因不再只藏在状态胶囊的悬停提示里，侧边栏顶部直接显示一行说明，一眼看出「为什么停了、要不要点继续」',
        '复制提示词不再依赖后台命令：后台若是旧版本（回 unknown-command）时直接读 item:<批次>:<序号> 兜底，并提示重新加载扩展；新增 readStorage 回归 3 组、看门狗回归 7 组，共 17 套 174 组通过'
      ]
    },
    {
      version: '0.6.2',
      date: '2026-11-07',
      title: '修「刚跑完的执行页被抢权」与图片下载失败',
      changes: [
        '根因（最重要）：僵尸执行页的判据用的是「最近一次领到任务」，而一条任务包含前提等回复 60 秒 + 等出图 120 秒以上，期间本来就不会领新任务。任务一结束，旁观标签页来领任务就把刚跑完的执行页判成「215 秒没来领任务」并夺权，前提在另一个标签页重发、后续提示词发进错误上下文，图自然检测不到也下载不到',
        '改用心跳 / 进度 / 结果 / 领取请求等真实页面通信时间（批次 lastPageAt）判定失联，阈值放宽到 30 秒；长任务刚结束、页面仍在通信时绝不再抢执行权',
        '下载链路四个确定性失败点：A 级直链被拒后找不到执行页（清了租约又从不写 tabId）、丢分片仍拼出损坏文件、取流卡住时 DOWNLOADING 永久挂在 ACTIVE 拖死整批、页面取流失败只写日志不通知后台。现在分别补 tabId 保留与 runtime 兜底、分片完整性校验、60 秒看门狗、失败立即收敛为「待确认」且绝不重发提示词',
        '4K 大图不再拼 data: URL（Chrome 有长度上限），改在页面里用 blob: + 原生下载点击，点击前先由后台登记归位目标，文件名与批次目录照旧',
        '旁观标签页的「等待派发」日志从 30 秒一条降到 2 分钟一条，文案改为明确说明这是正常旁观页；连续找不到输入框时主动上报「本页不是对话页」',
        '新增 download-recovery 回归 9 组、僵尸回归补「4 分钟长任务刚结束不误判」1 组，共 16 套 164 组通过'
      ]
    },
    {
      version: '0.6.1',
      date: '2026-11-07',
      title: '修「跑着跑着断开、不再发提示词」与页面脱节卡死',
      changes: [
        '根因：页面发往后台的消息没有超时兜底，SW 回收窗口里一条消息不回调就把主循环永久挂起；消息监听器还在（PING 照回 ok）、心跳还在替它续租，后台所有自愈都以为任务正常执行中 —— 批次显示「运行中」却再也不往聊天框发提示词',
        '所有页面 → 后台消息加 8 秒超时；PING 现在带回主循环活性（alive / phase / stalled），后台能分辨「监听器还通」和「主循环还在干活」，停摆时回收租约并强制重注入（不新开标签页）',
        '强制重注入会递增实例代次，让旧实例的 loop、心跳定时器与消息监听器彻底闭嘴，避免新旧两个执行页并行领任务、重复发提示词',
        '「手机显示生成成功、电脑不显示」= 服务端已出图但这一页与服务端脱节。新增页面进展签名，长时间毫无变化时提前收敛成「待确认」并让队列继续，不再干等 5 分钟总超时；绝不重发提示词',
        '新增 loop-stall 回归测试（消息超时不挂起、假活页面识别、强制重注入、PAGE_STALE 不重发），出图检测补「页面脱节提前收敛」与「慢生成不误判」两组'
      ]
    },
    {
      version: '0.6.0',
      date: '2026-11-07',
      title: '适配 Gemini 生图 + 队列提示词可复制',
      changes: [
        '新增站点注册表 sites.js：两个站点的域名、首页、对话 ID 与 DOM 选择器各自独立，批次设置里可选「工作站点」，默认 ChatGPT',
        'Gemini 用 Quill 输入框 / 上传菜单 / model-response 回复节点；生成图识别 generated-image 容器，优先点「下载全尺寸图片」而不是保存 blob: 预览图，下载仍归位到批次目录',
        '批次只接管同站点标签页：开始 / 立即修复 / 自愈补绑定都按站点过滤，跨站点领任务直接拒绝，不会把提示词发到错误网站',
        '队列每条新增「复制」按钮，工具条新增「复制选中 / 复制全部」；复制的是后台完整原文，不受列表 240 字预览截断影响，剪贴板不可用时自动兜底',
        '自检新增站点与生成图下载按钮诊断，日志带上站点实况；新增 site-adapter 与 prompt-copy 两套回归测试'
      ]
    },
    {
      version: '0.5.3',
      date: '2026-11-07',
      title: '一次生成多张图时默认只下载第一张',
      changes: [
        '根因：旧版按「尺寸最大 / 4K 高清原图链接」评分挑图，一次出 4 张时往往下载到第 2~4 张；产物列表本身也没有记录页面顺序',
        '产物统一按页面真实位置排序并写下 order，跨轮询轮次锁定首图：第一张加载慢、重渲染时短暂消失都不会让它被第二张顶替',
        '后台默认只取第一张，一条任务仍只发起一次下载；日志写明「共 N 张，只下载第 1 张」',
        '设置页新增「一次生成多张图时」下拉，可切回旧的评分策略；上报前剥离 DOM 节点，避免结果消息结构化克隆失败'
      ]
    },
    {
      version: '0.5.2',
      date: '2026-11-07',
      title: '修复下载变成「下载.png」且不进批次目录',
      changes: [
        '根因：扩展自己注册 onDeterminingFilename 后，Chrome 会忽略 downloads.download() 传入的 filename（Chromium 579563）；旧监听器又跳过扩展自己发起的下载，导致直链/取流下载全部落到默认下载目录',
        '新增下载意图表：直链、页面取流、附件点击三类下载都先登记批次目录与模板名，再由监听器同步写回文件名；SW 冷启动可从存储恢复',
        '队列页新增「实际保存位置」提示，直接显示最终目录与示例文件名；落盘路径不符时日志会明确报出实际路径',
        '附件点击把目标文件名写入 download 属性作为二级兜底；一键重置同时清理残留下载意图'
      ]
    },
    {
      version: '0.5.1',
      date: '2026-11-07',
      title: '修复「已接管标签页却一直等待派发」',
      changes: [
        '根因：上次运行遗留的后台标签页占着执行页绑定却不来领任务，其它 ChatGPT 标签页全被判「未绑定批次」，后台只反复唤醒那个死页',
        '执行页超过正常间隔没派发、且没有任务在生成时，自动由当前正在轮询的标签页接管并清掉旧绑定（有任务在生成时绝不接管，避免重复生图）',
        '开始 / 立即修复优先绑定用户当前正在看的 ChatGPT 标签页，并清理同批次残留绑定；仍然不新开标签页',
        '唤醒送不到立即标记失联；定时扫描 ping 恢复后清除失联标记'
      ]
    },
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
