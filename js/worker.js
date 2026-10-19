/* image2strokes 引擎跑在 Worker 里；主线程只负责 UI、场景规划和渲染 */
importScripts('vendor/pipeline.js?v=1');

self.onmessage = async function (e) {
  const d = e.data || {};
  const jobId = d.jobId;
  try {
    const px = new Uint8ClampedArray(d.px);
    const res = await self.ISP_PIPELINE.run(px, d.W, d.H, d.opts || {}, function (p, msg) {
      self.postMessage({ type: 'progress', jobId, p, msg });
    });
    const out = {
      W: res.W, H: res.H,
      strokes: res.strokes,
      clips: res.clips,
      stats: res.stats,
      layers: (res.dbg && res.dbg.layers) || null,
    };
    const transfer = [];
    const seen = new Set();
    for (const c of res.clips) {
      const b = c.mask && c.mask.buffer;
      if (b && !seen.has(b)) { seen.add(b); transfer.push(b); }
    }
    self.postMessage({ type: 'done', jobId, res: out }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', jobId, msg: (err && err.stack) || String(err) });
  }
};
