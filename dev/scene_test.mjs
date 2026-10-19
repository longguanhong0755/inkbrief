// 场景规划实验：跑管线 → 分组 → 逆序门禁，打印读数
import { pipelineFor } from './lib/pipeline-cache.mjs';
import { planScenes } from '../js/core/scene-planner.js';
import { checkOrder } from '../js/core/order-check.js';

const file = process.argv[2] || 'dev/fixtures/illustration.raw';
const K = parseInt(process.argv[3] || '4', 10);
const t0 = Date.now();
const { res, cached } = await pipelineFor(file);
const t1 = Date.now();
const plan = planScenes(res, { paragraphs: K, maxScenes: 8, debug: true });
const t2 = Date.now();
const chk = checkOrder(res.strokes, res.clips, plan.order, { cell: 64 });
const t3 = Date.now();
console.log(`${file} ${res.W}x${res.H}${cached ? ' (缓存)' : ''}`);
console.log(`管线 ${t1 - t0}ms  规划 ${t2 - t1}ms  逆序检查 ${t3 - t2}ms`);
console.log('规划', plan.stats);
console.log('门禁', { pairs: chk.pairs, inversions: chk.inversions });
if (chk.examples.length) {
  const dbg = plan._debug;
  for (const e of chk.examples) {
    console.log('  逆序', e.a, '→', e.b, 'at', e.at, 'scene', plan.sceneOf[e.a], plan.sceneOf[e.b], 'tail', e.a >= dbg.tailStart, e.b >= dbg.tailStart);
  }
}
for (const s of plan.scenes) console.log(`  景 ${s.index}: 笔 ${s.strokeCount} 单元 ${s.unitCount} bbox ${s.bbox.map((v) => Math.round(v)).join(',')}`);
