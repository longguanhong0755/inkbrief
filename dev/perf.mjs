// 性能探测：管线笔数 / 单笔渲染耗时 / 导出实时率。
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const BASE = process.env.URL || 'http://127.0.0.1:8742';
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

await page.goto(BASE + '/index.html?debug=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.getElementById('boot')?.hidden === true, null, { timeout: 180000 });

await page.setInputFiles('#fileInput', [path.resolve('samples/sample-1.jpg'), path.resolve('samples/sample-2.jpg')]);
await page.waitForFunction(() => window.__ink.state.assets.length === 2, null, { timeout: 30000 });
await page.fill('#rawScript', '第一段文案在这里。\n\n第二段文案也在这里，稍微长一点点。');
await page.click('#splitBtn');
await page.waitForFunction(() => window.__ink.state.segs.length === 2, null, { timeout: 10000 });

const t0 = Date.now();
await page.click('#genBtn');
await page.waitForFunction(() => {
  const t = window.__ink.timeline;
  return t?.scenes?.length === 2 && t.scenes.every((s) => s.strokeCount > 0);
}, null, { timeout: 300000 });
const genMs = Date.now() - t0;

const info = await page.evaluate(() => window.__ink.state.assets.map((a) => ({ n: a.name, w: a.w, h: a.h, strokes: a.strokes.length, ms: Math.round(a.pipelineMs) })));
console.log('生成', (genMs / 1000).toFixed(1) + 's', JSON.stringify(info));

const tl = await page.evaluate(() => window.__ink.timeline.scenes.map((s) => ({ dur: Math.round(s.dur), keep: s.keep, n: s.strokeCount })));
console.log('时间轴', JSON.stringify(tl));

// 渲染耗时：整段逐帧推进
const perf = await page.evaluate(() => {
  const tl = window.__ink.timeline;
  const out = [];
  for (const sc of tl.scenes) {
    window.__ink.renderAt(sc.start + 1);
    const t0 = performance.now();
    const N = 30;
    for (let i = 1; i <= N; i++) window.__ink.renderAt(sc.start + (sc.dur * i) / N);
    const ms = performance.now() - t0;
    // 固定开销：同一个时刻渲染 5 次（没有新笔）
    const t1 = performance.now();
    for (let i = 0; i < 5; i++) window.__ink.renderAt(sc.start + sc.dur * 0.99);
    const fixed = (performance.now() - t1) / 5;

    // 单笔成本：直接驱动 renderer
    const rec = window.__ink.state.renderers.get(sc.id);
    let per = null, clips = null;
    if (rec) {
      const asset = window.__ink.state.assets.find((a) => a.strokes === rec.rd.S);
      clips = asset ? asset.clips.length : (rec.rd.C ? rec.rd.C.length : null);
      rec.rd.reset();
      const a0 = performance.now();
      rec.rd.seekTo(Math.min(1200, rec.orderLen), 0);
      const a1 = performance.now();
      rec.rd.seekTo(Math.min(2400, rec.orderLen), 0);
      const a2 = performance.now();
      const drew = Math.min(2400, rec.orderLen) - Math.min(1200, rec.orderLen);
      per = drew > 0 ? +((a2 - a1) / drew).toFixed(3) : null;
    }

    out.push({
      dur: Math.round(sc.dur), keep: sc.keep, clips,
      perFrame: +(ms / N).toFixed(1), fps: +(1000 / (ms / N)).toFixed(1),
      fixedMs: +fixed.toFixed(1), perStrokeMs: per,
    });
  }
  return out;
});
console.log('渲染性能', JSON.stringify(perf, null, 1));

await browser.close();
