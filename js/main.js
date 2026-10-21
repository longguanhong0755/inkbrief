// inkbrief 主逻辑：多图 + 多段 → 逐屏手绘 + 本地 TTS 配音 + 字幕 → 导出 MP4。
import { StrokeRenderer } from './core/renderer.js?v=8';
import { Compositor, computeLayout } from './core/compositor.js';
import { CaptionPainter } from './core/subtitle.js';
import {
  buildTimeline, sceneAt, drawProgress, estimateDurationMs,
} from './core/timeline.js';
import { TTSEngine, VOICES, loadModel } from './tts/engine.js?v=8';
import { buildSoundtrack, toAudioBuffer } from './audio/mix.js';
import { exportVideo, downloadBlob, pickMime } from './core/exporter.js';

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
};

let worker = null;
let jobSeq = 0;
const pendingJobs = new Map();
let compositor = null;
let painter = null;
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
    const used = state.segs.some((s) => s.assetId === a.id);
    const d = document.createElement('div');
    d.className = 'thumb' + (used ? ' used' : '');
    d.innerHTML = `<img src="${a.url}" alt=""><span class="no">${i + 1}</span><button class="del" title="移除">×</button>`;
    d.querySelector('.del').addEventListener('click', (e) => {
      e.preventDefault();
      state.assets = state.assets.filter((x) => x.id !== a.id);
      for (const s of state.segs) if (s.assetId === a.id) s.assetId = null;
      state.renderers.clear();
      renderThumbs(); renderSegs(); rebuild();
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

// ── 文案 ──────────────────────────────────────────────
function splitScript() {
  const raw = $('rawScript').value.trim();
  if (!raw) { hint('先把文案粘进来。', 'warn'); return; }
  let parts = raw.split(/\n\s*\n+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (parts.length === 1) {
    const sents = raw.split(/(?<=[。！？])/).map((s) => s.trim()).filter(Boolean);
    if (sents.length > 1 && sents.length <= MAX_SEGS) parts = sents;
  }
  if (parts.length > MAX_SEGS) {
    const head = parts.slice(0, MAX_SEGS - 1);
    const rest = parts.slice(MAX_SEGS - 1).join(' ');
    parts = [...head, rest];
    hint(`超过 ${MAX_SEGS} 段，后面几段已合并到最后一段。`, 'warn');
  }
  state.segs = parts.map((text) => ({
    id: uid(), text, assetId: null, audio: null, status: 'idle', manualMs: null,
  }));
  state.renderers.clear();
  autoBind();
  renderSegs();
  rebuild();
  refreshGenButton();
}

function autoBind() {
  state.segs.forEach((s, i) => {
    if (s.assetId && state.assets.some((a) => a.id === s.assetId)) return;
    s.assetId = state.assets.length ? state.assets[Math.min(i, state.assets.length - 1)].id : null;
  });
}

function segDuration(seg) {
  const manual = Number(seg.manualMs);
  if (manual > 0) return Math.round(manual);
  if (seg.audio && seg.audio.duration) return Math.round(seg.audio.duration * 1000);
  return estimateDurationMs(seg.text);
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
    `;

    const ta = el.querySelector('textarea');
    ta.addEventListener('input', () => {
      seg.text = ta.value;
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

    const slider = el.querySelector('input[type=range]');
    const valEl = el.querySelector('.val');
    slider.addEventListener('input', () => {
      seg.manualMs = Number(slider.value);
      const s = audioMs ? audioMs / seg.manualMs : 1;
      valEl.textContent = `${(seg.manualMs / 1000).toFixed(1)}s${audioMs ? ` · ${s.toFixed(2)}×` : ''}`;
      rebuild();
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
  const noAsset = unbound.filter((s) => !s.assetId).length;
  const badAsset = unbound.length - noAsset;
  const parts = [];
  if (noAsset) parts.push(`${noAsset} 段没配图`);
  if (badAsset) parts.push(`${badAsset} 段配的图已被删除`);
  el.hidden = false;
  el.textContent = `⚠ ${parts.join('，')}，不会出现在成片里。点段落卡上的「选择配图」补上。`;
}

function cycleAsset(seg) {
  if (!state.assets.length) { hint('先加图片。', 'warn'); return; }
  const idx = state.assets.findIndex((a) => a.id === seg.assetId);
  seg.assetId = state.assets[(idx + 1) % state.assets.length].id;
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
  const ok = state.segs.length > 0 && state.segs.some((s) => s.assetId);
  $('genBtn').disabled = !ok;
}

async function generate() {
  if (state.busy) return;
  const segs = state.segs.filter((s) => s.assetId);
  if (!segs.length) { hint('每段都要先配一张图。', 'warn'); return; }

  state.busy = true;
  const genBtn = $('genBtn');
  genBtn.disabled = true;
  genBtn.textContent = '生成中…';

  try {
    const need = [...new Set(segs.map((s) => s.assetId))];
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
  const bound = state.segs.filter((s) => s.assetId && state.assets.some((a) => a.id === s.assetId));
  // 没配图的段不能静默吞掉：用户以为有 8 段，实际只出 6 屏，他不知道少了什么
  const unbound = state.segs.filter((s) => !(s.assetId && state.assets.some((a) => a.id === s.assetId)));
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
    const a = state.assets.find((x) => x.id === s.assetId);
    return {
      id: s.id, text: s.text, hasImage: !!a,
      audioMs: s.audio ? s.audio.duration * 1000 : 0,
      manualMs: s.manualMs,
      strokeCount: a && a.strokes ? a.strokes.length : 0,
    };
  });

  state.timeline = buildTimeline(mapped);
  state.timeline.scenes.forEach((sc) => {
    const seg = state.segs.find((s) => s.id === sc.id);
    sc.assetId = seg ? seg.assetId : null;
    sc.text = seg ? seg.text : '';
  });

  const validIds = new Set(state.timeline.scenes.map((s) => s.id));
  for (const key of [...state.renderers.keys()]) if (!validIds.has(key)) state.renderers.delete(key);

  $('stageEmpty').hidden = true;
  $('playBtn').disabled = false;
  $('seek').disabled = false;
  $('stat').textContent = `${state.timeline.scenes.length} 屏 · ${fmt(state.timeline.totalMs)}`;
  $('expBtn').disabled = !state.timeline.totalMs;

  renderChips();
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

function rendererFor(sc) {
  const asset = state.assets.find((a) => a.id === sc.assetId);
  if (!asset || !asset.strokes) return null;
  const n = asset.strokes.length;
  const keep = Math.min(n, Math.max(1, Math.round(sc.keep)));
  let rec = state.renderers.get(sc.id);
  if (rec && rec.assetId === asset.id && rec.count === n && rec.keep === keep) return rec;

  // 抽稀策略见 core/stroke-order.js：整块优先，不丢笔造成白斑
  const rd = StrokeRenderer.create({
    W: asset.w, H: asset.h, strokes: asset.strokes, clips: asset.clips, keep,
  });
  rec = { rd, assetId: asset.id, count: n, keep, orderLen: rd.order.length };
  state.renderers.set(sc.id, rec);
  return rec;
}

function renderAt(ms) {
  if (!state.timeline || !state.timeline.scenes.length) return;
  ensureCanvas();
  const hit = sceneAt(state.timeline, ms);
  if (!hit) return;
  const sc = hit.scene;
  const seg = state.segs.find((s) => s.id === sc.id);
  const asset = state.assets.find((a) => a.id === sc.assetId);
  if (!asset) return;

  const rec = rendererFor(sc);
  let partial = null, tip = null, painted = null;
  if (rec) {
    const p = drawProgress(sc, hit.local);
    const pos = p * rec.orderLen;
    const nDone = Math.floor(pos);
    rec.rd.seekTo(nDone, pos - nDone);
    partial = rec.rd.getPartial();
    tip = rec.rd.tip;
    painted = rec.rd.painted;
  }

  compositor.draw({
    bitmap: asset.el,
    imgW: asset.w,
    imgH: asset.h,
    painted,
    partial,
    tip,
    tipAlpha: hit.local < sc.drawMs ? 1 : 0,
  });

  const reveal = clamp((hit.local - 140) / Math.max(360, sc.dur * 0.7), 0, 1);
  const alpha = clamp((hit.local + 40) / 200, 0, 1);
  painter.draw(compositor.ctx, {
    key: sc.id,
    text: seg ? seg.text : '',
    reveal,
    alpha,
    seed: sc.index * 37,
  });

  const chips = $('chips').children;
  for (let i = 0; i < chips.length; i++) chips[i].classList.toggle('on', i === sc.index);
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

  $('splitBtn').addEventListener('click', splitScript);
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
    renderAt, generate, play, pause,
    synth: (t) => state.tts.synth(t, voiceOf()),
    addFiles, splitScript,
  };
}

boot();
