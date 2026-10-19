// 门禁：重排后的笔序里，所有"掩膜可能重叠"的笔对必须保持原序。
// 退出码 0 = 通过；1 = 有逆序或场景覆盖不完整。
import { pipelineFor } from './lib/pipeline-cache.mjs';
import { planScenes } from '../js/core/scene-planner.js';
import { checkOrder } from '../js/core/order-check.js';

const ALL = ['illustration', 'poster', 'photo'];
const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith('-'));
const K = parseInt(args.find((a) => /^\d+$/.test(a)) || '4', 10);
const files = only ? [only] : ALL;

let bad = 0;
for (const name of files) {
  const file = name.endsWith('.raw') ? name : `dev/fixtures/${name}.raw`;
  const { res, cached } = await pipelineFor(file);
  const plan = planScenes(res, { paragraphs: K, maxScenes: 8 });
  const chk = checkOrder(res.strokes, res.clips, plan.order, { cell: 64 });
  const n = res.strokes.length;
  const perm = new Set(Array.from(plan.order));
  const problem = [];
  if (chk.inversions) problem.push(`逆序 ${chk.inversions}`);
  if (perm.size !== n) problem.push(`order 不是排列（${perm.size}/${n}）`);
  if (plan.sceneOf.length !== n) problem.push('sceneOf 长度不对');
  if (plan.scenes.some((s) => s.strokeCount <= 0)) problem.push('有空场景');
  for (const v of plan.sceneOf) if (v < 0 || v >= plan.scenes.length) { problem.push('场景号越界'); break; }
  console.log(`${name}: mode=${plan.mode} scenes=${plan.scenes.length} strokes=${n} pairs=${chk.pairs} inversions=${chk.inversions} ${cached ? '(缓存)' : ''}`);
  if (problem.length) { console.log('  FAIL: ' + problem.join('；')); bad++; }
}
process.exit(bad ? 1 : 0);
