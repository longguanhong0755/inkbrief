// 完整 e2e：上传两图 → 两段文案 → 配音 → 生成 → 播放渲染 → 改时长 → 导出 MP4。
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const BASE = process.env.URL || 'http://127.0.0.1:8743/inkbrief';
// ENGINE=pinned|latest|dev 可以指定引擎通道；不设则由页面按环境选
const PAGE = BASE + '/index.html?debug=1' + (process.env.ENGINE ? '&engine=' + encodeURIComponent(process.env.ENGINE) : '');
const OUT = 'dev/out';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); }
};

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ viewport: { width: 1500, height: 940 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 240)); });
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 240)));

const T = (label) => console.log(`\n── ${label} ──`);

await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.getElementById('boot')?.hidden === true, null, { timeout: 180000 });
ok('语音引擎就绪', true);

T('上传图片');
await page.setInputFiles('#fileInput', [
  path.resolve('samples/sample-1.jpg'),
  path.resolve('samples/sample-2.jpg'),
]);
await page.waitForFunction(() => window.__ink.state.assets.length === 2, null, { timeout: 30000 });
const assetInfo = await page.evaluate(() => window.__ink.state.assets.map((a) => ({ n: a.name, w: a.w, h: a.h })));
ok('两张图已载入', assetInfo.length === 2, JSON.stringify(assetInfo));

T('文案分段');
await page.fill('#rawScript', '今天聊三件小事。\n\n第一，图片不要上传到服务器。\n\n第二，所有处理都在你自己的浏览器里完成。');
await page.click('#splitBtn');
await page.waitForFunction(() => window.__ink.state.segs.length === 3, null, { timeout: 10000 });
const bound = await page.evaluate(() => window.__ink.state.segs.map((s) => !!s.assetId));
ok('切成 3 段', bound.length === 3);
ok('每段自动配了图', bound.every(Boolean));

T('生成配音');
for (let i = 0; i < 3; i++) {
  await page.locator('.seg .voice-btn').nth(i).click();
  await page.waitForFunction((idx) => window.__ink.state.segs[idx]?.audio, i, { timeout: 120000 });
}
const audioInfo = await page.evaluate(() => window.__ink.state.segs.map((s) => ({ d: +(s.audio.duration).toFixed(2), sr: s.audio.sr })));
ok('三段都有配音', audioInfo.every((a) => a.d > 0.3), JSON.stringify(audioInfo));
// 采样率必须等于模型 config 的 16000。之前这里断言 22050，是把 bug 写进了测试：
// 引擎硬编码 22050 但模型输出 16000，配音快 1.38 倍、音高高 5.5 个半音。
ok('采样率 16000（与模型一致）', audioInfo.every((a) => a.sr === 16000));

T('生成笔触');
const tGen = Date.now();
await page.click('#genBtn');
await page.waitForFunction(() => {
  const t = window.__ink.timeline;
  return t?.scenes?.length === 3 && t.scenes.every((s) => s.strokeCount > 0);
}, null, { timeout: 300000 });
const genMs = Date.now() - tGen;
const tl = await page.evaluate(() => {
  const t = window.__ink.timeline;
  return {
    total: Math.round(t.totalMs),
    scenes: t.scenes.map((s) => ({ start: Math.round(s.start), dur: Math.round(s.dur), keep: s.keep, n: s.strokeCount, speed: +s.speed.toFixed(3) })),
    notes: t.notes,
  };
});
console.log('  时间轴', JSON.stringify(tl));
ok('3 屏', tl.scenes.length === 3, `生成用时 ${(genMs / 1000).toFixed(1)}s`);
ok('每屏都有笔触', tl.scenes.every((s) => s.n > 0 && s.keep > 0));
ok('总时长 ≈ 配音之和', Math.abs(tl.total - audioInfo.reduce((a, b) => a + b.d * 1000, 0)) < 400, `${tl.total}ms`);
ok('屏起点连续', tl.scenes.every((s, i) => i === 0 ? s.start === 0 : Math.abs(s.start - (tl.scenes[i - 1].start + tl.scenes[i - 1].dur)) < 2));

