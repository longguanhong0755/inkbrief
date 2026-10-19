// 顺序门禁：检查重排后的笔序里，是否出现"可能互相覆盖、但先后被颠倒"的笔对。
//
// 判据：每笔的落色范围一定在它的裁剪掩膜（clips[c].mask）内（paintStroke 会 destination-in 掩膜），
// 所以两个掩膜不重叠 ⇒ 两笔绝不可能覆盖同一像素。
// 只要所有"掩膜重叠"的笔对在新序里仍保持原序，最终画面就与不重排时逐像素一致。
//
// 为了快：只检查在新序里被颠倒的笔对（pos[a] > pos[b]），正序的直接跳过。

export function checkOrder(strokes, clips, order, opts = {}) {
  const n = order.length;
  const CELL = opts.cell || 64;
  const pos = new Int32Array(n);
  for (let k = 0; k < n; k++) pos[order[k]] = k;

  const boxes = new Array(n);
  const grid = new Map();
  const key = (cx, cy) => (cx + 2048) * 8192 + (cy + 2048);

  for (let i = 0; i < n; i++) {
    const cl = clips[strokes[i].c];
    if (!cl) { boxes[i] = null; continue; }
    const b = [cl.x, cl.y, cl.x + cl.w - 1, cl.y + cl.h - 1];
    boxes[i] = b;
    const cx0 = Math.floor(b[0] / CELL), cx1 = Math.floor(b[2] / CELL);
    const cy0 = Math.floor(b[1] / CELL), cy1 = Math.floor(b[3] / CELL);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const k = key(cx, cy);
      let arr = grid.get(k);
      if (!arr) { arr = []; grid.set(k, arr); }
      arr.push(i);
    }
  }

  let pairs = 0, inversions = 0;
  const examples = [];
  for (const [k, arr] of grid) {
    const cx = Math.floor(k / 8192) - 2048;
    const cy = (k % 8192) - 2048;
    for (let ai = 0; ai < arr.length; ai++) {
      const a = arr[ai], ba = boxes[a];
      if (!ba) continue;
      for (let bi = ai + 1; bi < arr.length; bi++) {
        const b = arr[bi], bb = boxes[b];
        if (!bb) continue;
        if (ba[0] > bb[2] || bb[0] > ba[2] || ba[1] > bb[3] || bb[1] > ba[3]) continue;
        // 每对只在"重叠区左上角所在格"处理一次，避免跨格重复计数
        const ox = Math.max(ba[0], bb[0]), oy = Math.max(ba[1], bb[1]);
        if (Math.floor(ox / CELL) !== cx || Math.floor(oy / CELL) !== cy) continue;
        pairs++;
        if (pos[a] < pos[b]) continue;       // 新序仍保持原序 → 无论是否重叠都安全
        const ca = clips[strokes[a].c], cb = clips[strokes[b].c];
        let hit = false, hx = 0, hy = 0;
        if (ca === cb) hit = true;
        else {
          const x0 = Math.max(ca.x, cb.x), x1 = Math.min(ca.x + ca.w, cb.x + cb.w);
          const y0 = Math.max(ca.y, cb.y), y1 = Math.min(ca.y + ca.h, cb.y + cb.h);
          if (x0 < x1 && y0 < y1) {
            outer: for (let y = y0; y < y1; y++) {
              const ra = (y - ca.y) * ca.w, rb = (y - cb.y) * cb.w;
              for (let x = x0; x < x1; x++) {
                if (ca.mask[ra + (x - ca.x)] && cb.mask[rb + (x - cb.x)]) { hit = true; hx = x; hy = y; break outer; }
              }
            }
          }
        }
        if (hit) {
          inversions++;
          if (examples.length < 8) examples.push({ a, b, posA: pos[a], posB: pos[b], sceneA: null, sceneB: null, at: [hx, hy] });
        }
      }
    }
  }
  return { pairs, inversions, examples };
}
