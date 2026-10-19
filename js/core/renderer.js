// 逐笔渲染器：从 image2strokes 的 app.js 移植（paintStroke / clip 掩膜 / 笔尖）。
// 只负责把"第 pos 笔、进度 u"画到离屏画布；不负责 UI、时间轴、导出。

import { frameAt } from './timeline.js';

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
    this.clipCache = new Map();
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

  clipCanvasFor(c) {
    if (this.clipCache.has(c)) return this.clipCache.get(c);
    const cl = this.C[c];
    const cv = document.createElement('canvas');
    cv.width = cl.w; cv.height = cl.h;
    const x = cv.getContext('2d');
    const id = x.createImageData(cl.w, cl.h);
    const m = cl.mask;
    for (let i = 0; i < m.length; i++) {
      id.data[i * 4] = 255; id.data[i * 4 + 1] = 255; id.data[i * 4 + 2] = 255;
      id.data[i * 4 + 3] = m[i] ? 255 : 0;
    }
    x.putImageData(id, 0, 0);
    if (this.clipCache.size > 40) {
      const first = this.clipCache.keys().next().value;
      this.clipCache.delete(first);
    }
    this.clipCache.set(c, cv);
    return cv;
  }

  // pos = 播放序；u=1 整笔（落到成品），u<1 半成品（只进 tmpC）
  paint(pos, u) {
    const st = this.S[this.order[pos]];
    const cl = this.C[st.c];
    const t = tipAt(st, u);
    this.tip = { x: t.x, y: t.y, r: Math.max(2.5, st.w * 0.5), pen: st.pen, color: st.color };
    const rgb = 'rgb(' + st.color[0] + ',' + st.color[1] + ',' + st.color[2] + ')';
    const rect = { x: cl.x, y: cl.y, w: cl.w, h: cl.h };
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
    tmp.drawImage(this.clipCanvasFor(st.c), rect.x, rect.y);
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

  // 把画布推进到时间线 t（毫秒）。向后会重置重画。
  seek(timeline, t) {
    const fr = frameAt(timeline, t);
    if (fr.done < this.done) this.reset();
    while (this.done < fr.done) {
      this.paint(this.done, 1);
      this.done++;
    }
    if (fr.cur >= 0) {
      const u = fr.u;
      if (u > 0.001) this.paint(fr.cur, u);
      else {
        this.partial = null;
        const st = this.S[this.order[fr.cur]];
        if (st) this.tip = { x: st.tp[0], y: st.tp[1], r: Math.max(2.5, st.w * 0.5), pen: st.pen, color: st.color };
      }
    } else {
      this.partial = null;
    }
    return fr;
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
