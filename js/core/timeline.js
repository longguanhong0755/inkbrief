// 时间轴：把"场景 + 笔 + 文案"排成一条时间线。
// 纯函数，浏览器和 Node 共用；不碰 canvas。
//
// 输出（笔序 = 播放序）：
//   order   Int32Array  播放序 → 原笔号
//   t0/t1   Float64Array 每笔起止（毫秒）
//   msPaint Float64Array 每笔净绘制时间（不含抬笔）
//   scenes  [{ start,end, textStart,textEnd, paragraphs:[{text,start,end}], strokeFrom,strokeTo }]
//   totalMs

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export const IMAGE_BOX = { x: 80, y: 28, w: 1120, h: 540 };
export const CAPTION_BOX = { x: 100, y: 578, w: 1080, h: 128 };

export function textWeight(str) {
  let n = 0;
  for (const ch of str) {
    if (/\s/.test(ch)) continue;
    const c = ch.codePointAt(0);
    n += c < 128 ? 0.55 : 1;
  }
  return n;
}

export function textSeconds(str) {
  return clamp(1.2 + 0.18 * textWeight(str), 2.2, 9.0);
}

function pathLen(tp) {
  let n = 0;
  for (let i = 2; i < tp.length; i += 2) n += Math.hypot(tp[i] - tp[i - 2], tp[i + 1] - tp[i - 1]);
  return n;
}

const PHASE_K = [0.75, 1.0, 1.25, 1.7];

function distribute(weights, budgetMs, minMs, maxMs) {
  const n = weights.length;
  const out = new Float64Array(n);
  if (!n) return out;
  let sum = 0;
  for (const w of weights) sum += w;
  if (sum <= 0) sum = n;
  for (let i = 0; i < n; i++) out[i] = budgetMs * (weights[i] > 0 ? weights[i] : 1) / sum;
  for (let iter = 0; iter < 4; iter++) {
    let over = 0, free = 0;
    for (let i = 0; i < n; i++) {
      if (out[i] < minMs) { over += minMs - out[i]; out[i] = minMs; }
      else if (out[i] > maxMs) { over += out[i] - maxMs; out[i] = maxMs; }
      else free += out[i];
    }
    if (Math.abs(over) < 0.01) break;
    if (free <= 0) break;
    const k = (free + over) / free;
    for (let i = 0; i < n; i++) if (out[i] > minMs + 1e-6 && out[i] < maxMs - 1e-6) out[i] *= k;
  }
  return out;
}

function assignParagraphs(paragraphs, sceneCount) {
  const K = paragraphs.length;
  if (K === 0) return [];
  return paragraphs.map((p, i) => ({
    text: p,
    scene: Math.min(sceneCount - 1, Math.floor(i * sceneCount / K)),
  }));
}

