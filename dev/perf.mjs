// 性能探测：把「跑得动不动」变成会失败的断言。
//
// 原来这个脚本只打印数字、不判定，等于没有测试。
// 现在 5 项指标各有阈值，超了直接 exit 1。
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

// 阈值（可按机器调整，但别调到失去意义）
const LIM = {
  seekP95: 200,      // seek 延迟 P95（ms）
  gen8: 240_000,     // 8 屏生成上限（ms）
  fixedMs: 2,        // 无新笔时的固定渲染开销（ms）
  perStroke: 1.0,    // 单笔渲染成本（ms）
  atlasReuse: 500,   // 改 keep 重建渲染器（图集按资产复用，不该重打包）（ms）
  queueUpdate: 2,    // 队列面板 12 项同步差量更新一次（ms）
  assetUrl: 1000,    // 素材缩略图 URL 长度（base64 会到几十万字节）
};

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

// 页面里塞个查渲染器的助手：
// 多图模式下 renderer 的 key 是 `${segId}#${index}`，不是光杆 segId，
// 之前直接 get(sc.id) 查不到，后面的断言全是在测空气。
await page.addInitScript(() => {
  window.__perfFindRenderer = (segId) => {
    const m = window.__ink.state.renderers;
    for (const rec of m.values()) {
      if (rec.key === segId || rec.key.startsWith(segId + '#')) return rec;
    }
    return null;
  };
});

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

T('生成笔触');
const t0 = Date.now();
await page.click('#genBtn');
await page.waitForFunction(() => {
  const t = window.__ink.timeline;
  return t?.scenes?.length === 2 && t.scenes.every((s) => s.strokeCount > 0);
}, null, { timeout: 300000 });
const genMs = Date.now() - t0;

const info = await page.evaluate(() => window.__ink.state.assets.map((a) => ({ n: a.name, w: a.w, h: a.h, strokes: a.strokes.length, ms: Math.round(a.pipelineMs) })));
console.log('  生成', (genMs / 1000).toFixed(1) + 's', JSON.stringify(info));

const tl = await page.evaluate(() => window.__ink.timeline.scenes.map((s) => ({ dur: Math.round(s.dur), keep: s.keep, n: s.strokeCount })));
console.log('  时间轴', JSON.stringify(tl));

T('性能指标');
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
    const rec = window.__perfFindRenderer(sc.id);
    let per = null;
    if (rec) {
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
      dur: Math.round(sc.dur), keep: sc.keep, n: sc.n,
      orderLen: rec ? rec.orderLen : 0,
      perFrame: +(ms / N).toFixed(1), fps: +(1000 / (ms / N)).toFixed(1),
      fixedMs: +fixed.toFixed(2), perStrokeMs: per,
    });
  }
  return out;
});
console.log('  ' + JSON.stringify(perf));

