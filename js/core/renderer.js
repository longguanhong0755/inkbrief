// 逐笔渲染器：从 image2strokes 的 app.js 移植（paintStroke / clip 掩膜 / 笔尖）。
// 只负责把"第 pos 笔、进度 u"画到离屏画布；不负责 UI、时间轴、导出。
import { buildOrder } from './stroke-order.js?v=10';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function hash01(a, b) {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
}
function ribbonPath(st) {
  const p = new Path2D();
  const r = st.rib;
  p.moveTo(r[0], r[1]);
  for (let i = 2; i < r.length; i += 2) p.lineTo(r[i], r[i + 1]);
  p.closePath();
  return p;
}

/**
 * 一笔的静态几何量：路径、包围盒、笔尖折线的弧长前缀和、颜色串。
 *
 * 这些量跟「画到第几笔」无关，每一帧都一样。所以算一次缓存起来，
 * 别在每帧里重算——实测一笔要跑两遍弧长扫描 + 两遍包围盒扫描。
 */
function geomOf(st) {
  let g = st._geom;
  if (g) return g;

  // 包围盒（笔触本身的 ribbon，不含笔尖）
  const rib = st.rib;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < rib.length; i += 2) {
    const px = rib[i], py = rib[i + 1];
    if (px < x0) x0 = px;
    if (px > x1) x1 = px;
    if (py < y0) y0 = py;
    if (py > y1) y1 = py;
  }

  // 笔尖折线的弧长前缀和：让 tipAt 从「两遍扫描」变成「一遍扫描 + 查表」
  const tp = st.tp, n = tp.length / 2;
  const cum = new Float64Array(Math.max(1, n));
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += Math.hypot(tp[i * 2] - tp[(i - 1) * 2], tp[i * 2 + 1] - tp[(i - 1) * 2 + 1]);
    cum[i] = total;
  }

  const c = st.color;
  g = st._geom = {
    path: ribbonPath(st),
    x0, y0, x1, y1,
    cum, total,
    rgb: 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')',
  };
  return g;
}

/** 笔尖位置：在弧长前缀和上二分，比原来两遍 hypot 扫描快 */
function tipAt(st, u) {
  const tp = st.tp, n = tp.length / 2;
  if (n < 2) return { x: tp[0], y: tp[1], dx: 1, dy: 0, single: true };
  const g = geomOf(st);
  const cum = g.cum;
  const want = clamp(u, 0, 1) * g.total;

  // 二分找目标落在哪一段
  let lo = 1, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < want) lo = mid + 1; else hi = mid;
  }
  const i = lo;
  const ax = tp[(i - 1) * 2], ay = tp[(i - 1) * 2 + 1];
  const bx = tp[i * 2], by = tp[i * 2 + 1];
  const seg = Math.hypot(bx - ax, by - ay);
  const run = cum[i - 1];
  const f = seg > 1e-6 ? (want - run) / seg : 1;
  const x = ax + (bx - ax) * f, y = ay + (by - ay) * f;
  const dx = bx - ax, dy = by - ay, ln = Math.hypot(dx, dy) || 1;
  return { x, y, dx: dx / ln, dy: dy / ln, single: false };
}

function leadPath(t, st) {
  const behind = st.pen ? 0 : Math.max(2, st.w * 0.45);
  const spread = Math.max(4, st.w * 1.3);
  const seed = st.ms * 7 + st.tp.length;
  const p = new Path2D();
  const nx = -t.dy, ny = t.dx;
  const back = 4000;
  p.moveTo(t.x - t.dx * back + nx * spread, t.y - t.dy * back + ny * spread);
  for (let k = 1; k <= 12; k++) {
    const f = k / 12;
    const j = (hash01(seed, k) - 0.5) * spread * 0.55;
    const along = -behind * f;
    p.lineTo(t.x + t.dx * along + nx * (spread + j), t.y + t.dy * along + ny * (spread + j));
  }
  for (let k = 12; k >= 1; k--) {
    const f = k / 12;
    const j = (hash01(seed + 3, k) - 0.5) * spread * 0.55;
    const along = -behind * f;
    p.lineTo(t.x + t.dx * along - nx * (spread + j), t.y + t.dy * along - ny * (spread + j));
  }
  p.closePath();
  return p;
}

