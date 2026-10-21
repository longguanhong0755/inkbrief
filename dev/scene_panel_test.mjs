// 右侧场景设置栏：选中联动、三个 tab 的改动能落到数据上。
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const BASE = process.env.URL || 'http://127.0.0.1:8743';

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

T('准备：3 图 3 段并生成笔触');
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
ok('3 屏已生成', true);

T('未选中时面板不出现');
ok('面板是隐藏的', await page.locator('#scenePanel').isHidden());
ok('布局没有多出第四列', !(await page.evaluate(() => document.querySelector('.grid').classList.contains('has-scene'))));

T('点时间轴 = 三处联动');
const b1 = await page.locator('.tl-block').nth(1).boundingBox();
await page.mouse.click(b1.x + b1.width / 2, b1.y + b1.height / 2);
await page.waitForTimeout(400);
ok('面板出现', await page.locator('#scenePanel').isVisible());
ok('时间轴块选中', await page.locator('.tl-block.sel').count() === 1);
ok('段卡也选中', await page.locator('.seg.sel').count() === 1);
const selId = await page.evaluate(() => window.__ink.state.selectedSeg);
ok('选中的是第 2 屏', await page.evaluate((id) => {
  const s = window.__ink.state.segs.find((x) => x.id === id);
  return s && s.text === '第二段内容。';
}, selId));
ok('面板标题写明第几屏', /第 2 屏/.test(await page.locator('#scenePanel .sp-head h2').textContent()));
ok('有三个 tab', await page.locator('.sp-tab').count() === 3);

T('画面 tab');
ok('显示当前屏的图', await page.locator('.sp-item .sp-thumb').count() >= 1);
ok('显示笔数信息', /笔/.test(await page.locator('.sp-item-sub').first().textContent()));
// 画不完时要有提示（4787 笔 / 1500ms 必然抽稀）
ok('画不完时给出提示', await page.locator('.sp-warn').count() >= 1,
  await page.locator('.sp-warn').first().textContent().catch(() => ''));