T('断言 1/8：seek 延迟 P95');
// seek 要分四类量，因为成本完全不同：
//   拖进度条 —— 一次 pointermove 只跨十几毫秒，补的笔很少 ← 唯一拿来做断言的
//   大跨步向前 —— 一步吃掉 1/30 屏（约 370 笔），「点场景标签」那个量级
//   同屏向后 —— 触发 reset() 从头重画本屏（没有场景快照，README 已知限制第 6 条）
//   跨屏     —— 触发 reset() 从头重画目标屏，同上
// 后三类慢是设计使然，不该拿来卡「拖进度条跟手」这条断言，但要打印出来
// 让人知道回头跳、点标签有多贵。
const seekStats = await page.evaluate(() => {
  const tl = window.__ink.timeline;
  const total = tl.totalMs;
  const samples = [];
  for (let i = 0; i < 40; i++) {
    const at = (total * (i * 0.6180339887)) % total;   // 黄金分割散布，避开整点
    const t0 = performance.now();
    window.__ink.renderAt(at);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const p = (q) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
  return { p50: +p(0.5).toFixed(1), p95: +p(0.95).toFixed(1), max: +samples[samples.length - 1].toFixed(1) };
});

// 向前 seek，按真实拖动节奏采样：模拟人手拖进度条，一次 pointermove 只跨
// 一帧（≈16ms）出头。全屏 3.5s 走完 120 小步，每步要补的笔数很少——
// 这才是「拖进度条跟不跟手」该测的东西。
const SCRUB_STEP_MS = 16;
const scrubStep = await page.evaluate((stepMs) => {
  const tl = window.__ink.timeline;
  const sc = tl.scenes[tl.scenes.length - 1];
  window.__ink.renderAt(sc.start + 1);            // 先把这一屏画到开头
  const samples = [];
  for (let at = sc.start + stepMs; at < sc.start + sc.dur; at += stepMs) {
    const t0 = performance.now();
    window.__ink.renderAt(at);                     // 单调递增，target >= done，不 reset
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const p = (q) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
  return { n: samples.length, p50: +p(0.5).toFixed(1), p95: +p(0.95).toFixed(1), max: +samples[samples.length - 1].toFixed(1) };
}, SCRUB_STEP_MS);

// 大跨步向前跳：一步吃掉全屏 1/30（≈120ms、≈370 笔）。这不是人手拖动的节奏，
// 是「点了场景标签」那种量级，只打印不作断言。
const coarseForward = await page.evaluate(() => {
  const tl = window.__ink.timeline;
  const sc = tl.scenes[tl.scenes.length - 1];
  window.__ink.renderAt(sc.start + 1);
  const samples = [];
  for (let i = 0; i < 30; i++) {
    const at = sc.start + sc.dur * (i / 29);
    const t0 = performance.now();
    window.__ink.renderAt(at);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const p = (q) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
  return { p50: +p(0.5).toFixed(1), p95: +p(0.95).toFixed(1), max: +samples[samples.length - 1].toFixed(1) };
});

// 同屏向后跳：从屏尾拉回屏首，触发 reset() 从头重画本屏——只打印，不作断言
const backwardIntra = await page.evaluate(() => {
  const tl = window.__ink.timeline;
  const sc = tl.scenes[tl.scenes.length - 1];
  window.__ink.renderAt(sc.start + sc.dur - 1);
  const samples = [];
  for (let i = 0; i < 10; i++) {
    const at = sc.start + sc.dur * (1 - (i + 1) / 10);
    const t0 = performance.now();
    window.__ink.renderAt(at);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const p = (q) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
  return { p50: +p(0.5).toFixed(1), p95: +p(0.95).toFixed(1), max: +samples[samples.length - 1].toFixed(1) };
});
console.log(`  拖动进度条（每步 ${SCRUB_STEP_MS}ms，作断言）`, JSON.stringify(scrubStep));
console.log('  大跨步向前（每步 1/30 屏）', JSON.stringify(coarseForward));
console.log('  同屏向后（重画本屏，见 README 限制 6）', JSON.stringify(backwardIntra));
console.log('  跨屏（重画目标屏，见 README 限制 6）', JSON.stringify(seekStats));
ok(`拖动进度条 seek P95 < ${LIM.seekP95}ms`, scrubStep.p95 < LIM.seekP95, `P95 ${scrubStep.p95}ms / 最大 ${scrubStep.max}ms（n=${scrubStep.n}）`);

T('断言 2/8：生成 8 屏在预算内');
// 用 2 屏的实测单屏耗时线性外推到 8 屏（比真跑 8 屏快得多，量级够用）
const perScene = genMs / Math.max(1, tl.length);
const projected8 = perScene * 8;
console.log(`  2 屏 ${(genMs / 1000).toFixed(1)}s → 单屏 ${(perScene / 1000).toFixed(1)}s → 8 屏外推 ${(projected8 / 1000).toFixed(1)}s`);
ok(`8 屏外推 < ${LIM.gen8 / 1000}s`, projected8 < LIM.gen8, `${(projected8 / 1000).toFixed(1)}s`);

T('断言 3/8：单笔渲染成本');
const worstPer = Math.max(...perf.map((p) => p.perStrokeMs ?? 0));
console.log('  单笔', perf.map((p) => `${p.perStrokeMs}ms`).join(' / '));
ok(`单笔 < ${LIM.perStroke}ms`, worstPer > 0 && worstPer < LIM.perStroke, `最差 ${worstPer}ms`);

T('断言 4/8：无新笔时的固定开销');
const worstFixed = Math.max(...perf.map((p) => p.fixedMs));
console.log('  固定开销', perf.map((p) => `${p.fixedMs}ms`).join(' / '));
ok(`固定开销 < ${LIM.fixedMs}ms`, worstFixed < LIM.fixedMs, `最差 ${worstFixed}ms`);

T('断言 5/8：抽稀零丢块（画面没有永久白斑）');
// 画到一屏末尾，检查整幅图里没有成片的空白
const holes = await page.evaluate(() => {
  const tl = window.__ink.timeline;
  const out = [];
  for (const sc of tl.scenes) {
    window.__ink.renderAt(sc.start + sc.dur - 1);
    const rec = window.__perfFindRenderer(sc.id);
    if (!rec) { out.push({ id: sc.id, found: false }); continue; }
    const cv = rec.rd.painted;
    const w = cv.width, h = cv.height;
    const g = cv.getContext('2d');
    const d = g.getImageData(0, 0, w, h).data;
    // 按 32×32 格子统计「非白」比例
    const G = 32;
    const cellW = Math.floor(w / G), cellH = Math.floor(h / G);
    let blank = 0, total = 0;
    for (let cy = 0; cy < G; cy++) {
      for (let cx = 0; cx < G; cx++) {
        let ink = 0, n = 0;
        for (let y = cy * cellH; y < (cy + 1) * cellH; y += 4) {
          for (let x = cx * cellW; x < (cx + 1) * cellW; x += 4) {
            const i = (y * w + x) * 4;
            const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
            if (l < 245) ink++;
            n++;
          }
        }
        if (!n) continue;
        total++;
        if (ink / n < 0.005) blank++;   // 这一格几乎全白
      }
    }
    out.push({ id: sc.id, found: true, keep: sc.keep, n: sc.n, blank, total });
  }
  return out;
});
console.log('  白块格子', JSON.stringify(holes));
// 画面本来就有大面积浅色，不能拿「白格多」直接判；
// 判的是「成片的洞」——连续全白的格子占比过高才是抽稀丢笔
const found = holes.filter((h) => h.found);
ok('每一屏都找到了渲染器', found.length === holes.length, `${found.length}/${holes.length}`);
const worstHole = Math.max(0, ...found.map((h) => (h.total ? h.blank / h.total : 0)));
ok('白块格子占比 < 35%', worstHole < 0.35, `最差 ${(worstHole * 100).toFixed(1)}%`);

T('断言 6/8：改 keep 重建渲染器不重打包掩膜');
// 掩膜只跟资产有关；图集按 assetId 共享后，改时长导致 keep 变化应只重建 order。
// 退回「每个渲染器一份图集」时这里会回到 4 秒量级。
const atlasReuse = await page.evaluate(() => {
  const tl = window.__ink.timeline;
  const sc = tl.scenes[tl.scenes.length - 1];
  const rec = window.__perfFindRenderer(sc.id);
  if (!rec) return null;
  const keep = Math.max(1, Math.floor(rec.orderLen * 0.9));
  const t0 = performance.now();
  window.__ink.__makeRendererWithKeep(sc, keep);
  return { ms: +(performance.now() - t0).toFixed(1), keep };
});
console.log('  重建渲染器', JSON.stringify(atlasReuse));
ok(`改 keep 重建 < ${LIM.atlasReuse}ms`, !!atlasReuse && atlasReuse.ms < LIM.atlasReuse,
  atlasReuse ? `${atlasReuse.ms}ms（keep=${atlasReuse.keep}）` : '没找到渲染器');

T('断言 7/8：队列面板差量更新');
const queuePer = await page.evaluate(() => {
  const ink = window.__ink;
  const items = Array.from({ length: 12 }, (_, i) => ({
    id: 'stroke:' + i, label: '分析笔触：sample-' + i, detail: '1280×853',
    status: 'running', progress: 0, attempt: 1, aborting: false, error: '',
  }));
  const t0 = performance.now();
  for (let k = 0; k < 200; k++) {
    items[k % 12].progress = (k % 100) / 100;
    ink.__queuePanelUpdate(items.map((x) => ({ ...x })));
  }
  const ms = (performance.now() - t0) / 200;
  return { ms: +ms.toFixed(3), rows: document.querySelectorAll('.qp-item').length };
});
console.log('  单次更新', JSON.stringify(queuePer));
ok(`12 项差量更新 < ${LIM.queueUpdate}ms/次`, queuePer.ms < LIM.queueUpdate && queuePer.rows === 12,
  `${queuePer.ms}ms/次，${queuePer.rows} 行`);

T('断言 8/8：缩略图不内联 base64');
const urlBytes = await page.evaluate(() => window.__ink.state.assets.map((a) => (a.url || '').length));
const worstUrl = Math.max(0, ...urlBytes);
console.log('  素材 URL 字节', JSON.stringify(urlBytes));
ok(`单张缩略图 URL < ${LIM.assetUrl} 字节`, worstUrl > 0 && worstUrl < LIM.assetUrl, `最长 ${worstUrl} 字节`);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
await browser.close();
process.exit(fail ? 1 : 0);
