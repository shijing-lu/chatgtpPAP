/* 发送链路回归测试（零依赖）：node tests/composer-send.test.js
 *
 * 复现「前提第一条就 send-failed、批次被整批置异常」的页面侧根因：
 *  - ChatGPT 流式输出时发送按钮变成「停止生成」，旧代码把它当发送按钮点 → 消息永远发不出去
 *  - 成功判据用脱离文档的旧输入框节点，导致提交后仍反复尝试 enter/requestSubmit
 *  - 插入失败、按钮禁用、按钮缺失、提交无响应全部混成 send-failed-3x，日志无法定位
 *  - 正式生图阶段不能主动停止生成，前提阶段才可以（回复内容无所谓）
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const load = (f) => vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });

/* ---------- 可控时钟：setTimeout 同步推进虚拟时间，避免测试真的等几十秒 ---------- */
let NOW = 1000000;
const realNow = Date.now;
const realSetTimeout = global.setTimeout;
Date.now = () => NOW;
let onTick = null;
global.setTimeout = (fn, ms) => {
  NOW += ms || 0;
  if (onTick) onTick();
  fn();
  return 0;
};

/* ---------- DOM 桩 ---------- */
let composerEl = null;
let formEl = null;
let sendBtn = null;
let stopBtn = null;
let msgNodes = [];
let generating = false;
let insertWorks = true;
let sendClickWorks = true;
let onSendClick = null;
let stopClicks = 0;
let submitCalls = 0;
let ticks = 0;

function makeComposer(text) {
  return {
    tagName: 'DIV',
    id: 'prompt-textarea',
    innerText: text,
    textContent: text,
    focus() {},
    closest(sel) {
      return sel === 'form' ? formEl : null;
    },
    dispatchEvent() {
      return true;
    },
    getBoundingClientRect() {
      return { width: 400, height: 80 };
    }
  };
}

function makeButton(kind) {
  return {
    tagName: 'BUTTON',
    disabled: false,
    hidden: false,
    offsetParent: {},
    _attrs: {},
    getAttribute(n) {
      return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null;
    },
    getClientRects() {
      return [{}];
    },
    getBoundingClientRect() {
      return { width: 32, height: 32 };
    },
    click() {
      if (kind === 'stop') {
        stopClicks += 1;
        generating = false;
        return;
      }
      if (!sendClickWorks) return;
      if (onSendClick) {
        onSendClick();
        return;
      }
      msgNodes.push({});
      composerEl = makeComposer('');
      generating = true;
    },
    dispatchEvent() {
      return true;
    }
  };
}

const buttonsFor = (sel) => {
  // 模拟真实 UI：生成中 form 里那个 submit 按钮就是「停止生成」按钮
  if (sel === 'button[data-testid="send-button"]') return [generating ? stopBtn : sendBtn].filter(Boolean);
  return [];
};
const stopsFor = (sel) => {
  if (/stop/i.test(sel)) return generating && stopBtn ? [stopBtn] : [];
  return [];
};

const document = {
  querySelector(sel) {
    if (sel === '#prompt-textarea') return composerEl;
    if (/stop/i.test(sel)) return generating ? stopBtn : null;
    if (sel === 'main') return { tag: 'main' };
    return null;
  },
  querySelectorAll(sel) {
    if (sel === '[data-message-author-role]') return msgNodes;
    if (/stop/i.test(sel)) return stopsFor(sel);
    return [];
  },
  execCommand(cmd, _ui, text) {
    if (cmd === 'selectAll' || cmd === 'delete') {
      if (composerEl) {
        composerEl.innerText = '';
        composerEl.textContent = '';
      }
      return true;
    }
    if (cmd === 'insertText') {
      if (!insertWorks || !composerEl) return false;
      composerEl.innerText = String(text || '');
      composerEl.textContent = String(text || '');
      return true;
    }
    return false;
  },
  createRange() {
    return { selectNodeContents() {} };
  },
  contains() {
    return true;
  },
  body: { querySelectorAll: () => [] }
};
global.document = document;

global.window = {
  getSelection() {
    return { rangeCount: 0, removeAllRanges() {}, addRange() {}, deleteFromDocument() {} };
  }
};
global.location = { pathname: '/c/conv-1', hostname: 'chatgpt.com', href: 'https://chatgpt.com/c/conv-1' };

class FakeEvent {
  constructor(type, opts) {
    this.type = type;
    Object.assign(this, opts || {});
  }
}
global.InputEvent = FakeEvent;
global.ClipboardEvent = FakeEvent;
global.KeyboardEvent = FakeEvent;
global.PointerEvent = FakeEvent;
global.MouseEvent = FakeEvent;
global.DataTransfer = class {
  constructor() {
    this.items = { add() {} };
  }
  setData() {}
};

/* ---------- 加载真实模块 ---------- */
load('src/shared/selectors.js');
load('src/shared/sched.js');
load('src/content/probes.js');
load('src/content/composer.js');

const CGR = global.CGR;
const composer = global.CGR_COMPOSER;
const probe = global.CGR_PROBE;

/* ---------- 工具 ---------- */
function reset() {
  composerEl = makeComposer('');
  sendBtn = makeButton('send');
  stopBtn = makeButton('stop');
  formEl = { querySelectorAll: buttonsFor };
  msgNodes = [];
  generating = false;
  insertWorks = true;
  sendClickWorks = true;
  onSendClick = null;
  onTick = null;
  stopClicks = 0;
  submitCalls = 0;
  ticks = 0;
  formEl.requestSubmit = () => {
    submitCalls += 1;
  };
}

function setupTicks() {
  onTick = () => {
    ticks += 1;
  };
}

