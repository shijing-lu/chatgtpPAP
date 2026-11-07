/* 队列提示词复制：纯函数部分可零依赖回归，DOM 部分只负责写剪贴板。
 *
 * 为什么单独一层：后台发布的视图里 prompt 只截了 240 字（compact()），
 * 拿视图里的 p 字段去复制会把长提示词悄悄截断。所以复制时一律通过
 * GET_PROMPTS 从后台取完整原文，这里负责「拼成什么文本」和「怎么放进剪贴板」。
 */
(function (root) {
  const CGR = (root.CGR = root.CGR || {});

  const DEFAULT_SEPARATOR = '\n\n---\n\n';

  /** 同时兼容后台的 {index,prompt} 与视图里的 {i,p} 两种结构 */
  function normalize(list) {
    return (Array.isArray(list) ? list : [])
      .map((it) => ({
        index: it && it.index != null ? Number(it.index) : Number(it && it.i),
        prompt: String((it && (it.prompt != null ? it.prompt : it.p)) || '')
      }))
      .filter((it) => Number.isFinite(it.index) && it.prompt.trim());
  }

  function one(list, index) {
    const hit = normalize(list).find((it) => it.index === Number(index));
    return hit ? hit.prompt : '';
  }

  /** 按队列顺序拼文本；indexes 为空 = 整批，否则只取指定条目 */
  function toText(list, opts) {
    const o = opts || {};
    const wanted = Array.isArray(o.indexes) && o.indexes.length
      ? new Set(o.indexes.map(Number))
      : null;
    const sep = o.separator != null ? o.separator : DEFAULT_SEPARATOR;
    const picked = normalize(list).filter((it) => !wanted || wanted.has(it.index));
    return picked
      .map((it) => (o.numbered ? `#${it.index + 1}\n${it.prompt}` : it.prompt))
      .join(sep);
  }

  function all(list, opts) {
    return toText(list, opts);
  }

  function selected(list, indexes, opts) {
    return toText(list, Object.assign({}, opts, { indexes: indexes || [] }));
  }

  /** 兜底：直接读 chrome.storage.local 里的条目原文。
   * 后台版本比侧边栏旧时（没注册 GET_PROMPTS，会回 unknown-command）也能复制完整提示词。
   * 存储布局 item:<batchId>:<index> 从早期版本起没变过，且只按需要的键取，不会把
   * 参考图的 dataURL 一起读出来。 */
  async function readStorage(storage, bid, count, indexes) {
    if (!storage || !bid) return [];
    const wanted = Array.isArray(indexes) && indexes.length ? new Set(indexes.map(Number)) : null;
    const n = Math.max(0, Number(count) || 0);
    if (!n) return [];
    const keys = [];
    for (let i = 0; i < n; i++) keys.push(`item:${bid}:${i}`);
    let got = {};
    try {
      got = (await storage.get(keys)) || {};
    } catch (e) {
      return [];
    }
    return keys
      .map((k, i) => ({ index: i, prompt: String((got[k] && got[k].prompt) || '') }))
      .filter((it) => it.prompt.trim() && (!wanted || wanted.has(it.index)));
  }

  /** 写剪贴板：优先 async Clipboard API，扩展页被限制时退回 execCommand。
   * 返回 boolean，不抛异常，调用方据此提示成功/失败。 */
  async function write(text) {
    const value = String(text == null ? '' : text);
    if (!value) return false;
    try {
      if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
        await root.navigator.clipboard.writeText(value);
        return true;
      }
    } catch (e) {
      /* 继续走兜底 */
    }
    try {
      const doc = root.document;
      if (!doc || !doc.body) return false;
      const ta = doc.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.opacity = '0';
      doc.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = !!doc.execCommand('copy');
      } catch (e) {
        ok = false;
      }
      doc.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  CGR.PROMPT_COPY = {
    DEFAULT_SEPARATOR,
    normalize,
    one,
    all,
    selected,
    toText,
    readStorage,
    write
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
