// 场景规划：把 image2strokes 的图层，分成 K 个"出场区块"，并给出重排后的笔序。
//
// 输入来自管线（debug:true, dropDead:false）：
//   strokes[i] = {rib, tp, w, color, c, ly, ...}
//   clips[c]   = {x,y,w,h,mask:Uint8Array}
//   layers[]   = {oi, area, paper, linear, strokes, from, to, bbox:[x0,y0,x1,y1]}
//
// 输出：
//   { mode:'zones'|'flat', sceneOf:Int32Array, order:Int32Array, scenes:[...], stats }
//
// 关键保证：两个可能互相覆盖的笔，如果在原序里 A 在 B 前，就要求 scene(A) <= scene(B)。
// 满足这条，重排后的最终画面与不重排时逐像素一致。
//
// 约束分三层：
//   1) 单元（图层）之间：主掩膜做 4px 粗筛（主笔都在这张掩膜里）；
//   2) 卫星笔（clip 不等于本层主掩膜，例如层间夹的细线）：用 4px 单元地图查它压到谁；
//   3) 尾部补笔：按它压住的单元/更早尾笔归到最晚的那个场景。

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const STEP = 4;

function bboxIntersect(a, b) {
  return !(a[0] > b[2] || b[0] > a[2] || a[1] > b[3] || b[1] > a[3]);
}

// 两个掩膜的重叠像素数（带外框粗筛）
function maskOverlap(a, b) {
  if (!a || !b) return 0;
  const x0 = Math.max(a.x, b.x), x1 = Math.min(a.x + a.w, b.x + b.w);
  const y0 = Math.max(a.y, b.y), y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x0 >= x1 || y0 >= y1) return 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    const ra = (y - a.y) * a.w, rb = (y - b.y) * b.w;
    for (let x = x0; x < x1; x++) {
      if (a.m[ra + (x - a.x)] && b.m[rb + (x - b.x)]) n++;
    }
  }
  return n;
}

// 4px 粗网格：只用于"两个单元是否可能重叠"的粗筛（宁可多判，不可漏判）
function buildGrid(mask, W, H, step = STEP) {
  const gw = Math.ceil(W / step), gh = Math.ceil(H / step);
  const g = new Uint8Array(gw * gh);
  for (let y = 0; y < mask.h; y++) {
    const gy = Math.floor((mask.y + y) / step);
    const row = y * mask.w;
    for (let x = 0; x < mask.w; x++) {
      if (mask.m[row + x]) g[gy * gw + Math.floor((mask.x + x) / step)] = 1;
    }
  }
  return {
    gw, gh, g, step,
    gx0: Math.floor(mask.x / step), gy0: Math.floor(mask.y / step),
    gx1: Math.floor((mask.x + mask.w - 1) / step), gy1: Math.floor((mask.y + mask.h - 1) / step),
  };
}

function gridOverlap(a, b) {
  const x0 = Math.max(a.gx0, b.gx0), x1 = Math.min(a.gx1, b.gx1);
  const y0 = Math.max(a.gy0, b.gy0), y1 = Math.min(a.gy1, b.gy1);
  if (x0 > x1 || y0 > y1) return false;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (a.g[y * a.gw + x] && b.g[y * b.gw + x]) return true;
    }
  }
  return false;
}

function strokeBBox(st) {
  const a = st.rib;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < a.length; i += 2) {
    const x = a[i], y = a[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

// 64px 笔级空间索引：只给"尾笔之间"用（尾笔 clip 小，候选不多）
class StrokeGrid {
  constructor(n, cell = 64) {
    this.cell = cell;
    this.map = new Map();
    this.mark = new Int32Array(n).fill(-1);
    this.qid = 0;
  }
  key(cx, cy) { return (cx + 2048) * 8192 + (cy + 2048); }
  insert(i, box) {
    const c = this.cell;
    const cx0 = Math.floor(box[0] / c), cx1 = Math.floor(box[2] / c);
    const cy0 = Math.floor(box[1] / c), cy1 = Math.floor(box[3] / c);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const k = this.key(cx, cy);
      let a = this.map.get(k);
      if (!a) { a = []; this.map.set(k, a); }
      a.push(i);
    }
  }
  query(box, cb) {
    const c = this.cell;
    const cx0 = Math.floor(box[0] / c), cx1 = Math.floor(box[2] / c);
    const cy0 = Math.floor(box[1] / c), cy1 = Math.floor(box[3] / c);
    const q = ++this.qid;
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const a = this.map.get(this.key(cx, cy));
      if (!a) continue;
      for (const j of a) {
        if (this.mark[j] === q) continue;
        this.mark[j] = q;
        cb(j);
      }
    }
  }
}