async function main() {
  /* A：生成中连发两条前提，第二条必须自动跳过文本回复并成功发出 */
  reset();
  setupTicks();
  const a1 = await composer.sendPrompt('前提一：风格设定', {}, { allowStop: true });
  assert.strictEqual(a1.ok, true, '第一条前提应发送成功');
  assert.strictEqual(generating, true, '模型收到消息后应开始输出');
  const beforeMsgs = msgNodes.length;
  const a2 = await composer.sendPrompt('前提二：构图设定', {}, { allowStop: true });
  assert.strictEqual(a2.ok, true, '生成中第二条前提也应发送成功');
  assert.ok(stopClicks >= 1, '前提阶段应主动停止文本回复来腾出输入框');
  assert.ok(a2.diagnostic.some((l) => /已停止文本回复/.test(l)), '诊断里应写明已跳过文本回复');
  assert.strictEqual(msgNodes.length, beforeMsgs + 1, '第二条前提应真的产生一条新消息');
  console.log('PASS A: 生成中连发前提会自动跳过文本回复，不再 send-failed');

  /* B：生成中不能把「停止生成」按钮当成发送按钮 */
  reset();
  generating = true;
  const bState = composer.findSendButton();
  assert.strictEqual(bState.btn, null, '生成中不应返回可点的发送按钮');
  assert.ok(bState.excludedStop >= 1, '应明确记录已排除停止按钮');
  assert.ok(/停止按钮已排除/.test(composer.stateText(composer.sendState())), '页面实况应包含停止按钮排除数');
  console.log('PASS B: 停止生成按钮已从发送候选中隔离');

  /* C：提交后输入框节点被 React 替换，第一步 click 就应判定成功，不再误触 requestSubmit */
  reset();
  setupTicks();
  onSendClick = () => {
    // 只替换输入框节点（清空），不新增消息节点、不进入生成态 —— 旧判据会全部落空
    composerEl = makeComposer('');
  };
  const c = await composer.sendPrompt('一条普通提示词', {});
  assert.strictEqual(c.ok, true, '输入框被重挂载也应判成功');
  assert.strictEqual(c.method, 'click', '应第一步就成功，不再尝试 enter/requestSubmit');
  assert.strictEqual(submitCalls, 0, '不得误触表单提交（可能引发导航）');
  console.log('PASS C: 输入框重挂载后按当前节点判定，不再误触多种提交方式');

  /* D：文字插不进输入框 → 细分错误码 + 页面实况 */
  reset();
  setupTicks();
  insertWorks = false;
  const d = await composer.sendPrompt('插不进去的提示词', {});
  assert.strictEqual(d.ok, false);
  assert.strictEqual(d.code, 'insert-failed', '应明确指出是插入失败');
  assert.ok(d.diagnostic.some((l) => /文字没插进输入框/.test(l) && /输入框=/.test(l)), '诊断须带页面实况');
  console.log('PASS D: 插入失败返回 insert-failed 并带页面实况');

  /* E：按钮点了没反应 → submit-failed，而不是笼统的 send-failed-3x */
  reset();
  setupTicks();
  sendClickWorks = false;
  const e = await composer.sendPrompt('点了没反应的提示词', {}, { naturalWaitMs: 100, maxWaitMs: 500 });
  assert.strictEqual(e.ok, false);
  assert.strictEqual(e.code, 'submit-failed', '应明确指出是提交未生效');
  assert.ok(e.diagnostic.some((l) => /提交未生效/.test(l)), '诊断须写明提交未生效');
  console.log('PASS E: 提交无响应返回 submit-failed');

  /* F：发送按钮被禁用 → send-button-disabled */
  reset();
  setupTicks();
  sendBtn.disabled = true;
  const f = await composer.sendPrompt('按钮禁用时的提示词', {}, { naturalWaitMs: 100, maxWaitMs: 500 });
  assert.strictEqual(f.ok, false);
  assert.strictEqual(f.code, 'send-button-disabled', '应明确指出按钮被禁用');
  console.log('PASS F: 按钮禁用返回 send-button-disabled');

  /* G：正式生图阶段在生成中不能主动点停止按钮，只能等自然结束 */
  reset();
  setupTicks();
  generating = true;
  onTick = () => {
    ticks += 1;
    if (ticks === 8) generating = false; // 模拟回复自然结束
  };
  const g = await composer.sendPrompt('正式生图提示词', {}, { naturalWaitMs: 300, maxWaitMs: 5000 });
  assert.strictEqual(g.ok, true, '等生成结束后应正常发送');
  assert.strictEqual(stopClicks, 0, '正式生图阶段绝不能主动停止生成（会截断出图）');
  assert.ok(g.diagnostic.some((l) => /reply-finished|waited|idle/.test(l)), '诊断应记录等待原因');
  console.log('PASS G: 正式生图阶段只等不停止，避免截断生成');

  /* H：waitSendable 在空闲时不应产生任何等待或点击 */
  reset();
  setupTicks();
  const h = await composer.sendPrompt('空闲状态下的提示词', {}, { allowStop: true });
  assert.strictEqual(h.ok, true);
  assert.strictEqual(stopClicks, 0, '空闲时不该点停止按钮');
  assert.ok(h.diagnostic[0].includes('idle'), '诊断应写明页面本来就可发送');
  console.log('PASS H: 空闲页面直接进入发送，无多余动作');

  Date.now = realNow;
  global.setTimeout = realSetTimeout;
  console.log('\nALL PASS — 发送链路回归通过');
}

main().catch((e) => {
  Date.now = realNow;
  global.setTimeout = realSetTimeout;
  console.error(e);
  process.exitCode = 1;
});
