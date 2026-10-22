// 边界与异常：竖屏 1080x1920、无配音、空文案、非图片文件、超段合并。
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  PASS ${n}${d ? '  ' + d : ''}`); } else { fail++; console.log(`  FAIL ${n}${d ? '  ' + d : ''}`); } };

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)));

const BASE = process.env.URL || 'http://127.0.0.1:8743/inkbrief';

await page.goto(BASE + '/index.html?debug=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.getElementById('boot')?.hidden === true, null, { timeout: 180000 });

console.log('── 空状态 ──');
ok('生成按钮禁用', await page.locator('#genBtn').isDisabled());
ok('播放按钮禁用', await page.locator('#playBtn').isDisabled());
ok('导出按钮禁用', await page.locator('#expBtn').isDisabled());
ok('遮罩提示存在', await page.locator('#stageEmpty').isVisible());

console.log('── 非图片文件 ──');
await page.setInputFiles('#fileInput', [{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') }]);
await page.waitForTimeout(500);
ok('拒绝非图片', (await page.evaluate(() => window.__ink.state.assets.length)) === 0);
ok('给出提示', /不是图片/.test(await page.locator('#previewHint').textContent()));

console.log('── 只加图不加文案 ──');
await page.setInputFiles('#fileInput', [path.resolve('samples/sample-3.jpg')]);
await page.waitForFunction(() => window.__ink.state.assets.length === 1, null, { timeout: 30000 });
ok('图已载入', true);
ok('无文案时仍禁用生成', await page.locator('#genBtn').isDisabled());

console.log('── 超段合并 ──');
const many = Array.from({ length: 15 }, (_, i) => `第 ${i + 1} 段内容。`).join('\n\n');
await page.fill('#rawScript', many);
await page.click('#splitBtn');
await page.waitForTimeout(400);
const segN = await page.evaluate(() => window.__ink.state.segs.length);
ok('最多 12 段', segN === 12, `实际 ${segN}`);

console.log('── 竖屏 1080x1920 ──');
await page.fill('#rawScript', '竖屏也要能正常出片。');
await page.click('#splitBtn');
await page.waitForTimeout(300);
await page.selectOption('#aspect', '1080x1920');
await page.waitForTimeout(300);
const dims = await page.evaluate(() => {
  const c = document.getElementById('stage');
  return { w: c.width, h: c.height, portrait: c.parentElement.classList.contains('portrait') };
});
ok('画布切到竖屏', dims.w === 1080 && dims.h === 1920, JSON.stringify(dims));
ok('容器套用竖屏样式', dims.portrait);

await page.click('#genBtn');
await page.waitForFunction(() => window.__ink.timeline?.scenes?.[0]?.strokeCount > 0, null, { timeout: 300000 });
const render = await page.evaluate(() => {
  const t = window.__ink.timeline;
  window.__ink.renderAt(t.totalMs * 0.6);
  const cv = document.getElementById('stage');
  const x = cv.getContext('2d');
  const d = x.getImageData(0, 0, cv.width, cv.height).data;
  let ink = 0, tot = 0;
  for (let i = 0; i < d.length; i += 4 * 7) {
    tot++;
    if ((d[i] + d[i + 1] + d[i + 2]) / 3 < 200) ink++;
  }
  return { total: Math.round(t.totalMs), ink: +(ink / tot).toFixed(3) };
});
ok('竖屏能画出内容', render.ink > 0.08, `墨迹 ${(render.ink * 100).toFixed(1)}%`);
ok('竖屏时长按字数估', render.total >= 1000 && render.total < 9000, `${render.total}ms`);

console.log('── 无配音也能导出 ──');
const exp = await page.evaluate(async () => {
  document.getElementById('expBtn').click();
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (window.__ink.lastExport) break;
  }
  const r = window.__ink.lastExport;
  if (!r) return null;
  // 大小不可靠：无配音时画面平坦，1080p 白纸+墨迹压出来可能只有几十 KB。
  // 真正该验的是容器合法、MIME 是视频。
  const head = [...new Uint8Array(await r.blob.slice(0, 12).arrayBuffer())]
    .map((b) => b.toString(16).padStart(2, '0')).join(' ');
  return { size: r.blob.size, mime: r.mime, audioMs: Math.round(r.audioMs), head };
});
const headOk = !!exp && ((exp.head.startsWith('00 00 00') && exp.head.includes('66 74 79 70')) || exp.head.startsWith('1a 45 df a3'));
ok('无配音仍产出视频', !!exp && exp.size > 0 && /^video\//.test(exp.mime || '') && headOk,
  exp ? `${(exp.size / 1024).toFixed(0)}KB ${exp.mime} head=${exp.head.slice(0, 24)}` : 'null');

console.log('── 手机宽度 ──');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok('390px 无横向溢出', overflow <= 2, `溢出 ${overflow}px`);

console.log('\nconsole errors:', errors.length, errors.slice(0, 4));
ok('无 console 错误', errors.length === 0);
console.log(`\n结果：${pass} 通过，${fail} 失败`);
await browser.close();
process.exit(fail ? 1 : 0);
