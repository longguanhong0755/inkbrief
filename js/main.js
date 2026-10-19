import { planScenes } from './core/scene-planner.js';
import { buildTimeline, frameAt } from './core/timeline.js';
import { StrokeRenderer } from './core/renderer.js';
import { Compositor } from './core/compositor.js';
import { CaptionPainter } from './core/subtitle.js';
import { exportVideo } from './core/exporter.js';

const $ = (id) => document.getElementById(id);
const MAXSIDE = 1024;
const MAX_SEG = 8;

let imgCanvas = null;
let W = 0, H = 0;
let strokes = null, clips = null, layers = null;
let plan = null, timeline = null;
let renderer = null, compositor = null, captions = null;
let playing = false, currentMs = 0, lastT = 0, raf = 0;
let exporting = false, abortCtl = null;
let worker = null, workerBusy = false, jobSeq = 0, jobNow = 0;
let paragraphsNow = [];
let pendingParagraphs = [];
let fontFamily = '"MaShanZheng", "KaiTi", "STKaiti", "楷体", serif';
let fontOk = false;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function showMsg(text, ok = false) {
  const el = $('msg');
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle('ok', !!ok);
}

function hideMsg() { $('msg').hidden = true; }

function fmt(sec) {
  const s = Math.max(0, Math.round(sec));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------------- 文案 ----------------
function readParagraphs() {
  return $('text').value
    .split(/\n\s*\n/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function updateCounts() {
  const ps = readParagraphs();
  paragraphsNow = ps;
  $('segInfo').textContent = `${ps.length} 段`;
  $('charInfo').textContent = `${ps.reduce((a, s) => a + [...s].length, 0)} 字`;
  $('go').disabled = !imgCanvas || ps.length === 0 || ps.length > MAX_SEG;
  if (ps.length > MAX_SEG) showMsg(`最多 ${MAX_SEG} 段，请把后面的并进上一段。`);
  else if ($('msg').textContent.startsWith('最多')) hideMsg();
}

// ---------------- 图片 ----------------
function fitImage(img) {
  let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const s = Math.min(1, MAXSIDE / Math.max(w, h));
  w = Math.max(8, Math.round(w * s));
  h = Math.max(8, Math.round(h * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = 'high';
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, w, h);
  x.drawImage(img, 0, 0, w, h);
  return c;
}

function useImage(img, url) {
  clearPreview();
  imgCanvas = fitImage(img);
  W = imgCanvas.width; H = imgCanvas.height;
  const thumb = $('thumb');
  thumb.src = url;
  thumb.hidden = false;
  $('dropHint').hidden = true;
  $('empty').hidden = false;
  $('empty').querySelector('.empty-title').textContent = '这边会出现一支手绘讲解视频';
  $('empty').querySelector('.empty-sub').textContent = '写好文案，点“生成预览”';
  hideMsg();
  updateCounts();
  setStatus('图片已就绪。');
}

function loadFile(file) {
  if (!file || !/^image\//.test(file.type)) { showMsg('请选择一张图片。'); return; }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => { useImage(img, url); };
  img.onerror = () => { URL.revokeObjectURL(url); showMsg('这张图打不开，换一张试试。'); };
  img.src = url;
}

async function loadSample(which) {
  const file = which === 'poster' ? 'samples/sample-3.jpg'
    : which === 'photo' ? 'samples/sample-2.jpg'
      : 'samples/sample-1.jpg';
  const text = which === 'poster'
    ? '1927 年，一封航空邮件\n\n红色飞机划过深蓝色的天\n\nfirst to arrive，先到先被看见\n\n用航空邮件，半盎司一角钱'
    : which === 'photo'
      ? '一只猫在舔爪子\n\n它低着头，很专心\n\n照片比插画更难画得像'
      : '一只圆脸小猫\n\n粉色的耳朵和腮红\n\n它正眯着眼睛笑\n\n看起来很开心';
  $('text').value = text;
  updateCounts();
  try {
    const img = new Image();
    img.src = file;
    await img.decode();
    useImage(img, file);
  } catch (e) {
    showMsg('示例图加载失败，请手动选一张图。');
  }
}

// ---------------- 状态 ----------------
function setStatus(text) {
  $('stats').textContent = text;
}

function showEmpty(title, sub) {
  $('empty').hidden = false;
  $('empty').querySelector('.empty-title').textContent = title;
  $('empty').querySelector('.empty-sub').textContent = sub;
}

function clearPreview() {
  stop();
  currentMs = 0;
  $('play').textContent = '播放';
  $('play').disabled = true;
  $('seek').disabled = true;
  $('export').disabled = true;
  $('seek').value = 0;
  $('clock').textContent = '0:00 / 0:00';
  $('scenes').innerHTML = '';
  $('mapInfo').textContent = '生成后显示“第几段对应哪一块”。';
  const c = $('map').getContext('2d');
  c.clearRect(0, 0, 320, 180);
  setStatus('还没有生成。');
  $('modeNote').textContent = '';
}

// ---------------- 生成 ----------------
function newWorker() {
  if (worker) { try { worker.terminate(); } catch (e) { /* ignore */ } }
  worker = new Worker('js/worker.js?v=1');
  worker.onmessage = onWorker;
  worker.onerror = (e) => {
    workerBusy = false;
    $('genStage').hidden = true;
    $('go').disabled = false;
    showMsg('引擎出错：' + (e.message || '未知错误'));
  };
  workerBusy = false;
}

function generate() {
  if (!imgCanvas) { showMsg('先选一张图。'); return; }
  const ps = readParagraphs();
  if (!ps.length) { showMsg('至少写一段文案。'); return; }
  if (ps.length > MAX_SEG) { showMsg(`最多 ${MAX_SEG} 段。`); return; }

  clearPreview();
  hideMsg();
  paragraphsNow = ps;
  pendingParagraphs = ps;
  $('go').disabled = true;
  $('genStage').hidden = false;
  $('genBar').style.width = '0%';
  $('genMsg').textContent = '正在提炼笔触…';
  showEmpty('正在提炼…', '图片只在本机处理，第一次大约 10~40 秒。');

  if (!worker || workerBusy) newWorker();
  workerBusy = true;
  jobNow = ++jobSeq;

  const detail = parseInt($('detail').value, 10);
  const opts = {
    colors: parseInt($('colors').value, 10) || 0,
    style: $('style').value,
    detail,
    targetSec: detail === 0 ? 120 : (detail === 2 ? 480 : 240),
    debug: true,
    dropDead: false,
    returnKeys: false,
  };
  const data = imgCanvas.getContext('2d').getImageData(0, 0, W, H).data;
  const copy = new Uint8ClampedArray(data);
  worker.postMessage({ jobId: jobNow, px: copy.buffer, W, H, opts }, [copy.buffer]);
}

function onWorker(e) {
  const d = e.data || {};
  if (d.jobId !== jobNow) return;
  if (d.type === 'progress') {
    const p = clamp(d.p || 0, 0, 1);
    $('genBar').style.width = (p * 100).toFixed(0) + '%';
    if (d.msg) $('genMsg').textContent = d.msg;
    return;
  }
  workerBusy = false;
  if (d.type === 'error') {
    $('genStage').hidden = true;
    $('go').disabled = false;
    showEmpty('没有生成出来', '换个参数或换张图再试。');
    showMsg('引擎出错：' + d.msg);
    return;
  }
  if (d.type === 'done') {
    try {
      onDone(d.res);
    } catch (err) {
      console.error(err);
      $('genStage').hidden = true;
      $('go').disabled = false;
      showMsg('生成结果处理失败：' + (err.message || err));
    }
  }
}

function onDone(res) {
  strokes = res.strokes;
  clips = res.clips;
  layers = res.layers;
  W = res.W; H = res.H;
  paragraphsNow = pendingParagraphs.length ? pendingParagraphs : readParagraphs();

  plan = planScenes({ W, H, strokes, clips, layers }, { paragraphs: paragraphsNow.length });
  timeline = buildTimeline({ plan, strokes, paragraphs: paragraphsNow, W, H });
  renderer = new StrokeRenderer({ W, H, strokes, clips, order: timeline.order });
  compositor = new Compositor({ W: 1280, H: 720, imageW: W, imageH: H, canvas: $('cv') });
  captions = new CaptionPainter({ family: fontFamily });
  captions.prepare(timeline);

  $('genStage').hidden = true;
  $('go').disabled = false;
  $('empty').hidden = true;
  $('play').disabled = false;
  $('seek').disabled = false;
  $('export').disabled = false;
  currentMs = 0;
  renderAt(0);

  const sec = timeline.totalMs / 1000;
  const where = plan.mode === 'zones'
    ? `${timeline.scenes.length} 个出场区块 · 分区依次出场`
    : `整图播放（字幕按段换）`;
  setStatus(`共 ${strokes.length} 笔 · ${where} · 约 ${sec.toFixed(0)} 秒`);
  $('modeNote').textContent = plan.mode === 'flat'
    ? '这张图的层互相压得太密，分不出干净的区域，已按整图播放（字幕仍按段换）。'
    : (plan.stats.changedUnits ? '为保持遮挡关系，有 ' + plan.stats.changedUnits + ' 个图层并到了相邻区块。' : '');
  if (!fontOk) $('modeNote').textContent += ' 手写字体没加载成功，已回退系统楷体。';

  buildSceneChips();
  drawMap();

  // 自动开播，让人一眼看到“讲到哪画到哪”
  setTimeout(() => { if (!playing) play(); }, 500);
}

// ---------------- 回放 ----------------
function renderAt(ms) {
  if (!timeline || !renderer || !compositor) return;
  currentMs = clamp(ms, 0, timeline.totalMs);
  renderer.seek(timeline, currentMs);
  const cap = captions ? captions.draw(timeline, currentMs) : null;
  compositor.draw({
    painted: renderer.painted,
    partial: renderer.getPartial(),
    captionCanvas: cap,
    tip: renderer.tip,
    showTip: true,
  });
  $('clock').textContent = `${fmt(currentMs / 1000)} / ${fmt(timeline.totalMs / 1000)}`;
  if (document.activeElement !== $('seek')) $('seek').value = String(Math.round(1000 * currentMs / timeline.totalMs));
  let active = -1;
  for (let i = 0; i < timeline.scenes.length; i++) {
    const s = timeline.scenes[i];
    if (currentMs >= s.start - 1 && currentMs <= s.end + 1) { active = i; break; }
  }
  [...$('scenes').children].forEach((b, i) => b.classList.toggle('on', i === active));
}

function play() {
  if (!timeline || exporting) return;
  if (currentMs >= timeline.totalMs - 20) {
    currentMs = 0;
    renderer.reset();
    renderAt(0);
  }
  playing = true;
  $('play').textContent = '暂停';
  lastT = performance.now();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

function stop() {
  playing = false;
  cancelAnimationFrame(raf);
  const b = $('play');
  if (b) b.textContent = currentMs >= (timeline ? timeline.totalMs : 0) - 20 ? '重播' : '播放';
}

function tick(now) {
  if (!playing) return;
  const dt = Math.min(100, now - lastT);
  lastT = now;
  currentMs = Math.min(timeline.totalMs, currentMs + dt);
  renderAt(currentMs);
  if (currentMs >= timeline.totalMs) {
    playing = false;
    $('play').textContent = '重播';
    return;
  }
  raf = requestAnimationFrame(tick);
}

// ---------------- 场景 / 地图 ----------------
const PALETTE = ['#c4553b', '#d99a4e', '#5b8f74', '#6b7fa8', '#a06a9a', '#8a8a4f', '#b06a4a', '#4f8a9a'];

function buildSceneChips() {
  const box = $('scenes');
  box.innerHTML = '';
  timeline.scenes.forEach((s, i) => {
    const b = document.createElement('button');
    const t = s.paragraphs.map((p) => p.text).join(' / ');
    b.textContent = `${i + 1}. ${t.length > 14 ? t.slice(0, 14) + '…' : t}`;
    b.title = `跳到 ${fmt(s.start / 1000)}`;
    b.onclick = () => {
      const was = playing;
      stop();
      currentMs = s.start;
      renderer.reset();
      renderAt(currentMs);
      if (was) { lastT = performance.now(); playing = true; $('play').textContent = '暂停'; raf = requestAnimationFrame(tick); }
    };
    box.appendChild(b);
  });
}

function drawMap() {
  const cv = $('map');
  const ctx = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  const pad = 10;
  const s = Math.min((w - pad * 2) / W, (h - pad * 2) / H);
  const ox = (w - W * s) / 2, oy = (h - H * s) / 2;
  const M = timeline.scenes.length;
  if (plan && plan.mode === 'flat') {
    ctx.fillStyle = '#efe8db';
    ctx.fillRect(ox, oy, W * s, H * s);
    ctx.strokeStyle = '#c9bfae';
    ctx.strokeRect(ox + .5, oy + .5, W * s - 1, H * s - 1);
    ctx.fillStyle = '#6f6759';
    ctx.font = '600 13px -apple-system, "Segoe UI", sans-serif';
    ctx.fillText('整图播放（字幕按段换）', ox + 12, oy + 24);
    $('mapInfo').innerHTML = `<div>这张图分不出干净的区块：整张图连续画完，字幕按段换。</div>` +
      timeline.scenes.map((sc, i) => `<div><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:#c9bfae;margin-right:6px"></span>第 ${i + 1} 段 · ${((sc.end - sc.start) / 1000).toFixed(1)} 秒<br><span style="color:#8f8677">${sc.paragraphs.map((p) => p.text).join(' / ')}</span></div>`).join('');
    return;
  }
  timeline.scenes.forEach((sc, i) => {
    const b = sc.bbox;
    const x0 = clamp(b[0], 0, W), y0 = clamp(b[1], 0, H);
    const x1 = clamp(b[2], 0, W), y1 = clamp(b[3], 0, H);
    ctx.fillStyle = PALETTE[i % PALETTE.length];
    ctx.globalAlpha = 0.16 + 0.5 * (M <= 1 ? 0 : i / (M - 1));
    ctx.fillRect(ox + x0 * s, oy + y0 * s, Math.max(2, (x1 - x0) * s), Math.max(2, (y1 - y0) * s));
    ctx.globalAlpha = 1;
    ctx.strokeStyle = PALETTE[i % PALETTE.length];
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + x0 * s + .5, oy + y0 * s + .5, Math.max(1, (x1 - x0) * s - 1), Math.max(1, (y1 - y0) * s - 1));
    ctx.fillStyle = '#2c2b28';
    ctx.font = '600 11px -apple-system, "Segoe UI", sans-serif';
    ctx.fillText(String(i + 1), ox + x0 * s + 6, oy + y0 * s + 15);
  });

  const info = timeline.scenes.map((sc, i) => {
    const texts = sc.paragraphs.map((p) => p.text).join(' / ');
    return `<div><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${PALETTE[i % PALETTE.length]};margin-right:6px"></span>第 ${i + 1} 块 · ${sc.strokeCount} 笔 · ${((sc.end - sc.start) / 1000).toFixed(1)} 秒<br><span style="color:#8f8677">${texts || '（无字幕）'}</span></div>`;
  }).join('');
  $('mapInfo').innerHTML = info;
}

// ---------------- 导出 ----------------
async function doExport() {
  if (!timeline || exporting) return;
  stop();
  exporting = true;
  abortCtl = new AbortController();
  $('export').disabled = true;
  $('go').disabled = true;
  $('expStage').hidden = false;
  $('expBar').style.width = '0%';
  $('expMsg').textContent = '准备录制…';
  const startMs = currentMs;
  try {
    const blob = await exportVideo({
      compositor, renderer, captions, timeline,
      signal: abortCtl.signal,
      onProgress: (p, sim, total) => {
        $('expBar').style.width = (p * 100).toFixed(1) + '%';
        $('expMsg').textContent = `正在录：${(sim / 1000).toFixed(0)} / ${(total / 1000).toFixed(0)} 秒（请保持这个标签页在前台）`;
      },
    });
    const name = `inkbrief-${paragraphsNow.length}段-${stamp()}.webm`;
    download(blob, name);
    $('expBar').style.width = '100%';
    $('expMsg').textContent = `完成，已开始下载：${name}`;
    showMsg('导出完成。', true);
  } catch (err) {
    if (String(err.message || err).includes('取消')) {
      $('expMsg').textContent = '已取消。';
    } else {
      console.warn('导出失败：', err);
      $('expMsg').textContent = '导出失败：' + (err.message || err);
      showMsg('导出失败：' + (err.message || err));
    }
  } finally {
    exporting = false;
    abortCtl = null;
    $('export').disabled = false;
    $('go').disabled = false;
    currentMs = clamp(startMs, 0, timeline.totalMs);
    renderer.reset();
    renderAt(currentMs);
  }
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

// ---------------- 字体 ----------------
async function loadFont() {
  try {
    if (!document.fonts) return false;
    const p = document.fonts.load('46px "MaShanZheng"', '汉字abc');
    const ok = await Promise.race([
      p.then((list) => list && list.length > 0),
      new Promise((r) => setTimeout(() => r(false), 2500)),
    ]);
    if (ok && document.fonts.check('46px "MaShanZheng"')) return true;
  } catch (e) { /* ignore */ }
  return false;
}

// ---------------- 绑定 ----------------
function bind() {
  $('file').addEventListener('change', (e) => loadFile(e.target.files && e.target.files[0]));
  const drop = $('drop');
  drop.addEventListener('click', () => $('file').click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') $('file').click(); });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  document.querySelectorAll('[data-sample]').forEach((b) => {
    b.addEventListener('click', () => loadSample(b.getAttribute('data-sample')));
  });

  $('text').addEventListener('input', updateCounts);
  $('go').addEventListener('click', generate);
  $('play').addEventListener('click', () => { if (playing) stop(); else play(); });
  $('seek').addEventListener('input', (e) => {
    if (!timeline) return;
    const ms = (parseInt(e.target.value, 10) / 1000) * timeline.totalMs;
    currentMs = ms;
    if (playing) lastT = performance.now();
    renderAt(ms);
  });
  $('export').addEventListener('click', doExport);
  $('cancelExp').addEventListener('click', () => { if (abortCtl) abortCtl.abort(); });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
      e.preventDefault();
      if (playing) stop(); else play();
    }
  });
}

async function init() {
  bind();
  updateCounts();
  clearPreview();
  showEmpty('这边会出现一支手绘讲解视频', '左边选图、写文案，点“生成预览”');
  fontOk = await loadFont();
  fontFamily = fontOk
    ? '"MaShanZheng", "KaiTi", "STKaiti", "楷体", serif'
    : '"KaiTi", "STKaiti", "楷体", serif';
  if (!fontOk) console.warn('Ma Shan Zheng 未加载，已回退系统楷体');
  if (new URLSearchParams(location.search).has('debug')) {
    window.__ink = {
      get playing() { return playing; },
      get ms() { return currentMs; },
      get total() { return timeline ? timeline.totalMs : 0; },
    };
    // 终检：用"场景序"和"原序"各画一遍最终帧，逐像素比较
    window.__inkVerify = () => {
      if (!renderer || !strokes) return null;
      const n = strokes.length;
      const mk = (order) => {
        const r = new StrokeRenderer({ W, H, strokes, clips, order });
        for (let i = 0; i < n; i++) r.paint(i, 1);
        return r;
      };
      const a = mk(timeline.order);
      const b = mk(Int32Array.from({ length: n }, (_, i) => i));
      const da = a.pctx.getImageData(0, 0, W, H).data;
      const db = b.pctx.getImageData(0, 0, W, H).data;
      let ch = 0, max = 0, px = 0;
      for (let i = 0; i < da.length; i += 4) {
        let hit = false;
        for (let k = 0; k < 3; k++) {
          const d = Math.abs(da[i + k] - db[i + k]);
          if (d) { ch++; hit = true; if (d > max) max = d; }
        }
        if (hit) px++;
      }
      return { strokeCount: n, diffChannels: ch, diffPixels: px, max };
    };
  }
}

init();
