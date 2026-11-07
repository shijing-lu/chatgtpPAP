/* 版本与更新记录回归（零依赖）：node tests/version.test.js
 *
 * 核心约束：每次发版后设置页必须显示新版本号 + 更新说明。
 *  - manifest.version 是唯一版本来源，RELEASES 最新一条必须与它一致（漏写说明会直接失败）
 *  - RELEASES 结构完整、版本倒序、无重复
 *  - sidepanel.html 与 service-worker.js 都必须加载 version.js
 *  - record()：首次记录 / 升级 / 同版本重载 / 历史上限 / 损坏数据
 *  - describe() / copyText()：没有历史记录时也要能显示版本号
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const load = (f) => vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const manifest = JSON.parse(read('manifest.json'));
load('src/shared/version.js');
const V = globalThis.CGR.VERSION;

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('  ✓ ' + name);
}

const T0 = Date.UTC(2026, 10, 7, 4, 30, 0);

/* ---------- A. 发版一致性 ---------- */
test('manifest.version 是合法的三段版本号', () => {
  assert.ok(/^\d+\.\d+\.\d+$/.test(manifest.version), `不合法版本：${manifest.version}`);
});

test('RELEASES 最新一条必须与 manifest.version 相同（每次更新都要补更新说明）', () => {
  const latest = V.latest();
  assert.ok(latest, 'RELEASES 不能为空');
  assert.strictEqual(latest.version, manifest.version, '发版漏写 RELEASES，设置页会显示「缺少更新说明」');
  assert.strictEqual(V.noteFor(manifest.version), latest);
});

test('每条更新说明结构完整、日期合法', () => {
  for (const r of V.RELEASES) {
    assert.ok(/^\d+\.\d+\.\d+$/.test(r.version), `版本号不合法：${r.version}`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.date), `日期不合法：${r.date}`);
    assert.ok(r.title && typeof r.title === 'string', `${r.version} 缺标题`);
    assert.ok(Array.isArray(r.changes) && r.changes.length > 0, `${r.version} 缺更新条目`);
    assert.ok(r.changes.every((c) => typeof c === 'string' && c.trim()), `${r.version} 有空条目`);
  }
});

test('RELEASES 版本倒序、无重复', () => {
  const seen = new Set();
  for (let i = 0; i < V.RELEASES.length; i++) {
    const v = V.RELEASES[i].version;
    assert.ok(!seen.has(v), `重复版本：${v}`);
    seen.add(v);
    if (i + 1 < V.RELEASES.length) {
      assert.strictEqual(V.compare(v, V.RELEASES[i + 1].version), 1, `${v} 应新于 ${V.RELEASES[i + 1].version}`);
    }
  }
});

test('sidepanel 与 service-worker 都加载了 version.js', () => {
  assert.ok(read('src/sidepanel/sidepanel.html').includes('../shared/version.js'), '侧边栏没引入版本模块');
  assert.ok(read('src/background/service-worker.js').includes("'../shared/version.js'"), 'SW 没引入版本模块');
});

/* ---------- B. 当前版本读取 ---------- */
test('currentVersion() 读的是运行中的 manifest，不是缓存字符串', () => {
  globalThis.chrome = { runtime: { getManifest: () => ({ version: manifest.version }) } };
  assert.strictEqual(V.currentVersion(), manifest.version);
  globalThis.chrome = { runtime: { getManifest: () => ({ version: '9.9.9' }) } };
  assert.strictEqual(V.currentVersion(), '9.9.9');
});

test('getManifest 抛异常时返回空串，不让设置页崩掉', () => {
  globalThis.chrome = { runtime: { getManifest: () => { throw new Error('no manifest'); } } };
  assert.strictEqual(V.currentVersion(), '');
  delete globalThis.chrome;
  assert.strictEqual(V.currentVersion(), '');
});

/* ---------- C. 版本变化记录 ---------- */
test('首次记录：history 一条、来源为空、原因 install', () => {
  const m = V.record(null, manifest.version, T0, { reason: 'install' });
  assert.strictEqual(m.version, manifest.version);
  assert.strictEqual(m.previousVersion, '');
  assert.strictEqual(m.reason, 'install');
  assert.strictEqual(m.installedAt, T0);
  assert.strictEqual(m.updatedAt, T0);
  assert.strictEqual(m.history.length, 1);
  assert.deepStrictEqual(m.history[0], { version: manifest.version, from: '', reason: 'install', at: T0 });
});

test('升级：记下旧版本，历史插到最前', () => {
  const first = V.record(null, '0.4.9', T0 - 60000, { reason: 'install' });
  const next = V.record(first, manifest.version, T0, { reason: 'update', previousVersion: '0.4.9' });
  assert.strictEqual(next.previousVersion, '0.4.9');
  assert.strictEqual(next.installedAt, T0 - 60000, '首次安装时间不能被升级覆盖');
  assert.strictEqual(next.history.length, 2);
  assert.strictEqual(next.history[0].version, manifest.version);
  assert.strictEqual(next.history[0].from, '0.4.9');
  assert.strictEqual(next.history[1].version, '0.4.9');
});

