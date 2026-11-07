/* 前提发送节奏回归测试（零依赖）：node tests/premise-pacing.test.js
 *
 * 用户要求：第一条前提发出去后必须等 ChatGPT 回复，检测到回复后才能发下一条。
 * 覆盖：
 *  - 回复文字出现还不够，要等回复写完（停止生成消失 + 文本稳定）
 *  - 第一条没等到回复前绝不发第二条；最后一条之后同样要等，才轮到生图提示词
 *  - 等不到回复按超时放行，只警告、不重发、不判失败
 *  - 回复秒回也补足最小间隔，防乐观 UI 假完成
 *  - 停止按钮选择器失效时靠文本稳定兜底；关闭开关回到固定窗口模式
 *
 * 只加载 constants / sched / premise 三个真实模块，页面能力全部注入桩；
 * 虚拟时钟同步推进，回复按时间线出现文字 → 写完，跑起来是毫秒级。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const load = (f) => vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });

/* ---------- 可控时钟：每次 sleep 推进虚拟时间并驱动页面回复进度 ---------- */
let NOW = 1000000;
let tickHook = null;
const realNow = Date.now;
const realSetTimeout = global.setTimeout;
Date.now = () => NOW;
global.setTimeout = (fn, ms) => {
  NOW += ms || 0;
  if (tickHook) tickHook();
  fn();
  return 0;
};

load('src/shared/constants.js');
load('src/shared/sched.js');
load('src/content/premise.js');

const CGR = global.CGR;
const premise = global.CGR_PREMISE;

/* ---------- 页面能力桩 ---------- */
function makeHarness(cfg, opts) {
  const o = opts || {};
  const textAt = o.replyTextAt != null ? o.replyTextAt : 800;   // 回复文字出现
  const doneAt = o.replyDoneAt != null ? o.replyDoneAt : 3000;  // 回复写完
  const neverReply = !!o.neverReply;
  const noStopButton = !!o.noStopButton;                        // 停止按钮选择器失效
  const events = [];
  const logs = [];
  const state = { msgCount: 0, assistantCount: 0, lastText: '', bodyLen: 1000, generating: false };
  let pending = null;
  let seq = 0;
  let sendIndex = 0;
  let failAt = -1;
  let aborted = false;

  function advance() {
    if (!pending) return;
    const t = Date.now() - pending.at;
    if (!pending.textShown && !neverReply && t >= textAt) {
      pending.textShown = true;
      state.assistantCount += 1;
      state.lastText = `回复${pending.seq}（正在写）`;
      state.bodyLen += 200;
    }
    if (pending.textShown && !pending.finished && !neverReply && t >= Math.max(doneAt, textAt)) {
      pending.finished = true;
      state.lastText = `回复${pending.seq}（完成）`;
      state.generating = false;
    }
  }
  tickHook = advance;

  const probe = {
    allMsgCount: () => state.msgCount,
    assistantCount: () => state.assistantCount,
    isGenerating: () => (noStopButton ? false : state.generating),
    lastAssistantText: () => state.lastText,
    bodyTextLen: () => state.bodyLen
  };

  async function sendPrompt(text, _cfg, sentOpts) {
    const i = sendIndex++;
    events.push({ kind: 'send', i, text, at: Date.now(), opts: sentOpts || {} });
    if (i === failAt) {
      return { ok: false, code: 'submit-failed', diagnostic: ['第1次：提交未生效（submit-failed）'] };
    }
    state.msgCount += 1;
    state.generating = true;
    seq += 1;
    pending = { at: Date.now(), seq, textShown: false, finished: false };
    await CGR.sleep(50);
    events.push({ kind: 'sent', i, text, at: Date.now() });
    return { ok: true, method: 'click', diagnostic: [] };
  }

  async function waitSendable(sOpts) {
    events.push({ kind: 'waitSendable', at: Date.now(), opts: sOpts || {} });
    if (state.generating && sOpts.allowStop) {
      state.generating = false;
      pending = null;
      return { ok: true, stopped: true, reason: 'stopped-text-reply' };
    }
    return { ok: true, stopped: false, reason: 'idle' };
  }

  const deps = {
    cfg: cfg || {},
    probe,
    sendPrompt,
    waitSendable,
    log: (level, message) => logs.push({ level, message, at: Date.now() }),
    progress: async () => {},
    isAborted: () => aborted
  };

  return {
    events,
    logs,
    state,
    deps,
    sends: () => events.filter((e) => e.kind === 'send'),
    sents: () => events.filter((e) => e.kind === 'sent'),
    stops: () => events.filter((e) => e.kind === 'waitSendable'),
    fail: (n) => { failAt = n; },
    abort: () => { aborted = true; }
  };
}

