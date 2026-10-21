// 任务队列：五态、并发上限、协作式中止、单项重试、清理。
// 这是纯逻辑测试，不开浏览器（scheduler.js 不依赖 DOM）。
import { TaskQueue } from '../js/core/scheduler.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); }
};
const T = (label) => console.log(`\n── ${label} ──`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 等队列跑到「没有排队也没有进行中」 */
const settle = async (q, timeout = 5000) => {
  const t0 = Date.now();
  while (q.isActive()) {
    if (Date.now() - t0 > timeout) throw new Error('队列没跑完');
    await sleep(5);
  }
  // 再等一拍，让状态落定
  await sleep(20);
};
/** 等某个任务真的跑起来（调度是 rAF 触发的，不是同步的） */
const waitRunning = async (q, id, timeout = 2000) => {
  const t0 = Date.now();
  while (true) {
    const it = q.items.find((x) => x.id === id);
    if (it && it.status === 'running') return it;
    if (Date.now() - t0 > timeout) throw new Error(`${id} 没跑起来`);
    await sleep(5);
  }
};
/** 等某个任务落到终态（中止中的任务 isActive 已经是 false，得单独等） */
const waitTerminal = async (q, id, timeout = 2000) => {
  const t0 = Date.now();
  while (true) {
    const it = q.items.find((x) => x.id === id);
    if (it && it.status !== 'running' && it.status !== 'queued') return it;
    if (Date.now() - t0 > timeout) throw new Error(`${id} 没落到终态`);
    await sleep(5);
  }
};

T('基本流转');
{
  const q = new TaskQueue({ concurrency: 1 });
  let ran = 0;
  q.add({ id: 'a', label: 'A', run: async () => { ran++; } });
  ok('加进去是排队中', q.items[0].status === 'queued');
  q.start();
  await settle(q);
  ok('跑完了是完成', q.items[0].status === 'done', q.items[0].status);
  ok('确实跑了一次', ran === 1);
  ok('进度是 1', q.items[0].progress === 1);
  ok('isActive 变 false', q.isActive() === false);
  ok('isDone 变 true', q.isDone() === true);
}

T('失败要能被看见');
{
  const q = new TaskQueue({ concurrency: 1 });
  q.add({ id: 'bad', label: '会炸的', run: async () => { throw new Error('故意的'); } });
  q.start();
  await settle(q);
  ok('状态是失败', q.items[0].status === 'failed', q.items[0].status);
  ok('错误信息留住了', q.items[0].error === '故意的', q.items[0].error);
  ok('失败后 isDone 仍是 true（没在跑）', q.isDone() === true);
}

T('重试');
{
  const q = new TaskQueue({ concurrency: 1 });
  let n = 0;
  q.add({ id: 'x', label: '前两次失败', run: async () => { n++; if (n < 3) throw new Error('还没好'); } });
  q.start();
  await settle(q);
  ok('第一次失败', q.items[0].status === 'failed');
  ok('尝试次数记着', q.items[0].attempt === 1, String(q.items[0].attempt));

  ok('retry 返回 true', q.retry('x') === true);
  ok('重试后回到排队中', q.items[0].status === 'queued');
  await settle(q);
  ok('第二次还是失败', q.items[0].status === 'failed');
  ok('尝试次数变成 2', q.items[0].attempt === 2, String(q.items[0].attempt));

  q.retry('x');
  await settle(q);
  ok('第三次成功', q.items[0].status === 'done', q.items[0].status);
  ok('成功时 attempt 是 3', q.items[0].attempt === 3, String(q.items[0].attempt));
}

T('重试失败的一批');
{
  const q = new TaskQueue({ concurrency: 1 });
  q.add({ id: 'b1', label: 'B1', run: async () => { throw new Error('x'); } });
  q.add({ id: 'b2', label: 'B2', run: async () => { throw new Error('x'); } });
  q.start();
  await settle(q);
  ok('两个都失败', q.items.filter((i) => i.status === 'failed').length === 2);
  const n = q.retryFailed();
  ok('retryFailed 返回 2', n === 2, String(n));
  ok('都回到排队中', q.items.every((i) => i.status === 'queued'));
}

T('取消排队中的任务');
{
  const q = new TaskQueue({ concurrency: 1 });
  q.add({ id: 'r1', label: '正在跑', run: async () => { await sleep(60); } });
  q.add({ id: 'r2', label: '排队中', run: async () => { await sleep(10); } });
  q.start();
  await waitRunning(q, 'r1');
  ok('取消排队中的那个', q.cancel('r2') === true);
  ok('状态是已取消', q.items[1].status === 'cancelled');
  ok('取消不会误伤在跑的', q.items[0].status === 'running');
  await settle(q);
  ok('在跑的那个照常完成', q.items[0].status === 'done', q.items[0].status);
}

T('协作式中止');
{
  const q = new TaskQueue({ concurrency: 1 });
  let sawAbort = false;
  q.add({
    id: 'long', label: '长任务',
    run: async (ctx) => {
      for (let i = 0; i < 100; i++) {
        if (ctx.signal.aborted) { sawAbort = true; return; }
        await sleep(5);
      }
    },
  });
  q.start();
  await waitRunning(q, 'long');
  ok('requestAbort 返回 true', q.requestAbort('long') === true);
  await settle(q);
  ok('任务自己看到信号了', sawAbort === true);
  ok('状态是已取消（不是完成）', q.items[0].status === 'cancelled', q.items[0].status);
  ok('标记了 aborting', q.items[0].aborting === true);
}

T('中止后不再算「活跃」');
{
  const q = new TaskQueue({ concurrency: 1 });
  q.add({ id: 'm', label: 'M', run: async (ctx) => { await sleep(50); } });
  q.start();
  await waitRunning(q, 'm');
  q.requestAbort('m');
  ok('正在收尾但不再算活跃', q.isActive() === false, q.items[0].status);
  await waitTerminal(q, 'm');
  ok('最终状态是已取消', q.items[0].status === 'cancelled', q.items[0].status);
}

T('并发上限');
{
  const q = new TaskQueue({ concurrency: 2 });
  let cur = 0, peak = 0;
  const mk = (id) => q.add({
    id, label: id,
    run: async () => { cur++; peak = Math.max(peak, cur); await sleep(40); cur--; },
  });
  for (let i = 0; i < 6; i++) mk('t' + i);
  q.start();
  await settle(q);
  ok('同时最多跑 2 个', peak <= 2, `峰值 ${peak}`);
  ok('6 个都跑完了', q.items.every((i) => i.status === 'done'));
}

T('清理与移除');
{
  const q = new TaskQueue({ concurrency: 1 });
  q.add({ id: 'k1', label: 'K1', run: async () => { throw new Error('x'); } });
  q.add({ id: 'k2', label: 'K2', run: async () => { await sleep(10); } });
  q.start();
  await settle(q);
  ok('两个都在', q.items.length === 2, String(q.items.length));
  q.clearFinished();
  ok('清理后空了', q.items.length === 0, String(q.items.length));

  q.add({ id: 'k3', label: 'K3', run: async () => {} });
  q.remove('k3');
  ok('remove 能去掉', q.items.length === 0);
}

T('同 id 重复加是替换');
{
  const q = new TaskQueue({ concurrency: 1 });
  q.add({ id: 'same', label: '第一个', run: async () => { throw new Error('x'); } });
  q.add({ id: 'same', label: '第二个', run: async () => {} });
  ok('还是一个任务', q.items.length === 1, String(q.items.length));
  ok('标签换成了新的', q.items[0].label === '第二个');
  q.start();
  await settle(q);
  ok('跑的是新那个（成功）', q.items[0].status === 'done', q.items[0].status);
}

T('进度回调');
{
  const q = new TaskQueue({ concurrency: 1 });
  const seen = [];
  q.add({
    id: 'p', label: 'P',
    run: async (ctx) => { ctx.onProgress(0.5); ctx.onProgress(1); },
  });
  q.start();
  await settle(q);
  ok('进度记下来了', q.items[0].progress === 1, String(q.items[0].progress));
}

T('统计');
{
  const q = new TaskQueue({ concurrency: 1 });
  q.add({ id: 's1', label: 'S1', run: async () => {} });
  q.add({ id: 's2', label: 'S2', run: async () => { throw new Error('x'); } });
  q.start();
  await settle(q);
  const s = q.summary;
  ok('完成 1 个', s.done === 1, JSON.stringify(s));
  ok('失败 1 个', s.failed === 1, JSON.stringify(s));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