/**
 * 掩膜图集：一张 2048² 画布按货架排布塞进成百上千个小掩膜，只写一次。
 *
 * 三个关键设计（都是实测逼出来的）：
 *
 * 1. **整页一次性上传**。早先每个 clip 单独 createImageData + putImageData，
 *    一张照片有 8000 多个 clip，就是 8000 多次上传。
 *
 * 2. **先打包、后绘制，绝不边写边读**。这是最大的坑：
 *    在 2048² 大画布上 putImageData 之后马上 drawImage 读它，
 *    每次都会触发整页 16MB 纹理重传——隔离测「打包」只要 1.2 秒，
 *    混在绘制循环里就变成 4.4 秒，差 3.6 倍。
 *    所以改成：先把这一屏用到的掩膜全部写进图集、统一刷盘，
 *    绘制阶段只做 Map 查表，一个像素都不再写。
 *
 * 3. **按资产共享**。掩膜只跟资产有关，跟抽稀比例（keep）无关。
 *    所以同一张图被多个渲染器用（比如改了时长导致 keep 变、渲染器重建）时，
 *    直接复用同一份图集，不必重新打包。
 */
class ClipAtlas {
  constructor(max = 2048) {
    this.max = max;
    this.pages = [];
    this.slots = new Map();     // clip 下标 -> {cv, x, y, w, h}
    this.pg = null;             // 当前正在填的页
    this.x = 0; this.y = 0; this.rowH = 0;
  }

  _newPage() {
    const cv = document.createElement('canvas');
    cv.width = this.max; cv.height = this.max;
    const ctx = cv.getContext('2d');
    // 整页开一块 ImageData，掩膜直接写进它的像素缓冲
    const img = ctx.createImageData(this.max, this.max);
    const pg = { cv, ctx, img, u32: new Uint32Array(img.data.buffer), dirty: false, sealed: false };
    this.pages.push(pg);
    this.pg = pg;
    this.x = 0; this.y = 0; this.rowH = 0;
    return pg;
  }

  /** 把一页刷到画布上（只在这一页填满、或整批打包结束时做） */
  _flush(pg) {
    if (!pg || !pg.dirty) { if (pg) pg.sealed = true; return; }
    pg.ctx.putImageData(pg.img, 0, 0);
    pg.dirty = false;
    // ImageData 跟画布内容是两份内存，16MB 一页，刷完就放掉
    pg.img = null; pg.u32 = null;
    pg.sealed = true;
  }

  /**
   * 把一批掩膜打包进图集。只在渲染器建好、知道要画哪些笔时调用一次。
   * @param {Array} clips 资产的全部 clip
   * @param {number[]} indices 这批要用的 clip 下标
   */
  ensurePacked(clips, indices) {
    if (!indices || !indices.length) return;
    for (const i of indices) {
      if (this.slots.has(i)) continue;
      const cl = clips && clips[i];
      if (!cl || !cl.mask) continue;
      // 超过图集尺寸的超大掩膜单独一张，避免浪费整页
      if (cl.w > this.max || cl.h > this.max) {
        const cv = document.createElement('canvas');
        cv.width = cl.w; cv.height = cl.h;
        const c2 = cv.getContext('2d');
        const id = c2.createImageData(cl.w, cl.h);
        const u32 = new Uint32Array(id.data.buffer);
        for (let k = 0; k < cl.mask.length; k++) u32[k] = cl.mask[k] ? 0xffffffff : 0;
        c2.putImageData(id, 0, 0);
        this.slots.set(i, { cv, x: 0, y: 0, w: cl.w, h: cl.h });
        continue;
      }
      // 当前页已经封口（刷过一次）就另开一页——封口的页不再往里写
      if (!this.pg || this.pg.sealed) {
        if (this.pg) this._flush(this.pg);
        this._newPage();
      }
      if (this.x + cl.w > this.max) { this.x = 0; this.y += this.rowH + 1; this.rowH = 0; }
      if (this.y + cl.h > this.max) {
        this._flush(this.pg);
        this._newPage();
        this.x = 0; this.y = 0; this.rowH = 0;
      }
      const pg = this.pg;
      const u32 = pg.u32;
      const m = cl.mask;
      for (let y = 0; y < cl.h; y++) {
        const src = y * cl.w;
        const dst = (this.y + y) * this.max + this.x;
        for (let x = 0; x < cl.w; x++) u32[dst + x] = m[src + x] ? 0xffffffff : 0;
      }
      pg.dirty = true;
      this.slots.set(i, { cv: pg.cv, x: this.x, y: this.y, w: cl.w, h: cl.h });
      this.x += cl.w + 1;
      if (cl.h > this.rowH) this.rowH = cl.h;
    }
    // 整批打包完，把当前页也刷出去（后面要读它）
    if (this.pg) this._flush(this.pg);
  }

