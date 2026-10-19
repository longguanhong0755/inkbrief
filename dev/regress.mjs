// 回归基线：三张 fixture 的笔数/模式/场景/时长/逆序。
//   node dev/regress.mjs        对比基线
//   node dev/regress.mjs --save 写基线
import fs from 'node:fs';
import { pipelineFor } from './lib/pipeline-cache.mjs';
import { planScenes } from '../js/core/scene-planner.js';
import { buildTimeline } from '../js/core/timeline.js';
import { checkOrder } from '../js/core/order-check.js';

const PARAS = {
  illustration: ['一只圆脸小猫', '粉色的耳朵和腮红', '它正眯着眼睛笑', '看起来很开心'],
  poster: ['1927 年，一封航空邮件', '红色飞机划过深蓝色的天', 'first to arrive，先到先被看见', '用航空邮件，半盎司一角钱'],
  photo: ['一只猫在舔爪子', '它低着头，很专心', '照片比插画更难画得像'],
};
const FIX = ['illustration', 'poster', 'photo'];
const BASE = 'dev/expected/baseline.json';
const save = process.argv.includes('--save');
const rows = {};

for (const name of FIX) {
  const { res } = await pipelineFor(`dev/fixtures/${name}.raw`);
  const paras = PARAS[name];
  const plan = planScenes(res, { paragraphs: paras.length, maxScenes: 8 });
  const tl = buildTimeline({ plan, strokes: res.strokes, paragraphs: paras, W: res.W, H: res.H });
  const chk = checkOrder(res.strokes, res.clips, plan.order, { cell: 64 });
  const n = res.strokes.length;
  const maxShare = Math.max(...tl.scenes.map((s) => s.strokeCount)) / Math.max(1, n);
  rows[name] = {
    strokes: n,
    mode: plan.mode,
    scenes: tl.scenes.length,
    sceneStrokeCounts: tl.scenes.map((s) => s.strokeCount),
    totalMs: Math.round(tl.totalMs),
    inversions: chk.inversions,
    maxShare: +maxShare.toFixed(3),
  };
}

if (save) {
  fs.mkdirSync('dev/expected', { recursive: true });
  fs.writeFileSync(BASE, JSON.stringify({ generated: new Date().toISOString(), items: rows }, null, 2));
  console.log('已写入 ' + BASE);
  for (const [k, v] of Object.entries(rows)) console.log(k, v);
  process.exit(0);
}

if (!fs.existsSync(BASE)) {
  console.log('没有基线，先跑 node dev/regress.mjs --save');
  process.exit(1);
}
const base = JSON.parse(fs.readFileSync(BASE, 'utf8')).items;
let bad = 0;
for (const name of FIX) {
  const a = rows[name], b = base[name];
  const err = [];
  if (!b) err.push('基线缺这一项');
  else {
    if (a.strokes !== b.strokes) err.push(`笔数 ${b.strokes}→${a.strokes}`);
    if (a.mode !== b.mode) err.push(`模式 ${b.mode}→${a.mode}`);
    if (a.scenes !== b.scenes) err.push(`景数 ${b.scenes}→${a.scenes}`);
    if (JSON.stringify(a.sceneStrokeCounts) !== JSON.stringify(b.sceneStrokeCounts)) err.push('每景笔数变了');
    if (Math.abs(a.totalMs - b.totalMs) > Math.max(500, b.totalMs * 0.02)) err.push(`时长 ${b.totalMs}→${a.totalMs}`);
    if (a.inversions !== 0) err.push(`逆序 ${a.inversions}`);
  }
  console.log(`${name}: ${a.strokes} 笔 / ${a.mode} / ${a.scenes} 景 / ${(a.totalMs / 1000).toFixed(1)}s / 逆序 ${a.inversions}${err.length ? '  FAIL ' + err.join('；') : '  ok'}`);
  if (err.length) bad++;
}
process.exit(bad ? 1 : 0);
