/* 调度工具：睡眠、随机延迟、节流、超时包装。 */
(function (root) {
  const CGR = (root.CGR = root.CGR || {});

  CGR.sleep = function (ms) {
    return new Promise((r) => setTimeout(r, Math.max(0, ms | 0)));
  };

  CGR.randBetween = function (min, max) {
    const a = Math.min(min, max);
    const b = Math.max(min, max);
    return Math.round(a + Math.random() * (b - a));
  };

  /** 时间戳节流：用于 MutationObserver 高频回调 */
  CGR.throttler = function (waitMs) {
    let last = 0;
    return function (fn) {
      const now = Date.now();
      if (now - last < waitMs) return false;
      last = now;
      fn();
      return true;
    };
  };

  /** 轮询直到 predicate 为真或超时，返回 true/false */
  CGR.pollUntil = async function (predicate, timeoutMs, intervalMs) {
    const deadline = Date.now() + timeoutMs;
    const step = intervalMs || 200;
    while (Date.now() < deadline) {
      let ok = false;
      try {
        ok = !!predicate();
      } catch (e) {
        ok = false;
      }
      if (ok) return true;
      await CGR.sleep(step);
    }
    return false;
  };

  /** 把 Promise 包一层超时（超时返回 fallback，不抛错） */
  CGR.withTimeout = function (promise, ms, fallback) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(fallback);
      }, ms);
      promise.then(
        (v) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(v);
        },
        () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(fallback);
        }
      );
    });
  };

  CGR.uuid = function () {
    try {
      if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    } catch (e) {
      /* ignore */
    }
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  };

  CGR.nowStr = function (ts) {
    const d = new Date(ts || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