  /** 绘制阶段只查表，不再写画布 */
  get(i) {
    return this.slots.get(i) || null;
  }
}

/**
 * 掩膜图集缓存：按资产 id 共享。
 *
 * 掩膜是资产的静态属性，跟抽稀比例无关。渲染器重建（比如用户拖了时长滑块，
 * keep 变了）时如果重新打包 8000 多个掩膜，主线程要卡 4 秒多——
 * 而重建渲染器本身只是因为 keep 变了一点点。
 * 所以这里按 assetId 缓存，资产还在就复用。
 */
const atlasCache = new Map();

export function getAtlas(assetId) {
  let a = atlasCache.get(assetId);
  if (!a) {
    a = new ClipAtlas();
    atlasCache.set(assetId, a);
  }
  return a;
}

/** 资产被删掉时把它的图集一起释放（否则显存会一直占着） */
export function dropAtlas(assetId) {
  const a = atlasCache.get(assetId);
  if (!a) return;
  for (const pg of a.pages) { pg.cv.width = 0; pg.cv.height = 0; }
  atlasCache.delete(assetId);
}

export class StrokeRenderer {
  constructor({ W, H, strokes, clips, order, atlas }) {
    this.W = W; this.H = H;
    this.S = strokes; this.C = clips; this.order = order;
    this.painted = document.createElement('canvas');
    this.painted.width = W; this.painted.height = H;
    this.pctx = this.painted.getContext('2d');
    this.tmpC = document.createElement('canvas');
    this.tmpC.width = W; this.tmpC.height = H;
    this.tmp = this.tmpC.getContext('2d');
    // 图集由外部注入（按资产共享），没有就自己建一个
    this.atlas = atlas || new ClipAtlas();
    this.ownAtlas = !atlas;
    this.done = 0;
    this.partial = null;
    this.lastEnd = [0, 0];
    this.tip = null;
    this.reset();
  }

  /**
   * 造一个渲染器。keep < 笔数时按「整块优先」的策略抽稀，
   * 避免丢笔造成画面永久白斑（详见 core/stroke-order.js）。
   *
   * atlas 可以从外部传进来复用——掩膜只跟资产有关，跟 keep 无关。
   * 建好之后立刻把这一屏要用的掩膜一次性打包进图集：
   * 绘制阶段就只读不写了（边写边读会让整页纹理反复重传，慢 3.6 倍）。
   */
  static create({ W, H, strokes, clips, keep, atlas }) {
    const order = buildOrder(strokes, clips, keep);
    const at = atlas || new ClipAtlas();
    // 这一屏要用的 clip（去重）
    const used = new Set();
    for (let i = 0; i < order.length; i++) {
      const st = strokes[order[i]];
      if (st) used.add(st.c);
    }
    at.ensurePacked(clips, [...used]);
    return new StrokeRenderer({ W, H, strokes, clips, order, atlas: at });
  }

