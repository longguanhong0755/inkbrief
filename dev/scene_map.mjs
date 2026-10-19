// 把场景分区画成一张 BMP（肉眼检查分区是否成团），同时输出 JSON 报告。
import fs from 'node:fs';
import { pipelineFor } from './lib/pipeline-cache.mjs';
import { planScenes } from '../js/core/scene-planner.js';
import { checkOrder } from '../js/core/order-check.js';
import { writeBMP } from './lib/bmp.mjs';

const PALETTE = [[196, 85, 59], [217, 154, 78], [91, 143, 116], [107, 127, 168], [160, 106, 154], [138, 138, 79], [176, 106, 74], [79, 138, 154]];
const ALL = ['illustration', 'poster', 'photo'];
const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith('-'));
const K = parseInt(args.find((a) => /^\d+$/.test(a)) || '4', 10);
fs.mkdirSync('dev/out', { recursive: true });

for (const name of (only ? [only] : ALL)) {
  const file = name.endsWith('.raw') ? name : `dev/fixtures/${name}.raw`;
  const { res } = await pipelineFor(file);
  const plan = planScenes(res, { paragraphs: K, maxScenes: 8 });
  const chk = checkOrder(res.strokes, res.clips, plan.order, { cell: 64 });
  const W = res.W, H = res.H;
  const rgb = new Uint8Array(W * H * 3).fill(255);
  const M = plan.scenes.length;
  plan.scenes.forEach((sc, i) => {
    const c = PALETTE[i % PALETTE.length];
    const a = 0.18 + 0.5 * (M <= 1 ? 0 : i / (M - 1));
    const x0 = Math.max(0, Math.min(W - 1, Math.round(sc.bbox[0])));
    const y0 = Math.max(0, Math.min(H - 1, Math.round(sc.bbox[1])));
    const x1 = Math.max(0, Math.min(W - 1, Math.round(sc.bbox[2])));
    const y1 = Math.max(0, Math.min(H - 1, Math.round(sc.bbox[3])));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const k = (y * W + x) * 3;
      rgb[k] = Math.round(rgb[k] * (1 - a) + c[0] * a);
      rgb[k + 1] = Math.round(rgb[k + 1] * (1 - a) + c[1] * a);
      rgb[k + 2] = Math.round(rgb[k + 2] * (1 - a) + c[2] * a);
    }
    for (let x = x0; x <= x1; x++) for (const y of [y0, y1]) {
      const k = (y * W + x) * 3;
      rgb[k] = c[0]; rgb[k + 1] = c[1]; rgb[k + 2] = c[2];
    }
    for (let y = y0; y <= y1; y++) for (const x of [x0, x1]) {
      const k = (y * W + x) * 3;
      rgb[k] = c[0]; rgb[k + 1] = c[1]; rgb[k + 2] = c[2];
    }
  });
  const base = name.replace(/\.raw$/, '');
  writeBMP(`dev/out/scene-${base}.bmp`, W, H, rgb);
  const report = {
    fixture: base, W, H, mode: plan.mode,
    stats: plan.stats,
    inversions: chk.inversions,
    pairs: chk.pairs,
    scenes: plan.scenes.map((s) => ({ index: s.index, strokeCount: s.strokeCount, unitCount: s.unitCount, bbox: s.bbox })),
  };
  fs.writeFileSync(`dev/out/scene-${base}.json`, JSON.stringify(report, null, 2));
  console.log(`${base}: ${plan.mode} ${plan.scenes.length} 景  逆序 ${chk.inversions}  → dev/out/scene-${base}.bmp / .json`);
  for (const s of plan.scenes) console.log(`  景${s.index}: ${s.strokeCount} 笔 / ${s.unitCount} 单元 / bbox ${s.bbox.map((v) => Math.round(v)).join(',')}`);
}
