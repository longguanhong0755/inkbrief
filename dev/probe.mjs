// 直接跑管线，打印笔数/图层/尾笔，用来确认 vendored 引擎在 Node 里正常
import { readRaw } from './lib/raw.mjs';

await import('../js/vendor/pipeline.js');
const P = globalThis.ISP_PIPELINE;
const file = process.argv[2] || 'dev/fixtures/illustration.raw';
const img = readRaw(file);
const t0 = Date.now();
let last = '';
const res = await P.run(img.data, img.W, img.H, { colors: 24, detail: 1, debug: true, dropDead: false }, (p, m) => {
  const s = `${(p * 100).toFixed(0)}% ${m}`;
  if (s !== last) { last = s; process.stdout.write('\r' + s.padEnd(60)); }
});
const ms = Date.now() - t0;
const layers = res.dbg.layers;
const neg = res.strokes.filter((s) => s.ly < 0).length;
console.log(`\n${file}  ${img.W}x${img.H}`);
console.log(`用时 ${ms}ms  笔数 ${res.strokes.length}  图层 ${layers.length}  尾笔(ly<0) ${neg}  clips ${res.clips.length}`);
console.log('phases', res.stats.phases, 'colors', res.stats.colors, 'photo', res.stats.photo);
const top = layers.filter((l) => l.strokes > 0).sort((a, b) => b.area - a.area).slice(0, 8);
for (const l of top) console.log(`  layer ${l.oi}: area ${l.area} strokes ${l.strokes} [${l.from},${l.to}) bbox ${l.bbox.join(',')} paper=${l.paper} linear=${l.linear}`);