T('画面渲染');
async function frameStats(ms) {
  return page.evaluate((t) => {
    window.__ink.renderAt(t);
    const cv = document.getElementById('stage');
    const x = cv.getContext('2d');
    const d = x.getImageData(0, 0, cv.width, cv.height).data;
    // 图框区域（避开纸面边缘）
    const x0 = Math.round(cv.width * 0.06), x1 = Math.round(cv.width * 0.94);
    const y0 = Math.round(cv.height * 0.06), y1 = Math.round(cv.height * 0.72);
    let ink = 0, tot = 0;
    for (let y = y0; y < y1; y += 3) {
      for (let xx = x0; xx < x1; xx += 3) {
        const i = (y * cv.width + xx) * 4;
        tot++;
        // 明显深于纸面的才算墨迹
        if ((d[i] + d[i + 1] + d[i + 2]) / 3 < 200) ink++;
      }
    }
    // 字幕区
    const cy0 = Math.round(cv.height * 0.82), cy1 = Math.round(cv.height * 0.95);
    let cap = 0;
    for (let y = cy0; y < cy1; y += 2) {
      for (let xx = x0; xx < x1; xx += 2) {
        const i = (y * cv.width + xx) * 4;
        if (d[i] < 150 && d[i + 1] < 150 && d[i + 2] < 150) cap++;
      }
    }
    return { ink: ink / tot, cap };
  }, ms);
}
const f0 = await frameStats(60);
const f1 = await frameStats(tl.total * 0.5);
const f2 = await frameStats(tl.total - 60);
ok('开头画面几乎空白', f0.ink < 0.06, `墨迹占比 ${(f0.ink * 100).toFixed(1)}%`);
ok('中段画面有内容', f1.ink > 0.10, `墨迹占比 ${(f1.ink * 100).toFixed(1)}%`);
// 抽稀改成「主体优先」后，墨迹会提前饱和（先画主体，细节后补），
// 末尾不再比中段多。所以这里验的是「画面已经画满且没有倒退」，
// 而不是「末尾比中段墨迹更多」——那是等距抽稀时代的假设。
ok('末尾画面已经画满', f2.ink > 0.30, `墨迹占比 ${(f2.ink * 100).toFixed(1)}%`);
ok('末尾画面不倒退', f2.ink >= f1.ink * 0.97, `${(f1.ink * 100).toFixed(1)}% -> ${(f2.ink * 100).toFixed(1)}%`);
ok('字幕可见', f2.cap > 40, `深色像素 ${f2.cap}`);

await page.evaluate((t) => { window.__ink.renderAt(t); }, tl.total * 0.6);
await page.locator('#stage').screenshot({ path: `${OUT}/e2e-frame.png` });

