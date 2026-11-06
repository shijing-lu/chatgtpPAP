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
    SNAPSHOT: 'SNAPSHOT'
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
    OPEN_ITEM_TAB: 'OPEN_ITEM_TAB'
  };

  CGR.DEFAULTS = {
    mode: 'new-chat-each',
    concurrency: 1,
    folder: 'chatgpt-images',
    batchName: '',
    template: '{index:03}_{slug}',
    preserveNewlines: false,
    minDelayMs: 3000,
    maxDelayMs: 7000,
    firstSignalMs: 120000,
    timeoutMs: 300000,
    stableMs: 3000,
    maxAttempts: 2,
    // review | retry | fail | skip
    // 默认 review：判「未出图」时不再自动重发提示词，避免误判导致反复消耗生图额度
    onNoImage: 'review',
    limitCooldownMin: 60,
    autoStartNextTabDelayMs: 2000,


    // 前提设定：按批次独立保存；每条新对话开始前逐条发送，发完即走，不等回复、不生图
    premises: [],
    premiseEnabled: true,
    premiseTimeoutMs: 60000 // 已废弃：保留仅为兼容旧配置，前提阶段不再等待回复
  };

  CGR.LIMITS = {
    maxConcurrency: 3,
    hardMaxConcurrency: 5,
    maxPromptsPerBatch: 2000,
    leaseTtlMs: 90000,
    heartbeatMs: 20000,
    // 空闲轮询：短周期且封顶。以前从 15 秒指数退避到 120 秒，
    // 一旦 SW 被回收丢一条消息，就会「越卡越久」，同时让 SW 更容易被回收。
    idlePollMs: 3000,
    idleMaxPollMs: 8000,
    // service worker 运行期唤醒检查间隔；只在批次确实卡住时才发 WAKE
    wakeTickMs: 5000,
    wakeStuckMs: 15000,
    maxLogs: 400
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
