// 导出：canvas 画面 + 混音音轨 -> MP4（不支持时退回 WebM）。
// MediaRecorder 墙钟录制，音画由同一个 AudioContext 时钟驱动；慢机只掉帧、不拉长。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((resolve) => {
  let done = false;
  const f = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(f);
  setTimeout(f, 120);   // 后台标签页 rAF 会停，用定时器兜底
});

export function pickMime() {
  const cands = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of cands) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch { /* ignore */ }
  }
  return '';
}

/**
 * @param {object} o
 * @param {HTMLCanvasElement} o.canvas
 * @param {AudioBuffer} o.audio 完整混音
 * @param {number} o.totalMs
 * @param {(ms:number)=>void} o.renderAt
 * @param {(p:{ratio:number,ms:number})=>void} [o.onProgress]
 * @param {{aborted:boolean}} [o.signal]
 */
export async function exportVideo(o) {
  const mime = pickMime();
  if (!mime) throw new Error('当前浏览器不支持录制视频');

  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC({ sampleRate: 48000 });
  if (ctx.state === 'suspended') await ctx.resume();

  const dest = ctx.createMediaStreamDestination();
  const src = ctx.createBufferSource();
  src.buffer = o.audio;
  src.connect(dest);

  const vStream = o.canvas.captureStream(30);
  const tracks = [...vStream.getVideoTracks(), ...dest.stream.getAudioTracks()];
  const stream = new MediaStream(tracks);

  const rec = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: 12_000_000,
    audioBitsPerSecond: 128_000,
  });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((res) => { rec.onstop = () => res(); });

  let started = false;
  const t0 = performance.now();

  // 先画第一帧再开录，避免开头空白
  o.renderAt(0);
  await nextFrame();

  try {
    rec.start(200);
    started = true;

    const audioStart = ctx.currentTime + 0.05;
    src.start(audioStart);

    for (;;) {
      if (o.signal?.aborted) throw new Error('已取消');
      const ms = Math.max(0, (ctx.currentTime - audioStart) * 1000);
      o.renderAt(Math.min(ms, o.totalMs));
      o.onProgress?.({ ratio: Math.min(1, ms / o.totalMs), ms });
      if (ms >= o.totalMs) break;
      await nextFrame();
    }

    o.renderAt(o.totalMs);
    await sleep(320);
    rec.stop();
    await stopped;
  } catch (err) {
    if (started) {
      try { if (rec.state !== 'inactive') rec.stop(); } catch { /* ignore */ }
      await stopped.catch(() => {});
    }
    throw err;
  } finally {
    try { src.stop(); } catch { /* ignore */ }
    for (const t of tracks) { try { t.stop(); } catch { /* ignore */ } }
    try { await ctx.close(); } catch { /* ignore */ }
  }

  const blob = new Blob(chunks, { type: mime.split(';')[0] });
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  return { blob, mime, ext, ms: performance.now() - t0, audioMs: o.audio.duration * 1000 };
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // 立即移除会让部分浏览器中断下载，留一段时间再清理
  setTimeout(() => {
    try { a.remove(); } catch { /* ignore */ }
    URL.revokeObjectURL(url);
  }, 120_000);
}
