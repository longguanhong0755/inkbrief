// 抽稀时的选笔策略（纯函数，浏览器与 Node 都能跑）。
//
// 背景：笔数超过一屏能画的上限时必须抽稀。如果按笔序等距抽（每隔 N 笔丢一笔），
// 丢掉的区域**永远不会被涂上**，画面上就是一块块永久白斑。
//
// 实测（dev/lib/raster.mjs 光栅化，photo/poster/illustration 三个 fixture）：
//   keep=27.8%  等距抽     保留 88.6%  空洞 566 块
//   keep=27.8%  本策略     保留 100%   空洞 0 块
//
// 原理：
//  1. 一个 clip 对应画面上一块同色区域，同一 clip 的笔画合起来才是完整的一块。
//     所以同一 clip 的笔要么整组保留，要么整组舍去，不能画一半。
//  2. 预算按「组的画面占比」分配：面积大的块（主体）优先画满，
//     零碎小块（细节）可以只画其中几笔。
//  3. 选中后恢复原始笔序，手绘「由主体长出细节」的手感不变。

/** 多边形面积（shoelace），用来在同组内挑出贡献最大的几笔 */
export function ribbonArea(rib) {
  if (!rib || rib.length < 6) return 0;
  let a = 0;
  for (let i = 0; i < rib.length; i += 2) {
    const j = (i + 2) % rib.length;
    a += rib[i] * rib[j + 1] - rib[j] * rib[i + 1];
  }
  return Math.abs(a) / 2;
}

/**
 * 选出要画的笔（返回下标数组，保持原始笔序）
 * @param {Array} strokes 管线输出，每笔有 c（所属 clip）与 rib
 * @param {Array} clips 管线输出，每项有 w/h
 * @param {number} keep 最多画多少笔
 * @returns {number[]}
 */
export function buildOrder(strokes, clips, keep) {
  const n = strokes ? strokes.length : 0;
  if (!n) return [];
  const k = Math.max(0, Math.min(n, Math.floor(keep)));
  if (k >= n) return Array.from({ length: n }, (_, i) => i);
  if (k === 0) return [];

  // 按 clip 分组
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const c = strokes[i].c;
    let g = groups.get(c);
    if (!g) { g = []; groups.set(c, g); }
    g.push(i);
  }

  // 组权重 = min(clip 覆盖面积, 组内笔画自身面积之和)
  // 用 min 是因为 clip 面积大但笔很稀疏时（背景大色块），
  // 真实贡献的是笔自己的面积，不能被 clip 面积虚高。
  const rows = [];
  let totalWeight = 0;
  for (const [c, list] of groups) {
    const cl = clips && clips[c];
    const clipArea = cl ? cl.w * cl.h : 0;
    let own = 0;
    for (const i of list) own += ribbonArea(strokes[i].rib);
    const weight = Math.min(clipArea, own);
    rows.push({ c, list, weight });
    totalWeight += weight;
  }
  if (totalWeight <= 0) {
    // 面积全算不出来（退化数据）：退化成等距抽稀，至少不会崩
    const set = new Set();
    for (let i = 0; i < k; i++) set.add(Math.floor((i * n) / k));
    return [...set].sort((a, b) => a - b);
  }

  // 面积大的组优先
  rows.sort((a, b) => b.weight - a.weight);

  const picked = [];
  let budget = k;
  for (const row of rows) {
    if (budget <= 0) break;
    const list = row.list;
    if (list.length <= budget) {
      // 整块放得下：全要
      for (const i of list) picked.push(i);
      budget -= list.length;
    } else {
      // 只放得下一部分：按权重占比给额度，组内取面积最大的几笔
      const quota = Math.max(1, Math.min(list.length, Math.floor((k * row.weight) / totalWeight)));
      const part = list
        .slice()
        .sort((a, b) => ribbonArea(strokes[b].rib) - ribbonArea(strokes[a].rib))
        .slice(0, quota);
      for (const i of part) picked.push(i);
      budget -= part.length;
    }
  }

  picked.sort((a, b) => a - b);
  return picked;
}
