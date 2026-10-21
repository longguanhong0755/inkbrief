// 把笔画集合光栅化成覆盖图，用来量化「抽稀造成多少白块」。
// 只在 Node 里跑（离线断言用），不进产品代码。
// 覆盖规则与浏览器一致：笔的 ribbon 多边形 ∩ clip 掩膜。

/** 点在多边形内（偶奇规则） */
export function inPoly(px, py, rib) {
  let inside = false;
  const n = rib.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = rib[i * 2], yi = rib[i * 2 + 1];
    const xj = rib[j * 2], yj = rib[j * 2 + 1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * 光栅化一组笔画。
 * @param {Array} strokes 管线输出
 * @param {Array} clips
 * @param {number} W 画布宽（原图像素）
 * @param {number} H
 * @param {number} D 降采样倍率（1 = 原分辨率，2 = 半分辨率）
 * @param {Int8Array|null} only 长度=strokes.length，1 表示画这一笔
 * @returns {{cover:Uint8Array, gw:number, gh:number}}
 */
export function rasterize(strokes, clips, W, H, D = 2, only = null) {
  const gw = Math.ceil(W / D), gh = Math.ceil(H / D);
  const cover = new Uint8Array(gw * gh);

  for (let si = 0; si < strokes.length; si++) {
    if (only && !only[si]) continue;
    const st = strokes[si];
    const rib = st.rib;
    if (!rib || rib.length < 6) continue;
    const cl = clips[st.c];
    if (!cl) continue;

    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < rib.length; i += 2) {
      if (rib[i] < x0) x0 = rib[i];
      if (rib[i] > x1) x1 = rib[i];
      if (rib[i + 1] < y0) y0 = rib[i + 1];
      if (rib[i + 1] > y1) y1 = rib[i + 1];
    }
    const gx0 = Math.max(0, Math.floor(x0 / D)), gx1 = Math.min(gw - 1, Math.ceil(x1 / D));
    const gy0 = Math.max(0, Math.floor(y0 / D)), gy1 = Math.min(gh - 1, Math.ceil(y1 / D));
    if (gx1 < gx0 || gy1 < gy0) continue;

    for (let gy = gy0; gy <= gy1; gy++) {
      const py = gy * D + D / 2;
      if (py < cl.y || py >= cl.y + cl.h) continue;
      const rowBase = gy * gw;
      for (let gx = gx0; gx <= gx1; gx++) {
        const idx = rowBase + gx;
        if (cover[idx]) continue;
        const px = gx * D + D / 2;
        if (px < cl.x || px >= cl.x + cl.w) continue;
        const mi = (Math.floor(py) - cl.y) * cl.w + (Math.floor(px) - cl.x);
        if (!cl.mask[mi]) continue;
        if (inPoly(px, py, rib)) cover[idx] = 1;
      }
    }
  }
  return { cover, gw, gh };
}

/** 覆盖保留率：原本被墨迹盖住的格子，抽稀后还剩多少 */
export function retention(full, part) {
  let fullCells = 0, kept = 0;
  for (let i = 0; i < full.length; i++) {
    if (full[i]) { fullCells++; if (part[i]) kept++; }
  }
  return { fullCells, kept, ratio: fullCells ? kept / fullCells : 1 };
}

/**
 * 空洞连通块统计（4 邻接）。白碎块的观感 = 块数多 + 最大块大。
 */
export function holeBlocks(full, part, gw, gh) {
  const hole = new Uint8Array(full.length);
  for (let i = 0; i < full.length; i++) if (full[i] && !part[i]) hole[i] = 1;

  const seen = new Uint8Array(hole.length);
  const stack = [];
  let blocks = 0, maxBlock = 0, totalHole = 0;

  for (let i = 0; i < hole.length; i++) {
    if (!hole[i] || seen[i]) continue;
    blocks++;
    let size = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const p = stack.pop();
      size++;
      const x = p % gw, y = (p / gw) | 0;
      if (x > 0 && hole[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < gw - 1 && hole[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && hole[p - gw] && !seen[p - gw]) { seen[p - gw] = 1; stack.push(p - gw); }
      if (y < gh - 1 && hole[p + gw] && !seen[p + gw]) { seen[p + gw] = 1; stack.push(p + gw); }
    }
    totalHole += size;
    if (size > maxBlock) maxBlock = size;
  }
  return { blocks, maxBlock, totalHole };
}
