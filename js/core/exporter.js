// 导出 WebM：录制合成画布，墙钟驱动，时长 = 时间轴总长。
// 慢机只掉帧、不拉长；后台标签页自动暂停/恢复。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((resolve) => {
  let done = false;
  const f = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(f);
  setTimeout(f, 120);
});

export function pickMime() {
  const list = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return list.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

export async function exportVideo({ compositor, renderer, captions, timeline, onProgress, signal, bitrate = 6000000 }) {
  if (!window.MediaRecorder || !compositor.cv.captureStream) {
    throw new Error('这个浏览器不支持录制 WebM，请换 Chrome / Edge。');
  }
  const stream = compositor.cv.captureStream(30);
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: bitrate } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((resolve) => { rec.onstop = resolve; });

  renderer.reset();
  let hiddenMs = 0, pausedAt = 0;
  const onVis = () => {
    if (document.hidden) {
      pausedAt = performance.now();
      try { if (rec.state === 'recording') rec.pause(); } catch (e) { /* ignore */ }
    } else {
      if (pausedAt) { hiddenMs += performance.now() - pausedAt; pausedAt = 0; }
      try { if (rec.state === 'paused') rec.resume(); } catch (e) { /* ignore */ }
    }
  };
  document.addEventListener('visibilitychange', onVis);

  const drawAt = (simT) => {
    renderer.seek(timeline, simT);
    const cap = captions.draw(timeline, simT);
    compositor.draw({
      painted: renderer.painted,
      partial: renderer.getPartial(),
      captionCanvas: cap,
      tip: renderer.tip,
      showTip: false,
    });
  };

  let started = false;
  try {
    // 先把第 0 帧画好，避免录制开头多出一段空白
    drawAt(0);
    rec.start();
    started = true;
    const t0 = performance.now();
    let simT = 0;
    while (simT < timeline.totalMs) {
      if (signal && signal.aborted) throw new Error('已取消导出');
      if (document.hidden) { await sleep(80); continue; }
      const now = performance.now() - t0 - hiddenMs;
      simT = Math.min(timeline.totalMs, Math.max(0, now));
      drawAt(simT);
      if (onProgress) onProgress(simT / Math.max(1, timeline.totalMs), simT, timeline.totalMs);
      await nextFrame();
    }
    drawAt(timeline.totalMs);
    if (onProgress) onProgress(1, timeline.totalMs, timeline.totalMs);
    await sleep(260);
    rec.stop();
    await stopped;
  } catch (err) {
    if (started) {
      try { if (rec.state !== 'inactive') rec.stop(); } catch (e) { /* ignore */ }
      await stopped.catch(() => {});
    }
    throw err;
  } finally {
    document.removeEventListener('visibilitychange', onVis);
  }
  return new Blob(chunks, { type: mime || 'video/webm' });
}