function weightedKMeans(units, K, baseIdx) {
  const L = units.length;
  const scene = new Int32Array(L).fill(0);
  if (K <= 1 || L <= 1) return scene;

  const centers = [[units[baseIdx].cx, units[baseIdx].cy]];
  const used = new Uint8Array(L);
  used[baseIdx] = 1;
  while (centers.length < K) {
    let best = -1, bestD = -1;
    for (let i = 0; i < L; i++) {
      if (used[i]) continue;
      let d2 = Infinity;
      for (const c of centers) {
        const dx = units[i].cx - c[0], dy = units[i].cy - c[1];
        d2 = Math.min(d2, dx * dx + dy * dy);
      }
      const score = d2 * Math.sqrt(Math.max(1, units[i].area));
      if (score > bestD) { bestD = score; best = i; }
    }
    if (best < 0) break;
    used[best] = 1;
    centers.push([units[best].cx, units[best].cy]);
  }
  const realK = centers.length;

  for (let iter = 0; iter < 24; iter++) {
    let changed = 0;
    for (let i = 0; i < L; i++) {
      if (i === baseIdx) { if (scene[i] !== 0) { scene[i] = 0; changed++; } continue; }
      let best = 0, bestD = Infinity;
      for (let k = 0; k < realK; k++) {
        const dx = units[i].cx - centers[k][0], dy = units[i].cy - centers[k][1];
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = k; }
      }
      if (scene[i] !== best) { scene[i] = best; changed++; }
    }
    const sx = new Float64Array(realK), sy = new Float64Array(realK), sw = new Float64Array(realK);
    for (let i = 0; i < L; i++) {
      const k = scene[i], w = Math.max(1, units[i].area);
      sx[k] += units[i].cx * w; sy[k] += units[i].cy * w; sw[k] += w;
    }
    for (let k = 0; k < realK; k++) {
      if (sw[k] > 0) { centers[k][0] = sx[k] / sw[k]; centers[k][1] = sy[k] / sw[k]; }
    }
    if (!changed) break;
  }
  scene[baseIdx] = 0;
  return scene;
}

