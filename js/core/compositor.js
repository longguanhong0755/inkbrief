// 合成：1280×720 的纸面 + 图画框 + 字幕 + 笔尖。
// 图画本体在管线坐标系里逐笔渲染，每帧只把它整幅按比例贴进画框（1024→1120 是 1.09×，高质量插值足够）。

import { IMAGE_BOX } from './timeline.js';

function hash01(a, b) {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export class Compositor {
  constructor({ W = 1280, H = 720, imageW, imageH, paper = true, canvas = null } = {}) {
    this.W = W; this.H = H;
    this.imageW = imageW; this.imageH = imageH;
    this.cv = canvas || document.createElement('canvas');
    this.cv.width = W; this.cv.height = H;
    this.ctx = this.cv.getContext('2d');
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    const s = Math.min(IMAGE_BOX.w / imageW, IMAGE_BOX.h / imageH);
    this.iw = imageW * s; this.ih = imageH * s;
    this.ix = IMAGE_BOX.x + (IMAGE_BOX.w - this.iw) / 2;
    this.iy = IMAGE_BOX.y + (IMAGE_BOX.h - this.ih) / 2;
    this.paperCv = paper ? this.makePaper() : null;
    this.frameCv = this.makeFrame();
  }

  makePaper() {
    const cv = document.createElement('canvas');
    cv.width = this.W; cv.height = this.H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#FBF8F1';
    ctx.fillRect(0, 0, this.W, this.H);
    const id = ctx.getImageData(0, 0, this.W, this.H);
    const d = id.data;
    for (let y = 0; y < this.H; y++) {
      for (let x = 0; x < this.W; x++) {
        const i = (y * this.W + x) * 4;
        const n = (hash01(x, y) - 0.5) * 5;
        d[i] = Math.max(0, Math.min(255, d[i] + n));
        d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
        d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
      }
    }
    ctx.putImageData(id, 0, 0);
    const g = ctx.createRadialGradient(this.W / 2, this.H / 2, this.H * 0.2, this.W / 2, this.H / 2, this.W * 0.72);
    g.addColorStop(0, 'rgba(120,100,70,0)');
    g.addColorStop(1, 'rgba(120,100,70,0.055)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.W, this.H);
    return cv;
  }

  makeFrame() {
    const cv = document.createElement('canvas');
    cv.width = IMAGE_BOX.w + 24;
    cv.height = IMAGE_BOX.h + 24;
    const ctx = cv.getContext('2d');
    const x = 12, y = 12, w = IMAGE_BOX.w, h = IMAGE_BOX.h;
    ctx.save();
    ctx.shadowColor = 'rgba(90,75,50,0.14)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(x, y, w, h);
    ctx.restore();
    ctx.strokeStyle = '#E7DFD1';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    return cv;
  }

  draw({ painted, partial = null, captionCanvas = null, tip = null, showTip = true }) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.paperCv) ctx.drawImage(this.paperCv, 0, 0);
    else { ctx.fillStyle = '#FBF8F1'; ctx.fillRect(0, 0, this.W, this.H); }

    ctx.drawImage(this.frameCv, IMAGE_BOX.x - 12, IMAGE_BOX.y - 12);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(painted, 0, 0, this.imageW, this.imageH, this.ix, this.iy, this.iw, this.ih);
    if (partial && partial.rect) {
      const r = partial.rect, s = this.iw / this.imageW;
      ctx.drawImage(partial.canvas || painted, r.x, r.y, r.w, r.h,
        this.ix + r.x * s, this.iy + r.y * s, r.w * s, r.h * s);
    }

    // 分隔线（手绘微抖）
    ctx.save();
    ctx.strokeStyle = 'rgba(60,55,45,0.22)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(96, 566);
    ctx.quadraticCurveTo(640, 567.5, 1184, 565.5);
    ctx.stroke();
    ctx.restore();

    if (captionCanvas) ctx.drawImage(captionCanvas, 0, 0);

    if (showTip && tip) {
      const s = this.iw / this.imageW;
      const x = this.ix + tip.x * s, y = this.iy + tip.y * s;
      const r = Math.max(2.2, tip.r * s);
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r + 1.2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.82)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${tip.color[0]},${tip.color[1]},${tip.color[2]})`;
      ctx.fill();
      ctx.restore();
    }
    return this.cv;
  }
}
