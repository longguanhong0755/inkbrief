// 交互层断言：分段规则、多图、字幕分句/位置、拆分合并重排删除。
// 原则：离线脚本，不依赖人工点网页。
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

await page.goto(BASE + '/index.html?debug=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.getElementById('boot')?.hidden === true, null, { timeout: 180000 });

T('分段规则');
await page.setInputFiles('#fileInput', [
  path.resolve('samples/sample-1.jpg'),
  path.resolve('samples/sample-2.jpg'),
  path.resolve('samples/sample-3.jpg'),
]);
await page.waitForFunction(() => window.__ink.state.assets.length === 3, null, { timeout: 30000 });

const splitWith = async (rule, text) => {
  await page.selectOption('#splitRule', rule);
  await page.fill('#rawScript', text);
  await page.click('#splitBtn');
  await page.waitForTimeout(300);
  return page.evaluate(() => window.__ink.state.segs.map((s) => s.text));
};

ok('按空行切', (await splitWith('blank', '甲。\n\n乙。\n\n丙。')).length === 3);
ok('按每行切', (await splitWith('line', '甲。\n乙。\n丙。')).length === 3);
ok('按每句切', (await splitWith('sentence', '甲。乙。丙。')).length === 3);
const auto = await splitWith('auto', '甲。\n\n乙。\n\n丙。');
ok('自动：有空行按空行', auto.length === 3);
const auto2 = await splitWith('auto', '甲。乙。丙。');
ok('自动：无空行按句', auto2.length === 3, JSON.stringify(auto2));
ok('规则选择器存在', await page.locator('#splitRule').count() === 1);

T('一屏多图');
await splitWith('line', '第一段。\n第二段。');
const multi = await page.evaluate(() => {
  const st = window.__ink.state;
  window.__ink.setSegImages(st.segs[0].id, [st.assets[0].id, st.assets[1].id], [3, 1]);
  const sc = window.__ink.timeline.scenes[0];
  return {
    items: sc.items.length,
    d0: sc.items[0].dur,
    d1: sc.items[1].dur,
    ids: sc.imageIds.length,
  };
});
ok('一屏两个分片', multi.items === 2);
ok('两张图都进了这一屏', multi.ids === 2);
ok('权重 3:1 反映在时长上', Math.abs(multi.d0 / multi.d1 - 3) < 0.06, `${multi.d0}/${multi.d1}`);
ok('段卡画出两个槽位', await page.locator('.seg').first().locator('.slot').count() === 2);

T('字幕分句');
const caps = await page.evaluate(() => {
  const st = window.__ink.state;
  window.__ink.setSegCaptions(st.segs[0].id, ['第一句。', '第二句。']);
  const sc = window.__ink.timeline.scenes[0];
  return sc.capSpans.map((x) => ({ t: x.text, s: x.start, d: x.dur }));
});
ok('切成两个字幕时间窗', caps.length === 2);
ok('首句从 0 开始', caps[0].s === 0);
ok('两窗首尾相接', caps[0].s + caps[0].d === caps[1].s);
ok('段卡文本框显示两行', (await page.locator('.seg').first().locator('textarea').inputValue()).includes('\n'));

T('字幕位置三档');
for (const [pos, check] of [
  ['bottom', 'bottom'], ['lower', 'lower'], ['upper', 'upper'],
]) {
  const got = await page.evaluate((p) => {
    const st = window.__ink.state;
    window.__ink.setSegCaptions(st.segs[0].id, st.segs[0].paragraphs, p);
    return window.__ink.timeline.scenes[0].capPos;
  }, pos);
  ok(`字幕位置 ${pos}`, got === check);
}
const capBox = await page.evaluate(() => {
  const st = window.__ink.state;
  const read = (p) => {
    window.__ink.setSegCaptions(st.segs[0].id, st.segs[0].paragraphs, p);
    window.__ink.renderAt(window.__ink.timeline.scenes[0].start + 800);
    const cv = document.getElementById('stage');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    // 找字幕墨迹的纵向分布
    let top = -1, bottom = -1;
    for (let y = 0; y < cv.height; y += 2) {
      for (let x = 0; x < cv.width; x += 4) {
        const i = (y * cv.width + x) * 4;
        if (d[i] < 120 && d[i + 1] < 120 && d[i + 2] < 120) {
          if (top < 0) top = y;
          bottom = y;
          break;
        }
      }
    }
    return { top, bottom };
  };
  return { b: read('bottom'), u: read('upper') };
});
ok('置顶时字幕明显比贴底高', capBox.u.top < capBox.b.top - 100,
  `贴底 ${capBox.b.top}px vs 置顶 ${capBox.u.top}px`);

T('段落拆分 / 合并 / 重排 / 删除');
const n0 = await page.evaluate(() => window.__ink.state.segs.length);
await page.evaluate(() => {
  const ta = document.querySelector('.seg textarea');
  ta.focus();
  ta.setSelectionRange(2, 2);
});
await page.locator('.seg .op[data-op="split"]').first().click();
await page.waitForTimeout(300);
const n1 = await page.evaluate(() => window.__ink.state.segs.length);
ok('拆分：段数 +1', n1 === n0 + 1, `${n0} → ${n1}`);

await page.locator('.seg .op[data-op="merge-next"]').first().click();
await page.waitForTimeout(300);
const n2 = await page.evaluate(() => window.__ink.state.segs.length);
ok('并入下一段：段数 -1', n2 === n0, `${n1} → ${n2}`);

const before = await page.evaluate(() => window.__ink.state.segs.map((s) => s.text));
await page.locator('.seg .op[data-op="down"]').first().click();
await page.waitForTimeout(300);
const after = await page.evaluate(() => window.__ink.state.segs.map((s) => s.text));
ok('下移：顺序变了', after[0] === before[1] && after[1] === before[0], JSON.stringify(after));

// 原第二段现在在索引 0，点索引 1 的「上移」把它挪回去
await page.locator('.seg').nth(1).locator('.op[data-op="up"]').click();
await page.waitForTimeout(300);
const back = await page.evaluate(() => window.__ink.state.segs.map((s) => s.text));
ok('上移：顺序复原', JSON.stringify(back) === JSON.stringify(before), JSON.stringify(back));

const n3 = await page.evaluate(() => window.__ink.state.segs.length);
await page.locator('.seg .op[data-op="del"]').first().click();
await page.waitForTimeout(300);
const n4 = await page.evaluate(() => window.__ink.state.segs.length);
ok('删除：段数 -1', n4 === n3 - 1, `${n3} → ${n4}`);

T('素材排序');
const a0 = await page.evaluate(() => window.__ink.state.assets.map((a) => a.name));
await page.locator('.thumb').first().locator('.dn').click();
await page.waitForTimeout(300);
const a1 = await page.evaluate(() => window.__ink.state.assets.map((a) => a.name));
ok('往后挪：顺序变了', a1[0] === a0[1] && a1[1] === a0[0], JSON.stringify(a1));
await page.locator('.thumb').nth(1).locator('.up').click();
await page.waitForTimeout(300);
const a2 = await page.evaluate(() => window.__ink.state.assets.map((a) => a.name));
ok('往前挪：顺序复原', JSON.stringify(a2) === JSON.stringify(a0));

T('未配图的段不静默吞掉');
await page.evaluate(() => {
  const st = window.__ink.state;
  window.__ink.setSegImages(st.segs[0].id, []);
});
await page.waitForTimeout(200);
const hint = await page.locator('#unboundHint').textContent();
ok('给出汇总提示', /没配图/.test(hint), hint);
ok('提示是可见的', await page.locator('#unboundHint').isVisible());
const nScenes = await page.evaluate(() => window.__ink.timeline?.scenes?.length ?? 0);
const nSegs = await page.evaluate(() => window.__ink.state.segs.length);
ok('未配图的段不进成片', nScenes < nSegs, `${nSegs} 段 → ${nScenes} 屏`);

console.log('\nconsole errors:', errors.length, errors.slice(0, 5));
ok('无 console 错误', errors.length === 0);
console.log(`\n结果：${pass} 通过，${fail} 失败`);
await browser.close();
process.exit(fail ? 1 : 0);