export function buildTimeline({ plan, strokes, paragraphs, W, H, imageBox = IMAGE_BOX }) {
  const n = strokes.length;
  const scale = Math.min(imageBox.w / W, imageBox.h / H);
  const order = Int32Array.from(plan.order);
  const t0 = new Float64Array(n);
  const t1 = new Float64Array(n);
  const msPaint = new Float64Array(n);
  const travels = new Float64Array(n);
  const scenes = [];

  const chunks = [];
  if (plan.mode === 'zones') {
    for (const sc of plan.scenes) chunks.push({ strokes: sc.strokes, bbox: sc.bbox });
  } else {
    // 整图模式：笔只画一遍，按段数把笔序切成连续章节，字幕按章换
    const K = Math.max(1, paragraphs.length);
    for (let k = 0; k < K; k++) {
      const a = Math.floor(k * n / K), b = Math.floor((k + 1) * n / K);
      chunks.push({ strokes: Array.from({ length: b - a }, (_, i) => a + i), bbox: [0, 0, W - 1, H - 1] });
    }
  }

  const paraOfScene = assignParagraphs(paragraphs, chunks.length);
  let cursor = 150; // ms
  let play = 0;

  for (let si = 0; si < chunks.length; si++) {
    const chunk = chunks[si];
    const texts = paraOfScene.filter((p) => p.scene === si).map((p) => p.text);
    const textTotal = texts.length ? texts.reduce((a, s) => a + textSeconds(s), 0) : 1.2;
    const ns = chunk.strokes.length;

    // 画画预算：约 6ms/笔，最少 1.5s，最多 12s
    let drawSec = clamp(1.2 + 0.006 * ns, 1.5, 12.0);

    // 每笔权重：画布上的轨迹长度 + 阶段系数
    const weights = new Float64Array(ns);
    const lens = new Float64Array(ns);
    for (let k = 0; k < ns; k++) {
      const st = strokes[chunk.strokes[k]];
      const len = Math.max(1, pathLen(st.tp || []) * scale);
      lens[k] = len;
      weights[k] = Math.pow(Math.max(len, 6), 0.7) * (PHASE_K[st.ph] || 1);
    }
    const ms = distribute(weights, drawSec * 1000, 3, 400);

    // 抬笔时间：近处不计，远处按距离；总时长不超过绘制预算的 12%
    const tr = new Float64Array(ns);
    let prevX = 0, prevY = 0;
    for (let k = 0; k < ns; k++) {
      const st = strokes[chunk.strokes[k]];
      const tp = st.tp || [0, 0];
      const x = tp[0] * scale, y = tp[1] * scale;
      if (k > 0) {
        const d = Math.hypot(x - prevX, y - prevY);
        tr[k] = d < 30 ? 0 : Math.min(160, 25 + d * 0.25);
      }
      prevX = tp[tp.length - 2] * scale;
      prevY = tp[tp.length - 1] * scale;
    }
    let trSum = 0;
    for (const v of tr) trSum += v;
    const trCap = drawSec * 1000 * 0.12;
    if (trSum > trCap && trSum > 0) {
      const k = trCap / trSum;
      for (let i = 0; i < ns; i++) tr[i] *= k;
    }

    const sceneStart = cursor;
    const textStart = sceneStart + 150;
    let sceneTextEnd = textStart;
    const outParas = [];
    for (const text of texts) {
      const dur = textSeconds(text) * 1000;
      outParas.push({ text, start: sceneTextEnd, end: sceneTextEnd + dur });
      sceneTextEnd += dur;
    }
    if (!outParas.length) sceneTextEnd = textStart + 1200;

    // 实际画完的时刻
    let p = sceneStart;
    const from = play;
    for (let k = 0; k < ns; k++) {
      p += tr[k];
      t0[play] = p;
      p += ms[k];
      t1[play] = p;
      msPaint[play] = ms[k];
      travels[play] = tr[k];
      play++;
    }
    const drawEnd = p;
    const sceneEnd = Math.max(drawEnd, sceneTextEnd) + 250;

    scenes.push({
      index: si,
      start: sceneStart,
      end: sceneEnd,
      textStart,
      textEnd: sceneTextEnd,
      paragraphs: outParas,
      strokeFrom: from,
      strokeTo: play,
      strokeCount: ns,
      bbox: chunk.bbox,
      drawSec,
    });
    cursor = sceneEnd + 150;
  }

  const totalMs = cursor;

  // 超总时长上限：按比例压绘制时间（字幕不动），最低 2ms/笔
  const LIMIT = 150000;
  if (totalMs > LIMIT) {
    // 只做一次整体缩放，保证单调；具体压缩在渲染端按比例读即可
    const k = Math.max(0.35, LIMIT / totalMs);
    for (let i = 0; i < n; i++) {
      t0[i] *= k; t1[i] *= k; msPaint[i] *= k; travels[i] *= k;
    }
    for (const s of scenes) {
      s.start *= k; s.end *= k; s.textStart *= k; s.textEnd *= k;
      for (const q of s.paragraphs) { q.start *= k; q.end *= k; }
    }
    return { totalMs: totalMs * k, order, t0, t1, msPaint, travels, scenes, scale, limitHit: true };
  }

  return { totalMs, order, t0, t1, msPaint, travels, scenes, scale, limitHit: false };
}

// 给定时刻 t（毫秒），返回 { done: 已完成到播放序第几笔, cur: 当前笔, u: 0..1 }
export function frameAt(timeline, t) {
  const t1 = timeline.t1;
  const n = t1.length;
  let lo = 0, hi = n - 1, done = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t1[mid] <= t) { done = mid + 1; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (done >= n) return { done: n, cur: -1, u: 1 };
  const a = timeline.t0[done], b = t1[done];
  const u = b > a ? clamp((t - a) / (b - a), 0, 1) : 0;
  return { done, cur: done, u };
}
