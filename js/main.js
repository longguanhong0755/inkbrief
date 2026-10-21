// inkbrief 主逻辑：多图 + 多段 → 逐屏手绘 + 本地 TTS 配音 + 字幕 → 导出 MP4。
import { StrokeRenderer } from './core/renderer.js?v=8';
import { Compositor, computeLayout } from './core/compositor.js';
import { CaptionPainter } from './core/subtitle.js';
import {
  buildTimeline, sceneAt, drawProgress, estimateDurationMs,
  itemAt, captionAt,
} from './core/timeline.js';
import { TTSEngine, VOICES, loadModel } from './tts/engine.js?v=8';
import { buildSoundtrack, toAudioBuffer } from './audio/mix.js';
import { exportVideo, downloadBlob, pickMime } from './core/exporter.js';
import { makeDraggable, resolveDrop, applyDrop } from './ui/dragdrop.js';
import { createTimelineView } from './ui/timeline-view.js';
import { createScenePanel } from './ui/scene-panel.js';

const $ = (id) => document.getElementById(id);
const MAX_SEGS = 12;
const MAX_EDGE = 1600;
// maxStrokes 直接决定渲染负担：每屏只有两三秒，笔数给太多必然卡。
// 实测单笔渲染约 0.5~1ms，5000 笔刚好铺满一屏且能跑满 30fps。
const PIPE_OPTS = { colors: 0, style: 'marker', detail: 1, targetSec: 240, maxStrokes: 5000, dropDead: false, returnKeys: false };
const FONT_NAME = 'MaShanZheng';
const KAI = '"KaiTi", "STKaiti", "楷体", serif';

const state = {
  assets: [],
  segs: [],
  timeline: null,
  renderers: new Map(),
  tts: null,
  ttsReady: false,
  playing: false,
  ms: 0,
  W: 1920,
  H: 1080,
  voiceId: VOICES[0].id,
  audioCtx: null,
  srcNode: null,
  playStart: 0,
  playFrom: 0,
  exportSignal: null,
  busy: false,
  mix: null,
  fontOk: false,
  unbound: 0,
  selectedSeg: null,      // 场景设置栏当前针对哪一段
};

let worker = null;
let jobSeq = 0;
const pendingJobs = new Map();
let compositor = null;
let painter = null;
let timelineView = null;
let scenePanel = null;
// 场景栏正在自己编辑（打字、拖滑块）时，别重画它——否则输入框会失焦。
// 由场景栏的回调置位，rebuild/renderSegs 读它来决定要不要跳过面板重绘。
let panelEditing = false;
const stage = $('stage');

// ── 小工具 ────────────────────────────────────────────
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const fmt = (ms) => (ms / 1000).toFixed(1) + 's';
const uid = () => Math.random().toString(36).slice(2, 9);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

function hint(msg, kind = 'info') {
  const el = $('previewHint');
  if (!el) return;
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = msg;
  el.style.color = kind === 'warn' ? 'var(--accent)' : 'var(--muted)';
}

// ── 启动 ──────────────────────────────────────────────
async function boot() {
  buildVoiceOptions();
  bindUI();
  ensureCanvas();
  initWorker();
  initTimelineView();
  initScenePanel();

  const engine = new TTSEngine();
  state.tts = engine;

  const bootEl = $('boot');
  const bar = $('bootBar');
  const text = $('bootText');
  const skip = $('bootSkip');

  let cancelled = false;
  skip.addEventListener('click', () => {
    cancelled = true;
    bootEl.hidden = true;
    hint('已跳过语音引擎。没有配音也能出片，只是时长按字数估。需要配音时刷新页面。', 'warn');
  });

  try {
    await engine.load((p) => {
      if (cancelled) return;
      bar.style.width = Math.round(clamp(p.ratio, 0, 1) * 100) + '%';
      text.textContent = p.text || '加载中…';
    });
    if (!cancelled) {
      state.ttsReady = true;
      bar.style.width = '100%';
      text.textContent = '就绪';
      await new Promise((r) => setTimeout(r, 240));
      bootEl.hidden = true;
    }
  } catch (err) {
    if (!cancelled) {
      text.textContent = '语音引擎加载失败：' + (err.message || err) + '。仍然可以手动画，只是没有配音。';
      text.style.color = 'var(--accent)';
      skip.textContent = '不加载了，直接开始';
    }
  }
  renderSegs();
  refreshGenButton();
  // 引擎就绪后再加载字体，免得 3.2MB 跟 21MB 抢带宽、把首屏拖慢。
  // 字体后到会触发一次重绘，不阻塞使用。
  if (!cancelled) loadFont();
}

const FONT_URL = 'assets/fonts/MaShanZheng-Regular.woff2';
const FONT_BYTES = 3247704;

async function loadFont() {
  if (!document.fonts || typeof FontFace === 'undefined') return;
  try {
    // 走和模型同一套分片下载：3.1MB 走单连接在国内同样会被掐断
    const buf = await loadModel(FONT_URL, FONT_BYTES);
    const blobUrl = URL.createObjectURL(new Blob([buf], { type: 'font/woff2' }));
    const face = new FontFace(FONT_NAME, `url(${blobUrl})`);
    await face.load();
    document.fonts.add(face);
    state.fontOk = true;
    if (painter) {
      painter.setFamily(`"${FONT_NAME}", ${KAI}`);
      if (state.timeline) renderAt(state.ms);
    }
  } catch { /* 拿不到就用系统楷体，只是字味差一点，不影响出片 */ }
}

function buildVoiceOptions() {
  const sel = $('voice');
  sel.innerHTML = '';
  for (const v of VOICES) {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = v.name;
    o.title = v.desc;
    sel.appendChild(o);
  }
  sel.value = state.voiceId;
  sel.addEventListener('change', () => {
    state.voiceId = sel.value;
    for (const s of state.segs) if (s.audio) { s.audio = null; s.status = 'idle'; }
    renderSegs();
    rebuild();
  });
}

const voiceOf = (id = state.voiceId) => VOICES.find((v) => v.id === id) || VOICES[0];

// ── 管线 worker ───────────────────────────────────────
function initWorker() {
  try {
    worker = new Worker('js/worker.js');
    worker.onmessage = (e) => {
      const d = e.data || {};
      const job = pendingJobs.get(d.jobId);
      if (!job) return;
      if (d.type === 'progress') job.onProgress?.(d.p, d.msg);
      else if (d.type === 'done') { pendingJobs.delete(d.jobId); job.resolve(d.res); }
      else if (d.type === 'error') { pendingJobs.delete(d.jobId); job.reject(new Error(d.msg)); }
    };
    worker.onerror = (e) => {
      for (const [, j] of pendingJobs) j.reject(new Error('管线异常：' + (e.message || '未知')));
      pendingJobs.clear();
    };
  } catch (err) {
    hint('无法启动笔触引擎：' + err.message, 'warn');
  }
}

