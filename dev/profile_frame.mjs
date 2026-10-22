// 帧内开销剖析：把「一次 renderAt」拆成各部分，量出谁在吃时间。
// 目的不是断言，是找出该先改哪儿——所以输出的是分解表。
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

// 等笔触生成完
await page.click('#genBtn');
await page.waitForFunction(() => {
  const t = window.__ink.timeline;
  return t?.scenes?.length === 2 && t.scenes.every((s) => s.strokeCount > 0);
}, null, { timeout: 300000 });
await page.waitForTimeout(1000);

const profile = await page.evaluate(() => {
  const ink = window.__ink;
  const st = ink.state;
  const sc = st.timeline.scenes[st.timeline.scenes.length - 1];

  // 渲染器是懒创建的：先 renderAt 一次把它建出来，再找
  ink.renderAt(sc.start + 1);
  let rec = null;
  for (const r of st.renderers.values()) {
    if (r.key === sc.id || r.key.startsWith(sc.id + '#')) { rec = r; break; }
  }
  if (!rec) return { err: 'no renderer', keys: [...st.renderers.keys()] };

  const N = 60;
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(2); };
  const out = {};

  // 1) 完整 renderAt
  {
    const s = [];
    for (let i = 0; i < N; i++) {
      const at = sc.start + 1 + (i / N) * sc.dur * 0.2;
      const t0 = performance.now();
      ink.renderAt(at);
      s.push(performance.now() - t0);
    }
    out.renderAt = { p50: med(s), max: +Math.max(...s).toFixed(2) };
  }

  // 2) 拆 compositor.draw：只调一次合成（不带笔触推进）
  {
    const s = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      ink.__compositorDrawOnly();
      s.push(performance.now() - t0);
    }
    out.compositorOnly = { p50: med(s), max: +Math.max(...s).toFixed(2) };
  }

  // 3) 拆字幕绘制
  {
    const s = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      ink.__captionDrawOnly();
      s.push(performance.now() - t0);
    }
    out.captionOnly = { p50: med(s), max: +Math.max(...s).toFixed(2) };
  }

  // 4) 笔触 seek（不含合成）
  {
    const s = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      ink.__seekOnly(0.5);
      s.push(performance.now() - t0);
    }
    out.seekOnly = { p50: med(s), max: +Math.max(...s).toFixed(2) };
  }

  // 5) shadowBlur 单项成本：一张 1650x930 的白卡 + 19px 阴影
  {
    const c = document.createElement('canvas');
    c.width = 1920; c.height = 1080;
    const x = c.getContext('2d');
    const s = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      x.save();
      x.shadowColor = 'rgba(90,72,48,0.20)';
      x.shadowBlur = 19;
      x.shadowOffsetY = 8;
      x.fillStyle = '#FFFFFF';
      x.fillRect(135, 75, 1650, 930);
      x.restore();
      s.push(performance.now() - t0);
    }
    out.shadowBlurOnly = { p50: med(s), max: +Math.max(...s).toFixed(2) };
  }

  // 6) imageSmoothingQuality=high 重采样
  {
    const src = document.createElement('canvas');
    src.width = 1600; src.height = 1000;
    const sc2 = src.getContext('2d');
    sc2.fillStyle = '#ccc'; sc2.fillRect(0, 0, 1600, 1000);
    const c = document.createElement('canvas');
    c.width = 1920; c.height = 1080;
    const x = c.getContext('2d');
    const s = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = 'high';
      x.drawImage(src, 135, 75, 1650, 930);
      s.push(performance.now() - t0);
    }
    out.smoothHighOnly = { p50: med(s), max: +Math.max(...s).toFixed(2) };
  }

  out.info = { W: st.W, H: st.H, orderLen: rec.rd.order.length, dur: sc.dur };
  return out;
});

console.log(JSON.stringify(profile, null, 2));
await browser.close();