T('改时长（变速）');
const before = await page.evaluate(() => {
  const s = window.__ink.timeline.scenes[0];
  return { dur: Math.round(s.dur), speed: +s.speed.toFixed(3) };
});
await page.evaluate(() => {
  const el = document.querySelectorAll('.seg input[type=range]')[0];
  const mid = Math.round((Number(el.min) + Number(el.max)) / 2);
  el.value = String(mid);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const after = await page.evaluate(() => {
  const s = window.__ink.timeline.scenes[0];
  return { dur: Math.round(s.dur), speed: +s.speed.toFixed(3), total: Math.round(window.__ink.timeline.totalMs) };
});
console.log('  改前', JSON.stringify(before), '改后', JSON.stringify(after));
ok('时长跟着滑块变', Math.abs(after.dur - before.dur) > 100, `${before.dur} -> ${after.dur}`);
ok('速度随之变化', Math.abs(after.speed - before.speed) > 0.05, `${before.speed} -> ${after.speed}`);
ok('音轨总长同步', after.total !== tl.total);

T('导出 MP4');
// 恢复到 1× 并缩短总长，加快测试
await page.evaluate(() => {
  for (const el of document.querySelectorAll('.seg input[type=range]')) {
    el.value = String(Math.round(Number(el.value) * 0.7));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
});
const expectMs = await page.evaluate(() => Math.round(window.__ink.timeline.totalMs));
await page.click('#expBtn');
// 等导出状态结束（不依赖 Playwright 的下载通道，先看页面里拿到的产物）
await page.waitForFunction(() => !!window.__ink.lastExport, null, { timeout: 300000 }).catch(() => {});
const exp = await page.evaluate(async () => {
  const r = window.__ink.lastExport;
  if (!r) return null;
  const buf = new Uint8Array(await r.blob.slice(0, 16).arrayBuffer());
  // 小文件顺带存盘，供抽帧校验
  let b64 = null;
  if (r.blob.size < 8 * 1024 * 1024) {
    const all = new Uint8Array(await r.blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < all.length; i += 8192) s += String.fromCharCode.apply(null, all.subarray(i, i + 8192));
    b64 = btoa(s);
  }
  return {
    size: r.blob.size, type: r.blob.type, mime: r.mime, ext: r.ext,
    ms: Math.round(r.ms), audioMs: Math.round(r.audioMs),
    head: [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' '),
    b64,
  };
});
if (exp?.b64) {
  fs.writeFileSync(path.join(OUT, 'e2e-video.' + exp.ext), Buffer.from(exp.b64, 'base64'));
  console.log('  已保存 dev/out/e2e-video.' + exp.ext);
  delete exp.b64;
}
console.log('  页面内产物：', JSON.stringify(exp));
ok('导出产出非空', !!exp && exp.size > 200_000, exp ? `${(exp.size / 1048576).toFixed(2)}MB` : 'null');
ok('容器头正确（MP4 ftyp / WebM EBML）', !!exp && (/66 74 79 70/.test(exp.head) || exp.head.startsWith('1a 45 df a3')), exp?.head);
ok('音轨时长与时间轴一致（±0.25s）', !!exp && Math.abs(exp.audioMs - expectMs) < 250, exp ? `${exp.audioMs} vs ${expectMs}` : '');

let download = null;
try { download = await page.waitForEvent('download', { timeout: 15000 }); } catch { /* 已产生过，事件可能早于监听 */ }
const fname = download ? download.suggestedFilename() : '';
if (download) {
  const savePath = path.join(OUT, 'e2e-' + fname);
  try {
    const tmp = await download.path();
    fs.copyFileSync(tmp, savePath);
    ok('浏览器下载可用', fs.statSync(savePath).size > 200_000, fname);
  } catch (e) {
    ok('浏览器下载可用', false, String(e.message).slice(0, 80));
  }
  fs.writeFileSync(`${OUT}/e2e-result.json`, JSON.stringify({ savePath, expectMs }, null, 1));
} else {
  console.log('  （下载事件未捕获，跳过下载断言）');
}

const stat = await page.evaluate(() => document.getElementById('previewHint').textContent);
console.log('  导出提示：', stat);
ok('导出无报错', !/失败|取消/.test(stat), stat);
const statMs = Number((stat.match(/时长 ([\d.]+)s/) || [])[1]);
ok('时长与时间轴一致（±0.4s）', Math.abs(statMs * 1000 - expectMs) < 400, `${statMs}s vs ${expectMs}ms`);

const probe = { mime: stat.includes('MP4') ? 'mp4' : 'webm', expectMs, tl };
fs.writeFileSync(`${OUT}/e2e-result.json`, JSON.stringify(probe, null, 1));

console.log('\nconsole errors:', errors.length, errors.slice(0, 5));
ok('无 console 错误', errors.length === 0);
console.log(`\n结果：${pass} 通过，${fail} 失败`);
await browser.close();
process.exit(fail ? 1 : 0);
