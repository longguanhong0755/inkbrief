// 底部时间轴的断言：块宽 ∝ 时长、点选、右边缘改时长、中段拖重排、4 档缩放。
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
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)));
const cdp = await page.context().newCDPSession(page);

/** 显式发一个鼠标事件（button:'none' 是必须的，见 dragdrop_test.mjs 的说明） */
async function mouse(type, x, y, buttons = 0, mods = 0) {
  const isButton = type === 'mousePressed' || type === 'mouseReleased';
  await cdp.send('Input.dispatchMouseEvent', {
    type,
    x: Math.round(x),
    y: Math.round(y),
    button: isButton ? 'left' : 'none',
    buttons,
    clickCount: isButton ? 1 : 0,
    modifiers: mods,
  });
}

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

T('时间轴基本结构');
ok('时间轴容器存在', await page.locator('#timeline').count() === 1);
const nBlocks = await page.locator('.tl-block').count();
ok('每屏一块', nBlocks === 3, `${nBlocks} 块`);
ok('块上有屏号', (await page.locator('.tl-block .tl-no').first().textContent()) === '1');
ok('块上有时长', /s$/.test((await page.locator('.tl-block .tl-dur').first().textContent()).trim()));
ok('块上有笔数信息', /笔/.test(await page.locator('.tl-block .tl-meta').first().textContent()));
ok('有播放头', await page.locator('.tl-head').count() === 1);
ok('有 4 档缩放', await page.locator('.tl-zoom').count() === 4);

// 时间轴必须常驻可见：放在文档流末尾会被长文案顶出首屏，鼠标根本够不着
const vis = await page.evaluate(() => {
  const b = document.querySelector('.tl-block');
  const r = b.getBoundingClientRect();
  const tl = document.getElementById('timeline');
  return {
    top: r.top, bottom: r.bottom,
    vh: window.innerHeight,
    inView: r.top >= 0 && r.bottom <= window.innerHeight,
    atBottom: Math.abs(r.bottom - window.innerHeight) < 40,
    pos: getComputedStyle(tl).position,
  };
});
ok('时间轴在视口内', vis.inView, `块 ${vis.top.toFixed(0)}~${vis.bottom.toFixed(0)} / 视口 ${vis.vh}`);
ok('时间轴贴在视口底部', vis.atBottom, `底 ${vis.bottom.toFixed(0)} / 视口 ${vis.vh}`);

T('块宽 ∝ 时长');
// 造一屏明显更长的（改 manualMs），宽度必须按比例拉开
await page.evaluate(() => {
  const s = window.__ink.state.segs[2];
  s.manualMs = 4000;
  window.__ink.rebuild();
});
await page.waitForTimeout(300);
const widths = await page.evaluate(() => {
  const t = window.__ink.timeline;
  return {
    durs: t.scenes.map((s) => Math.round(s.dur)),
    widths: [...document.querySelectorAll('.tl-block')].map((b) => b.getBoundingClientRect().width),
  };
});
const ratios = widths.widths.map((w, i) => w / widths.durs[i]);
const spread = Math.max(...ratios) / Math.min(...ratios);
ok('每块的「宽/时长」一致', spread < 1.15,
  `宽 ${widths.widths.map((w) => w.toFixed(0)).join('/')} · 时长 ${widths.durs.join('/')}`);
ok('更长的那屏块更宽', widths.widths[2] > widths.widths[0] * 1.5,
  `${widths.widths[0].toFixed(0)} vs ${widths.widths[2].toFixed(0)}`);

T('点击块 = 选中并跳转播放头');
const second = await page.locator('.tl-block').nth(1).boundingBox();
await mouse('mouseMoved', second.x + second.width / 2, second.y + second.height / 2, 0);
await mouse('mousePressed', second.x + second.width / 2, second.y + second.height / 2, 1);
await mouse('mouseReleased', second.x + second.width / 2, second.y + second.height / 2, 0);
await page.waitForTimeout(200);
ok('块被选中', await page.locator('.tl-block.sel').count() === 1);
const ms = await page.evaluate(() => window.__ink.state.ms);
ok('播放头跳到那一屏', ms > 0, `${Math.round(ms)}ms`);
ok('段卡也高亮了', await page.locator('.seg.sel').count() === 1);

