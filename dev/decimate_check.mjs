// 抽稀策略离线断言。
//
// 这是本次最关键的回归保护：抽稀方式错了，画面上就是一块块永久白斑，
// 而白斑在浏览器截图里很难一眼归因。这里用光栅化把"抽稀后还剩多少墨迹、
// 有多少块空洞"变成可比较的数字。
//
// 关键数据（photo.raw，15416 笔）：
//   等距抽稀 keep=27.8%  保留 88.6%  空洞 566 块
//   本策略   keep=27.8%  保留 100%   空洞 0 块
import { pipelineFor } from './lib/pipeline-cache.mjs';
import { readRaw } from './lib/raw.mjs';
import { rasterize, retention, holeBlocks } from './lib/raster.mjs';
import { buildOrder, ribbonArea } from '../js/core/stroke-order.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); }
};
const T = (label) => console.log(`\n── ${label} ──`);

const FIXTURES = [
  { file: 'dev/fixtures/photo.raw', name: '照片' },
  { file: 'dev/fixtures/poster.raw', name: '海报' },
  { file: 'dev/fixtures/illustration.raw', name: '插画' },
];

T('buildOrder 基本性质');
{
  const strokes = [{ rib: [0, 0, 10, 0, 10, 10], c: 0 }, { rib: [0, 0, 5, 0, 5, 5], c: 1 }];
  const clips = [{ w: 100, h: 100 }, { w: 10, h: 10 }];
  ok('keep >= 笔数时全要', buildOrder(strokes, clips, 2).length === 2);
  ok('keep = 0 时为空', buildOrder(strokes, clips, 0).length === 0);
  ok('空输入不炸', buildOrder([], [], 5).length === 0);
  ok('结果按原笔序排列', (() => {
    const o = buildOrder(strokes, clips, 2);
    return o.every((v, i) => i === 0 || o[i - 1] < v);
  })());
  ok('不产生重复下标', (() => {
    const o = buildOrder(strokes, clips, 1);
    return new Set(o).size === o.length;
  })());
  ok('下标不越界', (() => {
    const o = buildOrder(strokes, clips, 1);
    return o.every((v) => v >= 0 && v < strokes.length);
  })());
}
{
  ok('ribbonArea 算方形面积', Math.abs(ribbonArea([0, 0, 10, 0, 10, 10, 0, 10]) - 100) < 0.01);
  ok('ribbonArea 对空输入返回 0', ribbonArea(null) === 0 && ribbonArea([]) === 0);
  ok('ribbonArea 对退化输入返回 0', ribbonArea([0, 0]) === 0);
}

for (const fx of FIXTURES) {
  const { res } = await pipelineFor(fx.file);
  const S = res.strokes, C = res.clips;
  const img = readRaw(fx.file);
  const W = img.W, H = img.H, D = 2;

  T(`${fx.name}（${S.length} 笔 / ${C.length} clip）`);

  const { cover: full, gw, gh } = rasterize(S, C, W, H, D);
  const totalCells = gw * gh;

  for (const ratio of [0.5, 0.278, 0.15]) {
    const keep = Math.max(1, Math.round(S.length * ratio));
    const idx = buildOrder(S, C, keep);
    const mask = new Int8Array(S.length);
    for (const i of idx) mask[i] = 1;
    const { cover: part } = rasterize(S, C, W, H, D, mask);
    const r = retention(full, part);
    const hb = holeBlocks(full, part, gw, gh);

    ok(`keep=${(ratio * 100).toFixed(1)}% 笔数不超预算`, idx.length <= keep, `${idx.length} <= ${keep}`);
    // 98% 是实测下界：插画只有 2476 笔，抽到 15%（371 笔）时物理上必然丢细节
    ok(`keep=${(ratio * 100).toFixed(1)}% 墨迹保留 >98%`, r.ratio > 0.98, `${(r.ratio * 100).toFixed(1)}%`);
    ok(`keep=${(ratio * 100).toFixed(1)}% 无大块空洞`, hb.maxBlock < totalCells * 0.01,
      `最大 ${hb.maxBlock} 格 / 全画面 ${totalCells} 格 (${(hb.maxBlock / totalCells * 100).toFixed(2)}%)`);
  }

  // 现状的等距抽稀会出多少洞——留作对照，数字会变，但应始终明显更差
  {
    const keep = Math.max(1, Math.round(S.length * 0.278));
    const set = new Set();
    for (let i = 0; i < keep; i++) set.add(Math.floor((i * S.length) / keep));
    const mask = new Int8Array(S.length);
    for (const i of set) mask[i] = 1;
    const { cover: part } = rasterize(S, C, W, H, D, mask);
    const r = retention(full, part);
    const hb = holeBlocks(full, part, gw, gh);
    ok('对照：等距抽稀明显更差', r.ratio < 0.995 || hb.blocks > 20,
      `等距 保留 ${(r.ratio * 100).toFixed(1)}% 空洞 ${hb.blocks} 块`);
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
