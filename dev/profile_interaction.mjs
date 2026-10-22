// 交互热点剖析：量「用户手会触发」的那些操作到底多慢。
// 目的是定优先级——改哪一处最值钱。
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

const out = await page.evaluate(async () => {
  const ink = window.__ink;
  const st = ink.state;
  const sc = st.timeline.scenes[st.timeline.scenes.length - 1];
  const R = {};

  const med = (a) => { const s = [...a].sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(2); };
  const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(s.length * 0.95))].toFixed(2); };
  const timeIt = (fn, n) => { const s = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); fn(i); s.push(performance.now() - t0); } return { p50: med(s), p95: p95(s), max: +Math.max(...s).toFixed(2) }; };

  // 找到最后一屏的渲染器
  ink.renderAt(sc.start + 1);
  let rec = null;
  for (const r of st.renderers.values()) if (r.key === sc.id || r.key.startsWith(sc.id + '#')) { rec = r; break; }
  R.orderLen = rec ? rec.orderLen : 0;

  // A) 画一整屏（从头到尾）要多久 —— 决定「跳到结尾」的代价
  if (rec) {
    R.fullScreenPaint = timeIt(() => { rec.rd.reset(); rec.rd.seekTo(rec.orderLen, 0); }, 3);
    // 单独测：重建渲染器（滑块改时长会触发）
    R.rebuildRenderer = timeIt(() => {
      const rd = ink.__makeRenderer(sc, 0);
      return rd;
    }, 3);
  }

  // B) renderAt 推进固定笔数（模拟播放一帧）
  R.renderAtFrame = timeIt((i) => {
    ink.renderAt(sc.start + 1 + (i * 20) % (sc.dur * 0.9));
  }, 40);

  // C) rebuild() 全量（改时长/改文案会触发）
  R.rebuild = timeIt(() => { ink.rebuild(); }, 10);

  // D) renderSegs()（加图/删图会触发）
  R.renderSegs = timeIt(() => { ink.renderSegs(); }, 10);

  // E) 素材缩略图内联字符串有多大
  R.assetUrlBytes = st.assets.map((a) => (a.url || '').length);
  R.innerHTMLBytesEstimate = st.segs.length * 2 * (R.assetUrlBytes[0] || 0);

  // F) 混音（点播放时同步算）
  const t0 = performance.now();
  await ink.__ensureMix();
  R.ensureMix = +(performance.now() - t0).toFixed(2);

  // G) 队列面板更新一次
  R.queuePanelUpdate = timeIt(() => { ink.__queuePanelUpdate(); }, 20);

  return R;
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