  reset() {
    const x = this.pctx;
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, this.W, this.H);
    this.done = 0;
    this.partial = null;
    this.tip = null;
    const st0 = this.S[this.order[0]];
    if (st0) this.lastEnd = [st0.tp[0], st0.tp[1]];
  }

  clipSlotFor(c) {
    let s = this.atlas.get(c);
    if (!s) {
      // 兜底：正常路径下该 clip 在建渲染器时就打包好了。
      // 万一缺了（比如图集被清过），就地补一个，别让整屏变成白屏。
      this.atlas.ensurePacked(this.C, [c]);
      s = this.atlas.get(c);
      if (!s) return null;
    }
    return s;
  }

  // 批量画 from..to（同一 clip 的连续笔）：一次清屏、按颜色合并路径、一次掩膜合成。
  // 单笔合成在 4K 笔规模下会成为瓶颈，这里是整条渲染链最关键的优化。
  paintRun(from, to) {
    const S = this.S, order = this.order;
    const cl = this.C[S[order[from]].c];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const groups = new Map();
    let last = null;

    for (let i = from; i < to; i++) {
      const st = S[order[i]];
      last = st;
      const pad = Math.max(4, st.w * 0.9);
      const rib = st.rib;
      const key = (st.color[0] << 16) | (st.color[1] << 8) | st.color[2];
      let p = groups.get(key);
      if (!p) { p = new Path2D(); groups.set(key, p); }
      // 一次遍历同时做两件事：建路径 + 算包围盒
      // （早先是两遍，一遍扫 ribbon 算框、一遍建 Path2D）
      const n = rib.length;
      p.moveTo(rib[0], rib[1]);
      let bx0 = rib[0], by0 = rib[1], bx1 = rib[0], by1 = rib[1];
      for (let k = 2; k < n; k += 2) {
        const px = rib[k], py = rib[k + 1];
        p.lineTo(px, py);
        if (px < bx0) bx0 = px;
        if (px > bx1) bx1 = px;
        if (py < by0) by0 = py;
        if (py > by1) by1 = py;
      }
      p.closePath();
      if (bx0 - pad < x0) x0 = bx0 - pad;
      if (bx1 + pad > x1) x1 = bx1 + pad;
      if (by0 - pad < y0) y0 = by0 - pad;
      if (by1 + pad > y1) y1 = by1 + pad;
    }
    if (!last) return;

    const rx = Math.max(cl.x, Math.floor(x0));
    const ry = Math.max(cl.y, Math.floor(y0));
    const rw = Math.max(1, Math.min(cl.x + cl.w, Math.ceil(x1)) - rx);
    const rh = Math.max(1, Math.min(cl.y + cl.h, Math.ceil(y1)) - ry);

    const tmp = this.tmp;
    tmp.setTransform(1, 0, 0, 1, 0, 0);
    tmp.clearRect(rx, ry, rw, rh);
    tmp.save();
    tmp.lineWidth = 1.4;
    tmp.lineJoin = 'round';
    tmp.lineCap = 'round';
    for (const [key, p] of groups) {
      const rgb = 'rgb(' + ((key >> 16) & 255) + ',' + ((key >> 8) & 255) + ',' + (key & 255) + ')';
      tmp.fillStyle = rgb;
      tmp.strokeStyle = rgb;
      tmp.fill(p);
      tmp.stroke(p);
    }
    tmp.restore();
    tmp.globalCompositeOperation = 'destination-in';
    const slot = this.clipSlotFor(last.c);
    if (slot) {
      tmp.drawImage(slot.cv, slot.x + (rx - cl.x), slot.y + (ry - cl.y), rw, rh, rx, ry, rw, rh);
    } else {
      tmp.clearRect(rx, ry, rw, rh);   // 没有掩膜就别合成，直接清掉
    }
    tmp.globalCompositeOperation = 'source-over';
    this.pctx.drawImage(this.tmpC, rx, ry, rw, rh, rx, ry, rw, rh);

    this.lastEnd = [last.tp[0], last.tp[1]];
    this.tip = {
      x: last.tp[0], y: last.tp[1],
      r: Math.max(2.5, last.w * 0.5), pen: last.pen, color: last.color,
    };
  }

  // pos = 播放序；u=1 整笔（落到成品），u<1 半成品（只进 tmpC）
  paint(pos, u) {
    const st = this.S[this.order[pos]];
    const cl = this.C[st.c];
    const g = geomOf(st);
    const t = tipAt(st, u);
    this.tip = { x: t.x, y: t.y, r: Math.max(2.5, st.w * 0.5), pen: st.pen, color: st.color };
    const rgb = g.rgb;

    // 只处理这一笔自己的包围盒（与 clip 求交），避免每笔清空整块掩膜区域
    const pad = Math.max(6, st.w * 1.8);
    const bx0 = g.x0 - pad, by0 = g.y0 - pad, bx1 = g.x1 + pad, by1 = g.y1 + pad;
    const x0 = Math.max(cl.x, Math.floor(bx0));
    const y0 = Math.max(cl.y, Math.floor(by0));
    const x1 = Math.min(cl.x + cl.w, Math.ceil(bx1));
    const y1 = Math.min(cl.y + cl.h, Math.ceil(by1));
    const rect = { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };

    const tmp = this.tmp;
    tmp.setTransform(1, 0, 0, 1, 0, 0);
    tmp.clearRect(rect.x, rect.y, rect.w, rect.h);
    tmp.save();
    tmp.fillStyle = rgb;
    tmp.strokeStyle = rgb;
    if (u >= 1) {
      const pth = g.path;
      tmp.lineWidth = 1.4;
      tmp.lineJoin = 'round';
      tmp.lineCap = 'round';
      tmp.fill(pth);
      tmp.stroke(pth);
    } else {
      tmp.clip(g.path);
      tmp.clip(leadPath(t, st));
      tmp.fillRect(rect.x, rect.y, rect.w, rect.h);
      tmp.restore();
      tmp.save();
      tmp.clip(g.path);
      const nx = -t.dy, ny = t.dx, spread = Math.max(4, st.w * 1.3);
      const fwd = st.pen ? 0 : Math.max(2, st.w * 0.9);
      const wet = new Path2D();
      wet.moveTo(t.x + nx * spread, t.y + ny * spread);
      wet.lineTo(t.x + t.dx * fwd + nx * spread, t.y + t.dy * fwd + ny * spread);
      wet.lineTo(t.x + t.dx * fwd - nx * spread, t.y + t.dy * fwd - ny * spread);
      wet.lineTo(t.x - nx * spread, t.y - ny * spread);
      wet.closePath();
      tmp.fillStyle = rgb;
      tmp.globalAlpha = 0.42;
      tmp.fill(wet);
    }
    tmp.restore();
    tmp.globalCompositeOperation = 'destination-in';
    // 图集槽位的原点对应 (cl.x, cl.y)，只贴 rect 那一片
    const slot = this.clipSlotFor(st.c);
    if (slot) {
      tmp.drawImage(
        slot.cv,
        slot.x + (rect.x - cl.x), slot.y + (rect.y - cl.y), rect.w, rect.h,
        rect.x, rect.y, rect.w, rect.h,
      );
    } else {
      tmp.clearRect(rect.x, rect.y, rect.w, rect.h);
    }
    tmp.globalCompositeOperation = 'source-over';
    const ctx = this.pctx;
    ctx.drawImage(this.tmpC, rect.x, rect.y, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
    if (u >= 1) {
      this.partial = null;
      this.lastEnd = [t.x, t.y];
      return { complete: true, rect, tip: this.tip };
    }
    this.partial = { pos, u, rect, tip: this.tip, canvas: this.tmpC };
    return { complete: false, rect, tip: this.tip };
  }

  // 把画布推进到「已画完 done 笔 + 当前笔进度 u」。向后会重置重画。
  seekTo(done, u = 0) {
    const total = this.order.length;
    const target = Math.max(0, Math.min(done, total));
    if (target < this.done) this.reset();
    while (this.done < target) {
      const c = this.S[this.order[this.done]].c;
      let end = this.done + 1;
      while (end < target && this.S[this.order[end]].c === c) end++;
      this.paintRun(this.done, end);
      this.done = end;
    }
    if (u > 0.002 && target < total) {
      this.paint(target, Math.min(u, 1));
    } else {
      this.partial = null;
      if (target < total) {
        const st = this.S[this.order[target]];
        if (st) this.tip = { x: st.tp[0], y: st.tp[1], r: Math.max(2.5, st.w * 0.5), pen: st.pen, color: st.color };
      }
    }
    return this.done;
  }

  // 已画完的总像素进度（0..1），用于抽稀后的稳定推进
  progress() {
    const total = this.order.length || 1;
    return Math.min(1, this.done / total);
  }

  // 跳到某个场景起点：从头重画到该时刻
  seekToScene(timeline, sceneIndex) {
    const sc = timeline.scenes[sceneIndex];
    this.reset();
    if (!sc) return 0;
    return sc.start;
  }

  getPartial() { return this.partial; }
}
