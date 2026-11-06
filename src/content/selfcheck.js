/* 自检：定位「哪一步断了」，输出结构化报告给侧边栏。 */
(function (root) {
  const CGR = root.CGR;
  const probe = root.CGR_PROBE;

  function item(key, label, ok, detail, hint) {
    return { key, label, ok: !!ok, detail: detail || '', hint: hint || '' };
  }

  async function run() {
    const out = [];
    const composer = CGR.pick(CGR.SEL.composer);
    const sendBtn = CGR.pick(CGR.SEL.sendButton);
    const main = CGR.pick(CGR.SEL.main);

    out.push(item('page', '页面地址', CGR.isChatGPT(), location.href.slice(0, 90), '请把标签页打开到 chatgpt.com 的对话页面'));

    const loginWall = probe.hasLoginWall();
    out.push(item('auth', '登录状态', !loginWall, loginWall ? '检测到登录入口/登录表单' : '未发现登录墙', '请在该标签页手动登录 ChatGPT'));

    out.push(
      item(
        'composer',
        '输入框存在',
        !!composer,
        composer ? `命中：${composer.tagName.toLowerCase()}${composer.id ? '#' + composer.id : ''}` : '找不到输入框',
        'ChatGPT 前端可能已改版，请更新 src/shared/selectors.js 里的 CGR.SEL.composer'
      )
    );

    let focusOk = false;
    if (composer) {
      try {
        composer.focus();
        focusOk = document.activeElement === composer || composer.contains(document.activeElement);
      } catch (e) {
        focusOk = false;
      }
    }
    out.push(item('focus', '输入框可聚焦', focusOk, focusOk ? '聚焦正常' : '聚焦失败', '输入框可能被遮罩层覆盖或页面未完全加载'));

    let insertOk = false;
    let insertDetail = '未执行';
    if (composer) {
      const draft = String(composer.innerText || '').trim();
      if (draft) {
        insertOk = true;
        insertDetail = '输入框里有内容，已跳过写入测试以免覆盖你的草稿';
      } else {
        try {
          const okExec = document.execCommand('insertText', false, 'CGRTEST');
          insertOk = okExec && String(composer.innerText || '').includes('CGRTEST');
          insertDetail = insertOk ? 'execCommand 插入成功（已清空）' : 'execCommand 插入未生效，将依赖 paste 事件兜底';
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
        } catch (e) {
          insertDetail = String(e && e.message);
        }
      }
    }
    out.push(item('insert', '输入链路可用', insertOk, insertDetail, '若失败但提示词能正常输入，可忽略；若发送后输入框为空，说明需要更新插入逻辑'));

    out.push(
      item(
        'send',
        '发送按钮存在',
        !!sendBtn,
        sendBtn ? `aria-label=${sendBtn.getAttribute('aria-label') || '无'} / disabled=${!!sendBtn.disabled}` : '找不到发送按钮',
        '找不到按钮时会回退用 Enter 发送，一般仍可用'
      )
    );

    out.push(item('main', '对话容器 main', !!main, main ? '已找到' : '未找到', '对话容器缺失会导致无法检测出图'));

    let imgHits = 0;
    let looseHits = 0;
    const samples = [];
    for (const img of document.querySelectorAll('img')) {
      const s = img.currentSrc || img.src || '';
      if (probe.isImageSrc(s)) imgHits += 1;
      if (probe.isLikelyGenerated(img, true)) looseHits += 1;
      if (s && samples.length < 3) samples.push(`${img.naturalWidth || 0}x${img.naturalHeight || 0} ${s.slice(0, 70)}`);
    }
    out.push(
      item(
        'imgrule',
        '图片识别（URL 规则）',
        true,
        imgHits ? `命中 ${imgHits} 张` : '未命中 URL 白名单（不影响识别，仍会按「新出现的大图」判定）',
        '出图后这里为 0 表示 ChatGPT 换了图片域名，属于正常，宽松规则会兜住'
      )
    );
    out.push(
      item(
        'looseRule',
        '图片识别（宽松规则）',
        true,
        looseHits ? `当前页面有 ${looseHits} 张合格大图` : '当前页面还没有合格大图（出图后再自检可验证）',
        '若网页已经出图但这里仍是 0，把下面几条 src 发给开发者即可定位'
      )
    );
    for (let i = 0; i < samples.length; i++) {
      out.push(item(`imgSample${i}`, `页面图片 ${i + 1}`, true, samples[i], ''));
    }

    const generating = probe.isGenerating();
    const stopHit = !!CGR.pick(CGR.SEL.stopButton);
    out.push(
      item(
        'stopbutton',
        '停止生成按钮选择器',
        true,
        stopHit ? '命中（生成状态可判定）' : '当前未命中；空闲时正常，生成中若也不命中说明前端改版，已由 DOM 静默兜底',
        '选择器失效不会导致误判出图，但会让判定多等几秒'
      )
    );
    out.push(item('generating', '是否正在生成', true, generating ? '当前正在生成中，任务会等待其结束' : '当前空闲', ''));

    const limit = probe.detectLimit();
    out.push(item('limit', '限额提示', !limit, limit ? limit.slice(0, 60) : '未检测到限额提示', '出现限额需要等待额度恢复后再继续'));

    const conv = CGR.getConvId();
    out.push(item('conv', '当前对话 ID', !!conv, conv ? conv : '尚未进入具体对话（新对话状态）', ''));

    out.push(item('lang', '页面语言', true, document.documentElement.lang || 'unknown', ''));

    out.push(
      item('visible', '页面可见性', true, `${document.visibilityState} / 宽 ${window.innerWidth}`, '后台标签页会被 Chrome 节流，检测逻辑已用 MutationObserver 规避，但仍建议让窗口可见')
    );

    return out;
  }

  root.CGR_SELFCHECK = { run };
})(typeof globalThis !== 'undefined' ? globalThis : self);