test('同版本重载不重复记一条更新，只刷新生效时间', () => {
  const first = V.record(null, manifest.version, T0, { reason: 'install' });
  const reload = V.record(first, manifest.version, T0 + 5000, { reason: 'update', previousVersion: manifest.version });
  assert.strictEqual(reload.history.length, 1, '重载不应往历史里塞重复版本');
  assert.strictEqual(reload.reloadedAt, T0 + 5000);
  assert.strictEqual(reload.reloadCount, 1);
  assert.strictEqual(reload.updatedAt, T0);
  const again = V.record(reload, manifest.version, T0 + 9000, { reason: 'update', previousVersion: manifest.version });
  assert.strictEqual(again.reloadCount, 2);
  assert.strictEqual(again.history.length, 1);
});

test('onInstalled 与冷启动兜底撞在同一秒也只留一条版本记录', () => {
  const a = V.record(null, manifest.version, T0, { reason: 'update' });
  const b = V.record(a, manifest.version, T0 + 10, null);
  assert.strictEqual(b.history.length, 1);
  assert.strictEqual(b.history[0].version, manifest.version);
});

test('details.previousVersion 与缓存冲突时，以缓存里真正跑过的版本为准', () => {
  const prev = V.record(null, '0.4.8', T0 - 1000, { reason: 'install' });
  const next = V.record(prev, manifest.version, T0, { reason: 'update', previousVersion: '0.1.0' });
  assert.strictEqual(next.previousVersion, '0.4.8');
  assert.strictEqual(next.history[0].from, '0.4.8');
});

test('历史条数不超过 MAX_HISTORY', () => {
  const old = { version: '0.0.1', history: Array.from({ length: 30 }, (_, i) => ({ version: `0.0.${i}`, from: '', reason: 'update', at: T0 - i })) };
  const next = V.record(old, manifest.version, T0, { reason: 'update' });
  assert.strictEqual(next.history.length, V.MAX_HISTORY);
  assert.strictEqual(next.history[0].version, manifest.version);
});

test('降级或损坏的旧元数据也不会抛异常', () => {
  assert.doesNotThrow(() => V.record('bad', manifest.version, T0, null));
  assert.doesNotThrow(() => V.record({ version: '9.9.9', history: 'bad' }, manifest.version, T0, null));
  const down = V.record({ version: '9.9.9', history: [] }, manifest.version, T0, null);
  assert.strictEqual(down.previousVersion, '9.9.9');
  assert.strictEqual(down.history.length, 1);
});

/* ---------- D. 展示数据 ---------- */
test('describe 把当前版本的说明、来源、更新时间、历史都整理出来', () => {
  const first = V.record(null, '0.4.9', T0 - 60000, { reason: 'install' });
  const meta = V.record(first, manifest.version, T0, { reason: 'update' });
  const info = V.describe(manifest.version, meta);
  assert.strictEqual(info.version, manifest.version);
  assert.strictEqual(info.note.version, manifest.version);
  assert.strictEqual(info.latestReleased, manifest.version);
  assert.strictEqual(info.previousVersion, '0.4.9');
  assert.strictEqual(info.updatedAt, T0);
  assert.strictEqual(info.history.length, 2);
});

test('没有任何历史记录时，版本号与更新说明照样能显示', () => {
  const info = V.describe(manifest.version, null);
  assert.strictEqual(info.version, manifest.version);
  assert.ok(info.note, 'manifest 对应版本的说明必须存在');
  assert.strictEqual(info.previousVersion, '');
  assert.strictEqual(info.updatedAt, 0);
  assert.deepStrictEqual(info.history, []);
});

test('describe 对没有更新说明的版本返回 note=null，UI 走缺说明提示', () => {
  const info = V.describe('7.7.7', null);
  assert.strictEqual(info.note, null);
  assert.ok(V.copyText(info).includes('暂无更新说明'));
});

test('copyText 带版本号、更新说明和历史，可直接贴给开发者', () => {
  const first = V.record(null, '0.4.9', T0 - 60000, { reason: 'install' });
  const meta = V.record(first, manifest.version, T0, { reason: 'update' });
  const text = V.copyText(V.describe(manifest.version, meta));
  assert.ok(text.includes(`v${manifest.version}`));
  assert.ok(text.includes('v0.4.9 → v' + manifest.version));
  assert.ok(text.includes(V.noteFor(manifest.version).title));
  assert.ok(text.includes('版本记录：'));
});

/* ---------- E. 版本比较 ---------- */
test('compare 按数字段比较，0.10.0 不能输给 0.9.9', () => {
  assert.strictEqual(V.compare('0.10.0', '0.9.9'), 1);
  assert.strictEqual(V.compare('0.5.0', '0.5.0'), 0);
  assert.strictEqual(V.compare('v0.4.9', '0.5.0'), -1);
  assert.strictEqual(V.compare('0.5', '0.5.0'), 0);
});

console.log(`\nALL PASS — 版本与更新记录回归通过（${passed} 组）`);