T('时间 tab：改时长要落到数据上');
await page.locator('.sp-tab', { hasText: '时间' }).click();
await page.waitForTimeout(250);
const durBefore = await page.evaluate(() => Math.round(window.__ink.timeline.scenes[1].dur));
// 把滑块推到最大（模拟一次完整拖动：input + change）
const slider = page.locator('#scenePanel .sp-range');
await slider.evaluate((el) => {
  el.value = String(Number(el.max));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(500);
const durAfter = await page.evaluate(() => Math.round(window.__ink.timeline.scenes[1].dur));
ok('时长变长了', durAfter > durBefore, `${durBefore}ms → ${durAfter}ms`);
ok('时长来源变成「手动」', /手动/.test(await page.locator('#scenePanel .sp-time-now').textContent()));
ok('「恢复自动时长」可用了', !(await page.locator('#scenePanel [data-act="auto"]').isDisabled()));

// 恢复自动
await page.locator('#scenePanel [data-act="auto"]').click();
await page.waitForTimeout(400);
const durAuto = await page.evaluate(() => Math.round(window.__ink.timeline.scenes[1].dur));
ok('恢复自动后回到估时', durAuto !== durAfter, `${durAfter}ms → ${durAuto}ms`);

T('时间 tab：时间去向明细');
const brk = await page.locator('#scenePanel .sp-break li').allTextContents();
ok('列出了作画时间', brk.some((t) => t.includes('作画')), brk.join(' | '));
ok('列出了结尾留白', brk.some((t) => t.includes('留白')));
ok('列出了字幕时长', brk.some((t) => t.includes('字幕')));

T('字幕 tab：分句');
await page.locator('.sp-tab', { hasText: '字幕' }).click();
await page.waitForTimeout(250);
ok('有一句字幕框', await page.locator('#scenePanel textarea[data-captext]').count() === 1);
ok('字幕位置三档可选', await page.locator('#scenePanel input[name="capPos"]').count() === 3);

// 加一句
await page.locator('#scenePanel [data-act="add-cap"]').click();
await page.waitForTimeout(400);
ok('加了一句后有两个框', await page.locator('#scenePanel textarea[data-captext]').count() === 2);
ok('数据里也是两句', await page.evaluate(() => {
  const s = window.__ink.state.segs.find((x) => x.id === window.__ink.state.selectedSeg);
  return s.paragraphs.length === 2;
}));
ok('空句不进成片', await page.evaluate(() => {
  const sc = window.__ink.timeline.scenes.find((x) => x.id === window.__ink.state.selectedSeg);
  return sc.paragraphs.length === 1;
}), '空的那句被过滤掉');

// 填第二句
await page.locator('#scenePanel textarea[data-captext="1"]').fill('这是新增的第二句字幕。');
await page.waitForTimeout(700);
ok('第二句进了数据', await page.evaluate(() => {
  const s = window.__ink.state.segs.find((x) => x.id === window.__ink.state.selectedSeg);
  return s.paragraphs[1] === '这是新增的第二句字幕。';
}));
ok('时间轴场景也是两句', await page.evaluate(() => {
  const sc = window.__ink.timeline.scenes.find((x) => x.id === window.__ink.state.selectedSeg);
  return sc.paragraphs.length === 2;
}));

T('字幕 tab：位置三档');
await page.locator('#scenePanel input[name="capPos"][value="upper"]').check();
await page.waitForTimeout(500);
ok('位置存进了数据', await page.evaluate(() => {
  const s = window.__ink.state.segs.find((x) => x.id === window.__ink.state.selectedSeg);
  return s.capPos === 'upper';
}));
ok('时间轴场景也跟着变', await page.evaluate(() => {
  const sc = window.__ink.timeline.scenes.find((x) => x.id === window.__ink.state.selectedSeg);
  return sc.capPos === 'upper';
}));

T('删掉一句');
await page.locator('#scenePanel [data-del]').first().click();
await page.waitForTimeout(500);
ok('回到一句', await page.locator('#scenePanel textarea[data-captext]').count() === 1);

T('点段卡空白 = 也选中');
await page.locator('.seg[data-segid]').nth(2).locator('.seg-head .wc').click();
await page.waitForTimeout(400);
ok('选中了第 3 屏', /第 3 屏/.test(await page.locator('#scenePanel .sp-head h2').textContent()));
ok('时间轴同步选中', await page.locator('.tl-block.sel').count() === 1);

T('窄屏降级为底部抽屉');
await page.setViewportSize({ width: 1200, height: 900 });
await page.waitForTimeout(500);
// 抽屉默认收起，选中一屏才弹出来
await page.locator('.tl-block').nth(0).click();
await page.waitForTimeout(600);
const drawer = await page.evaluate(() => {
  const p = document.getElementById('scenePanel');
  const r = p.getBoundingClientRect();
  const tl = document.getElementById('timeline').getBoundingClientRect();
  return {
    pos: getComputedStyle(p).position,
    top: r.top, bottom: r.bottom,
    vh: window.innerHeight,
    tlTop: tl.top,
  };
});
ok('窄屏下变成 fixed', drawer.pos === 'fixed', drawer.pos);
ok('抽屉在视口内', drawer.top >= 0 && drawer.bottom <= drawer.vh + 1,
  `顶 ${drawer.top.toFixed(0)} 底 ${drawer.bottom.toFixed(0)} / 视口 ${drawer.vh}`);
ok('抽屉浮在时间轴上方', drawer.bottom <= drawer.tlTop + 1,
  `抽屉底 ${drawer.bottom.toFixed(0)} / 时间轴顶 ${drawer.tlTop.toFixed(0)}`);
await page.screenshot({ path: 'dev/out/scene-drawer.png' });

T('面板不遮挡主内容');
await page.setViewportSize({ width: 1600, height: 940 });
await page.waitForTimeout(400);
const overlap = await page.evaluate(() => {
  const p = document.getElementById('scenePanel').getBoundingClientRect();
  const prev = document.querySelector('.pane-preview').getBoundingClientRect();
  return Math.max(0, Math.min(p.right, prev.right) - Math.max(p.left, prev.left))
       * Math.max(0, Math.min(p.bottom, prev.bottom) - Math.max(p.top, prev.top));
});
ok('与预览列不重叠', overlap === 0, `重叠 ${overlap.toFixed(0)}px²`);

console.log('\nconsole errors:', errors.length, errors.slice(0, 5));
ok('无 console 错误', errors.length === 0);
console.log(`\n结果：${pass} 通过，${fail} 失败`);
await browser.close();
process.exit(fail ? 1 : 0);
