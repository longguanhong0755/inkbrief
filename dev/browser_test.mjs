// 浏览器端到端测试（本机 Chrome + playwright-core）
// 运行：PLAYWRIGHT_CORE=<path> node dev/browser_test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PW = process.env.PLAYWRIGHT_CORE || 'playwright-core';
const { chromium } = require(PW);

const BASE = process.env.URL || 'http://127.0.0.1:8732/';
const OUT = path.resolve('dev/out');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'not-image.txt'), 'this is not an image');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
});

let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
}

const errors = [];
const logs = [];

async function newPage(viewport = { width: 1440, height: 1000 }, opts = {}) {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport });
  const page = await ctx.newPage();
  page.setDefaultTimeout(opts.timeout || 120000);
  page.on('console', (m) => { logs.push(`${m.type()}: ${m.text()}`); if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  if (opts.init) await page.addInitScript(opts.init);
  if (opts.route) await page.route(opts.route, opts.routeHandler);
  return { ctx, page };
}

async function gen(page) {
  await page.click('#go');
  await page.waitForSelector('#export:not([disabled])', { timeout: 150000 });
  await page.waitForTimeout(900);
}

// ---------- 正常流程 ----------
{
  const { ctx, page } = await newPage();
  await page.goto(BASE + '?debug=1', { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  ok('页面标题', (await page.title()).includes('inkbrief'));

  await page.click('button[data-sample="cat"]');
  await page.waitForSelector('#thumb:not([hidden])', { timeout: 10000 });
  await page.waitForTimeout(400);
  ok('示例文案 4 段', (await page.textContent('#segInfo')).trim() === '4 段');
  ok('生成按钮可用', (await page.getAttribute('#go', 'disabled')) === null);

  const t0 = Date.now();
  await gen(page);
  const stats = (await page.textContent('#stats')).trim();
  ok('生成完成', /笔/.test(stats), `${Date.now() - t0}ms · ${stats}`);
  ok('场景按钮 4 个', (await page.locator('#scenes button').count()) === 4);
  ok('分区说明非空', (await page.textContent('#mapInfo')).includes('第 1 块'));
  await page.screenshot({ path: path.join(OUT, 'preview.png') });

  // 暂停 / 恢复
  await page.click('#play');
  ok('可以暂停', (await page.textContent('#play')).trim() === '播放');
  await page.waitForTimeout(300);
  const c1 = (await page.textContent('#clock')).trim();
  await page.waitForTimeout(600);
  const c2 = (await page.textContent('#clock')).trim();
  ok('暂停后时钟不动', c1 === c2, `${c1} / ${c2}`);
  await page.click('#play');
  ok('恢复后按钮为暂停', (await page.textContent('#play')).trim() === '暂停');
  await page.waitForTimeout(1800);
  const c3 = (await page.textContent('#clock')).trim();
  ok('恢复播放时钟前进', c3 !== c2, `${c2} → ${c3}`);

  // 拖动 / 场景跳转
  await page.evaluate(() => {
    const s = document.getElementById('seek');
    s.value = '650';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(700);
  const c4 = (await page.textContent('#clock')).trim();
  ok('拖动定位有帧', c4 !== c3, `${c3} → ${c4}`);
  await page.locator('#scenes button').nth(1).click();
  await page.waitForTimeout(900);
  ok('场景跳转有帧', (await page.textContent('#clock')).trim() !== c4);
  await page.screenshot({ path: path.join(OUT, 'seek.png') });

  // 终检：场景序 vs 原序，最终帧逐像素一致
  const verify = await page.evaluate(() => window.__inkVerify());
  ok('最终帧与原序逐像素一致', verify && verify.diffChannels === 0 && verify.max === 0, JSON.stringify(verify));

  // 取消导出
  await page.locator('#scenes button').nth(0).click();
  await page.waitForTimeout(300);
  await page.click('#export');
  await page.waitForTimeout(1500);
  await page.click('#cancelExp');
  await page.waitForTimeout(800);
  ok('导出可取消', (await page.textContent('#expMsg')).includes('取消'), (await page.textContent('#expMsg')).trim());

  // 完整导出
  const totalMs = await page.evaluate(() => window.__ink.total);
  const dlPromise = page.waitForEvent('download', { timeout: 180000 });
  await page.click('#export');
  const dl = await dlPromise;
  const file = path.join(OUT, 'test.webm');
  await dl.saveAs(file);
  const size = fs.statSync(file).size;
  const head = fs.readFileSync(file).subarray(0, 4).toString('hex');
  ok('导出 WebM 文件', size > 50000, `${(size / 1024).toFixed(0)}KB`);
  ok('WebM 头正确', head === '1a45dfa3', head);
  ok('导出提示完成', (await page.textContent('#expMsg')).includes('完成'));
  const vp = await ctx.newPage();
  await vp.goto(BASE + 'dev/out/test.webm', { waitUntil: 'load' });
  await vp.waitForTimeout(600);
  const vinfo = await vp.evaluate(() => {
    const v = document.querySelector('video');
    return v ? { dur: v.duration, w: v.videoWidth, h: v.videoHeight } : null;
  });
  ok('视频分辨率 1280×720', vinfo && vinfo.w === 1280 && vinfo.h === 720, JSON.stringify(vinfo));
  ok('视频时长误差 ≤2%', vinfo && Math.abs(vinfo.dur * 1000 - totalMs) / totalMs <= 0.02,
    `timeline=${(totalMs / 1000).toFixed(2)}s video=${vinfo ? vinfo.dur.toFixed(2) : '?'}s`);
  await vp.close();

  // 不支持 MediaRecorder
  await page.evaluate(() => { window.MediaRecorder = undefined; });
  await page.click('#export');
  await page.waitForTimeout(600);
  ok('不支持录制时有提示', (await page.textContent('#expMsg')).includes('不支持'), (await page.textContent('#expMsg')).trim());

  // 重新载入，边界输入
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(600);
  ok('空状态生成按钮禁用', (await page.getAttribute('#go', 'disabled')) !== null);
  ok('空状态导出按钮禁用', (await page.getAttribute('#export', 'disabled')) !== null);
  await page.fill('#text', '第一段\n\n第二段');
  await page.waitForTimeout(200);
  ok('只有文案时生成按钮仍禁用', (await page.getAttribute('#go', 'disabled')) !== null);

  await page.setInputFiles('#file', path.join(OUT, 'not-image.txt'));
  await page.waitForTimeout(500);
  ok('非图片文件有提示', (await page.textContent('#msg')).includes('图片'), (await page.textContent('#msg')).trim());

  // 9 段：按钮禁用 + 提示
  await page.click('button[data-sample="cat"]');
  await page.waitForTimeout(500);
  const nine = Array.from({ length: 9 }, (_, i) => `第 ${i + 1} 段`).join('\n\n');
  await page.fill('#text', nine);
  await page.waitForTimeout(300);
  ok('超过 8 段时禁用生成', (await page.getAttribute('#go', 'disabled')) !== null);
  ok('超过 8 段有提示', (await page.textContent('#msg')).includes('最多'));

  // 照片：应退化为整图播放
  await page.click('button[data-sample="photo"]');
  await page.waitForTimeout(700);
  await gen(page);
  const modeNote = (await page.textContent('#modeNote')).trim();
  ok('照片自动退化为整图播放', modeNote.includes('整图播放'), modeNote);
  ok('照片生成有读数', (await page.textContent('#stats')).includes('笔'), (await page.textContent('#stats')).trim());
  await page.screenshot({ path: path.join(OUT, 'photo.png') });

  console.log('--- normal console errors ---');
  console.log(errors.length ? errors.join('\n') : '(无)');
  ok('正常流程无页面错误', errors.length === 0, `${errors.length} 条`);
  await ctx.close();
}

// ---------- 字体加载失败时的降级 ----------
{
  const errs = [];
  const { ctx, page } = await newPage({ width: 1280, height: 900 }, {
    route: /MaShanZheng-Regular\.(woff2|ttf)$/,
    routeHandler: (route) => route.abort(),
  });
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(3500);
  await page.click('button[data-sample="cat"]');
  await page.waitForTimeout(400);
  await gen(page);
  const note = (await page.textContent('#modeNote')).trim();
  ok('字体失败时回退楷体', note.includes('系统楷体'), note);
  ok('字体失败仍能生成', (await page.getAttribute('#export', 'disabled')) === null);
  await page.screenshot({ path: path.join(OUT, 'font-fallback.png') });
  await ctx.close();
}

// ---------- 移动端不横向溢出 ----------
{
  const { ctx, page } = await newPage({ width: 390, height: 844 });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok('移动端无横向溢出', over <= 1, `overflow=${over}px`);
  await page.screenshot({ path: path.join(OUT, 'mobile.png'), fullPage: true });
  await ctx.close();
}

console.log('--- last logs ---');
console.log(logs.slice(-12).join('\n'));
await browser.close();
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
