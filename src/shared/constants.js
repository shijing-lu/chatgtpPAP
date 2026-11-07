/* 全局常量：状态枚举、消息类型、默认配置。
 * content script 与 service worker 共用，IIFE 挂载到 globalThis.CGR，零构建。 */
(function (root) {
  const CGR = (root.CGR = root.CGR || {});

  CGR.STATUS = {
    PENDING: 'pending',
    CLAIMED: 'claimed',
    SENDING: 'sending',
    GENERATING: 'generating',
    DOWNLOADING: 'downloading',
    DONE: 'done',
    FAILED: 'failed',
    NEEDS_REVIEW: 'needs_review',
    SKIPPED: 'skipped'
  };

  CGR.STATUS_LABEL = {
    pending: '待生成',
    claimed: '已分配',
    sending: '发送中',
    generating: '生成中',
    downloading: '下载中',
    done: '已完成',
    failed: '失败',
    needs_review: '待确认',
    skipped: '已跳过'
  };

  CGR.GLOBAL = {
    IDLE: 'idle',
    RUNNING: 'running',
    PAUSED: 'paused',
    LIMIT_WAITING: 'limit_waiting',
    ERROR: 'error',
    FINISHED: 'finished'
  };

  CGR.GLOBAL_LABEL = {
    idle: '空闲',
    running: '运行中',
    paused: '已暂停',
    limit_waiting: '限额冷却中',
    error: '异常中断',
    finished: '已完成'
  };

  CGR.MODE = {
    SINGLE: 'single-chat',
    NEW_EACH: 'new-chat-each',
    PARALLEL: 'parallel'
  };

  CGR.MODE_LABEL = {
    'single-chat': '同一对话连续生成',
    'new-chat-each': '每条新开对话',
    parallel: '多对话并行'
  };

  // content <-> service worker 消息类型
  CGR.MSG = {
    HELLO: 'HELLO',
    PING: 'PING',
    WAKE: 'WAKE',
    EVALUATE: 'EVALUATE',
    ABORT: 'ABORT',
    LEASE_REQUEST: 'LEASE_REQUEST',
    LEASE_HEARTBEAT: 'LEASE_HEARTBEAT',
    PROGRESS: 'PROGRESS',
    OUTCOME: 'OUTCOME',
    LOG: 'LOG',
    DL_CHUNK: 'DL_CHUNK',
    DL_COMMIT: 'DL_COMMIT',
    SELFCHECK: 'SELFCHECK',
    SNAPSHOT: 'SNAPSHOT',
    // 后台 -> 内容：点当前站点的「下载全尺寸图片」按钮（Gemini）
    CLICK_SITE_DOWNLOAD: 'CLICK_SITE_DOWNLOAD'
  };

  // side panel -> service worker 命令
  CGR.CMD = {
    BATCH_CREATE: 'BATCH_CREATE',
    BATCH_UPDATE: 'BATCH_UPDATE',
    BATCH_DELETE: 'BATCH_DELETE',
    BATCH_SELECT: 'BATCH_SELECT',
    ADD_ITEM: 'ADD_ITEM',
    ADD_ITEMS: 'ADD_ITEMS',
    START: 'START',
    PAUSE: 'PAUSE',
    RESUME: 'RESUME',
    STOP: 'STOP',
    SET_CONFIG: 'SET_CONFIG',
    RESET_ITEM: 'RESET_ITEM',
    SKIP_ITEM: 'SKIP_ITEM',
    DELETE_ITEMS: 'DELETE_ITEMS',
    RUN_ONE: 'RUN_ONE',
    CLEAR_FINISHED: 'CLEAR_FINISHED',
    CLEAR_ALL: 'CLEAR_ALL',
    SELFCHECK: 'SELFCHECK',
    EXPORT_LOGS: 'EXPORT_LOGS',
    FIX_TABS: 'FIX_TABS',
    OPEN_ITEM_TAB: 'OPEN_ITEM_TAB',
    RESET: 'RESET',
    // 侧边栏复制提示词：视图里的 prompt 只有 240 字预览，完整原文在这里取
    GET_PROMPTS: 'GET_PROMPTS'
  };

  // 一键重置的两种范围：runtime 只清运行态（保留全部数据），factory 恢复出厂设置
  CGR.RESET_SCOPE = {
    RUNTIME: 'runtime',
    FACTORY: 'factory'
  };

  CGR.DEFAULTS = {
    mode: 'new-chat-each',
    concurrency: 1,
    folder: 'chatgpt-images',
    batchName: '',
    template: '{index:03}_{slug}',
    // 一次生成多张图时默认只下载页面上的第一张；'best' 回到旧的「评分最优」策略
    multiImage: 'first',
    preserveNewlines: false,
    minDelayMs: 3000,
    maxDelayMs: 7000,
    firstSignalMs: 120000,
    timeoutMs: 300000,
    // 页面与服务端脱节（SSE 断流 / 标签页被冻结）时，服务端其实已经出图，
    // 但这一页永远等不到结果。超过这么久「消息数、正文、产物、生成状态」全都没变过，
    // 就提前收敛成 PAGE_STALE（待确认、绝不重发），别把整个队列拖到 5 分钟总超时。
    stalePageMs: 150000,
    stableMs: 3000,
    maxAttempts: 2,
    // review | retry | fail | skip
    // 默认 review：判「未出图」时不再自动重发提示词，避免误判导致反复消耗生图额度
    onNoImage: 'review',
    limitCooldownMin: 60,
    autoStartNextTabDelayMs: 2000,


    // 前提设定：按批次独立保存；每条新对话开始前逐条发送，不生图。
    // 每条（含最后一条）发出后必须等 ChatGPT 检测到回复、回复写完，才允许发下一条，
    // 否则新对话里第一条前提会被紧接着的生图提示词挤掉，前提等于没生效。
    premises: [],
    premiseEnabled: true,
    premiseGapMs: 4000,       // 最小间隔：回复秒回也要补足，防乐观 UI 的假完成
    premiseWaitReply: true,   // 每条前提都等回复写完才发下一条；关掉则回到固定窗口模式
    premiseReplyMs: 60000,    // 等回复的总超时；超时只警告并继续，绝不重发
    premiseAckMs: 8000,       // 固定窗口模式（premiseWaitReply=false）下等「开始响应」信号的上限
    premiseTimeoutMs: 60000   // 已废弃：保留仅为兼容旧配置
  };

  CGR.LIMITS = {
    maxConcurrency: 3,
    hardMaxConcurrency: 5,
    maxPromptsPerBatch: 2000,
    leaseTtlMs: 90000,
    heartbeatMs: 20000,
    // 页面 -> 后台的单条消息回调兜底：MV3 在 SW 回收/冷启动窗口里可能永远不回调，
    // 不加超时就会有一个 await send() 把主循环永久挂起，还不留任何异常日志。
    msgTimeoutMs: 8000,
    // 主循环活性判据：空闲阶段的迭代超过这么久没推进一次，就认定它停摆。
    // lease 阶段（正在等出图）不算，正常生图本来就可能几分钟。
    loopStallMs: 90000,
    // 空闲轮询：短周期且封顶。以前从 15 秒指数退避到 120 秒，
    // 一旦 SW 被回收丢一条消息，就会「越卡越久」，同时让 SW 更容易被回收。
    idlePollMs: 3000,
    idleMaxPollMs: 8000,
    // service worker 运行期唤醒检查间隔；只在批次确实卡住时才发 WAKE
    wakeTickMs: 5000,
    wakeStuckMs: 15000,
    // 执行页「占着绑定却不来领任务」的判定：超过这么久没有成功派发、也没有任务在执行，
    // 就允许其它正在轮询的 ChatGPT 标签页就地接管。实际阈值还会按配置的间隔上限放宽，
    // 避免把两条任务之间的正常等待误判成失联。
    claimTakeoverMs: 10000,
    maxLogs: 400
  };

  /* 站点模块的兼容垫片：生产环境 sites.js 会在 constants.js 之后加载并覆盖这些实现。
   * 零依赖回归测试若只加载 constants.js + 某个后台模块，也得能跑出默认站点行为。 */
  if (!Array.isArray(CGR.SITE_IDS)) CGR.SITE_IDS = ['chatgpt', 'gemini'];
  if (typeof CGR.siteLabel !== 'function') {
    CGR.siteLabel = (id) => (id === 'gemini' ? 'Gemini' : id === 'chatgpt' ? 'ChatGPT' : '自动');
  }
  if (typeof CGR.siteMeta !== 'function') {
    CGR.siteMeta = (id) => (CGR.SITE_IDS.includes(id) ? { id, label: CGR.siteLabel(id) } : null);
  }
  if (typeof CGR.currentSiteLabel !== 'function') CGR.currentSiteLabel = () => 'ChatGPT';
})(typeof globalThis !== 'undefined' ? globalThis : self);
