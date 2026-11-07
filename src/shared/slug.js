/* 文件名 slug 化：中英混排、Windows 保留名、非法字符清理。 */
(function (root) {
  const CGR = (root.CGR = root.CGR || {});

  const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  /** 把提示词变成可安全落盘的文件名片段（保留中文，不转拼音） */
  CGR.slug = function (text, maxLen) {
    const limit = maxLen || 40;
    let s = String(text == null ? '' : text).trim();
    if (!s) return 'image';

    try {
      s = s.normalize('NFC');
    } catch (e) {
      /* ignore */
    }

    // 多字节预留余量
    s = s.slice(0, limit * 4);

    // 去掉路径/文件系统非法字符与控制字符
    s = s.replace(/[\\/:*?"<>|]/g, ' ');
    s = s.replace(/[\u0000-\u001f\u007f]/g, ' ');
    // 空白 -> 下划线
    s = s.replace(/\s+/g, '_');
    // 只保留中文、字母、数字、下划线、连字符
    s = s.replace(/[^\p{Script=Han}A-Za-z0-9_-]/gu, '');
    // 折叠并清理首尾
    s = s.replace(/_+/g, '_').replace(/^[_.]+|[_.]+$/g, '');

    if (!s) return fnv1a(text);

    // 按码点截断，避免切坏汉字
    const chars = Array.from(s);
    if (chars.length > limit) s = chars.slice(0, limit).join('');
    s = s.replace(/[_.]+$/g, '');

    if (RESERVED.test(s)) s = '_' + s;
    return s || fnv1a(text);
  };

  /** 校验并规范化用户填写的「下载目录」（只能是相对 Downloads 的子路径） */
  CGR.normalizeFolder = function (folder, fallback) {
    const def = fallback || 'chatgpt-images';
    let f = String(folder == null ? '' : folder).trim();
    if (!f) return def;
    f = f.replace(/\\/g, '/');
    // 必须先判断盘符（绝对路径），再剥离冒号，否则 "C:\\x" 会变成 Downloads/C/x
    if (/^[A-Za-z]:/.test(f) || /^\/\//.test(f)) return def;
    f = f.replace(/[<>:"|?*\u0000-\u001f]/g, '');
    f = f.replace(/\/{2,}/g, '/');
    f = f.replace(/^\/+|\/+$/g, '');
    if (/^[A-Za-z]:/.test(f)) return def;
    const parts = f.split('/').filter((p) => p && p !== '.' && p !== '..');
    if (!parts.length) return def;
    const safe = parts.map((p) => p.replace(/[. ]+$/g, '').trim()).filter(Boolean);
    return safe.length ? safe.join('/') : def;
  };

  /** 提示词开头的编号：`## 36 标题`、`[36]`、`（36）`、`36.`、`36、`、`#36`、`36_标题`。
   *  返回 { index, length }；length 是整段编号前缀（含分隔符）的长度，用来从 slug 里切掉它。
   *  这样文件名只用提示词自己的编号，不会再出现「037_36_标题」两个不一样的编号。 */
  CGR.leadingIndex = function (text) {
    let s = String(text == null ? '' : text);
    // 全角数字转半角（一字符换一字符，长度不变，切片位置仍然准确）
    s = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    const m = s.match(
      /^[\s#>*\-–—•·]*(?:[【[(（]\s*)?(\d{1,4})(?:[】\])）][\s.、,，:：|｜_\-–—]*|[\s.、,，:：|｜_\-–—]+|$)/
    );
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    return { index: n, length: m[0].length };
  };

  /** 模板渲染：支持 {index} {index:03} {slug} {date} {time} {batch} {ext} */
  CGR.renderName = function (tpl, ctx) {
    const idx = Number(ctx.index) || 0;
    const date = ctx.date || new Date();
    const pad = (n, w) => String(n).padStart(w, '0');
    const dateStr = `${date.getFullYear()}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}`;
    const timeStr = `${pad(date.getHours(), 2)}${pad(date.getMinutes(), 2)}${pad(date.getSeconds(), 2)}`;

    let out = String(tpl || '{index:03}_{slug}');
    out = out.replace(/\{index(?::(\d+))?\}/g, (_m, w) => (w ? pad(idx, Number(w)) : String(idx)));
    out = out.replace(/\{slug\}/g, ctx.slug || 'image');
    out = out.replace(/\{date\}/g, dateStr);
    out = out.replace(/\{time\}/g, timeStr);
    out = out.replace(/\{batch\}/g, CGR.slug(ctx.batch || 'batch', 24));
    out = out.replace(/\{ext\}/g, ctx.ext || 'png');
    out = out.replace(/\{[a-zA-Z]+\}/g, '');

    out = out.replace(/[\\/:*?"<>|]/g, '_').replace(/^[_.\s]+|[_.\s]+$/g, '');
    return out || `image_${idx}`;
  };

  /** 从 URL / content-type 推断扩展名 */
  CGR.extFromUrl = function (url, contentType) {
    const m = String(url || '').match(/\.(png|jpe?g|webp|gif|avif)(?:[?#]|$)/i);
    if (m) return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    const ct = String(contentType || '').toLowerCase();
    if (ct.includes('jpeg')) return 'jpg';
    if (ct.includes('webp')) return 'webp';
    if (ct.includes('gif')) return 'gif';
    if (ct.includes('avif')) return 'avif';
    return 'png';
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
