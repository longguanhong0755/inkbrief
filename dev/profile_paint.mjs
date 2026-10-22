// 细查：画一整屏 5.4 秒到底花在哪。
// 假设：不是「每笔」贵，而是「每段同 clip 连笔（run）」的固定开销贵。
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const BASE = process.env.URL || 'http://127.0.0.1:8743';
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

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
  if (!rec) return { err: 'no renderer' };

  const rd = rec.rd;
  const S = rd.S, C = rd.C, order = rd.order;
  const total = order.length;

  // 统计 run 结构：连续同 clip 的分组
  const runs = [];
  let i = 0;
  while (i < total) {
    const c = S[order[i]].c;
    let e = i + 1;
    while (e < total && S[order[e]].c === c) e++;
    runs.push({ c, from: i, to: e, n: e - i });
    i = e;
  }
  const clipCount = new Set(order.map((o) => S[o].c)).size;

  // run 的包围盒面积（用 clip 自身面积近似）
  let areaSum = 0, areaMax = 0, areaHist = {};
  for (const r of runs) {
    const cl = C[r.c];
    const a = cl.w * cl.h;
    areaSum += a;
    if (a > areaMax) areaMax = a;
    const b = a > 1e6 ? '>1M' : a > 1e5 ? '100k-1M' : a > 1e4 ? '10k-100k' : '<10k';
    areaHist[b] = (areaHist[b] || 0) + 1;
  }

  // 分段计时：reset / 逐 run 画 / mask 打包
  const t0 = performance.now();
  rd.reset();
  const tReset = performance.now() - t0;

  // 第一次画（会打包 mask） vs 第二次画（mask 已缓存）
  const t1 = performance.now();
  rd.reset(); rd.seekTo(total, 0);
  const tFirst = performance.now() - t1;

  const t2 = performance.now();
  rd.reset(); rd.seekTo(total, 0);
  const tSecond = performance.now() - t2;

  // 画一半
  const t3 = performance.now();
  rd.reset(); rd.seekTo(Math.floor(total / 2), 0);
  const tHalf = performance.now() - t3;

  // 纯掩膜打包成本：重建一个渲染器（新 keep → 新打包）
  const t4 = performance.now();
  const rd2 = ink.__makeRendererWithKeep(sc, Math.max(1, Math.floor(rec.orderLen * 0.9)));
  const tRepack = performance.now() - t4;

  return {
    total, clipCount, runCount: runs.length,
    avgRunLen: +(total / runs.length).toFixed(1),
    runLenHist: {
      '1': runs.filter((r) => r.n === 1).length,
      '2-5': runs.filter((r) => r.n >= 2 && r.n <= 5).length,
      '6-20': runs.filter((r) => r.n >= 6 && r.n <= 20).length,
      '>20': runs.filter((r) => r.n > 20).length,
    },
    areaHist,
    areaSumM: +(areaSum / 1e6).toFixed(1), areaMaxM: +(areaMax / 1e6).toFixed(2),
    tReset: +tReset.toFixed(1),
    tFirst: +tFirst.toFixed(1), tSecond: +tSecond.toFixed(1), tHalf: +tHalf.toFixed(1),
    tRepack: +tRepack.toFixed(1),
    canvasW: rd.W, canvasH: rd.H,
  };
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
