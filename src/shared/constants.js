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
    onNoImage: 'retry', // retry | fail | skip
    limitCooldownMin: 60,
    autoStartNextTabDelayMs: 2000,


    // 前提设定：不产生图片，每条新对话开始前先逐条发送并等待模型回复
    premises: [],
    premiseEnabled: true,
    premiseTimeoutMs: 60000
  };

  CGR.LIMITS = {
    maxConcurrency: 3,
    hardMaxConcurrency: 5,
    maxPromptsPerBatch: 2000,
    leaseTtlMs: 90000,
    heartbeatMs: 20000,
    idlePollMs: 15000,
    maxLogs: 400
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
