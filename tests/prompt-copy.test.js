/* 队列提示词复制回归（零依赖）：node tests/prompt-copy.test.js
 *
 * 锁死的坑：后台发布给侧边栏的视图里 prompt 只截 240 字（compact()），
 * 直接复制视图里的 p 会把长提示词悄悄截断。复制必须走 GET_PROMPTS 取原文，
 * 这里验证「原文拼装」与「剪贴板写入」两层。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const load = (f) => vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });

load('src/shared/prompt-copy.js');
const PC = globalThis.CGR.PROMPT_COPY;

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('  ✓ ' + name);
}

const LONG = '把这只猫画成油画风格，'.repeat(40); // 远超过 240 字的视图预览上限

/* ---------- A. 纯函数 ---------- */
test('normalize 同时兼容后台 {index,prompt} 与视图 {i,p}，并过滤空条目', () => {
  const out = PC.normalize([
    { index: 0, prompt: '第一条' },
    { i: 1, p: '第二条' },
    { index: 2, prompt: '   ' },
    null
  ]);
  assert.deepStrictEqual(out, [
    { index: 0, prompt: '第一条' },
    { index: 1, prompt: '第二条' }
  ]);
});

test('one() 按队列索引取单条完整原文，不截断', () => {
  assert.strictEqual(PC.one([{ index: 0, prompt: LONG }, { index: 1, prompt: 'B' }], 1), 'B');
  assert.strictEqual(PC.one([{ index: 0, prompt: LONG }], 0), LONG);
  assert.strictEqual(PC.one([{ index: 0, prompt: LONG }], 9), '');
});

test('all() 保留长提示词原文与换行，一条不少', () => {
  const list = [
    { index: 0, prompt: LONG },
    { index: 1, prompt: '第二行\n带换行' },
    { index: 2, prompt: '第三条' }
  ];
  const text = PC.all(list);
  assert.ok(text.includes(LONG), '长提示词不能被截断');
  assert.ok(text.includes('第二行\n带换行'), '换行必须原样保留');
  assert.ok(text.includes('第三条'));
  assert.strictEqual(text.split(PC.DEFAULT_SEPARATOR).length, 3);
});

test('selected() 只取勾选条目，且按队列顺序而不是勾选顺序', () => {
  const list = [0, 1, 2, 3].map((i) => ({ index: i, prompt: `提示词${i}` }));
  assert.strictEqual(PC.selected(list, [3, 1]), '提示词1' + PC.DEFAULT_SEPARATOR + '提示词3');
  assert.strictEqual(PC.selected(list, [99]), '');
});

test('numbered 选项给每条加 #序号 前缀，自定义分隔符生效', () => {
  const list = [{ index: 0, prompt: 'A' }, { index: 1, prompt: 'B' }];
  assert.strictEqual(PC.all(list, { numbered: true, separator: '\n' }), '#1\nA\n#2\nB');
  assert.strictEqual(PC.all(list, { separator: '' }), 'AB');
});

test('toText 遇到空列表 / 非数组不抛异常', () => {
  assert.strictEqual(PC.all(null), '');
  assert.strictEqual(PC.toText(undefined, { indexes: [1] }), '');
  assert.strictEqual(PC.selected([], [0]), '');
});

/* ---------- B. 剪贴板 ---------- */
async function clipboardTests() {
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const realDocument = globalThis.document;

  // B1: 原生 Clipboard API 可用时直接用它
  let written = '';
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (t) => { written = t; } } }
  });
  assert.strictEqual(await PC.write('完整提示词'), true);
  assert.strictEqual(written, '完整提示词');
  console.log('  ✓ write() 优先使用 navigator.clipboard');
  passed += 1;

  // B2: Clipboard API 抛错时退回 execCommand('copy')
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async () => { throw new Error('denied'); } } }
  });
  const appended = [];
  let removed = 0;
  let copied = '';
  globalThis.document = {
    body: {
      appendChild: (el) => appended.push(el),
      removeChild: () => { removed += 1; }
    },
    createElement: () => ({
      value: '',
      style: {},
      setAttribute() {},
      select() { copied = this.value; }
    }),
    execCommand: () => true
  };
  assert.strictEqual(await PC.write('兜底文本'), true);
  assert.strictEqual(copied, '兜底文本');
  assert.strictEqual(appended.length, 1);
  assert.strictEqual(removed, 1, '临时 textarea 必须被移除');
  console.log('  ✓ write() Clipboard API 失败时退回 execCommand 并清理临时节点');
  passed += 1;

  // B3: 两条路都不可用 / 空文本 → 明确返回 false，不抛异常
  globalThis.document.execCommand = () => false;
  assert.strictEqual(await PC.write('还是会失败'), false);
  assert.strictEqual(await PC.write(''), false);
  assert.strictEqual(await PC.write(null), false);
  console.log('  ✓ write() 复制失败返回 false，空文本不写剪贴板');
  passed += 1;

  delete globalThis.document;
  if (realDocument !== undefined) globalThis.document = realDocument;
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
  else delete globalThis.navigator;
}

/* ---------- C. 存储兜底（后台旧版本不认 GET_PROMPTS 时） ---------- */
async function storageTests() {
  const mem = {
    'item:b1:0': { index: 0, prompt: LONG },
    'item:b1:1': { index: 1, prompt: '第二条' },
    'item:b2:0': { index: 0, prompt: '另一个批次' },
    'img:abc': { dataUrl: 'data:image/png;base64,AAAA' }
  };
  const calls = [];
  const storage = {
    get: (keys) => {
      calls.push(keys);
      const out = {};
      for (const k of keys) if (k in mem) out[k] = mem[k];
      return Promise.resolve(out);
    }
  };

  const all = await PC.readStorage(storage, 'b1', 2, []);
  assert.strictEqual(all.length, 2, '只取当前批次、只取需要的键');
  assert.strictEqual(all[0].prompt, LONG, '长提示词必须完整，不能被视图的 240 字截断');
  assert.strictEqual(all[1].prompt, '第二条');
  assert.ok(!calls[0].some((k) => k.startsWith('img:')), '不能把参考图的 dataURL 一起读出来');
  passed += 1;
  console.log('  ✓ readStorage() 取当前批次完整原文，不读图片数据');

  const picked = await PC.readStorage(storage, 'b1', 2, [1]);
  assert.deepStrictEqual(picked.map((x) => x.index), [1]);
  assert.strictEqual(picked[0].prompt, '第二条');
  passed += 1;
  console.log('  ✓ readStorage() 只取选中条目');

  assert.deepStrictEqual(await PC.readStorage(storage, 'b1', 0, []), []);
  assert.deepStrictEqual(await PC.readStorage(null, 'b1', 2, []), []);
  assert.deepStrictEqual(
    await PC.readStorage({ get: () => Promise.reject(new Error('boom')) }, 'b1', 2, []),
    [],
    'storage 异常时返回空数组，不能让复制按钮抛异常'
  );
  passed += 1;
  console.log('  ✓ readStorage() 空批次/无 storage/读取异常都安全返回');
}

async function main() {
  await clipboardTests();
  await storageTests();
  console.log(`\nALL PASS — 队列提示词复制回归通过（${passed} 组）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
