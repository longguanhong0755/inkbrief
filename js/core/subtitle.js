// 字幕：换行/字号是纯函数（Node 可测），逐字揭示与绘制在浏览器里。
// 字体：Ma Shan Zheng（OFL），失败时回退系统楷体。

export const HEAD_PUNCT = '，。！？、；：）》”』】…—';
export const TAIL_PUNCT = '（《“‘『【';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** 合成度量（Node 用）：CJK = 1em，ASCII = 0.55em */
export function syntheticMeasure(ch, size) {
  let w = 0;
  for (const c of ch) w += c.codePointAt(0) < 128 ? size * 0.55 : size;
  return w;
}

function tokenize(text) {
  const out = [];
  for (const ch of text) {
    if (/[A-Za-z0-9]/.test(ch) && out.length && /^[A-Za-z0-9]+$/.test(out[out.length - 1])) {
      out[out.length - 1] += ch;
    } else out.push(ch);
  }
  return out;
}

/** 贪心换行：不把标点放到行首；放不下时允许行尾多一个标点 */
export function wrapText(text, maxWidth, measure) {
  const lines = [];
  for (const hard of String(text).split('\n')) {
    const toks = tokenize(hard);
    let line = '', w = 0;
    for (const tok of toks) {
      const tw = measure(tok);
      if (!line) { line = tok; w = tw; continue; }
      if (w + tw <= maxWidth) { line += tok; w += tw; continue; }
      if (HEAD_PUNCT.includes(tok) && w + tw <= maxWidth * 1.15) { line += tok; w += tw; continue; }
      lines.push(line);
      line = tok;
      w = tw;
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [''];
}

/** 字号候选：以字幕框高度为基准，从大到小 */
export function sizeSteps(boxH) {
  return [0.40, 0.36, 0.325, 0.29, 0.26, 0.235, 0.215]
    .map((r) => Math.max(18, Math.round(boxH * r)))
    .filter((v, i, a) => a.indexOf(v) === i);
}

/**
 * 选字号并排版。
 * @param {string} text
 * @param {{x:number,y:number,w:number,h:number}} box
 * @param {(ch:string,size:number)=>number} measureForSize
 */
export function layoutText(text, box, measureForSize) {
  const steps = sizeSteps(box.h);
  let best = null;
  for (const size of steps) {
    const lines = wrapText(text, box.w, (ch) => measureForSize(ch, size));
    const lineH = Math.round(size * 1.34);
    const maxLines = size <= steps[4] ? 3 : 2;
    const totalH = lines.length * lineH;
    if (lines.length <= maxLines && totalH <= box.h) {
      best = { size, lines, lineH, totalH, overflow: false };
      break;
    }
  }
  if (!best) {
    const size = steps[steps.length - 1];
    const lines = wrapText(text, box.w, (ch) => measureForSize(ch, size));
    const lineH = Math.round(size * 1.34);
    const maxLines = Math.max(1, Math.floor(box.h / lineH));
    if (lines.length > maxLines) {
      lines.length = maxLines;
      lines[maxLines - 1] = lines[maxLines - 1].replace(/.$/, '…');
    }
    best = { size, lines, lineH, totalH: lines.length * lineH, overflow: true };
  }

  const out = [];
  let y = box.y + (box.h - best.totalH) / 2 + best.size;
  for (const line of best.lines) {
    const widths = [];
    let lw = 0;
    for (const ch of line) { const w = measureForSize(ch, best.size); widths.push(w); lw += w; }
    let x = box.x + (box.w - lw) / 2;
    const chars = [];
    let i = 0;
    for (const ch of line) {
      const w = widths[i++];
      chars.push({ ch, x, y, w });
      x += w;
    }
    out.push({ text: line, chars, width: lw, y });
    y += best.lineH;
  }
  return { size: best.size, lineH: best.lineH, lines: out, overflow: best.overflow, totalH: best.totalH };
}

function hash01(a, b) {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export class CaptionPainter {
  constructor({ W, H, box, family = '"MaShanZheng", "KaiTi", "STKaiti", "楷体", serif' }) {
    this.W = W; this.H = H;
    this.box = box;
    this.family = family;
    this.mcv = document.createElement('canvas');
    this.mcv.width = 8; this.mcv.height = 8;
    this.mctx = this.mcv.getContext('2d');
    this.layouts = new Map();
    this.measureCache = new Map();
  }

  setFamily(family) { this.family = family; this.measureCache.clear(); this.layouts.clear(); }
  setBox(box) { this.box = box; this.layouts.clear(); }

  measureFor(size) {
    const key = 'f' + size;
    return (ch) => {
      const ck = key + ch;
      let w = this.measureCache.get(ck);
      if (w === undefined) {
        this.mctx.font = `${size}px ${this.family}`;
        w = this.mctx.measureText(ch).width || size;
        this.measureCache.set(ck, w);
      }
      return w;
    };
  }

  layout(key, text) {
    let lay = this.layouts.get(key);
    if (!lay) {
      lay = layoutText(text || '', this.box, (ch, size) => this.measureFor(size)(ch));
      this.layouts.set(key, lay);
    }
    return lay;
  }

  clearLayouts() { this.layouts.clear(); }

  /**
   * 直接画到目标 ctx。
   * @param {CanvasRenderingContext2D} ctx
   * @param {{key:string,text:string,reveal:number,alpha:number}} p
   */
  draw(ctx, p) {
    if (!p || !p.text || p.alpha <= 0) return;
    const lay = this.layout(p.key, p.text);
    const chars = [];
    for (const line of lay.lines) for (const c of line.chars) chars.push(c);
    const n = chars.length;
    if (!n) return;

    const reveal = clamp(p.reveal, 0, 1);
    const shown = reveal >= 1 ? n : Math.floor(reveal * n);
    const frac = reveal >= 1 ? 1 : (reveal * n - shown);

    ctx.save();
    ctx.font = `${lay.size}px ${this.family}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = p.color || '#2B2B33';
    const seed = p.seed || 0;

    for (let i = 0; i < n; i++) {
      const c = chars[i];
      if (c.ch === ' ' || c.ch === '\t') continue;
      if (i > shown) break;
      const local = i < shown ? 1 : frac;
      if (local <= 0) break;
      const jitter = (hash01(seed + 1, i) - 0.5) * 2.4;
      const rot = (1 - local) * (-2 + jitter) * Math.PI / 180;
      const sc = 1 + (1 - local) * 0.08;
      ctx.save();
      ctx.globalAlpha = clamp(p.alpha * local, 0, 1);
      ctx.translate(c.x + c.w / 2, c.y);
      ctx.rotate(rot);
      ctx.scale(sc, sc);
      ctx.fillText(c.ch, -c.w / 2, 0);
      ctx.restore();
    }
    ctx.restore();
  }
}