export function planScenes(data, opts = {}) {
  const tStart = Date.now();
  const { strokes, clips } = data;
  const layers = data.layers || (data.dbg && data.dbg.layers) || [];
  const W = data.W, H = data.H;
  const n = strokes.length;
  const paragraphCount = clamp(opts.paragraphs || 3, 1, 12);
  const maxScenes = clamp(opts.maxScenes || 8, 2, 12);
  const K = Math.min(paragraphCount, maxScenes);

  const flat = (reason) => ({
    mode: 'flat',
    sceneOf: new Int32Array(n),
    order: Int32Array.from({ length: n }, (_, i) => i),
    scenes: [{
      index: 0,
      strokes: Array.from({ length: n }, (_, i) => i),
      bbox: [0, 0, W - 1, H - 1],
      strokeCount: n,
      unitCount: 0,
    }],
    stats: { mode: 'flat', reason, sceneCount: 1, units: 0, tails: 0, changedUnits: 0, paragraphs: paragraphCount },
  });

  const live = layers.filter((l) => l.strokes > 0 && l.to > l.from).sort((a, b) => a.from - b.from);
  if (!live.length || n === 0) return flat('no-layers');

  // ---- 1. 图层 → 单元 ----
  const units = [];
  const owner = new Int32Array(n).fill(-1);
  let prevTo = 0;
  for (const l of live) {
    const from = Math.max(prevTo, l.from | 0);
    const to = Math.min(n, l.to | 0);
    if (to <= from) continue;
    const u = {
      idx: units.length,
      from, to,
      bbox: [l.bbox[0], l.bbox[1], l.bbox[2], l.bbox[3]],
      area: Math.max(1, l.area || 1),
      cx: (l.bbox[0] + l.bbox[2]) / 2,
      cy: (l.bbox[1] + l.bbox[3]) / 2,
    };
    const cnt = new Map();
    for (let i = from; i < to; i++) {
      const c = strokes[i].c;
      cnt.set(c, (cnt.get(c) || 0) + 1);
    }
    let bestC = -1, bestN = -1;
    for (const [c, k] of cnt) if (k > bestN) { bestN = k; bestC = c; }
    const cl = clips[bestC];
    u.clip = bestC;
    u.mask = cl ? { x: cl.x, y: cl.y, w: cl.w, h: cl.h, m: cl.mask } : null;
    u.grid = u.mask ? buildGrid(u.mask, W, H, STEP) : null;
    units.push(u);
    for (let i = from; i < to; i++) owner[i] = u.idx;
    prevTo = Math.max(prevTo, to);
  }
  if (!units.length) return flat('no-units');

  const tailStart = units[units.length - 1].to;
  let cur = units[0].idx;
  for (let i = 0; i < tailStart; i++) {
    if (owner[i] >= 0) cur = owner[i];
    else owner[i] = cur;
  }
  for (let i = tailStart; i < n; i++) owner[i] = -2;

  // ---- 2. 空间分组 ----
  const scene = weightedKMeans(units, Math.min(K, units.length), 0);
  const L = units.length;

  // ---- 3. 顺序约束 ----
  const preds = Array.from({ length: L }, () => []);
  const addPred = (v, u) => {
    if (v === u) return;
    const a = preds[v];
    if (a.indexOf(u) < 0) a.push(u);
  };

  // 3a) 主笔之间：单元主掩膜 4px 粗筛
  for (let i = 0; i < L; i++) {
    for (let j = i + 1; j < L; j++) {
      if (!units[i].grid || !units[j].grid) continue;
      if (gridOverlap(units[i].grid, units[j].grid)) addPred(j, i);
    }
  }
  const tUnitEdges = Date.now();

  // 3b) 卫星笔：4px 单元地图查它压到哪些单元
  const gw = Math.ceil(W / STEP), gh = Math.ceil(H / STEP);
  const cellUnits = new Array(gw * gh);
  const addCell = (k, idx) => {
    let a = cellUnits[k];
    if (!a) { a = cellUnits[k] = []; }
    if (a[a.length - 1] !== idx) a.push(idx);
  };
  const eachMaskCell = (m, idx) => {
    for (let y = 0; y < m.h; y++) {
      const gy = Math.floor((m.y + y) / STEP);
      if (gy < 0 || gy >= gh) continue;
      const row = y * m.w;
      for (let x = 0; x < m.w; x++) {
        if (!m.m[row + x]) continue;
        const gx = Math.floor((m.x + x) / STEP);
        if (gx < 0 || gx >= gw) continue;
        addCell(gy * gw + gx, idx);
      }
    }
  };
  for (const u of units) if (u.mask) eachMaskCell(u.mask, u.idx);
  for (let i = 0; i < tailStart; i++) {
    const u = owner[i];
    if (u < 0 || strokes[i].c === units[u].clip) continue;
    const cl = clips[strokes[i].c];
    if (cl) eachMaskCell({ x: cl.x, y: cl.y, w: cl.w, h: cl.h, m: cl.mask }, u);
  }
  const unitsInClipCells = (cl) => {
    const hit = new Map();
    const x0 = Math.max(0, Math.floor(cl.x / STEP)), x1 = Math.min(gw - 1, Math.floor((cl.x + cl.w - 1) / STEP));
    const y0 = Math.max(0, Math.floor(cl.y / STEP)), y1 = Math.min(gh - 1, Math.floor((cl.y + cl.h - 1) / STEP));
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const arr = cellUnits[cy * gw + cx];
      if (!arr) continue;
      for (const v of arr) hit.set(v, (hit.get(v) || 0) + 1);
    }
    return hit;
  };
  for (let i = 0; i < tailStart; i++) {
    const u = owner[i];
    if (u < 0 || strokes[i].c === units[u].clip) continue;
    const cl = clips[strokes[i].c];
    if (!cl) continue;
    const hit = unitsInClipCells(cl);
    for (const v of hit.keys()) {
      if (v === u) continue;
      if (i < units[v].from) addPred(v, u); else addPred(u, v);
    }
  }
  const tEdges = Date.now();

  // ---- 4. 修场景号：保证沿原序单调 ----
  let changedUnits = 0;
  for (let v = 0; v < L; v++) {
    let s = scene[v];
    for (const p of preds[v]) if (scene[p] > s) s = scene[p];
    if (s !== scene[v]) { scene[v] = s; changedUnits++; }
  }

  // ---- 5. 尾部补笔：压住的单元 + 更早尾笔 ----
  // 尾笔很多（海报 1.2 万支），两两比较会慢；用 4px 空间索引 + "候选场景不比当前高就跳过"。
  let maxUnitScene = 0;
  for (const s of scene) if (s > maxUnitScene) maxUnitScene = s;
  const tailGrid = new StrokeGrid(n, 4);
  const tailScene = new Map();
  for (let i = tailStart; i < n; i++) {
    const cl = clips[strokes[i].c];
    if (!cl) { tailScene.set(i, scene[0]); continue; }
    const mi = { x: cl.x, y: cl.y, w: cl.w, h: cl.h, m: cl.mask };
    const box = [cl.x, cl.y, cl.x + cl.w - 1, cl.y + cl.h - 1];
    const hit = unitsInClipCells(cl);
    let s = -1, bestV = -1, bestN = -1;
    for (const [v, cnt] of hit) {
      if (scene[v] > s) s = scene[v];
      if (cnt > bestN) { bestN = cnt; bestV = v; }
    }
    if (s < 0) {
      if (bestV >= 0) s = scene[bestV];
      else {
        let best = 0, bestD = Infinity;
        const cx = cl.x + cl.w / 2, cy = cl.y + cl.h / 2;
        for (let v = 0; v < L; v++) {
          const dx = units[v].cx - cx, dy = units[v].cy - cy;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = v; }
        }
        s = scene[best];
      }
    }
    if (s < maxUnitScene) {
      tailGrid.query(box, (j) => {
        const ts = tailScene.get(j);
        if (ts === undefined || ts <= s) return;
        const cj = clips[strokes[j].c];
        if (!cj) return;
        if (!bboxIntersect(box, [cj.x, cj.y, cj.x + cj.w - 1, cj.y + cj.h - 1])) return;
        if (maskOverlap(mi, { x: cj.x, y: cj.y, w: cj.w, h: cj.h, m: cj.mask }) > 0) s = ts;
      });
    }
    tailScene.set(i, s);
    tailGrid.insert(i, box);
  }
  const tTails = Date.now();

  // ---- 6. 场景号压缩；只剩一景就退化成整图 ----
  const all = new Set();
  for (const s of scene) all.add(s);
  for (const s of tailScene.values()) all.add(s);
  const distinct = [...all].sort((a, b) => a - b);
  if (distinct.length < 2) return flat('single-scene');
  const remap = new Map(distinct.map((s, k) => [s, k]));
  const M = distinct.length;

  const sceneOf = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (owner[i] === -2) sceneOf[i] = remap.get(tailScene.get(i) || 0) || 0;
    else sceneOf[i] = remap.get(scene[owner[i]]) || 0;
  }

  // 稳定排序：先按场景，再按原笔号
  const order = Int32Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => (sceneOf[a] - sceneOf[b]) || (a - b));

  const scenes = [];
  for (let k = 0; k < M; k++) scenes.push({ index: k, strokes: [], bbox: [Infinity, Infinity, -Infinity, -Infinity], strokeCount: 0, unitCount: 0 });
  for (let i = 0; i < n; i++) {
    const k = sceneOf[i];
    const sc = scenes[k];
    sc.strokes.push(i);
    sc.strokeCount++;
    const b = strokeBBox(strokes[i]);
    if (b[0] < sc.bbox[0]) sc.bbox[0] = b[0];
    if (b[1] < sc.bbox[1]) sc.bbox[1] = b[1];
    if (b[2] > sc.bbox[2]) sc.bbox[2] = b[2];
    if (b[3] > sc.bbox[3]) sc.bbox[3] = b[3];
  }
  for (const u of units) scenes[remap.get(scene[u.idx])].unitCount++;

  // 层与层互相压得太密（照片常见）或某一景吃掉 85% 的笔 ⇒ 分区没有意义，退回整图
  const maxShare = Math.max(...scenes.map((s) => s.strokeCount)) / Math.max(1, n);
  if (changedUnits > units.length * 0.4 || maxShare > 0.85) return flat('too-interleaved');

  const out = {
    mode: 'zones',
    sceneOf,
    order,
    scenes,
    stats: {
      mode: 'zones',
      reason: '',
      sceneCount: M,
      units: L,
      tails: n - tailStart,
      changedUnits,
      paragraphs: paragraphCount,
      k: K,
      sceneStrokeCounts: scenes.map((s) => s.strokeCount),
      sceneUnitCounts: scenes.map((s) => s.unitCount),
      ms: { unitEdges: tUnitEdges - tStart, edges: tEdges - tUnitEdges, tails: tTails - tEdges, total: Date.now() - tStart },
    },
  };
  if (opts.debug) out._debug = {
    units, unitScene: scene, tailScene, owner, tailStart, remap, distinct, preds,
    unitClip: units.map((u) => u.clip),
    gridOverlap: (i, j) => !!(units[i].grid && units[j].grid && gridOverlap(units[i].grid, units[j].grid)),
    gridCell: (i, gx, gy) => {
      const g = units[i].grid;
      if (!g || gx < g.gx0 || gx > g.gx1 || gy < g.gy0 || gy > g.gy1) return -1;
      return g.g[gy * g.gw + gx];
    },
    unitsInStroke: (i) => {
      const cl = clips[strokes[i].c];
      return cl ? [...unitsInClipCells(cl).keys()] : [];
    },
  };
  return out;
}
