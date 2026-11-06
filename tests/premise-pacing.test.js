/* 前提发送节奏回归测试（零依赖）：node tests/premise-pacing.test.js
 *
 * 复现「前提提示词一发完，第一条生图提示词就发出去了，ChatGPT 没时间接收」：
 *  - 旧逻辑最后一条前提之后只 sleep 600ms，第一条生图提示词贴着前提发出去
 *  - 「发送成功」只判输入框清空 / 气泡挂上 DOM（乐观 UI），不等于服务端已写进会话
 *  - 前提模式 allowStop 默认 1.5 秒就点停止生成，把服务端对前提的处理也截断了
 *  - ack 超时被当成失败并重试，会重复消耗额度
 *
 * 本测试只加载 constants / sched / premise 三个真实模块，页面能力全部注入桩，
 * 用虚拟时钟把 4~8 秒的窗口同步推进，跑起来是毫秒级。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const load = (f) => vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });

/* ---------- 可控时钟 ---------- */
let NOW = 1000000;
const realNow = Date.now;
const realSetTimeout = global.setTimeout;
Date.now = () => NOW;
global.setTimeout = (fn, ms) => {
  NOW += ms || 0;
  fn();
  return 0;
};

load('src/shared/constants.js');
load('src/shared/sched.js');
load('src/content/premise.js');

const CGR = global.CGR;
const premise = global.CGR_PREMISE;

