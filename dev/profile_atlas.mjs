// 掩膜打包成本细分：JS 像素循环 vs putImageData 上传，各占多少。
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const BASE = process.env.URL || 'http://127.0.0.1:8743/inkbrief';
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(BASE + '/index.html?debug=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.getElementById('boot')?.hidden === true, null, { timeout: 180000 });
await page.setInputFiles('#fileInput', [path.resolve('samples/sample-1.jpg'), path.resolve('samples/sample-2.jpg')]);
await page.waitForFunction(() => window.__ink.state.assets.length === 2, null, { timeout: 30000 });
await page.fill('#rawScript', '第一段文案在这里。\n\n第二段文案也在这里，稍微长一点点。');
await page.click('#splitBtn');
await page.waitForFunction(() => window.__ink.state.segs.length === 2, null, { timeout: 10000 });
await page.evaluate(() => {
  const segs = window.__ink.state.segs;
  const ids = window.__ink.state.assets.map((a) => a.id);
  segs.forEach((s, i) => window.__ink.setSegImages(s.id, [ids[i % ids.length]]));
});
await page.click('#genBtn');
await page.waitForFunction(() => {
  const t = window.__ink.timeline;
  return t?.scenes?.length === 2 && t.scenes.every((s) => s.strokeCount > 0);
}, null, { timeout: 300000 });
await page.waitForTimeout(800);

const out = await page.evaluate(() => {
  const ink = window.__ink;
  const st = ink.state;
  const sc = st.timeline.scenes[st.timeline.scenes.length - 1];
  ink.renderAt(sc.start + 1);
  let rec = null;
  for (const r of st.renderers.values()) if (r.key === sc.id || r.key.startsWith(sc.id + '#')) { rec = r; break; }
  const C = rec.rd.C;
  const clips = [];
  for (const c of C) if (c && c.mask) clips.push(c);

  let totalPx = 0;
  for (const c of clips) totalPx += c.mask.length;

  // A) 纯 JS 像素循环（不涉及画布）
  const buf = new Uint32Array(4 * 1024 * 1024);
  let t0 = performance.now();
  let acc = 0;
  for (const c of clips) {
    const m = c.mask;
    for (let i = 0; i < m.length; i++) { buf[i & 0xfffff] = m[i] ? 0xffffffff : 0; acc += buf[i & 0xfffff]; }
  }
  const tJs = performance.now() - t0;

  // B) 逐 clip createImageData + putImageData（现在的做法）
  const cv = document.createElement('canvas');
  cv.width = 2048; cv.height = 2048;
  const ctx = cv.getContext('2d');
  t0 = performance.now();
  for (const c of clips) {
    const id = ctx.createImageData(c.w, c.h);
    const u32 = new Uint32Array(id.data.buffer);
    for (let i = 0; i < c.mask.length; i++) u32[i] = c.mask[i] ? 0xffffffff : 0;
    ctx.putImageData(id, 0, 0);
  }
  const tPerClip = performance.now() - t0;

  // C) 整页 ImageData，一次 putImageData
  const cv2 = document.createElement('canvas');
  cv2.width = 2048; cv2.height = 2048;
  const ctx2 = cv2.getContext('2d');
  const pageImg = ctx2.createImageData(2048, 2048);
  const pu32 = new Uint32Array(pageImg.data.buffer);
  t0 = performance.now();
  let ox = 0, oy = 0, rowH = 0, pg = 0;
  const pages = [];
  for (const c of clips) {
    if (ox + c.w > 2048) { ox = 0; oy += rowH + 1; rowH = 0; }
    if (oy + c.h > 2048) { ctx2.putImageData(pageImg, 0, 0); pages.push(1); pg++; ox = 0; oy = 0; rowH = 0; }
    const m = c.mask;
    for (let y = 0; y < c.h; y++) {
      const src = y * c.w, dst = (oy + y) * 2048 + ox;
      for (let x = 0; x < c.w; x++) pu32[dst + x] = m[src + x] ? 0xffffffff : 0;
    }
    ox += c.w + 1;
    if (c.h > rowH) rowH = c.h;
  }
  ctx2.putImageData(pageImg, 0, 0);
  const tWholePage = performance.now() - t0;

  // D) 只做 putImageData 不做像素循环（隔离上传成本）
  t0 = performance.now();
  for (let i = 0; i < clips.length; i++) {
    const id = ctx.createImageData(Math.max(1, clips[i].w), Math.max(1, clips[i].h));
    ctx.putImageData(id, 0, 0);
  }
  const tUploadOnly = performance.now() - t0;

  return {
    clipCount: clips.length, totalPx,
    tJsLoop: +tJs.toFixed(0),
    tPerClip: +tPerClip.toFixed(0),
    tWholePage: +tWholePage.toFixed(0),
    tUploadOnly: +tUploadOnly.toFixed(0),
    pages,
  };
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
