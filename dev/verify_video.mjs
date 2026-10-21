// 校验导出的 MP4：能否解码、分辨率、时长、抽帧画面是否正常。
//
// 用 page.setContent() 起一个空白页：原来引用的 dev/probe.html 根本不存在，
// 这个脚本以前是跑不起来的（浏览器会跳到 404 页，页面上下文不对）。
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const file = process.argv[2] || 'dev/out/e2e-video.mp4';
if (!fs.existsSync(file)) { console.log('找不到', file); process.exit(1); }

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
// 空白页即可：只用页面里的 <video>/<canvas> API，不需要任何项目资源
await page.setContent('<!doctype html><meta charset="utf-8"><title>verify</title><body></body>');
await page.waitForFunction(() => typeof document.createElement === 'function');

const b64 = fs.readFileSync(file).toString('base64');
const info = await page.evaluate(async (data) => {
  const bin = atob(data);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([buf], { type: 'video/mp4' }));
  const v = document.createElement('video');
  v.src = url; v.muted = true; v.playsInline = true;
  await new Promise((res, rej) => {
    v.onloadedmetadata = res;
    v.onerror = () => rej(new Error('decode failed'));
    setTimeout(() => rej(new Error('timeout')), 20000);
  });
  const shots = [];
  const cv = document.createElement('canvas');
  cv.width = 320; cv.height = Math.round(320 * v.videoHeight / v.videoWidth);
  const x = cv.getContext('2d');
  for (const f of [0.15, 0.5, 0.85]) {
    const t = v.duration * f;
    await new Promise((res) => { v.onseeked = res; v.currentTime = t; });
    x.drawImage(v, 0, 0, cv.width, cv.height);
    const d = x.getImageData(0, 0, cv.width, cv.height).data;
    let ink = 0, dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
      if (l < 200) ink++;
      if (l < 150) dark++;
    }
    shots.push({ t: +t.toFixed(2), ink: +(ink / (d.length / 4)).toFixed(3), dark: +(dark / (d.length / 4)).toFixed(3) });
  }
  // 音轨在不在：解码器能报出的轨道数
  let audioTracks = 0;
  if (v.mozHasAudio !== undefined) audioTracks = v.mozHasAudio ? 1 : 0;
  else if (v.webkitAudioDecodedByteCount !== undefined) audioTracks = v.webkitAudioDecodedByteCount > 0 ? 1 : 0;
  else if (v.audioTracks) audioTracks = v.audioTracks.length;
  return { w: v.videoWidth, h: v.videoHeight, duration: +v.duration.toFixed(2), audioTracks, shots };
}, b64);

console.log(JSON.stringify(info, null, 1));
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); }
};
ok('分辨率 1920x1080', info.w === 1920 && info.h === 1080, `${info.w}x${info.h}`);
ok('画面随时间增长', info.shots[0].ink < info.shots[2].ink,
  info.shots.map((s) => s.ink).join(' → '));
ok('时长 > 0', info.duration > 0, `${info.duration}s`);
console.log(`\n结果：${pass} 通过，${fail} 失败`);
await browser.close();
process.exit(fail ? 1 : 0);

