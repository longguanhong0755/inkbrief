// 拖拽绑定的断言：真的用指针把图从左栏拖到段卡上。
//
// 为什么不用 page.mouse.*：
//   Playwright 的 mouse.move() 在按钮按下时会自动补一个 mouseReleased，
//   拖拽会在第一步就结束（pointerup 先于 pointermove 到）。
//   这里直接用 CDP 的 Input.dispatchMouseEvent 显式带 buttons 字段，
//   才能真实复现「按住左键拖动」。
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const BASE = process.env.URL || 'http://127.0.0.1:8742';

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

/**
 * 显式发一个鼠标事件。
 * 注意：mouseMoved 的 button 必须是 'none'——传 'left' 会让浏览器当成新的按键动作，
 * e.button/e.buttons 状态错乱，pointerdown 的判断会失效（拖拽根本起不来）。
 */
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

const ALT = 1; // CDP modifiers: Alt=1

/** 把第 n 个缩略图拖到目标元素上 */
async function dragTo(thumbIndex, targetSel, opts = {}) {
  const src = page.locator('.thumb').nth(thumbIndex);
  const dst = page.locator(targetSel).first();
  const sb = await src.boundingBox();
  const db = await dst.boundingBox();
  if (!sb || !db) throw new Error('拿不到坐标：' + targetSel);
  const from = { x: sb.x + sb.width / 2, y: sb.y + sb.height / 2 };
  const to = {
    x: db.x + db.width * (opts.fx ?? 0.5),
    y: db.y + db.height * (opts.fy ?? 0.5),
  };
  const mods = opts.alt ? ALT : 0;

  await mouse('mouseMoved', from.x, from.y, 0, mods);
  await mouse('mousePressed', from.x, from.y, 1, mods);
  // 分几步移动，每步都保持 buttons=1
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved',
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
      1, mods);
    await page.waitForTimeout(15);
  }
  await page.waitForTimeout(60);
  if (opts.screenshot) await page.screenshot({ path: opts.screenshot });
  await mouse('mouseReleased', to.x, to.y, 0, mods);
  await page.waitForTimeout(250);
}

/** 把第 2 段的第 from 个槽位拖到第 to 个槽位的左半/右半 */
async function dragSlotToSlot(from, to, side = 'right') {
  const src = page.locator('.seg[data-segid]:nth-of-type(2) .slot[data-slot-index="' + from + '"]');
  const dst = page.locator('.seg[data-segid]:nth-of-type(2) .slot[data-slot-index="' + to + '"]');
  const sb = await src.boundingBox();
  const db = await dst.boundingBox();
  if (!sb || !db) throw new Error('拿不到槽位坐标');
  const from2 = { x: sb.x + sb.width / 2, y: sb.y + sb.height / 2 };
  const to2 = { x: db.x + db.width * (side === 'left' ? 0.2 : 0.8), y: db.y + db.height / 2 };
  await mouse('mouseMoved', from2.x, from2.y, 0);
  await mouse('mousePressed', from2.x, from2.y, 1);
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved',
      from2.x + ((to2.x - from2.x) * i) / steps,
      from2.y + ((to2.y - from2.y) * i) / steps,
      1);
    await page.waitForTimeout(15);
  }
  await page.waitForTimeout(60);
  await mouse('mouseReleased', to2.x, to2.y, 0);
  await page.waitForTimeout(250);
}

