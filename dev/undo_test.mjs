// 撤销/重做：按钮、快捷键、各类操作的撤销、输入框不劫持。
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const BASE = process.env.URL || 'http://127.0.0.1:8743/inkbrief';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); }
};
const T = (label) => console.log(`\n── ${label} ──`);

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 940 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)));

await page.goto(BASE + '/index.html?debug=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.getElementById('boot')?.hidden === true, null, { timeout: 180000 });

T('准备');
ok('撤销按钮存在', await page.locator('#undoBtn').count() === 1);
ok('重做按钮存在', await page.locator('#redoBtn').count() === 1);
ok('一开始撤销是禁用的', await page.locator('#undoBtn').isDisabled());
ok('一开始重做是禁用的', await page.locator('#redoBtn').isDisabled());

await page.setInputFiles('#fileInput', [
  path.resolve('samples/sample-1.jpg'),
  path.resolve('samples/sample-2.jpg'),
  path.resolve('samples/sample-3.jpg'),
]);
await page.waitForFunction(() => window.__ink.state.assets.length === 3, null, { timeout: 30000 });
await page.fill('#rawScript', '第一段内容。\n第二段内容。\n第三段内容。');
await page.selectOption('#splitRule', 'line');
await page.click('#splitBtn');
await page.waitForFunction(() => window.__ink.state.segs.length === 3, null, { timeout: 10000 });
await page.click('#genBtn');
await page.waitForFunction(() => {
  const t = window.__ink.timeline;
  return t?.scenes?.length === 3 && t.scenes.every((s) => s.strokeCount > 0);
}, null, { timeout: 300000 });

T('删段 → 撤销 → 重做');
const before = await page.evaluate(() => window.__ink.state.segs.length);
await page.locator('.seg[data-segid]').nth(1).locator('.op.danger').click();
await page.waitForTimeout(400);
ok('段少了一段', await page.evaluate(() => window.__ink.state.segs.length) === before - 1);
ok('撤销按钮解禁了', !(await page.locator('#undoBtn').isDisabled()));

await page.locator('#undoBtn').click();
await page.waitForTimeout(400);
ok('撤销后段数回来了', await page.evaluate(() => window.__ink.state.segs.length) === before);
ok('重做按钮解禁了', !(await page.locator('#redoBtn').isDisabled()));
ok('段卡也回来了', await page.locator('.seg[data-segid]').count() === before);

await page.locator('#redoBtn').click();
await page.waitForTimeout(400);
ok('重做后又少一段', await page.evaluate(() => window.__ink.state.segs.length) === before - 1);
await page.locator('#undoBtn').click();
await page.waitForTimeout(400);

T('删图 → 撤销（图片要能回来）');
const assetCount = await page.evaluate(() => window.__ink.state.assets.length);
await page.locator('.thumb').first().hover();
await page.locator('.thumb .del').first().click();
await page.waitForTimeout(400);
ok('图少了一张', await page.evaluate(() => window.__ink.state.assets.length) === assetCount - 1);
await page.locator('#undoBtn').click();
await page.waitForTimeout(400);
ok('撤销后图回来了', await page.evaluate(() => window.__ink.state.assets.length) === assetCount);
ok('缩略图也回来了', await page.locator('.thumb').count() === assetCount);

T('换图 → 撤销');
const segId0 = await page.evaluate(() => window.__ink.state.segs[0].id);
const imgBefore = await page.evaluate(() => window.__ink.state.segs[0].imageIds[0]);
await page.evaluate(() => window.__ink.cycleAsset(window.__ink.state.segs[0]));
await page.waitForTimeout(300);
const imgAfter = await page.evaluate(() => window.__ink.state.segs[0].imageIds[0]);
ok('图换了', imgAfter !== imgBefore);
await page.locator('#undoBtn').click();
await page.waitForTimeout(400);
ok('撤销后换回来', await page.evaluate((id) => window.__ink.state.segs.find((s) => s.id === id).imageIds[0], segId0) === imgBefore);

T('段重排 → 撤销');
const textsBefore = await page.evaluate(() => window.__ink.state.segs.map((s) => s.text));
await page.locator('.seg[data-segid]').nth(2).locator('.op', { hasText: '上移' }).click();
await page.waitForTimeout(400);
const textsMoved = await page.evaluate(() => window.__ink.state.segs.map((s) => s.text));
ok('顺序变了', textsMoved[1] !== textsBefore[1], `${textsBefore.join('|')} → ${textsMoved.join('|')}`);
await page.locator('#undoBtn').click();
await page.waitForTimeout(400);
const textsBack = await page.evaluate(() => window.__ink.state.segs.map((s) => s.text));
ok('撤销后顺序恢复', JSON.stringify(textsBack) === JSON.stringify(textsBefore),
  `${textsBack.join('|')}`);

T('打字 → 撤销（连续打字合并成一步）');
await page.locator('.seg[data-segid]').nth(0).locator('textarea').fill('改过的文案。');
await page.waitForTimeout(700);
ok('文案改了', await page.evaluate(() => window.__ink.state.segs[0].text) === '改过的文案。');
await page.locator('#undoBtn').click();
await page.waitForTimeout(500);
ok('撤销后文案回来了', await page.evaluate(() => window.__ink.state.segs[0].text) === '第一段内容。',
  await page.evaluate(() => window.__ink.state.segs[0].text));

T('快捷键 Ctrl+Z / Ctrl+Shift+Z');
const n0 = await page.evaluate(() => window.__ink.state.segs.length);
await page.locator('.seg[data-segid]').nth(0).locator('.op.danger').click();
await page.waitForTimeout(400);
ok('删了一段', await page.evaluate(() => window.__ink.state.segs.length) === n0 - 1);
await page.locator('body').press('Control+z');
await page.waitForTimeout(400);
ok('Ctrl+Z 撤销了', await page.evaluate(() => window.__ink.state.segs.length) === n0);
await page.locator('body').press('Control+Shift+z');
await page.waitForTimeout(400);
ok('Ctrl+Shift+Z 重做了', await page.evaluate(() => window.__ink.state.segs.length) === n0 - 1);
await page.locator('body').press('Control+z');
await page.waitForTimeout(400);

T('输入框里不劫持 Ctrl+Z');
const ta = page.locator('.seg[data-segid]').nth(0).locator('textarea');
await ta.click();
await ta.press('Control+a');
await ta.type('abc');
await page.waitForTimeout(600);
const typed = await ta.inputValue();
ok('输入框里打字正常', typed.includes('abc'), typed);
// 在输入框里按 Ctrl+Z：文字应该被原生撤销，而不是触发全局撤销
const segsBefore = await page.evaluate(() => window.__ink.state.segs.length);
await ta.press('Control+z');
await page.waitForTimeout(400);
ok('没触发全局撤销', await page.evaluate(() => window.__ink.state.segs.length) === segsBefore);
ok('原生撤销生效了（文字变了）', (await ta.inputValue()) !== typed,
  `${typed} → ${await ta.inputValue()}`);

T('撤销后时间轴也跟着恢复');
const durBefore = await page.evaluate(() => window.__ink.timeline.scenes.map((s) => s.dur));
await page.evaluate(() => {
  const s = window.__ink.state.segs[0];
  s.manualMs = 5000;
  window.__ink.rebuild();
});
await page.waitForTimeout(300);
ok('时长变了', await page.evaluate(() => window.__ink.timeline.scenes[0].dur) !== durBefore[0]);

T('连续打字只占一步历史');
const depth0 = await page.evaluate(() => window.__ink.undoDepth());
const ta2 = page.locator('.seg[data-segid]').nth(1).locator('textarea');
await ta2.click();
await ta2.press('Control+a');
// 一个字一个字地打（每次 input 都触发一次）
for (const ch of '一二三四五') await ta2.type(ch);
await page.waitForTimeout(800);
const depth1 = await page.evaluate(() => window.__ink.undoDepth());
ok('连打 5 个字只多了 1 步历史', depth1 === depth0 + 1, `${depth0} → ${depth1}`);
ok('文字确实改了', (await ta2.inputValue()) === '一二三四五');
await page.locator('#undoBtn').click();
await page.waitForTimeout(500);
ok('一次撤销全回退', (await ta2.inputValue()) === '第二段内容。',
  await ta2.inputValue());

console.log('\nconsole errors:', errors.length, errors.slice(0, 5));
ok('无 console 错误', errors.length === 0);
console.log(`\n结果：${pass} 通过，${fail} 失败`);
await browser.close();
process.exit(fail ? 1 : 0);
