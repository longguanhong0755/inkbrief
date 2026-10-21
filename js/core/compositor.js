// 合成：纸面 + 图片卡 + 已画笔触 + 字幕。输出固定 W×H（横屏 1920x1080 / 竖屏 1080x1920）。

export function computeLayout(W, H) {
  const portrait = H > W;
  const margin = Math.round(W * (portrait ? 0.046 : 0.032));
  const capH = Math.round(H * (portrait ? 0.125 : 0.148));
  const capY = H - margin - capH;
  const top = Math.round(H * (portrait ? 0.038 : 0.036));
  const gap = Math.round(H * 0.022);
  const area = {
    x: margin,
    y: top,
    w: W - margin * 2,
    h: capY - top - gap,
  };
  const capPad = Math.round(W * 0.022);
  const cap = {
    x: margin + capPad,
    y: capY,
    w: W - margin * 2 - capPad * 2,
    h: capH,
  };
  return { portrait, margin, area, cap };
}

/** 把 sw×sh 的图按 contain 放进 area */
export function fitInto(sw, sh, area) {
  if (!sw || !sh) return { x: area.x, y: area.y, w: area.w, h: area.h, s: 1 };
  const s = Math.min(area.w / sw, area.h / sh);
  const w = Math.round(sw * s);
  const h = Math.round(sh * s);
  return {
    x: area.x + Math.round((area.w - w) / 2),
    y: area.y + Math.round((area.h - h) / 2),
    w, h, s,
  };
}

function makePaper(W, H) {
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const x = cv.getContext('2d');
  const g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#FBF8F1');
  g.addColorStop(0.55, '#F8F4EA');
  g.addColorStop(1, '#F2EDE0');
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);

  // 纸纹：低分辨率噪点放大，省时
  const nw = Math.max(2, Math.round(W / 3));
  const nh = Math.max(2, Math.round(H / 3));
  const nc = document.createElement('canvas');
  nc.width = nw; nc.height = nh;
  const nx = nc.getContext('2d');
  const id = nx.createImageData(nw, nh);
  for (let i = 0; i < nw * nh; i++) {
    const v = 235 + Math.random() * 20;
    id.data[i * 4] = v;
    id.data[i * 4 + 1] = v - 2;
    id.data[i * 4 + 2] = v - 8;
    id.data[i * 4 + 3] = 16;
  }
  nx.putImageData(id, 0, 0);
  x.globalAlpha = 0.5;
  x.drawImage(nc, 0, 0, W, H);
  x.globalAlpha = 1;

  const vg = x.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.32, W / 2, H * 0.5, Math.max(W, H) * 0.78);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(60,48,32,0.11)');
  x.fillStyle = vg;
  x.fillRect(0, 0, W, H);
  return cv;
}

export class Compositor {
  constructor({ W, H, canvas }) {
    this.W = W;
    this.H = H;
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.paper = makePaper(W, H);
    this.layout = computeLayout(W, H);
  }

  resize(W, H) {
    this.W = W; this.H = H;
    this.paper = makePaper(W, H);
    this.layout = computeLayout(W, H);
  }

  begin() {
    const { ctx, W, H } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.paper, 0, 0);
    return { ctx, W, H };
  }

  /**
   * @param {object} o
   * @param {ImageBitmap|HTMLImageElement} o.bitmap
   * @param {number} o.imgW
   * @param {number} o.imgH
   * @param {HTMLCanvasElement} o.painted
   * @param {{rect:object,canvas:HTMLCanvasElement}|null} o.partial
   * @param {{x:number,y:number,color:number[]}|null} o.tip
   * @param {number} o.tipAlpha
   */
  draw(o) {
    const { ctx } = this.begin();
    const { area } = this.layout;
    const box = fitInto(o.imgW || 1600, o.imgH || 1000, area);

    // 图卡：白底 + 投影 + 细边
    ctx.save();
    ctx.shadowColor = 'rgba(90,72,48,0.20)';
    ctx.shadowBlur = Math.round(this.H * 0.018);
    ctx.shadowOffsetY = Math.round(this.H * 0.007);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.restore();
    ctx.strokeStyle = 'rgba(120,104,80,0.16)';
    ctx.lineWidth = Math.max(1, Math.round(this.W / 1400));
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);

    if (o.painted) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(o.painted, box.x, box.y, box.w, box.h);
    }

    const p = o.partial;
    if (p && p.canvas && p.rect && p.rect.w > 0) {
      const s = box.s;
      const sx = p.rect.x, sy = p.rect.y, sw = p.rect.w, sh = p.rect.h;
      ctx.drawImage(p.canvas, sx, sy, sw, sh, box.x + sx * s, box.y + sy * s, sw * s, sh * s);
    }

    if (o.tip && o.tipAlpha > 0) {
      const s = box.s;
      const x = box.x + o.tip.x * s;
      const y = box.y + o.tip.y * s;
      const c = o.tip.color || [40, 40, 44];
      ctx.save();
      ctx.globalAlpha = 0.85 * o.tipAlpha;
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(2.2, this.W / 700), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    return { box, layout: this.layout };
  }
}