await page.goto(BASE + '/index.html?debug=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.getElementById('boot')?.hidden === true, null, { timeout: 180000 });

T('准备');
await page.setInputFiles('#fileInput', [
  path.resolve('samples/sample-1.jpg'),
  path.resolve('samples/sample-2.jpg'),
  path.resolve('samples/sample-3.jpg'),
]);
await page.waitForFunction(() => window.__ink.state.assets.length === 3, null, { timeout: 30000 });
await page.fill('#rawScript', '第一段。\n第二段。\n第三段。');
await page.selectOption('#splitRule', 'line');
await page.click('#splitBtn');
await page.waitForFunction(() => window.__ink.state.segs.length === 3, null, { timeout: 10000 });
ok('3 段已就绪', true);

await page.evaluate(() => {
  const st = window.__ink.state;
  window.__ink.setSegImages(st.segs[0].id, []);
  window.__ink.setSegImages(st.segs[1].id, []);
});
ok('前两段已清空', await page.evaluate(() => window.__ink.state.segs[0].imageIds.length === 0));

T('拖到段卡空白 = 追加为多图');
await dragTo(0, '.seg[data-segid]');
const a0 = await page.evaluate(() => window.__ink.state.segs[0].imageIds.length);
ok('第 1 段多了一张图', a0 === 1, `${a0} 张`);

T('拖到已有图的左半 = 插到它前面');
// 第 2 段放图 1、图 3；把图 2 拖到第 1 张前面
await page.evaluate(() => {
  const st = window.__ink.state;
  window.__ink.setSegImages(st.segs[1].id, [st.assets[0].id, st.assets[2].id]);
});
const before = await page.evaluate(() => window.__ink.state.segs[1].imageIds);
const dragged2 = await page.evaluate(() => window.__ink.state.assets[1].id);
await dragTo(1, '.seg[data-segid]:nth-of-type(2) .slot[data-slot-index="0"]', { fx: 0.2 });
const after = await page.evaluate(() => window.__ink.state.segs[1].imageIds);
ok('插到了第 1 张前面', after[0] === dragged2 && after[1] === before[0] && after.length === before.length + 1,
  `${before.join(',')} → ${after.join(',')}`);

T('拖到已有图的右半 = 插到它后面');
// 把图 3 拖到第 1 张后面（图 3 现在在第 2 位，但换个源避免歧义）
const before2 = await page.evaluate(() => window.__ink.state.segs[1].imageIds);
const dragged3 = await page.evaluate(() => window.__ink.state.assets[2].id);
await dragTo(2, '.seg[data-segid]:nth-of-type(2) .slot[data-slot-index="0"]', { fx: 0.8 });
const after2 = await page.evaluate(() => window.__ink.state.segs[1].imageIds);
ok('插到了第 1 张后面', after2[1] === dragged3 && after2.length === before2.length,
  `${before2.join(',')} → ${after2.join(',')}`);

T('段内拖槽位 = 调整这一屏里图的先后');
const before3 = await page.evaluate(() => window.__ink.state.segs[1].imageIds);
const firstId = before3[0];
// 把第 1 个槽位拖到第 2 个槽位的右半
await dragSlotToSlot(0, 1, 'right');
const after3 = await page.evaluate(() => window.__ink.state.segs[1].imageIds);
ok('顺序变了', after3[0] !== firstId, `${before3.join(',')} → ${after3.join(',')}`);
ok('长度没变（是排序不是新增）', after3.length === before3.length);
ok('没有出现重复的图', new Set(after3).size === after3.length, after3.join(','));

T('按住 Alt 拖 = 替换那一槽');
// 清空第 2 段，只放图 1；然后把图 2 按住 Alt 拖到这个槽位上
await page.evaluate(() => {
  const st = window.__ink.state;
  window.__ink.setSegImages(st.segs[1].id, [st.assets[0].id]);
});
const beforeAlt = await page.evaluate(() => window.__ink.state.segs[1].imageIds);
const altAsset = await page.evaluate(() => window.__ink.state.assets[1].id);
await dragTo(1, '.seg[data-segid]:nth-of-type(2) .slot[data-slot-index="0"]', { fx: 0.5, alt: true });
const afterAlt = await page.evaluate(() => window.__ink.state.segs[1].imageIds);
ok('槽位被换成了别的图', afterAlt[0] === altAsset && afterAlt.length === beforeAlt.length,
  `${beforeAlt.join(',')} → ${afterAlt.join(',')}`);

T('没有 Alt 时是插入不是替换');
await page.evaluate(() => {
  const st = window.__ink.state;
  window.__ink.setSegImages(st.segs[1].id, [st.assets[0].id]);
});
const beforeNoAlt = await page.evaluate(() => window.__ink.state.segs[1].imageIds);
await dragTo(1, '.seg[data-segid]:nth-of-type(2) .slot[data-slot-index="0"]', { fx: 0.5 });
const afterNoAlt = await page.evaluate(() => window.__ink.state.segs[1].imageIds);
ok('变成了两张图', afterNoAlt.length === beforeNoAlt.length + 1, `${beforeNoAlt.join(',')} → ${afterNoAlt.join(',')}`);
ok('原来那张还在', afterNoAlt.includes(beforeNoAlt[0]));

T('拖拽视觉反馈');
const sb = await page.locator('.thumb').first().boundingBox();
await mouse('mouseMoved', sb.x + sb.width / 2, sb.y + sb.height / 2, 0);
await mouse('mousePressed', sb.x + sb.width / 2, sb.y + sb.height / 2, 1);
await mouse('mouseMoved', sb.x + sb.width / 2 + 60, sb.y + sb.height / 2 + 30, 1);
await page.waitForTimeout(120);
const mid = await page.evaluate(() => ({
  ghost: document.querySelectorAll('.drag-ghost').length,
  dragging: document.querySelectorAll('.thumb.dragging').length,
  badge: document.querySelector('.drag-ghost .ghost-badge')?.textContent || '',
}));
ok('出现了跟手的 ghost', mid.ghost === 1);
ok('源元素变半透明', mid.dragging === 1);
ok('ghost 上有说明文字', mid.badge.length > 0, mid.badge);
await page.screenshot({ path: 'dev/out/drag-ghost.png' });
await mouse('mouseReleased', sb.x + sb.width / 2 + 60, sb.y + sb.height / 2 + 30, 0);
await page.waitForTimeout(150);
ok('松手后 ghost 消失', await page.locator('.drag-ghost').count() === 0);

T('落点高亮');
await mouse('mouseMoved', sb.x + sb.width / 2, sb.y + sb.height / 2, 0);
await mouse('mousePressed', sb.x + sb.width / 2, sb.y + sb.height / 2, 1);
const segBox = await page.locator('.seg[data-segid]').first().boundingBox();
await mouse('mouseMoved', segBox.x + segBox.width / 2, segBox.y + segBox.height / 2, 1);
await page.waitForTimeout(120);
ok('段卡被高亮', await page.locator('.seg.drop-on').count() >= 1);
await mouse('mouseReleased', segBox.x + segBox.width / 2, segBox.y + segBox.height / 2, 0);
await page.waitForTimeout(150);
ok('松手后高亮消失', await page.locator('.drop-on').count() === 0);

T('拖拽不会改段数');
const n = await page.evaluate(() => window.__ink.state.segs.length);
ok('段数没变', n === 3, `${n}`);

console.log('\nconsole errors:', errors.length, errors.slice(0, 5));
ok('无 console 错误', errors.length === 0);
console.log(`\n结果：${pass} 通过，${fail} 失败`);
await browser.close();
process.exit(fail ? 1 : 0);
