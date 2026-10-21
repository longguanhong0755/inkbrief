// 冒烟：打开页面，等语音引擎就绪，检查 console / 请求失败 / 关键能力。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const URL = process.env.URL || 'http://127.0.0.1:8742/index.html?debug=1';

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
const failed = [];
// 大文件（模型 / wasm / 字体）走分片下载，单片被掐断后会重试，
// 所以 Range 请求的失败是预期内的，只当作提示，不算失败。
const RETRIABLE = /zh-huayan-fp16\.onnx|ort-wasm-simd-threaded\.wasm|MaShanZheng-Regular\.woff2/;
const retried = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const text = m.text().slice(0, 300);
  const from = m.location()?.url || '';
  if (RETRIABLE.test(from)) retried.push(text); else errors.push(text);
});
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 300)));
page.on('requestfailed', (r) => {
  const isRange = !!r.headers()['range'] || RETRIABLE.test(r.url());
  const line = r.url() + ' :: ' + (r.failure()?.errorText || '');
  if (isRange) retried.push(line); else failed.push(line);
});

const t0 = Date.now();
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

// 等 boot 消失（语音引擎就绪）
let booted = false;
try {
  // 线上首次访问要走 CDN 拉 21MB（模型 + wasm），国内可能要好几分钟，
  // 超时按 10 分钟给，避免把「慢」误判成「坏」。
  await page.waitForFunction(() => document.getElementById('boot')?.hidden === true, null, { timeout: 600000 });
  booted = true;
} catch { booted = false; }
const bootMs = Date.now() - t0;
const bootText = await page.evaluate(() => document.getElementById('bootText')?.textContent);
if (!booted) console.log('boot 未完成，停在：', bootText);

// 字体在引擎就绪之后才开始下载，给它一点时间再判断
await page.waitForFunction(() => window.__ink?.state?.fontOk === true, null, { timeout: 60000 }).catch(() => {});

const info = await page.evaluate(() => {
  const s = window.__ink?.state;
  return {
    ttsReady: !!s?.ttsReady,
    voices: [...document.querySelectorAll('#voice option')].map((o) => o.textContent),
    hasOrt: typeof globalThis.ort !== 'undefined',
    hasPinyin: typeof globalThis.pinyinPro !== 'undefined',
    mime: (() => {
      const cands = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus'];
      return cands.filter((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } });
    })(),
    canvas: (() => { const c = document.getElementById('stage'); return c.width + 'x' + c.height; })(),
    fontOk: !!s?.fontOk,
  };
});

// 试合成一句话
let synth = null;
if (info.ttsReady) {
  synth = await page.evaluate(async () => {
    const t = performance.now();
    const r = await window.__ink.synth('今天聊三件小事');
    return { ms: Math.round(performance.now() - t), dur: +(r.pcm.length / r.sampleRate).toFixed(2), sr: r.sampleRate, peak: Math.max(...Array.from(r.pcm.slice(0, 20000)).map(Math.abs)) };
  }).catch((e) => ({ error: String(e).slice(0, 200) }));
}

console.log('启动耗时', (bootMs / 1000).toFixed(1) + 's', 'boot 完成:', booted);
console.log(JSON.stringify(info, null, 1));
console.log('合成:', JSON.stringify(synth));
console.log('console errors:', errors.length, errors.slice(0, 6));
console.log('分片重试记录（正常现象）:', retried.length, retried.slice(0, 3));
console.log('failed requests:', failed.length, failed.slice(0, 6));

await page.screenshot({ path: 'dev/out/smoke.png', fullPage: false });
await browser.close();
process.exit(errors.length || failed.length || !booted ? 1 : 0);
