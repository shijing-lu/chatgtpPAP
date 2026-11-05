/* Markdown 提示词解析：每个围栏代码块（``` 或 ~~~）= 一条提示词 */
(function (root) {
  const CGR = (root.CGR = root.CGR || {});

  /* 围栏起始行：最多 3 格缩进 + 3 个以上反引号/波浪号 + 可选信息串 */
  const OPEN = /^([ \t]*)(`{3,}|~{3,})[ \t]*(.*)$/;

  /** 行首缩进宽度（tab 按 4 格对齐计算） */
  function indentOf(line) {
    let n = 0;
    for (const ch of line) {
      if (ch === ' ') n += 1;
      else if (ch === '\t') n += 4 - (n % 4);
      else break;
    }
    return n;
  }

  /** 去掉围栏本身的缩进（代码块写在列表项里时会整体缩进） */
  function dedent(lines, width) {
    if (!width) return lines;
    return lines.map((line) => {
      let removed = 0;
      let i = 0;
      while (i < line.length && removed < width && (line[i] === ' ' || line[i] === '\t')) {
        removed += line[i] === '\t' ? 4 - (removed % 4) : 1;
        i += 1;
      }
      return line.slice(i);
    });
  }

  /** 去掉首尾空行与行尾空白，中间结构原样保留 */
  function tidy(body) {
    const lines = body.map((l) => String(l).replace(/[ \t]+$/, ''));
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join('\n').trim();
  }

  /**
   * 解析 Markdown，每个代码块产出一条提示词。
   * @returns {{prompts: Array<{prompt:string,line:number}>, stats: object, warnings: string[]}}
   */
  function parse(raw) {
    const text = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').replace(/\uFEFF/g, '');
    const lines = text.split('\n');
    const prompts = [];
    let blocks = 0;
    let empty = 0;
    let unclosed = 0;
    let hasFence = false;

    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(OPEN);
      if (!m) continue;

      const indent = indentOf(m[1]);
      if (indent > 3) continue; // 缩进超过 3 格不是合法的围栏

      const marker = m[2][0];
      const fenceLen = m[2].length;
      const info = String(m[3] || '').trim();
      // 反引号围栏的信息串里不允许再出现反引号，否则它只是普通文本
      if (marker === '`' && info.includes('`')) continue;

      hasFence = true;
      blocks += 1;

      const startLine = i;
      const body = [];
      let closed = false;
      let j = i + 1;
      const closeRe = new RegExp(
        '^[ \\t]{0,3}' + (marker === '`' ? '`' : '~') + '{' + fenceLen + ',}[ \\t]*$'
      );

      for (; j < lines.length; j++) {
        if (closeRe.test(lines[j])) {
          closed = true;
          break;
        }
        body.push(lines[j]);
      }
      if (!closed) unclosed += 1;

      const promptText = tidy(dedent(body, indent));
      if (promptText) prompts.push({ prompt: promptText, line: startLine + 1 });
      else empty += 1;

      i = j; // 跳过已消费的行；未闭合时 j 等于总行数，循环自然结束
    }

    const warnings = [];
    if (!hasFence) {
      warnings.push('没有找到 ``` 代码块。每条提示词需要单独包在一个代码块里。');
    } else {
      if (unclosed) warnings.push(`${unclosed} 个代码块没有闭合，已按「直到文末」处理`);
      if (empty) warnings.push(`${empty} 个空代码块已忽略`);
    }

    return {
      prompts,
      stats: { blocks, kept: prompts.length, empty, unclosed },
      warnings
    };
  }

  CGR.MD = { parse };
})(typeof globalThis !== 'undefined' ? globalThis : self);
