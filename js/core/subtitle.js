// 字幕：换行/字号是纯函数（Node 可测），逐字揭示与绘制在浏览器里。
// 字体：Ma Shan Zheng（OFL），失败时回退系统楷体。

export const CAPTION_BOX = { x: 100, y: 578, w: 1080, h: 128 };
export const FONT_SIZES = [46, 42, 38, 34, 30, 27, 24];
export const HEAD_PUNCT = '，。！？、；：）》”』】…—';
export const TAIL_PUNCT = '（《“‘『【';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// 合成度量（Node 用）：CJK/标点 = 1em，ASCII = 0.55em
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

// 贪心换行：不把标点放到行首；放不下时允许行尾多一个标点
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

// 选字号：46→24；最多 2 行（≤30px 时允许 3 行），块高不超过 boxH
export function layoutText(text, maxWidth, measureForSize, boxH = CAPTION_BOX.h) {
  let best = null;
  for (const size of FONT_SIZES) {
    const lines = wrapText(text, maxWidth, (ch) => measureForSize(ch, size));
    const lineH = Math.round(size * 1.35);
    const maxLines = size <= 30 ? 3 : 2;
    const totalH = lines.length * lineH;
    if (lines.length <= maxLines && totalH <= boxH) {
      best = { size, lines, lineH, totalH, overflow: false };
      break;
    }
  }
  if (!best) {
    const size = FONT_SIZES[FONT_SIZES.length - 1];
    const lines = wrapText(text, maxWidth, (ch) => measureForSize(ch, size));
    const lineH = Math.round(size * 1.35);
    const maxLines = Math.floor(boxH / lineH);
    if (lines.length > maxLines) {
      lines.length = maxLines;
      lines[maxLines - 1] = lines[maxLines - 1].replace(/.$/, '…');
    }
    best = { size, lines, lineH, totalH: lines.length * lineH, overflow: true };
  }
  // 每行每个字的位置（居中）
  const out = [];
  let y = CAPTION_BOX.y + (CAPTION_BOX.h - best.totalH) / 2 + best.size;
  for (const line of best.lines) {
    const widths = [];
    let lw = 0;
    for (const ch of line) { const w = measureForSize(ch, best.size); widths.push(w); lw += w; }
    let x = CAPTION_BOX.x + (CAPTION_BOX.w - lw) / 2;
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
  constructor({ W = 1280, H = 720, family = '"MaShanZheng", "KaiTi", "STKaiti", "楷体", serif' } = {}) {
    this.W = W; this.H = H;
    this.family = family;
    this.cv = document.createElement('canvas');
    this.cv.width = W; this.cv.height = H;
    this.ctx = this.cv.getContext('2d');
    this.mcv = document.createElement('canvas');
    this.mcv.width = 8; this.mcv.height = 8;
    this.mctx = this.mcv.getContext('2d');
    this.layouts = new Map();
    this.measureCache = new Map();
  }

  setFamily(family) { this.family = family; this.measureCache.clear(); this.layouts.clear(); }

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

  prepare(timeline) {
    this.layouts.clear();
    for (const sc of timeline.scenes) {
      for (const p of sc.paragraphs) {
        const lay = layoutText(p.text, CAPTION_BOX.w, (ch, size) => this.measureFor(size)(ch));
        this.layouts.set(p, lay);
      }
    }
  }

  // 画到自己的透明画布；调用方负责把它叠到合成画布
  draw(timeline, t) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    let sc = null;
    for (const s of timeline.scenes) {
      if (t >= s.start - 1 && t <= s.end + 1) { sc = s; break; }
    }
    if (!sc || !sc.paragraphs.length) return this.cv;
    let para = null;
    for (const p of sc.paragraphs) if (t >= p.start - 1) para = p;
    if (!para) return this.cv;
    const lay = this.layouts.get(para);
    if (!lay) return this.cv;

    const fadeIn = clamp((t - (para.start - 120)) / 120, 0, 1);
    const fadeOut = clamp((sc.end - t) / 200, 0, 1);
    const alpha = Math.min(fadeIn, fadeOut);
    if (alpha <= 0) return this.cv;

    const chars = [];
    for (const line of lay.lines) for (const c of line.chars) chars.push(c);
    const n = chars.length;
    const revealDur = Math.max(250, Math.min((para.end - para.start) * 0.9, 1500));
    const step = n > 0 ? revealDur / n : 0;

    ctx.font = `${lay.size}px ${this.family}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#2B2B33';
    const pid = sc.index * 1000 + (para.start | 0);
    for (let i = 0; i < n; i++) {
      const c = chars[i];
      if (c.ch === ' ' || c.ch === '\t') continue;
      const p = clamp((t - para.start - i * step) / 90, 0, 1);
      if (p <= 0) break;
      const jitter = (hash01(pid, i) - 0.5) * 2.4;
      const rot = (1 - p) * (-2 + jitter) * Math.PI / 180;
      const sc2 = 1 + (1 - p) * 0.08;
      ctx.save();
      ctx.globalAlpha = alpha * p;
      ctx.translate(c.x + c.w / 2, c.y);
      ctx.rotate(rot);
      ctx.scale(sc2, sc2);
      ctx.fillText(c.ch, -c.w / 2, 0);
      ctx.restore();
    }
    return this.cv;
  }
}
