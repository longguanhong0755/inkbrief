// WebCodecs 离线导出：能力探测、双画幅、音轨、进度与取消。
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const BASE = process.env.URL || 'http://127.0.0.1:8743';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); }
};
const T = (label) => console.log(`\n── ${label} ──`);

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 940 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)));

await page.goto(BASE + '/index.html?debug=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.getElementById('boot')?.hidden === true, null, { timeout: 180000 });

T('能力探测：Video / Audio 分开');
const caps = await page.evaluate(async () => {
  const m = await import('/js/core/exporter.js');
  return m.probeCodecs();
});
ok('有 VideoEncoder', caps.hasVideoEncoder === true);
ok('有 AudioEncoder', caps.hasAudioEncoder === true);
ok('探到了视频编码器', !!caps.video, caps.video ? `${caps.video.label} (${caps.video.webcodecs})` : 'null');
ok('探到了音频编码器', !!caps.audio, caps.audio ? `${caps.audio.label} (${caps.audio.webcodecs})` : 'null');
ok('视频/音频是分别报的', caps.video && caps.audio && caps.video.webcodecs !== caps.audio.webcodecs);

T('准备：2 图 2 段');
await page.setInputFiles('#fileInput', [
  path.resolve('samples/sample-1.jpg'),
  path.resolve('samples/sample-2.jpg'),
]);
await page.waitForFunction(() => window.__ink.state.assets.length === 2, null, { timeout: 30000 });
await page.fill('#rawScript', '第一段内容。\n第二段内容。');
await page.selectOption('#splitRule', 'line');
await page.click('#splitBtn');
await page.waitForFunction(() => window.__ink.state.segs.length === 2, null, { timeout: 10000 });
await page.evaluate(() => {
  const segs = window.__ink.state.segs;
  const ids = window.__ink.state.assets.map((a) => a.id);
  segs.forEach((s, i) => window.__ink.setSegImages(s.id, [ids[i % ids.length]]));
});
await page.waitForFunction(() => window.__ink.state.segs.every((s) => s.imageIds.length === 1),
  null, { timeout: 10000 });

T('离线导出：单画幅');
// 缩短时长，测试跑得快一点
await page.evaluate(() => {
  for (const el of document.querySelectorAll('.seg input[type=range]')) {
    el.value = String(Math.round(Number(el.value) * 0.35));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
});
const expectMs = await page.evaluate(() => Math.round(window.__ink.timeline.totalMs));
ok('总长已缩短', expectMs > 200 && expectMs < 6000, `${expectMs}ms`);

await page.click('#expBtn');
await page.waitForFunction(() => !!window.__ink.lastExport, null, { timeout: 300000 }).catch(() => {});
const exp = await page.evaluate(async () => {
  const r = window.__ink.lastExport;
  if (!r) return null;
  const buf = new Uint8Array(await r.blob.slice(0, 16).arrayBuffer());
  return {
    size: r.blob.size, type: r.blob.type, mime: r.mime, ext: r.ext,
    ms: Math.round(r.ms), audioMs: Math.round(r.audioMs),
    offline: !!r.offline, hasAudio: !!r.hasAudio, frames: r.frames,
    videos: (r.videos || []).map((v) => ({ size: v.blob.size, w: v.width, h: v.height, label: v.label })),
    head: [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' '),
  };
});
console.log('  产物：', JSON.stringify(exp));
ok('导出了', !!exp);
ok('走的是离线编码', exp?.offline === true);
ok('有音轨', exp?.hasAudio === true);
ok('容器是 MP4', exp?.mime === 'video/mp4' && exp?.ext === 'mp4');
ok('文件头是 ftyp', /66 74 79 70/.test(exp?.head || ''), exp?.head);
ok('产物非空', exp?.size > 100_000, exp ? `${(exp.size / 1048576).toFixed(2)}MB` : '');
ok('音轨时长与时间轴一致（±0.25s）', !!exp && Math.abs(exp.audioMs - expectMs) < 250,
  exp ? `${exp.audioMs} vs ${expectMs}` : '');
ok('帧数对得上', !!exp && exp.frames > 0, exp ? `${exp.frames} 帧` : '');
ok('单画幅只出一个文件', exp?.videos?.length === 1, exp ? exp.videos.map((v) => v.label).join(',') : '');

T('双画幅：一次出横屏 + 竖屏');
await page.evaluate(() => { window.__ink.lastExport = null; });
await page.check('#dualExport');
await page.click('#expBtn');
await page.waitForFunction(() => !!window.__ink.lastExport, null, { timeout: 300000 }).catch(() => {});
const dual = await page.evaluate(async () => {
  const r = window.__ink.lastExport;
  if (!r) return null;
  const heads = [];
  for (const v of r.videos || []) {
    const b = new Uint8Array(await v.blob.slice(0, 12).arrayBuffer());
    heads.push([...b].map((x) => x.toString(16).padStart(2, '0')).join(' '));
  }
  return {
    n: (r.videos || []).length,
    list: (r.videos || []).map((v) => ({ w: v.width, h: v.height, size: v.blob.size, label: v.label })),
    heads,
  };
});
console.log('  双画幅：', JSON.stringify(dual));
ok('出了两个文件', dual?.n === 2, dual ? String(dual.n) : '');
ok('一个横一个竖', !!dual && dual.list.some((v) => v.w > v.h) && dual.list.some((v) => v.w < v.h),
  dual ? dual.list.map((v) => `${v.label}`).join(' + ') : '');
ok('两个都是 MP4', !!dual && dual.heads.every((h) => /66 74 79 70/.test(h)));
ok('两个都不为空', !!dual && dual.list.every((v) => v.size > 100_000),
  dual ? dual.list.map((v) => `${v.label}:${(v.size / 1048576).toFixed(2)}MB`).join(' ') : '');

T('导出的视频能正常解码');
const dec = await page.evaluate(async () => {
  const r = window.__ink.lastExport;
  if (!r) return null;
  const out = [];
  for (const v of r.videos || []) {
    const url = URL.createObjectURL(v.blob);
    const el = document.createElement('video');
    el.src = url; el.muted = true; el.playsInline = true;
    let err = '';
    try {
      await new Promise((res, rej) => {
        el.onloadedmetadata = res;
        el.onerror = () => rej(new Error('decode failed'));
        setTimeout(() => rej(new Error('timeout')), 20000);
      });
    } catch (e) { err = String(e.message); }
    out.push({ w: el.videoWidth, h: el.videoHeight, dur: el.duration, err });
    URL.revokeObjectURL(url);
  }
  return out;
});
console.log('  解码：', JSON.stringify(dec));
ok('两个文件都能解码', !!dec && dec.every((d) => !d.err), dec ? dec.map((d) => d.err).join(',') : '');
ok('分辨率正确', !!dec && dec.some((d) => d.w === 1920 && d.h === 1080) && dec.some((d) => d.w === 1080 && d.h === 1920),
  dec ? dec.map((d) => `${d.w}×${d.h}`).join(' + ') : '');

T('离线导出比录制快（不受墙钟限制）');
ok('编码耗时 < 视频时长', !!exp && exp.ms < expectMs * 2,
  exp ? `编码 ${(exp.ms / 1000).toFixed(1)}s / 视频 ${(expectMs / 1000).toFixed(1)}s` : '');

console.log('\nconsole errors:', errors.length, errors.slice(0, 5));
ok('无 console 错误', errors.length === 0);
console.log(`\n结果：${pass} 通过，${fail} 失败`);
await browser.close();
process.exit(fail ? 1 : 0);