T('右边缘 8px = 改时长');
const before = await page.evaluate(() => Math.round(window.__ink.timeline.scenes[0].dur));
const b0 = await page.locator('.tl-block').first().boundingBox();
const gripX = b0.x + b0.width - 3;
await mouse('mouseMoved', gripX, b0.y + b0.height / 2, 0);
await mouse('mousePressed', gripX, b0.y + b0.height / 2, 1);
for (let i = 1; i <= 6; i++) {
  await mouse('mouseMoved', gripX + i * 10, b0.y + b0.height / 2, 1);
  await page.waitForTimeout(20);
}
await mouse('mouseReleased', gripX + 60, b0.y + b0.height / 2, 0);
await page.waitForTimeout(300);
const after = await page.evaluate(() => Math.round(window.__ink.timeline.scenes[0].dur));
ok('时长变长了', after > before, `${before}ms → ${after}ms`);

T('左边缘 = 拒绝（起点不能拖）');
const beforeLeft = await page.evaluate(() => Math.round(window.__ink.timeline.scenes[0].dur));
const b1 = await page.locator('.tl-block').first().boundingBox();
await mouse('mouseMoved', b1.x + 2, b1.y + b1.height / 2, 0);
await mouse('mousePressed', b1.x + 2, b1.y + b1.height / 2, 1);
for (let i = 1; i <= 5; i++) {
  await mouse('mouseMoved', b1.x + 2 - i * 8, b1.y + b1.height / 2, 1);
  await page.waitForTimeout(20);
}
await mouse('mouseReleased', b1.x - 38, b1.y + b1.height / 2, 0);
await page.waitForTimeout(300);
const afterLeft = await page.evaluate(() => Math.round(window.__ink.timeline.scenes[0].dur));
ok('时长没变', afterLeft === beforeLeft, `${beforeLeft}ms → ${afterLeft}ms`);
ok('给了说明为什么不能拖', /起点/.test(await page.locator('#previewHint').textContent()));

T('中段拖 = 重排');
const textsBefore = await page.evaluate(() => window.__ink.state.segs.map((s) => s.text));
const s0 = await page.locator('.tl-block').first().boundingBox();
const s2 = await page.locator('.tl-block').nth(2).boundingBox();
await mouse('mouseMoved', s0.x + s0.width / 2, s0.y + s0.height / 2, 0);
await mouse('mousePressed', s0.x + s0.width / 2, s0.y + s0.height / 2, 1);
for (let i = 1; i <= 8; i++) {
  await mouse('mouseMoved',
    s0.x + s0.width / 2 + ((s2.x + s2.width / 2 - s0.x - s0.width / 2) * i) / 8,
    s0.y + s0.height / 2, 1);
  await page.waitForTimeout(20);
}
await mouse('mouseReleased', s2.x + s2.width / 2, s2.y + s2.height / 2, 0);
await page.waitForTimeout(400);
const textsAfter = await page.evaluate(() => window.__ink.state.segs.map((s) => s.text));
ok('顺序变了', textsAfter[0] !== textsBefore[0], `${textsBefore.join('|')} → ${textsAfter.join('|')}`);

T('4 档缩放');
const w0 = await page.evaluate(() => document.querySelector('.tl-block').getBoundingClientRect().width);
await page.locator('.tl-zoom').nth(1).click();   // 1×
await page.waitForTimeout(200);
const w1 = await page.evaluate(() => document.querySelector('.tl-block').getBoundingClientRect().width);
await page.locator('.tl-zoom').nth(2).click();   // 2×
await page.waitForTimeout(200);
const w2 = await page.evaluate(() => document.querySelector('.tl-block').getBoundingClientRect().width);
ok('1× 比适应模式宽', w1 > w0, `${w0.toFixed(0)} → ${w1.toFixed(0)}`);
ok('2× 比 1× 宽', w2 > w1, `${w1.toFixed(0)} → ${w2.toFixed(0)}`);
ok('当前档位有高亮', await page.locator('.tl-zoom.on').count() === 1);
await page.locator('.tl-zoom').nth(0).click();   // 回到适应
await page.waitForTimeout(200);
ok('能回到适应模式', await page.locator('.tl-zoom.on').getAttribute('data-zoom') === 'fit');

T('窄屏不横向溢出');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok('390px 无横向溢出', overflow <= 2, `溢出 ${overflow}px`);

console.log('\nconsole errors:', errors.length, errors.slice(0, 5));
ok('无 console 错误', errors.length === 0);
console.log(`\n结果：${pass} 通过，${fail} 失败`);
await browser.close();
process.exit(fail ? 1 : 0);