function runPipeline(px, W, H, onProgress) {
  return new Promise((resolve, reject) => {
    if (!worker) return reject(new Error('笔触引擎未就绪'));
    const jobId = ++jobSeq;
    pendingJobs.set(jobId, { resolve, reject, onProgress });
    worker.postMessage({ jobId, px: px.buffer, W, H, opts: PIPE_OPTS }, [px.buffer]);
  });
}

// ── 素材 ──────────────────────────────────────────────
async function addFiles(files) {
  const list = [...files].filter((f) => /^image\//.test(f.type));
  if (!list.length) { hint('这些文件不是图片。', 'warn'); return; }
  for (const f of list) {
    try {
      const img = await loadImage(f);
      const scaled = scaleTo(img, MAX_EDGE);
      state.assets.push({
        id: uid(),
        name: f.name.replace(/\.[^.]+$/, ''),
        el: scaled.canvas,
        w: scaled.w,
        h: scaled.h,
        url: scaled.canvas.toDataURL('image/jpeg', 0.8),
        strokes: null,
        clips: null,
        pipelineMs: 0,
      });
    } catch (err) {
      hint(`「${f.name}」读不了：` + err.message, 'warn');
    }
  }
  renderThumbs();
  autoBind();
  renderSegs();
  refreshGenButton();
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
    img.src = url;
  });
}

function scaleTo(img, maxEdge) {
  const w0 = img.naturalWidth || img.width;
  const h0 = img.naturalHeight || img.height;
  const s = Math.min(1, maxEdge / Math.max(w0, h0));
  const w = Math.max(2, Math.round(w0 * s));
  const h = Math.max(2, Math.round(h0 * s));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const x = cv.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high';
  x.drawImage(img, 0, 0, w, h);
  return { canvas: cv, w, h };
}

function renderThumbs() {
  const box = $('thumbs');
  box.innerHTML = '';
  state.assets.forEach((a, i) => {
    const used = state.segs.some((s) => s.imageIds.includes(a.id));
    const d = document.createElement('div');
    d.className = 'thumb' + (used ? ' used' : '');
    d.innerHTML = `<img src="${a.url}" alt=""><span class="no">${i + 1}</span>
      <span class="mv">
        <button class="up" title="往前挪" ${i === 0 ? 'disabled' : ''}>‹</button>
        <button class="dn" title="往后挪" ${i === state.assets.length - 1 ? 'disabled' : ''}>›</button>
      </span>
      <button class="del" title="移除">×</button>`;
    d.querySelector('.del').addEventListener('click', (e) => {
      e.preventDefault();
      removeAsset(a.id);
    });
    d.querySelector('.up').addEventListener('click', (e) => {
      e.preventDefault();
      reorderAssets(i, i - 1);
    });
    d.querySelector('.dn').addEventListener('click', (e) => {
      e.preventDefault();
      reorderAssets(i, i + 1);
    });
    // 拖拽源：把这张图拖到段卡上
    makeDraggable(d, {
      getPayload: () => ({ kind: 'asset', assetId: a.id, name: a.name, index: i }),
      ghostLabel: `图 ${i + 1}`,
      badgeOf: (target) => dropBadge(target, i + 1),
      onDrop: (payload, ctx) => handleAssetDrop(payload, ctx),
    });
    box.appendChild(d);
  });
  $('assetHint').textContent = state.assets.length
    ? `${state.assets.length} 张图。段和图怎么对应，在中间每段的「图 N」按钮上点一下就能换。`
    : '';
  $('dropText').innerHTML = state.assets.length
    ? '继续添加图片<br><small>可一次多选</small>'
    : '拖入图片，或点这里选择<br><small>可一次多选，顺序即出场顺序</small>';
}

/** ghost 上显示的落点提示 */
function dropBadge(zone, assetNo, pt = {}) {
  const segEl = zone?.closest?.('[data-segid]') || zone;
  if (!segEl) return '';
  const seg = state.segs.find((s) => s.id === segEl.dataset.segid);
  if (!seg) return '';
  const idx = segIndexOf(seg) + 1;
  const slot = pt.under?.closest?.('[data-slot-index]');
  if (slot) {
    const i = Number(slot.dataset.slotIndex);
    const r = slot.getBoundingClientRect();
    const x = pt.x ?? r.left + r.width / 2;
    const left = x < r.left + r.width / 2;
    return left ? `→ 第${idx}段·图${i}前面` : `→ 第${idx}段·图${i}后面`;
  }
  return `→ 第${idx}段·追加`;
}

function segIndexOf(seg) {
  return state.segs.findIndex((s) => s.id === seg.id);
}

/** 把图拖到段卡上：按落点规则插入 / 追加 / 替换 */
function handleAssetDrop(payload, ctx) {
  if (!payload || payload.kind !== 'asset') return;
  const zone = ctx.target;
  const segEl = zone?.closest?.('[data-segid]') || zone;
  if (!segEl) return;
  const seg = state.segs.find((s) => s.id === segEl.dataset.segid);
  if (!seg) return;

  const drop = resolveDrop(zone, ctx.under, ctx.x);
  const ids = applyDrop(seg, payload.assetId, drop, ctx.alt);
  if (ids.length === seg.imageIds.length && ids.every((v, i) => v === seg.imageIds[i])) return;
  setSegImages(seg.id, ids);
  const op = ctx.alt && drop.slotIndex != null ? '替换'
    : drop.op === 'insert' ? '插入' : '追加';
  hint(`已${op}「图 ${payload.index + 1}」到第 ${segIndexOf(seg) + 1} 段。`, 'info');
}

// ── 文案 ──────────────────────────────────────────────

/**
 * 造一段（Scene）。
 * 源字段是 imageIds / weights / paragraphs；
 * assetId 与 text 用 getter 派生，避免两份真相走偏。
 */
function makeSeg(init = {}) {
  const seg = {
    id: init.id || uid(),
    imageIds: init.imageIds ? [...init.imageIds] : [],
    weights: init.weights ? [...init.weights] : [],
    paragraphs: init.paragraphs ? [...init.paragraphs] : [''],
    audio: init.audio || null,
    status: init.status || 'idle',
    manualMs: init.manualMs ?? null,
    capPos: init.capPos || 'bottom',      // bottom | lower | upper
  };
  if (!seg.weights.length) seg.weights = seg.imageIds.map(() => 1);
  // mode 只是给人看的标签：多图和多字幕是**两个正交维度**，
  // 塞进一个字段会互相覆盖（一屏既 2 图又 2 字幕时字幕会被吞掉）。
  // 真正的判断一律看 imageIds.length / paragraphs.length。
  Object.defineProperty(seg, 'mode', {
    get() {
      const multiImg = this.imageIds.length > 1;
      const multiCap = this.paragraphs.length > 1;
      if (multiImg && multiCap) return 'multiImage+multiCaption';
      if (multiImg) return 'multiImage';
      if (multiCap) return 'multiCaption';
      return 'single';
    },
    enumerable: false, configurable: true,
  });
  Object.defineProperty(seg, 'assetId', {
    get() { return this.imageIds[0] || null; },
    set(v) {
      if (v == null || v === '') this.imageIds = [];
      else if (this.imageIds.length) this.imageIds[0] = v;
      else this.imageIds = [v];
      if (this.weights.length !== this.imageIds.length) this.weights = this.imageIds.map(() => 1);
    },
    enumerable: false, configurable: true,
  });
  Object.defineProperty(seg, 'text', {
    get() { return this.paragraphs.join('\n'); },
    set(v) { this.paragraphs = [String(v ?? '')]; },
    enumerable: false, configurable: true,
  });
  return seg;
}

