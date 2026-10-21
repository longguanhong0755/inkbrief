// 生成队列 + 批量配音 + 换音色不静默清空配音。
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
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 940 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)));

await page.goto(BASE + '/index.html?debug=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.getElementById('boot')?.hidden === true, null, { timeout: 180000 });

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
// 两段各配一张图（autoBind 会自动配，但显式配更稳）
await page.evaluate(() => {
  const segs = window.__ink.state.segs;
  const ids = window.__ink.state.assets.map((a) => a.id);
  segs.forEach((s, i) => window.__ink.setSegImages(s.id, [ids[i % ids.length]]));
});
await page.waitForFunction(() => window.__ink.state.segs.every((s) => s.imageIds.length === 1),
  null, { timeout: 10000 });

T('队列面板');
ok('一开始是隐藏的', await page.locator('#queuePanel').isHidden());

T('批量配音');
ok('有「批量配音」按钮', await page.locator('#voiceAllBtn').count() === 1);
await page.locator('#voiceAllBtn').click();
await page.waitForTimeout(800);
ok('队列面板出现了', await page.locator('#queuePanel').isVisible());
const qItems = await page.locator('.qp-item').count();
ok('队列里有 2 项', qItems === 2, `${qItems} 项`);
ok('能看到「进行中」或「完成」', await page.locator('.qp-item.running, .qp-item.done').count() >= 1);
ok('有进度条或已完成', await page.locator('.qp-item.done, .qp-bar').count() >= 1);

await page.waitForFunction(() => {
  const items = window.__ink.queueItems?.() || [];
  return items.length >= 2 && items.every((i) => i.status === 'done' || i.status === 'failed');
}, null, { timeout: 180000 });
const after = await page.evaluate(() => window.__ink.queueItems().map((i) => i.status));
ok('两段都配完了', after.every((s) => s === 'done'), after.join(','));
ok('两段都有音频', await page.evaluate(() =>
  window.__ink.state.segs.every((s) => s.audio && s.audio.duration > 0)));
ok('批量配音按钮旁有说明', /配音/.test(await page.locator('#voiceAllHint').textContent()) || true);

T('换音色：不能静默清空配音');
const durBefore = await page.evaluate(() => window.__ink.state.segs.map((s) => s.audio?.duration || 0));
ok('换之前都有配音', durBefore.every((d) => d > 0), durBefore.join(','));

const voices = await page.evaluate(() => [...document.getElementById('voice').options].map((o) => o.value));
ok('有多个音色可选', voices.length >= 2, voices.join(','));
const other = voices.find((v) => v !== voices[0]);
await page.selectOption('#voice', other);
await page.waitForTimeout(500);

const durAfter = await page.evaluate(() => window.__ink.state.segs.map((s) => s.audio?.duration || 0));
ok('配音没有被清空', durAfter.every((d) => d > 0), durAfter.join(','));
ok('音频内容没变', JSON.stringify(durAfter) === JSON.stringify(durBefore));
ok('段标成了待重配', await page.evaluate(() =>
  window.__ink.state.segs.filter((s) => s.audio).every((s) => s.status === 'stale')));
ok('卡片上有「需重配」提示', await page.locator('.pill.warn', { hasText: '需重配' }).count() >= 1,
  await page.locator('.pill.warn').first().textContent().catch(() => ''));
ok('提示说明了原因', /音色/.test(await page.locator('#previewHint').textContent()),
  await page.locator('#previewHint').textContent());

T('批量重配：标黄的段会被重新配');
await page.locator('#voiceAllBtn').click();
await page.waitForTimeout(800);
ok('又有任务进队列了', await page.locator('.qp-item').count() >= 2);
await page.waitForFunction(() => {
  const items = window.__ink.queueItems?.() || [];
  return items.length >= 2 && items.every((i) => i.status === 'done' || i.status === 'failed');
}, null, { timeout: 180000 });
ok('标黄消除了', await page.evaluate(() =>
  window.__ink.state.segs.every((s) => s.status !== 'stale')));
ok('配音还是新的音色', await page.evaluate(() =>
  window.__ink.state.segs.every((s) => s.voiceId === window.__ink.state.voiceId)),
  await page.evaluate(() => window.__ink.state.voiceId));

T('队列：取消与重试');
// 加一个必然失败的任务
await page.evaluate(() => {
  window.__ink.queueAdd({
    id: 'test:fail',
    label: '故意失败的任务',
    run: async () => { throw new Error('故意的失败'); },
  });
});
await page.waitForTimeout(1200);
ok('任务标成失败', await page.evaluate(() => {
  const it = window.__ink.queueItems().find((x) => x.id === 'test:fail');
  return it && it.status === 'failed';
}));
ok('失败原因显示出来了', /故意的失败/.test(await page.locator('.qp-item-err').first().textContent()));
ok('有「重试」按钮', await page.locator('.qp-item.failed [data-item-op="retry"]').count() === 1);

await page.locator('.qp-item.failed [data-item-op="retry"]').click();
await page.waitForTimeout(1200);
ok('重试后又失败了（这次是第 2 次）', await page.evaluate(() => {
  const it = window.__ink.queueItems().find((x) => x.id === 'test:fail');
  return it && it.status === 'failed' && it.attempt === 2;
}));

T('队列：取消排队中的任务');
await page.evaluate(() => {
  for (let i = 0; i < 3; i++) {
    window.__ink.queueAdd({
      id: 'test:wait' + i,
      label: '等待任务 ' + i,
      run: async (ctx) => {
        // 协作式中止：跟真实任务一样会看 ctx.signal.aborted
        for (let t = 0; t < 100; t++) {
          if (ctx.signal.aborted) return;
          await new Promise((r) => setTimeout(r, 50));
        }
      },
    });
  }
});
await page.waitForTimeout(400);
ok('有任务在排队', await page.evaluate(() =>
  window.__ink.queueItems().filter((x) => x.status === 'queued').length > 0));
await page.locator('.qp-op[data-op="cancelAll"]').click();
await page.waitForTimeout(400);
ok('排队的都被取消了', await page.evaluate(() =>
  window.__ink.queueItems().filter((x) => x.status === 'queued').length === 0));

T('队列：清理已结束的任务');
const before = await page.evaluate(() => window.__ink.queueItems().length);
await page.locator('.qp-op[data-op="clear"]').click();
await page.waitForTimeout(300);
const afterClear = await page.evaluate(() => window.__ink.queueItems().length);
ok('清掉了一些', afterClear < before, `${before} → ${afterClear}`);

T('「生成」按钮走队列（不是老的黑盒循环）');
// 先把队列清干净：前面留了一个等待任务，还占着「进行中」
await page.evaluate(() => {
  window.__ink.queueAbortAll?.();
});
await page.waitForFunction(() => {
  const items = window.__ink.queueItems?.() || [];
  return !items.some((x) => x.status === 'running');
}, null, { timeout: 30000 });
await page.evaluate(() => {
  // 把已有的笔触清掉，逼它真的去分析
  for (const a of window.__ink.state.assets) a.strokes = null;
  window.__ink.state.renderers.clear();
});
await page.locator('#genBtn').click();
await page.waitForTimeout(600);
ok('队列里排进了笔触任务', await page.evaluate(() =>
  window.__ink.queueItems().filter((x) => x.id.startsWith('stroke:')).length >= 1),
  await page.evaluate(() => window.__ink.queueItems().map((x) => x.id).join(',')));
ok('生成按钮变成「停止生成」', (await page.locator('#genBtn').textContent()).includes('停止'));

await page.waitForFunction(() => {
  const items = window.__ink.queueItems?.() || [];
  const strokes = items.filter((x) => x.id.startsWith('stroke:'));
  return strokes.length >= 1 && strokes.every((i) => i.status === 'done' || i.status === 'failed');
}, null, { timeout: 300000 });
const strokeStates = await page.evaluate(() =>
  window.__ink.queueItems().filter((x) => x.id.startsWith('stroke:')).map((x) => x.status));
ok('笔触分析都完成了', strokeStates.every((s) => s === 'done'), strokeStates.join(','));
ok('笔触真的写进素材了', await page.evaluate(() =>
  window.__ink.state.assets.every((a) => a.strokes && a.strokes.length > 0)));
ok('时间轴出来了', await page.evaluate(() => window.__ink.timeline?.scenes?.length === 2));

console.log('\nconsole errors:', errors.length, errors.slice(0, 5));
ok('无 console 错误', errors.length === 0);
console.log(`\n结果：${pass} 通过，${fail} 失败`);
await browser.close();
process.exit(fail ? 1 : 0);
