// 逐笔渲染器：从 image2strokes 的 app.js 移植（paintStroke / clip 掩膜 / 笔尖）。
// 只负责把"第 pos 笔、进度 u"画到离屏画布；不负责 UI、时间轴、导出。

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
function tipAt(st, u) {
  const tp = st.tp, n = tp.length / 2;
  if (n < 2) return { x: tp[0], y: tp[1], dx: 1, dy: 0, single: true };
  let total = 0;
  for (let i = 1; i < n; i++) total += Math.hypot(tp[i * 2] - tp[(i - 1) * 2], tp[i * 2 + 1] - tp[(i - 1) * 2 + 1]);
  const want = clamp(u, 0, 1) * total;
  let run = 0;
  for (let i = 1; i < n; i++) {
    const ax = tp[(i - 1) * 2], ay = tp[(i - 1) * 2 + 1];
    const bx = tp[i * 2], by = tp[i * 2 + 1];
    const seg = Math.hypot(bx - ax, by - ay);
    if (run + seg >= want || i === n - 1) {
      const f = seg > 1e-6 ? (want - run) / seg : 1;
      const x = ax + (bx - ax) * f, y = ay + (by - ay) * f;
      const dx = bx - ax, dy = by - ay, ln = Math.hypot(dx, dy) || 1;
      return { x, y, dx: dx / ln, dy: dy / ln, single: false };
    }
    run += seg;
  }
  return { x: tp[0], y: tp[1], dx: 1, dy: 0, single: false };
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

/** 掩膜图集：一张 2048² 画布按货架排布塞进成百上千个小掩膜，只写一次。 */
class ClipAtlas {
  constructor(max = 2048) {
    this.max = max;
    this.pages = [];
    this.slots = new Map();
    this.pg = null; this.x = 0; this.y = 0; this.rowH = 0;
  }

  _page() {
    const cv = document.createElement('canvas');
    cv.width = this.max; cv.height = this.max;
    this.pages.push({ cv, ctx: cv.getContext('2d') });
    this.pg = this.pages[this.pages.length - 1];
    this.x = 0; this.y = 0; this.rowH = 0;
    return this.pg;
  }

  static _paint(ctx, mask, w, h, dx, dy) {
    const id = ctx.createImageData(w, h);
    const u32 = new Uint32Array(id.data.buffer);
    for (let i = 0; i < mask.length; i++) u32[i] = mask[i] ? 0xffffffff : 0;
    ctx.putImageData(id, dx, dy);
  }

  get(i, cl) {
    const hit = this.slots.get(i);
    if (hit) return hit;
    // 超过图集尺寸的超大掩膜单独一张，避免浪费整页
    if (cl.w > this.max || cl.h > this.max) {
      const cv = document.createElement('canvas');
      cv.width = cl.w; cv.height = cl.h;
      ClipAtlas._paint(cv.getContext('2d'), cl.mask, cl.w, cl.h, 0, 0);
      const s = { cv, x: 0, y: 0, w: cl.w, h: cl.h };
      this.slots.set(i, s);
      return s;
    }
    if (!this.pg) this._page();
    if (this.x + cl.w > this.max) { this.x = 0; this.y += this.rowH + 1; this.rowH = 0; }
    if (this.y + cl.h > this.max) this._page();
    const s = { cv: this.pg.cv, x: this.x, y: this.y, w: cl.w, h: cl.h };
    ClipAtlas._paint(this.pg.ctx, cl.mask, cl.w, cl.h, this.x, this.y);
    this.slots.set(i, s);
    this.x += cl.w + 1;
    if (cl.h > this.rowH) this.rowH = cl.h;
    return s;
  }
}

export class StrokeRenderer {
  constructor({ W, H, strokes, clips, order }) {
    this.W = W; this.H = H;
    this.S = strokes; this.C = clips; this.order = order;
    this.painted = document.createElement('canvas');
    this.painted.width = W; this.painted.height = H;
    this.pctx = this.painted.getContext('2d');
    this.tmpC = document.createElement('canvas');
    this.tmpC.width = W; this.tmpC.height = H;
    this.tmp = this.tmpC.getContext('2d');
    this.atlas = new ClipAtlas();
    this.done = 0;
    this.partial = null;
    this.lastEnd = [0, 0];
    this.tip = null;
    this.reset();
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
    return this.atlas.get(c, this.C[c]);
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
      for (let k = 0; k < rib.length; k += 2) {
        const px = rib[k], py = rib[k + 1];
        if (px - pad < x0) x0 = px - pad;
        if (px + pad > x1) x1 = px + pad;
        if (py - pad < y0) y0 = py - pad;
        if (py + pad > y1) y1 = py + pad;
      }
      const key = (st.color[0] << 16) | (st.color[1] << 8) | st.color[2];
      let p = groups.get(key);
      if (!p) { p = new Path2D(); groups.set(key, p); }
      p.moveTo(rib[0], rib[1]);
      for (let k = 2; k < rib.length; k += 2) p.lineTo(rib[k], rib[k + 1]);
      p.closePath();
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
    tmp.drawImage(slot.cv, slot.x + (rx - cl.x), slot.y + (ry - cl.y), rw, rh, rx, ry, rw, rh);
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
    const t = tipAt(st, u);
    this.tip = { x: t.x, y: t.y, r: Math.max(2.5, st.w * 0.5), pen: st.pen, color: st.color };
    const rgb = 'rgb(' + st.color[0] + ',' + st.color[1] + ',' + st.color[2] + ')';

    // 只处理这一笔自己的包围盒（与 clip 求交），避免每笔清空整块掩膜区域
    const pad = Math.max(6, st.w * 1.8);
    const rib = st.rib;
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let i = 0; i < rib.length; i += 2) {
      const px = rib[i], py = rib[i + 1];
      if (px < bx0) bx0 = px;
      if (px > bx1) bx1 = px;
      if (py < by0) by0 = py;
      if (py > by1) by1 = py;
    }
    bx0 -= pad; by0 -= pad; bx1 += pad; by1 += pad;
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
      const pth = ribbonPath(st);
      tmp.lineWidth = 1.4;
      tmp.lineJoin = 'round';
      tmp.lineCap = 'round';
      tmp.fill(pth);
      tmp.stroke(pth);
    } else {
      tmp.clip(ribbonPath(st));
      tmp.clip(leadPath(t, st));
      tmp.fillRect(rect.x, rect.y, rect.w, rect.h);
      tmp.restore();
      tmp.save();
      tmp.clip(ribbonPath(st));
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
    tmp.drawImage(
      slot.cv,
      slot.x + (rect.x - cl.x), slot.y + (rect.y - cl.y), rect.w, rect.h,
      rect.x, rect.y, rect.w, rect.h,
    );
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