/**
 * 该段实际要显示的字幕句。
 * 依据是 paragraphs 数组本身，不看 mode ——
 * 段落数组有几项就是几句，空的（还没写）不进成片。
 */
function segParagraphs(seg) {
  const raw = (seg.paragraphs || []).map(String);
  if (raw.length <= 1) return [seg.text || ''];
  const list = raw.filter((p) => p.trim() !== '');
  return list.length ? list : [''];
}

/**
 * 编辑整段文本后的落点：
 * 多句（数组多于一项）时按换行切分，单句时保留换行做手动断行。
 */
function setSegText(seg, value) {
  if ((seg.paragraphs || []).length > 1) {
    seg.paragraphs = String(value).split('\n');
  } else {
    seg.paragraphs = [String(value)];
  }
}

/** 分段规则：auto（先按空行，空行切不动就按句）/ blank / line / sentence */
const SPLIT_RULES = {
  auto(raw) {
    let parts = raw.split(/\n\s*\n+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (parts.length === 1) {
      const sents = raw.split(/(?<=[。！？])/).map((s) => s.trim()).filter(Boolean);
      if (sents.length > 1 && sents.length <= MAX_SEGS) parts = sents;
    }
    return parts;
  },
  blank(raw) {
    return raw.split(/\n\s*\n+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  },
  line(raw) {
    return raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  },
  sentence(raw) {
    return raw.split(/(?<=[。！？])/).map((s) => s.trim()).filter(Boolean);
  },
};

function splitScript(rule = 'auto') {
  const raw = $('rawScript').value.trim();
  if (!raw) { hint('先把文案粘进来。', 'warn'); return; }
  const fn = SPLIT_RULES[rule] || SPLIT_RULES.auto;
  let parts = fn(raw);
  if (!parts.length) { hint('这段文案切不出内容。', 'warn'); return; }
  if (parts.length > MAX_SEGS) {
    const head = parts.slice(0, MAX_SEGS - 1);
    const rest = parts.slice(MAX_SEGS - 1).join(' ');
    parts = [...head, rest];
    hint(`超过 ${MAX_SEGS} 段，后面几段已合并到最后一段。`, 'warn');
  }
  state.segs = parts.map((text) => makeSeg({ paragraphs: [text] }));
  state.renderers.clear();
  autoBind();
  renderSegs();
  rebuild();
  refreshGenButton();
}
/** 在光标处把一段拆成两段 */
function splitSegAt(segId, caret) {
  const idx = state.segs.findIndex((s) => s.id === segId);
  if (idx < 0) return;
  const seg = state.segs[idx];
  const text = seg.text;
  const at = Math.max(0, Math.min(text.length, Number(caret) || 0));
  if (at <= 0 || at >= text.length) { hint('把光标放到要拆开的位置。', 'warn'); return; }
  const a = text.slice(0, at).trim();
  const b = text.slice(at).trim();
  if (!a || !b) { hint('光标位置切不出两段。', 'warn'); return; }
  const next = makeSeg({ paragraphs: [b] });
  // 拆出来的后半段继承原段的图与设置
  next.imageIds = [...seg.imageIds];
  next.weights = [...seg.weights];
  next.capPos = seg.capPos;
  seg.paragraphs = [a];
  seg.imageIds = [];
  seg.weights = [];
  state.segs.splice(idx + 1, 0, next);
  state.renderers.clear();
  renderSegs();
  rebuild();
}

/** 把一段并到上一段 */
function mergeSegWithPrev(segId) {
  const idx = state.segs.findIndex((s) => s.id === segId);
  if (idx <= 0) { hint('第一段没法再往上并了。', 'warn'); return; }
  const prev = state.segs[idx - 1];
  const cur = state.segs[idx];
  prev.paragraphs = [...segParagraphs(prev), ...segParagraphs(cur)];
  // 上一段没图就把这一段的图接过去
  if (!prev.imageIds.length && cur.imageIds.length) {
    prev.imageIds = [...cur.imageIds];
    prev.weights = [...cur.weights];
  }
  state.segs.splice(idx, 1);
  state.renderers.clear();
  renderSegs();
  rebuild();
}

/** 把一段并到下一段 */
function mergeSegWithNext(segId) {
  const idx = state.segs.findIndex((s) => s.id === segId);
  if (idx < 0 || idx >= state.segs.length - 1) { hint('最后一段没法再往下并了。', 'warn'); return; }
  const cur = state.segs[idx];
  const next = state.segs[idx + 1];
  next.paragraphs = [...segParagraphs(cur), ...segParagraphs(next)];
  if (!next.imageIds.length && cur.imageIds.length) {
    next.imageIds = [...cur.imageIds];
    next.weights = [...cur.weights];
  }
  state.segs.splice(idx, 1);
  state.renderers.clear();
  renderSegs();
  rebuild();
}

/** 段落重排：把 from 位置的段移到 to 位置 */
function reorderSeg(from, to) {
  const n = state.segs.length;
  const f = Math.max(0, Math.min(n - 1, Number(from) | 0));
  const t = Math.max(0, Math.min(n - 1, Number(to) | 0));
  if (f === t) return;
  const [item] = state.segs.splice(f, 1);
  state.segs.splice(t, 0, item);
  state.renderers.clear();
  renderSegs();
  rebuild();
}

/** 素材重排 */
function reorderAssets(from, to) {
  const n = state.assets.length;
  const f = Math.max(0, Math.min(n - 1, Number(from) | 0));
  const t = Math.max(0, Math.min(n - 1, Number(to) | 0));
  if (f === t) return;
  const [item] = state.assets.splice(f, 1);
  state.assets.splice(t, 0, item);
  renderThumbs();
  renderSegs();
  rebuild();
}

/** 删一张图：引用它的段会变成未配图（有汇总提示，不会静默吞掉） */
function removeAsset(assetId) {
  const a = state.assets.find((x) => x.id === assetId);
  if (!a) return;
  state.assets = state.assets.filter((x) => x.id !== assetId);
  for (const s of state.segs) {
    const i = s.imageIds.indexOf(assetId);
    if (i >= 0) s.imageIds.splice(i, 1);
    if (s.weights.length === s.imageIds.length) s.weights = s.imageIds.map(() => 1);
  }
  state.renderers.clear();
  renderThumbs();
  renderSegs();
  rebuild();
}

function autoBind() {
  state.segs.forEach((s, i) => {
    if (s.imageIds.length && s.imageIds.every((id) => state.assets.some((a) => a.id === id))) return;
    s.imageIds = state.assets.length ? [state.assets[Math.min(i, state.assets.length - 1)].id] : [];
    s.weights = s.imageIds.map(() => 1);
  });
}

function segDuration(seg) {
  const manual = Number(seg.manualMs);
  if (manual > 0) return Math.round(manual);
  if (seg.audio && seg.audio.duration) return Math.round(seg.audio.duration * 1000);
  return estimateDurationMs(seg.text);
}

/** 段卡上的图片槽位：多图时并排显示，每格可删、可点着换 */
function segSlotsHtml(seg) {
  const cells = seg.imageIds.map((id, i) => {
    const a = state.assets.find((x) => x.id === id);
    if (!a) return `<span class="slot ghost" title="图已被删除">?</span>`;
    const n = state.assets.indexOf(a) + 1;
    const w = seg.weights[i] || 1;
    const wTxt = seg.imageIds.length > 1 ? `<i class="w">${w % 1 === 0 ? w : w.toFixed(1)}</i>` : '';
    return `<span class="slot" data-slot-index="${i}" data-segid="${seg.id}" title="图 ${n}（点一下换下一张，× 移除）">
      <img src="${a.url}" alt=""><b>${n}</b>${wTxt}<button class="x" data-x="${i}" title="移除">×</button>
    </span>`;
  }).join('');
  return `<div class="slots" data-segid="${seg.id}">${cells}</div>`;
}

function renderSegs() {
  const box = $('segs');
  if (!state.segs.length) {
    box.innerHTML = '<p class="empty">还没有分段。粘稿子后点「按空行分段」。</p>';
    return;
  }
  const focused = document.activeElement;
  const focusId = focused && focused.dataset?.segid;
  const caret = focused && focused.selectionStart;
  box.innerHTML = '';

  state.segs.forEach((seg, i) => {
    const asset = state.assets.find((a) => a.id === seg.assetId);
    const el = document.createElement('div');
    el.className = 'seg' + (asset ? '' : ' unbound');
    el.dataset.segid = seg.id;
    el.dataset.dropAccept = 'seg';

    const audioPill = seg.status === 'busy'
      ? '<span class="pill">生成中…</span>'
      : seg.audio
        ? `<span class="pill ok">配音 ${seg.audio.duration.toFixed(1)}s</span>`
        : seg.status === 'stale'
          ? '<span class="pill warn">文案改过，需重配</span>'
          : '<span class="pill">无配音</span>';

    const dur = segDuration(seg);
    const audioMs = seg.audio ? Math.round(seg.audio.duration * 1000) : 0;
    const lo = Math.round(audioMs ? audioMs * 0.55 : Math.min(dur * 0.5, 6000));
    const hi = Math.round(audioMs ? Math.max(audioMs * 2, 2000) : Math.max(dur * 2, 6000));
    const val = Math.round(clamp(dur, lo, hi));
    const speedTxt = audioMs ? (audioMs / dur).toFixed(2) + '×' : '';

    el.innerHTML = `
      <div class="seg-head">
        <span class="seg-no">${i + 1}</span>
        <span class="wc">${seg.text.replace(/\s/g, '').length} 字</span>
        <span class="right">${audioPill}</span>
      </div>
      <textarea rows="2" data-segid="${seg.id}" placeholder="这一段要讲的话">${escapeHtml(seg.text)}</textarea>
      ${segSlotsHtml(seg)}
      <div class="seg-bar">
        <button class="pick ${asset ? '' : 'none'}" type="button">
          ${asset ? `<img src="${asset.url}" alt="">图 ${state.assets.indexOf(asset) + 1}` : '选择配图'}
        </button>
        <button class="ghost voice-btn" type="button" ${state.ttsReady ? '' : 'disabled'}>
          ${seg.audio ? '重配' : '配音'}
        </button>
        <label class="speed" title="拖动改变这一屏的时长；配音会自动变速来匹配">
          <input type="range" min="${lo}" max="${hi}" value="${val}" step="50">
          <span class="val">${(dur / 1000).toFixed(1)}s${speedTxt ? ` · ${speedTxt}` : ''}</span>
        </label>
      </div>
      <div class="seg-ops">
        <button class="ghost op" data-op="split" type="button" title="在光标处把这段拆成两段">拆分</button>
        <button class="ghost op" data-op="merge-prev" type="button" ${i === 0 ? 'disabled' : ''} title="并入上一段">并入上段</button>
        <button class="ghost op" data-op="merge-next" type="button" ${i === state.segs.length - 1 ? 'disabled' : ''} title="并入下一段">并入下段</button>
        <button class="ghost op" data-op="up" type="button" ${i === 0 ? 'disabled' : ''} title="往前挪一段">上移</button>
        <button class="ghost op" data-op="down" type="button" ${i === state.segs.length - 1 ? 'disabled' : ''} title="往后挪一段">下移</button>
        <button class="ghost op" data-op="cap" type="button" title="字幕位置：贴底 / 抬高 / 置顶">字幕：${{ bottom: '贴底', lower: '抬高', upper: '置顶' }[seg.capPos]}</button>
        <button class="ghost op danger" data-op="del" type="button" title="删掉这一段">删</button>
      </div>
    `;

    const ta = el.querySelector('textarea');
    ta.addEventListener('input', () => {
      setSegText(seg, ta.value);
      el.querySelector('.wc').textContent = `${ta.value.replace(/\s/g, '').length} 字`;
      if (seg.audio) {
        seg.status = 'stale';
        const pill = el.querySelector('.seg-head .right');
        if (pill) pill.innerHTML = '<span class="pill warn">文案改过，需重配</span>';
      }
      clearTimeout(seg._t);
      seg._t = setTimeout(() => rebuild(), 600);
    });

    el.querySelector('.pick').addEventListener('click', () => cycleAsset(seg));
    el.querySelector('.voice-btn').addEventListener('click', () => genVoice(seg));

    // 槽位：点 × 移除，点槽位本身换下一张
    const slots = el.querySelector('.slots');
    if (slots) {
      slots.addEventListener('click', (e) => {
        const x = e.target.closest('.x');
        if (x) {
          e.stopPropagation();
          const i2 = Number(x.dataset.x);
          seg.imageIds.splice(i2, 1);
          if (seg.weights.length > seg.imageIds.length) seg.weights.splice(i2, 1);
          state.renderers.clear();
          renderSegs(); rebuild();
          return;
        }
        const s = e.target.closest('.slot');
        if (s && !s.classList.contains('ghost')) cycleAsset(seg, Number(s.dataset.slotIndex));
      });

      // 槽位也是拖拽源：拖到同段另一个槽位 = 调整这一屏里图的先后
      slots.querySelectorAll('.slot[data-slot-index]').forEach((slotEl) => {
        const si = Number(slotEl.dataset.slotIndex);
        makeDraggable(slotEl, {
          getPayload: () => ({
            kind: 'asset',
            assetId: seg.imageIds[si],
            index: state.assets.findIndex((a) => a.id === seg.imageIds[si]),
            sourceSegId: seg.id,
          }),
          ghostLabel: `图 ${state.assets.findIndex((a) => a.id === seg.imageIds[si]) + 1}`,
          badgeOf: (zone, payload, pt) => dropBadge(zone, payload.index + 1, pt),
          onDrop: (payload, ctx) => handleAssetDrop(payload, ctx),
        });
      });
    }

    // 段操作
    el.querySelector('.seg-ops').addEventListener('click', (e) => {
      const b = e.target.closest('.op');
      if (!b) return;
      const op = b.dataset.op;
      if (op === 'split') splitSegAt(seg.id, ta.selectionStart);
      else if (op === 'merge-prev') mergeSegWithPrev(seg.id);
      else if (op === 'merge-next') mergeSegWithNext(seg.id);
      else if (op === 'up') reorderSeg(i, i - 1);
      else if (op === 'down') reorderSeg(i, i + 1);
      else if (op === 'del') removeSeg(seg.id);
      else if (op === 'cap') {
        const order = ['bottom', 'lower', 'upper'];
        seg.capPos = order[(order.indexOf(seg.capPos) + 1) % order.length];
        renderSegs(); rebuild();
      }
    });

    const slider = el.querySelector('input[type=range]');
    const valEl = el.querySelector('.val');
    slider.addEventListener('input', () => {
      seg.manualMs = Number(slider.value);
      const s = audioMs ? audioMs / seg.manualMs : 1;
      valEl.textContent = `${(seg.manualMs / 1000).toFixed(1)}s${audioMs ? ` · ${s.toFixed(2)}×` : ''}`;
      rebuild();
    });

    // 点段卡空白处 = 选中这一屏（右侧场景栏跟着显示）
    // 但点在输入框/按钮/图片上时不抢焦点，那些控件自己管
    el.addEventListener('click', (e) => {
      if (e.target.closest('button, input, textarea, select, .slots, .seg-bar')) return;
      selectSeg(seg.id);
    });

    box.appendChild(el);
  });

  // 还原焦点
  if (focusId) {
    const again = box.querySelector(`textarea[data-segid="${focusId}"]`);
    if (again) { again.focus(); try { again.setSelectionRange(caret, caret); } catch { /* ignore */ } }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** 未配图的段：段落卡上有红框，这里再给一条汇总，导出前必须看得见 */
function updateUnboundHint(unbound) {
  const el = $('unboundHint');
  if (!el) return;
  if (!unbound.length) { el.hidden = true; el.textContent = ''; return; }
  const noAsset = unbound.filter((s) => !s.imageIds.length).length;
  const badAsset = unbound.length - noAsset;
  const parts = [];
  if (noAsset) parts.push(`${noAsset} 段没配图`);
  if (badAsset) parts.push(`${badAsset} 段配的图已被删除`);
  el.hidden = false;
  el.textContent = `⚠ ${parts.join('，')}，不会出现在成片里。点段落卡上的「选择配图」补上。`;
}

/** 删一段 */
function removeSeg(segId) {
  const idx = state.segs.findIndex((s) => s.id === segId);
  if (idx < 0) return;
  state.segs.splice(idx, 1);
  state.renderers.clear();
  renderSegs();
  rebuild();
}

/**
 * 设置某一段的字幕分句与位置。UI 与外部调用走同一入口。
 */
function setSegCaptions(segId, paragraphs, capPos = null) {
  const seg = state.segs.find((s) => s.id === segId);
  if (!seg) return false;
  const list = (paragraphs || []).map(String);
  seg.paragraphs = list.length ? list : [''];
  if (capPos) seg.capPos = capPos;
  // 面板正在被编辑时不重画它，否则打字会失焦
  if (!panelEditing) renderSegs();
  rebuild();
  if (!panelEditing) scenePanel?.render();
  return true;
}

/**
 * 设置某一段的图。UI 交互（拖拽）和外部调用都走这一个入口，
 * 保证「state 改了但界面没刷新」这种事不会发生。
 * @param {string} segId
 * @param {string[]} imageIds
 * @param {number[]} [weights] 与 imageIds 等长；不给则全为 1
 */
function setSegImages(segId, imageIds, weights = null) {
  const seg = state.segs.find((s) => s.id === segId);
  if (!seg) return false;
  const ids = (imageIds || []).filter(Boolean);
  seg.imageIds = ids;
  seg.weights = weights && weights.length === ids.length
    ? weights.map((w) => Math.max(0.05, Number(w) || 1))
    : ids.map(() => 1);
  state.renderers.clear();
  if (!panelEditing) renderThumbs();
  if (!panelEditing) renderSegs();
  rebuild();
  if (!panelEditing) scenePanel?.render();
  return true;
}

/**
 * 换图。
 * 不传 slotIndex：整体轮换（第一张图往后换，保持单图行为不变）。
 * 传了 slotIndex：只换那一张。
 */
function cycleAsset(seg, slotIndex = null) {
  if (!state.assets.length) { hint('先加图片。', 'warn'); return; }
  if (slotIndex === null) {
    const idx = state.assets.findIndex((a) => a.id === seg.assetId);
    const next = state.assets[(idx + 1) % state.assets.length].id;
    if (seg.imageIds.length <= 1) {
      seg.imageIds = [next];
      seg.weights = [1];
    } else {
      // 多图时整体轮换 = 整组往后挪一位
      const cur = state.assets.findIndex((a) => a.id === seg.imageIds[0]);
      const rot = seg.imageIds.map((id) => {
        const i = state.assets.findIndex((a) => a.id === id);
        return state.assets[(i + 1) % state.assets.length].id;
      });
      void cur;
      seg.imageIds = rot;
    }
  } else {
    const i = slotIndex;
    if (i < 0 || i >= seg.imageIds.length) return;
    const cur = state.assets.findIndex((a) => a.id === seg.imageIds[i]);
    seg.imageIds[i] = state.assets[(cur + 1) % state.assets.length].id;
  }
  state.renderers.clear();
  renderThumbs(); renderSegs(); rebuild();
}

async function genVoice(seg) {
  if (!state.ttsReady) { hint('语音引擎还没就绪。', 'warn'); return; }
  if (!seg.text.trim()) { hint('这段没有文字。', 'warn'); return; }
  seg.status = 'busy';
  renderSegs();
  try {
    const r = await state.tts.synth(seg.text, voiceOf());
    if (!r.pcm.length) throw new Error('合成结果为空');
    seg.audio = { pcm: r.pcm, sr: r.sampleRate, duration: r.pcm.length / r.sampleRate };
    seg.status = 'done';
    seg.manualMs = null;
  } catch (err) {
    seg.status = 'idle';
    hint('配音失败：' + (err.message || err), 'warn');
  }
  renderSegs();
  rebuild();
}

// ── 生成 ──────────────────────────────────────────────
function refreshGenButton() {
  const ok = state.segs.length > 0 && state.segs.some((s) => s.imageIds.length);
  $('genBtn').disabled = !ok;
}

async function generate() {
  if (state.busy) return;
  const segs = state.segs.filter((s) => s.imageIds.length);
  if (!segs.length) { hint('每段都要先配一张图。', 'warn'); return; }

  state.busy = true;
  const genBtn = $('genBtn');
  genBtn.disabled = true;
  genBtn.textContent = '生成中…';

  try {
    // 一屏多图时，每张图都要分析笔触
    const need = [...new Set(segs.flatMap((s) => s.imageIds))];
    let done = 0;
    for (const id of need) {
      const a = state.assets.find((x) => x.id === id);
      if (!a) continue;
      if (a.strokes) { done++; continue; }
      hint(`正在分析图片 ${done + 1}/${need.length}：「${a.name}」`);
      const ctx = a.el.getContext('2d', { willReadFrequently: true });
      const img = ctx.getImageData(0, 0, a.w, a.h);
      const px = new Uint8ClampedArray(img.data.buffer.slice(0));
      const t0 = performance.now();
      const res = await runPipeline(px, a.w, a.h, (p) => {
        hint(`正在分析图片 ${done + 1}/${need.length}：「${a.name}」 ${Math.round((p || 0) * 100)}%`);
      });
      a.strokes = res.strokes;
      a.clips = res.clips;
      a.pipelineMs = performance.now() - t0;
      done++;
    }

    rebuild();
    const tl = state.timeline;
    const notes = (tl.notes || []).slice(0, 2).join('；');
    hint(`完成：${tl.scenes.length} 屏，总长 ${fmt(tl.totalMs)}。${notes}`);
    genBtn.textContent = '重新生成';
  } catch (err) {
    hint('生成失败：' + (err.message || err), 'warn');
    genBtn.textContent = '生成';
  } finally {
    state.busy = false;
    genBtn.disabled = false;
    refreshGenButton();
  }
}

function rebuild() {
  // 一段只要有图就出片（多图都算）；完全没图的段不能静默吞掉
  const bound = state.segs.filter((s) => s.imageIds.length && s.imageIds.some((id) => state.assets.some((a) => a.id === id)));
  // 没配图的段不能静默吞掉：用户以为有 8 段，实际只出 6 屏，他不知道少了什么
  const unbound = state.segs.filter((s) => !(s.imageIds.length && s.imageIds.some((id) => state.assets.some((a) => a.id === id))));
  state.unbound = unbound.length;
  updateUnboundHint(unbound);

  if (!bound.length) {
    state.timeline = null;
    $('chips').innerHTML = '';
    $('stageEmpty').hidden = false;
    $('playBtn').disabled = true;
    $('seek').disabled = true;
    $('stat').textContent = '';
    $('expBtn').disabled = true;
    return;
  }

  const mapped = bound.map((s) => {
    // 已被删掉的图从这一屏里剔掉（并留警告，不静默）
    const ids = [];
    const weights = [];
    s.imageIds.forEach((id, i) => {
      if (!state.assets.some((a) => a.id === id)) return;
      ids.push(id);
      weights.push(Number(s.weights[i]) || 1);
    });
    const assets = ids.map((id) => state.assets.find((x) => x.id === id));
    return {
      id: s.id,
      text: s.text,
      paragraphs: segParagraphs(s),
      mode: s.mode,
      capPos: s.capPos,
      imageIds: ids,
      weights: weights.length === ids.length ? weights : ids.map(() => 1),
      hasImage: !!assets.length,
      audioMs: s.audio ? s.audio.duration * 1000 : 0,
      manualMs: s.manualMs,
      strokeCount: assets.length === 1 && assets[0].strokes ? assets[0].strokes.length : 0,
      strokeCounts: assets.map((a) => (a.strokes ? a.strokes.length : 0)),
    };
  });

  state.timeline = buildTimeline(mapped);
  state.timeline.scenes.forEach((sc) => {
    const seg = state.segs.find((s) => s.id === sc.id);
    sc.assetId = seg ? seg.assetId : null;
    sc.text = seg ? seg.text : '';
  });

  // 渲染器缓存的 key 可能是 `segId`（单图）或 `segId#图片序号`（多图），按前缀清理
  const validIds = new Set(state.timeline.scenes.map((s) => s.id));
  for (const key of [...state.renderers.keys()]) {
    const base = String(key).split('#')[0];
    if (!validIds.has(base)) state.renderers.delete(key);
  }

  $('stageEmpty').hidden = true;
  $('playBtn').disabled = false;
  $('seek').disabled = false;
  $('stat').textContent = `${state.timeline.scenes.length} 屏 · ${fmt(state.timeline.totalMs)}`;
  $('expBtn').disabled = !state.timeline.totalMs;

  renderChips();
  timelineView?.render();
  if (!panelEditing) scenePanel?.render();
  state.ms = Math.min(state.ms, state.timeline.totalMs);
  renderAt(state.ms);
  updateTransport();
}

function renderChips() {
  const box = $('chips');
  box.innerHTML = '';
  if (!state.timeline) return;
  state.timeline.scenes.forEach((sc, i) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.textContent = `${i + 1} · ${fmt(sc.dur)}`;
    b.addEventListener('click', () => {
      pause();
      state.ms = sc.start;
      renderAt(state.ms);
      updateTransport();
    });
    box.appendChild(b);
  });
}

// ── 底部时间轴 ──────────────────────────────────────
function initTimelineView() {
  const el = $('timeline');
  if (!el) return;
  timelineView = createTimelineView({
    root: el,
    state,
    onSeek: (ms) => {
      pause();
      state.ms = ms;
      renderAt(state.ms);
      updateTransport();
    },
    onSelect: (segId) => {
      selectSeg(segId);
    },
    onReorder: (from, to) => {
      // 时间轴上的屏序 = state.segs 的序（未配图的段不出片，不在时间轴里）
      const tl = state.timeline;
      if (!tl) return;
      const fromSeg = tl.scenes[from];
      const toSeg = tl.scenes[to];
      if (!fromSeg || !toSeg) return;
      const i = state.segs.findIndex((s) => s.id === fromSeg.id);
      const j = state.segs.findIndex((s) => s.id === toSeg.id);
      if (i < 0 || j < 0) return;
      reorderSeg(i, j);
    },
    onResize: (segId, ms) => {
      const seg = state.segs.find((s) => s.id === segId);
      if (!seg) return;
      seg.manualMs = Math.round(ms);
      rebuild();
      renderSegs();
    },
    onStatus: (segId, msg) => hint(msg, 'warn'),
  });
}

/**
 * 选中某一段：时间轴、段卡、右侧场景栏三处同步。
 * 这是唯一的「选中」入口，避免三边各记一份状态走偏。
 */
function selectSeg(segId) {
  state.selectedSeg = segId;
  highlightSegCard(segId);
  timelineView?.setSelected(segId);
  scenePanel?.render();
  // 窄屏下场景栏是抽屉，选中了才弹出来
  if (segId && window.matchMedia('(max-width: 1400px)').matches) {
    scenePanel?.setOpen(true);
  }
}

/** 选中某段时，段卡上也高亮一下 */
function highlightSegCard(segId) {
  document.querySelectorAll('.seg.sel').forEach((e) => e.classList.remove('sel'));
  if (!segId) return;
  const card = document.querySelector(`.seg[data-segid="${segId}"]`);
  if (card) {
    card.classList.add('sel');
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

// ── 右侧场景设置栏 ──────────────────────────────────
function initScenePanel() {
  const el = $('scenePanel');
  if (!el) return;
  scenePanel = createScenePanel({
    root: el,
    state,
    getSeg: () => state.segs.find((s) => s.id === state.selectedSeg) || null,
    getScene: () => {
      const tl = state.timeline;
      if (!tl) return null;
      return tl.scenes.find((s) => s.id === state.selectedSeg) || null;
    },
    onImages: (segId, imageIds, weights) => {
      // 走统一入口，保证段卡、素材缩略图、时间轴三处一起刷新
      setSegImages(segId, imageIds, weights);
    },
    onCaptions: (segId, paragraphs, capPos) => {
      setSegCaptions(segId, paragraphs, capPos);
    },
    onDuration: (segId, ms) => {
      const seg = state.segs.find((s) => s.id === segId);
      if (!seg) return;
      seg.manualMs = ms == null ? null : Math.round(ms);
      rebuild();
      renderSegs();
      scenePanel?.render();
    },
    onVoice: (segId) => {
      const seg = state.segs.find((s) => s.id === segId);
      if (seg) genVoice(seg);
    },
    onSeek: (ms) => {
      pause();
      state.ms = ms;
      renderAt(state.ms);
      updateTransport();
    },
    // 用户正在面板里打字/拖滑块时，别把面板重画了（会失焦）
    onEditingChange: (editing) => { panelEditing = editing; },
  });
}

// ── 渲染 ──────────────────────────────────────────────
function ensureCanvas() {
  const [w, h] = $('aspect').value.split('x').map(Number);
  // 尺寸没变就直接返回：重建纸面纹理与字幕排版缓存是每帧最大的浪费
  if (compositor && painter && state.W === w && state.H === h) return;
  state.W = w; state.H = h;
  if (stage.width !== w || stage.height !== h) { stage.width = w; stage.height = h; }
  stage.parentElement.classList.toggle('portrait', h > w);

  if (!compositor) compositor = new Compositor({ W: w, H: h, canvas: stage });
  else compositor.resize(w, h);

  const lay = computeLayout(w, h);
  if (!painter) {
    painter = new CaptionPainter({
      W: w, H: h, box: lay.cap,
      family: state.fontOk ? `"${FONT_NAME}", ${KAI}` : KAI,
    });
  } else {
    painter.W = w; painter.H = h;
    painter.setBox(lay.cap);
  }
}

/**
 * 渲染器缓存的键：一屏多图时每张图要独立的渲染器（笔数、抽稀比例都不同）。
 */
function rendererFor(sc, item) {
  const assetId = item ? item.assetId : sc.assetId;
  const asset = state.assets.find((a) => a.id === assetId);
  if (!asset || !asset.strokes) return null;
  const n = asset.strokes.length;
  const keepRaw = item ? item.keep : sc.keep;
  const keep = Math.min(n, Math.max(1, Math.round(keepRaw)));
  const key = item ? `${sc.id}#${item.index}` : sc.id;
  let rec = state.renderers.get(key);
  if (rec && rec.assetId === asset.id && rec.count === n && rec.keep === keep) return rec;

  // 抽稀策略见 core/stroke-order.js：整块优先，不丢笔造成白斑
  const rd = StrokeRenderer.create({
    W: asset.w, H: asset.h, strokes: asset.strokes, clips: asset.clips, keep,
  });
  rec = { rd, assetId: asset.id, count: n, keep, orderLen: rd.order.length, key };
  state.renderers.set(key, rec);
  return rec;
}

function renderAt(ms) {
  if (!state.timeline || !state.timeline.scenes.length) return;
  ensureCanvas();
  const hit = sceneAt(state.timeline, ms);
  if (!hit) return;
  const sc = hit.scene;
  const seg = state.segs.find((s) => s.id === sc.id);

  // 多图：这一时刻该画哪一张
  const cur = itemAt(sc, hit.local);
  if (!cur) return;
  const asset = state.assets.find((a) => a.id === cur.item.assetId);
  if (!asset) return;

  const rec = rendererFor(sc, cur.item);
  let partial = null, tip = null, painted = null;
  if (rec) {
    const pos = cur.progress * rec.orderLen;
    const nDone = Math.floor(pos);
    rec.rd.seekTo(nDone, pos - nDone);
    partial = rec.rd.getPartial();
    tip = rec.rd.tip;
    painted = rec.rd.painted;
  }

  // 每屏的字幕位置可以不同 → 版式跟着换
  const lay = computeLayout(state.W, state.H, { capPos: sc.capPos });

  compositor.draw({
    bitmap: asset.el,
    imgW: asset.w,
    imgH: asset.h,
    painted,
    partial,
    tip,
    tipAlpha: hit.local < sc.drawMs ? 1 : 0,
    layout: lay,
  });

  // 字幕：多句时按时间窗切换当前该显示的那句
  const span = captionAt(sc, hit.local);
  const capText = span ? span.text : (seg ? seg.text : '');
  const spanStart = span ? span.start : 0;
  const reveal = clamp((hit.local - spanStart - 140) / Math.max(360, (span ? span.dur : sc.dur) * 0.7), 0, 1);
  const alpha = clamp((hit.local - spanStart + 40) / 200, 0, 1);
  painter.draw(compositor.ctx, {
    key: `${sc.id}#${span ? span.index : 0}`,
    text: capText,
    reveal,
    alpha,
    seed: sc.index * 37,
    box: lay.cap,
  });

  const chips = $('chips').children;
  for (let i = 0; i < chips.length; i++) chips[i].classList.toggle('on', i === sc.index);
  // 播放头跟着走（只改 transform，不重建整条时间轴）
  timelineView?.updateHead();
}

function updateTransport() {
  const total = state.timeline ? state.timeline.totalMs : 0;
  $('seek').value = total ? Math.round((state.ms / total) * 1000) : 0;
  $('time').textContent = `${fmt(state.ms)} / ${fmt(total)}`;
  $('playBtn').textContent = state.playing ? '❚❚' : '▶';
}

// ── 播放 ──────────────────────────────────────────────
async function ensureMix() {
  if (!state.timeline) return null;
  const map = new Map(state.segs.map((s) => [s.id, s]));
  const mix = buildSoundtrack(state.timeline.scenes, (id) => map.get(id));
  state.mix = mix;
  return mix;
}

async function startAudioFrom(fromMs) {
  const mix = await ensureMix();
  if (!mix || !mix.hasAudio) { state.srcNode = null; return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!state.audioCtx) state.audioCtx = new AC({ sampleRate: 48000 });
  if (state.audioCtx.state === 'suspended') await state.audioCtx.resume();
  try { state.srcNode?.stop(); } catch { /* ignore */ }
  const ab = toAudioBuffer(state.audioCtx, mix);
  const src = state.audioCtx.createBufferSource();
  src.buffer = ab;
  src.connect(state.audioCtx.destination);
  src.start(0, clamp(fromMs / 1000, 0, Math.max(0, ab.duration - 0.01)));
  state.srcNode = src;
  state.playStart = state.audioCtx.currentTime;
  state.playFrom = fromMs;
}

async function play() {
  if (!state.timeline) return;
  if (state.ms >= state.timeline.totalMs - 30) state.ms = 0;
  state.playing = true;
  await startAudioFrom(state.ms);
  if (!state.srcNode) {
    state.playStart = performance.now() / 1000;
    state.playFrom = state.ms;
  }
  updateTransport();
  requestAnimationFrame(tick);
}

function pause() {
  state.playing = false;
  try { state.srcNode?.stop(); } catch { /* ignore */ }
  state.srcNode = null;
  updateTransport();
}

function tick() {
  if (!state.playing || !state.timeline) return;
  const total = state.timeline.totalMs;
  let ms;
  if (state.srcNode && state.audioCtx) {
    ms = state.playFrom + (state.audioCtx.currentTime - state.playStart) * 1000;
  } else {
    ms = state.playFrom + (performance.now() / 1000 - state.playStart) * 1000;
  }
  if (ms >= total) {
    state.ms = total;
    renderAt(total);
    updateTransport();
    pause();
    return;
  }
  state.ms = ms;
  renderAt(ms);
  updateTransport();
  requestAnimationFrame(tick);
}

// ── 导出 ──────────────────────────────────────────────
async function doExport() {
  if (!state.timeline || !state.timeline.totalMs) return;
  if (state.busy) return;
  pause();

  if (!pickMime()) { hint('这个浏览器不支持录制视频，请用 Chrome / Edge。', 'warn'); return; }

  state.busy = true;
  $('expBtn').disabled = true;
  $('genBtn').disabled = true;
  $('expBar').hidden = false;
  $('expFill').style.width = '0%';
  $('expText').textContent = '准备中…';
  state.exportSignal = { aborted: false };
  $('expCancel').addEventListener('click', () => { state.exportSignal.aborted = true; }, { once: true });

  try {
    const mix = await ensureMix();
    const AC = window.AudioContext || window.webkitAudioContext;
    const tmp = new AC({ sampleRate: 48000 });
    const ab = toAudioBuffer(tmp, mix);
    await tmp.close();

    state.ms = 0;
    renderAt(0);
    await nextFrame();

    const res = await exportVideo({
      canvas: stage,
      audio: ab,
      totalMs: state.timeline.totalMs,
      renderAt: (ms) => { state.ms = ms; renderAt(ms); },
      onProgress: ({ ratio, ms }) => {
        $('expFill').style.width = Math.round(ratio * 100) + '%';
        $('expText').textContent = `录制中 ${fmt(ms)} / ${fmt(state.timeline.totalMs)}`;
      },
      signal: state.exportSignal,
    });

    const stamp = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '');
    downloadBlob(res.blob, `inkbrief-${state.timeline.scenes.length}段-${stamp}.${res.ext}`);
    if (window.__ink) window.__ink.lastExport = res;
    const size = (res.blob.size / 1048576).toFixed(1);
    const drift = (res.audioMs - state.timeline.totalMs) / 1000;
    hint(`已导出 ${res.ext.toUpperCase()} · ${size}MB · ${state.W}×${state.H} · 时长 ${fmt(state.timeline.totalMs)}（录制用了 ${(res.ms / 1000).toFixed(0)}s，音轨与时间轴差 ${drift.toFixed(2)}s）`);
  } catch (err) {
    if (String(err.message).includes('已取消')) hint('导出已取消。');
    else hint('导出失败：' + (err.message || err), 'warn');
  } finally {
    state.busy = false;
    $('expBar').hidden = true;
    $('expBtn').disabled = false;
    $('genBtn').disabled = false;
    state.exportSignal = null;
    updateTransport();
  }
}

// ── 事件绑定 ──────────────────────────────────────────
function bindUI() {
  $('fileInput').addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });

  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.remove('over');
  }));
  drop.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  $('splitBtn').addEventListener('click', () => splitScript($('splitRule')?.value || 'auto'));
  $('genBtn').addEventListener('click', generate);
  $('expBtn').addEventListener('click', doExport);

  $('playBtn').addEventListener('click', () => { if (state.playing) pause(); else play(); });

  $('seek').addEventListener('input', (e) => {
    if (!state.timeline) return;
    state.ms = (Number(e.target.value) / 1000) * state.timeline.totalMs;
    renderAt(state.ms);
    updateTransport();
  });

  $('aspect').addEventListener('change', () => {
    pause();
    state.renderers.clear();
    ensureCanvas();
    renderAt(state.ms);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.code === 'Space') { e.preventDefault(); if (state.playing) pause(); else play(); }
  });
}

// ── 调试钩子（仅 ?debug=1）────────────────────────────
if (new URLSearchParams(location.search).has('debug')) {
  window.__ink = {
    get state() { return state; },
    get timeline() { return state.timeline; },
    renderAt, generate, play, pause, rebuild, renderSegs,
    synth: (t) => state.tts.synth(t, voiceOf()),
    addFiles, splitScript,
    makeSeg, splitSegAt, mergeSegWithPrev, mergeSegWithNext,
    reorderSeg, reorderAssets, removeAsset, removeSeg, cycleAsset, setSegImages, setSegCaptions,
  };
}

boot();