const GAP = 4000;
const REPLY_MS = 3000;

async function main() {
  /* A：第一条前提没检测到回复前绝不发第二条 */
  {
    const h = makeHarness({});
    const res = await premise.apply(['前提一：风格', '前提二：构图', '前提三：色调'], h.deps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.gaps.length, 3);
    assert.ok(res.gaps.every((g) => g.replied && g.finished), '每条前提都必须检测到完整回复');
    const sends = h.sends();
    // 站点名会随工作站点变化（ChatGPT / Gemini），这里只认「检测到站点回复并写完」这个事件
    const readyLogs = h.logs.filter((l) => /已检测到.*回复并写完/.test(l.message));
    assert.strictEqual(readyLogs.length, 3, '每条前提都要有「检测到回复」日志');
    for (let i = 1; i < sends.length; i++) {
      assert.ok(sends[i].at - sends[i - 1].at >= REPLY_MS, `第 ${i + 1} 条前提发得太早`);
      assert.ok(sends[i].at >= readyLogs[i - 1].at, '下一条必须在上一条回复检测之后才发出');
    }
    assert.strictEqual(h.stops().length, 0, '回复已经写完，不该再点停止生成截断回复');
    console.log('PASS A: 第一条等回复，检测到回复后才允许发第二条');
  }

  /* B：最后一条前提之后同样等回复，之后才轮到第一条生图提示词 */
  {
    const h = makeHarness({});
    await premise.apply(['甲', '乙'], h.deps);
    assert.strictEqual(h.state.generating, false, 'apply 结束时回复应已写完');
    const lastSentAt = h.sents().pop().at;
    assert.ok(Date.now() - lastSentAt >= REPLY_MS, '最后一条之后也必须等回复');
    await h.deps.sendPrompt('第一条生图提示词', {}, {});
    assert.ok(h.sends().pop().at - lastSentAt >= REPLY_MS, '生图提示词不能贴着前提发出');
    console.log('PASS B: 最后一条前提回复后才发第一条生图提示词');
  }

  /* C：不是只看「文字出现」，必须等回复写完 */
  {
    const h = makeHarness({});
    const res = await premise.apply(['甲'], h.deps);
    assert.ok(res.gaps[0].waitedMs >= REPLY_MS, `回复 0.8 秒就出字，但必须等写完；实际 ${res.gaps[0].waitedMs}ms`);
    assert.ok(h.logs.some((l) => /回复并写完/.test(l.message)));
    console.log('PASS C: 回复文字出现不算数，等写完才放行');
  }

  /* D：回复秒回也要补足最小间隔（乐观 UI 保护） */
  {
    const h = makeHarness({}, { replyTextAt: 0, replyDoneAt: 0 });
    const res = await premise.apply(['甲', '乙'], h.deps);
    assert.ok(res.gaps.every((g) => g.finished && g.waitedMs >= GAP), '秒回也要补足最小间隔');
    console.log('PASS D: 回复秒回仍补足最小间隔');
  }

  /* E：等不到回复超时放行，只警告、不重发、不判失败 */
  {
    const h = makeHarness({ premiseReplyMs: 10000 }, { neverReply: true });
    const res = await premise.apply(['甲', '乙'], h.deps);
    assert.strictEqual(res.ok, true, '等回复超时不能判失败');
    assert.strictEqual(h.sends().length, 2, '等回复超时绝不能重发前提');
    assert.ok(res.gaps.every((g) => g.timedOut && !g.finished));
    assert.ok(h.logs.some((l) => l.level === 'warn' && /没检测到完整回复/.test(l.message)));
    console.log('PASS E: 等不到回复按超时放行，只警告不重发');
  }

  /* F：停止按钮选择器失效时靠回复文本稳定兜底，不会白等满超时 */
  {
    const h = makeHarness({ premiseReplyMs: 30000 }, { noStopButton: true });
    const res = await premise.apply(['甲'], h.deps);
    assert.strictEqual(res.ok, true);
    assert.ok(res.gaps[0].finished, '没有停止按钮也要能判定回复写完');
    assert.ok(res.gaps[0].waitedMs < 30000, '不该白等满超时');
    console.log('PASS F: 停止按钮选择器失效时靠文本稳定兜底');
  }

  /* G：关掉「等回复」开关回到固定窗口模式 */
  {
    const h = makeHarness({ premiseWaitReply: false });
    const res = await premise.apply(['甲', '乙'], h.deps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.waitReply, false);
    assert.ok(res.gaps.every((g) => g.finished === undefined && typeof g.acked === 'boolean'));
    assert.ok(h.logs.some((l) => /未等回复/.test(l.message)));
    console.log('PASS G: 关闭开关后回到固定窗口模式');
  }

  /* H：发送失败立即终止、中止不发送、单条前提也等回复 */
  {
    const a = makeHarness({});
    a.fail(1);
    const r1 = await premise.apply(['甲', '乙', '丙'], a.deps);
    assert.strictEqual(r1.ok, false);
    assert.ok(/send-failed\(submit-failed\)/.test(r1.reason));
    assert.strictEqual(a.sends().length, 2, '失败后不得继续发剩下的前提');
    assert.ok(a.logs.some((l) => l.level === 'warn' && /提交未生效/.test(l.message)));

    const b = makeHarness({});
    b.abort();
    const r2 = await premise.apply(['甲'], b.deps);
    assert.strictEqual(r2.reason, 'aborted');
    assert.strictEqual(b.sends().length, 0);

    const c = makeHarness({});
    const r3 = await premise.apply(['唯一一条前提'], c.deps);
    assert.strictEqual(r3.gaps.length, 1);
    assert.strictEqual(r3.gaps[0].finished, true);
    console.log('PASS H: 失败/中止/单条前提的边界行为正确');
  }

  /* I：配置钳制与老配置回落默认值 */
  {
    assert.deepStrictEqual(premise.pacing({}), {
      gapMs: 4000, replyMs: 60000, ackMs: 8000, waitReply: true
    }, '老配置缺字段应回落默认且默认开启等回复');
    assert.deepStrictEqual(
      premise.pacing({ premiseGapMs: 999999999, premiseReplyMs: 999999999, premiseAckMs: 999999999 }),
      { gapMs: 30000, replyMs: 300000, ackMs: 30000, waitReply: true }
    );
    assert.deepStrictEqual(
      premise.pacing({ premiseGapMs: -1, premiseReplyMs: 0, premiseAckMs: 0, premiseWaitReply: false }),
      { gapMs: 4000, replyMs: 60000, ackMs: 8000, waitReply: false }
    );
    console.log('PASS I: 配置钳制、老配置回落默认、开关生效');
  }

  /* J：前提发送仍不会 1.5 秒就点停止生成 */
  {
    const h = makeHarness({});
    await premise.apply(['甲', '乙'], h.deps);
    for (const ev of h.sends()) {
      assert.strictEqual(ev.opts.allowStop, true);
      assert.ok(ev.opts.naturalWaitMs >= GAP, `naturalWaitMs 太短：${ev.opts.naturalWaitMs}`);
    }
    console.log('PASS J: 前提停止动作不会提前截断服务端处理');
  }

  /* K：前提阶段不产出图片、不下载 */
  {
    const h = makeHarness({});
    const res = await premise.apply(['甲', '乙'], h.deps);
    assert.strictEqual(res.images, undefined);
    assert.ok(!h.logs.some((l) => /等待出图|开始下载|下载完成/.test(l.message)));
    console.log('PASS K: 前提阶段不看图、不下载');
  }

  Date.now = realNow;
  global.setTimeout = realSetTimeout;
  console.log('\nALL PASS — 前提等回复节奏回归通过（11 组）');
}

main().catch((e) => {
  Date.now = realNow;
  global.setTimeout = realSetTimeout;
  console.error(e);
  process.exitCode = 1;
});