/* ---------- 页面能力桩 ---------- */
function makeHarness(cfg) {
  const events = [];
  const logs = [];
  const state = { msgCount: 0, assistantCount: 0, generating: false };
  const probe = {
    allMsgCount: () => state.msgCount,
    assistantCount: () => state.assistantCount,
    isGenerating: () => state.generating
  };
  let sendIndex = 0;
  let failAt = -1;
  let ackMode = 'ok'; // ok | assistant | none
  let aborted = false;

  async function sendPrompt(text, _cfg, opts) {
    const i = sendIndex++;
    events.push({ kind: 'send', i, text, at: Date.now(), opts: opts || {} });
    if (i === failAt) {
      return { ok: false, code: 'submit-failed', diagnostic: ['第1次：提交未生效（submit-failed）'] };
    }
    state.msgCount += 1;
    if (ackMode === 'ok') state.generating = true;
    if (ackMode === 'assistant') state.assistantCount += 1;
    await CGR.sleep(50);
    events.push({ kind: 'sent', i, text, at: Date.now() });
    return { ok: true, method: 'click', diagnostic: [] };
  }

  async function waitSendable(opts) {
    events.push({ kind: 'waitSendable', at: Date.now(), opts: opts || {} });
    if (state.generating && opts.allowStop) {
      state.generating = false;
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
    setAckMode: (m) => { ackMode = m; },
    fail: (n) => { failAt = n; },
    abort: () => { aborted = true; }
  };
}

const GAP = 4000;

async function main() {
  /* A：最后一条前提之后仍留满接收窗口，第一条生图提示词不会贴着前提发出 */
  {
    const h = makeHarness({});
    const res = await premise.apply(['前提一：风格', '前提二：构图', '前提三：色调'], h.deps);
    assert.strictEqual(res.ok, true);
    const lastSentAt = h.sents().pop().at;
    const applyEnd = Date.now();
    assert.ok(
      applyEnd - lastSentAt >= GAP,
      `最后一条前提之后也必须留满 ${GAP}ms，实际只留 ${applyEnd - lastSentAt}ms`
    );
    // 模拟 content.js 在 apply 之后紧接着发第一条正式生图提示词
    await h.deps.sendPrompt('第一条生图提示词', {}, {});
    const formalAt = h.sends().pop().at;
    assert.ok(
      formalAt - lastSentAt >= GAP,
      `第一条生图提示词距最后一条前提太近：${formalAt - lastSentAt}ms`
    );
    console.log('PASS A: 最后一条前提之后仍留满接收窗口，生图提示词不再贴着前提发出');
  }

  /* B：每条前提之间都有完整间隔，不再是 sleep(1200) 就发下一条 */
  {
    const h = makeHarness({});
    await premise.apply(['甲', '乙', '丙'], h.deps);
    const sends = h.sends();
    for (let i = 1; i < sends.length; i++) {
      assert.ok(
        sends[i].at - sends[i - 1].at >= GAP,
        `第 ${i + 1} 条前提距上一条只有 ${sends[i].at - sends[i - 1].at}ms`
      );
    }
    console.log('PASS B: 前提逐条留间隔，不再连珠炮发送');
  }

  /* C：ack 立刻命中也必须补足最小间隔（乐观 UI 的 ack 早于服务端落库） */
  {
    const h = makeHarness({});
    const res = await premise.apply(['甲', '乙'], h.deps);
    assert.strictEqual(res.gaps.length, 2);
    assert.ok(res.gaps.every((g) => g.acked === true), '正常情况应拿到服务端响应信号');
    assert.ok(res.gaps.every((g) => g.waitedMs >= GAP), 'ack 命中也要补足最小间隔');
    console.log('PASS C: ack 秒回也补足最小接收窗口');
  }

  /* D：等不到接收信号只警告并继续，绝不失败、绝不重发前提 */
  {
    const h = makeHarness({});
    h.setAckMode('none');
    const res = await premise.apply(['甲', '乙', '丙'], h.deps);
    assert.strictEqual(res.ok, true, 'ack 超时不能把批次判失败');
    assert.strictEqual(h.sends().length, 3, 'ack 超时绝不能重发前提');
    assert.ok(res.gaps.every((g) => g.acked === false && g.waitedMs >= GAP));
    assert.ok(h.logs.some((l) => l.level === 'warn' && /未收到响应信号/.test(l.message)), '应留下警告日志');
    console.log('PASS D: 接收信号超时只警告放行，不重发、不判失败');
  }

  /* E：只认「接收确认」，不读回复、不等回复结束、不下载、不看图 */
  {
    const h = makeHarness({});
    const res = await premise.apply(['甲', '乙'], h.deps);
    assert.strictEqual(res.images, undefined, '前提阶段不产出图片结果');
    assert.ok(
      !h.logs.some((l) => /等待出图|开始下载|回复已完成|等待模型回复/.test(l.message)),
      '日志里不应出现等回复/下载动作'
    );
    assert.ok(
      h.logs.some((l) => /不读回复、不等生成结束/.test(l.message)),
      '日志应明确写出前提阶段不等回复'
    );
    // 所有「停止生成」动作都晚于对应前提的接收窗口
    const sents = h.sents();
    for (const ev of h.events.filter((e) => e.kind === 'waitSendable')) {
      const prior = sents.filter((s) => s.at <= ev.at).pop();
      if (prior) assert.ok(ev.at - prior.at >= GAP, '停止文本回复必须晚于接收窗口');
    }
    assert.strictEqual(h.state.generating, false, 'apply 结束时输入框应已恢复可发送');
    console.log('PASS E: 不等回复、不下载，停止动作永远晚于接收窗口');
  }

  /* F：前提模式的停止等待被抬到接收窗口长度，不会 1.5 秒就截断服务端处理 */
  {
    const h = makeHarness({});
    await premise.apply(['甲', '乙'], h.deps);
    for (const ev of h.sends()) {
      assert.strictEqual(ev.opts.allowStop, true);
      assert.ok(ev.opts.naturalWaitMs >= GAP, `前提的 naturalWaitMs 太短：${ev.opts.naturalWaitMs}`);
    }
    console.log('PASS F: 前提发送前至少等满接收窗口才可能点停止生成');
  }

  /* G：发送失败立即停下，不重发、不给后续前提留窗口，诊断写进日志 */
  {
    const h = makeHarness({});
    h.fail(1);
    const res = await premise.apply(['甲', '乙', '丙'], h.deps);
    assert.strictEqual(res.ok, false);
    assert.ok(/send-failed\(submit-failed\)/.test(res.reason));
    assert.strictEqual(h.sends().length, 2, '失败后不得继续发剩下的前提');
    assert.ok(h.logs.some((l) => l.level === 'warn' && /提交未生效/.test(l.message)), '诊断应写进日志');
    console.log('PASS G: 发送失败立即终止，不重发、不带后续窗口');
  }

  /* H：中止后一条都不发 */
  {
    const h = makeHarness({});
    h.abort();
    const res = await premise.apply(['甲', '乙'], h.deps);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'aborted');
    assert.strictEqual(h.sends().length, 0);
    console.log('PASS H: 中止信号生效，不再发送任何前提');
  }

  /* I：自定义间隔生效；异常配置被钳制，老配置缺字段回落默认值 */
  {
    const h = makeHarness({ premiseGapMs: 6000, premiseAckMs: 3000 });
    const res = await premise.apply(['甲', '乙'], h.deps);
    assert.strictEqual(h.sends()[1].at - h.sends()[0].at >= 6000, true);
    assert.strictEqual(res.gapMs, 6000);

    assert.deepStrictEqual(premise.pacing({}), { gapMs: 4000, ackMs: 8000 }, '老配置缺字段应回落默认');
    assert.deepStrictEqual(
      premise.pacing({ premiseGapMs: 999999999, premiseAckMs: 999999999 }),
      { gapMs: 30000, ackMs: 30000 },
      '超大值应被钳制'
    );
    assert.deepStrictEqual(
      premise.pacing({ premiseGapMs: -1, premiseAckMs: 0 }),
      { gapMs: 4000, ackMs: 8000 },
      '非法值应回落默认'
    );
    console.log('PASS I: 自定义间隔生效，异常配置钳制、老配置回落默认');
  }

  /* J：只有一条前提时，同样要给第一条生图提示词留窗口 */
  {
    const h = makeHarness({});
    const res = await premise.apply(['唯一一条前提'], h.deps);
    assert.strictEqual(res.ok, true);
    const lastSentAt = h.sents().pop().at;
    assert.ok(Date.now() - lastSentAt >= GAP, '单条前提也必须留窗口');
    assert.strictEqual(res.gaps.length, 1);
    console.log('PASS J: 只有一条前提时同样留接收窗口');
  }

  /* K：assistant 回复节点也是有效的接收信号（停止按钮选择器失效时不误判） */
  {
    const h = makeHarness({});
    h.setAckMode('assistant');
    const res = await premise.apply(['甲'], h.deps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.gaps[0].acked, true, '新回复节点应算服务端已接收');
    assert.ok(res.gaps[0].waitedMs >= GAP);
    console.log('PASS K: 停止按钮选择器失效时靠新回复节点也能确认接收');
  }

  Date.now = realNow;
  global.setTimeout = realSetTimeout;
  console.log('\nALL PASS — 前提接收窗口回归通过（11 组）');
}

main().catch((e) => {
  Date.now = realNow;
  global.setTimeout = realSetTimeout;
  console.error(e);
  process.exitCode = 1;
});
