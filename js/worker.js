/* 笔触引擎来自独立的 image2strokes 项目（本仓库不存副本）。
 *
 * 依赖只有一个配置文件：js/engine-config.js。通道：
 *   pinned（生产默认）—— 锁定已验证的 commit，上游更新不会把线上带崩；
 *   dev / latest      —— 优先用同源兄弟目录里的最新 image2strokes（本地开发默认）。
 * 页面 URL 的 ?engine= 会透传到 Worker，可临时切换。
 *
 * 稳定性约定（见 image2strokes/js/engine.js）：
 *   ISP_PIPELINE.api 是整数契约版本；不匹配就换下一个候选，最后退到 pinned。
 */
importScripts('engine-config.js?v=11');

const CFG = self.INK_ENGINE;
const ENGINE_API = CFG.api;

const params = new URL(self.location.href).searchParams;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const channel = params.get('engine') || (LOCAL_HOSTS.has(self.location.hostname) ? 'dev' : 'pinned');

function entryCandidate(base) {
  // 配置里的基址可能是相对的（本地兄弟目录），先按 Worker 的位置解析成绝对 URL
  const abs = new URL(base, self.location.href).href;
  return {
    kind: 'entry',
    base: abs,
    url: new URL(`engine.js?v=${CFG.entryVersion}`, abs).href,
  };
}

const pinned = { kind: 'pipeline', url: CFG.pinUrl, pinned: true };
const entries = CFG.bases.map(entryCandidate);
// pinned 通道先锁版本；dev/latest 先吃最新代码；两边互为兜底
const ordered = channel === 'pinned' ? [pinned, ...entries] : [...entries, pinned];
const seen = new Set();
const candidates = ordered.filter((c) => !seen.has(c.url) && seen.add(c.url));

let engineInfo = null;
let engineError = null;

function acceptEngine(c) {
  const P = self.ISP_PIPELINE;
  if (!P || typeof P.run !== 'function') throw new Error('没有导出 run()');
  // 老版本 pipeline 没有 api 字段，按 api 1 处理（v20 就是这样）
  if (P.api != null && P.api !== ENGINE_API) {
    throw new Error(`引擎 API ${P.api} 与本项目要求的 ${ENGINE_API} 不兼容`);
  }
  return {
    api: P.api == null ? ENGINE_API : P.api,
    version: P.version || 'legacy',
    url: c.url,
    pinned: !!c.pinned,
    channel,
  };
}

for (const c of candidates) {
  try {
    if (c.kind === 'entry') {
      // engine.js 里的相对路径按 Worker 的目录解析，必须显式告诉它 js/ 在哪
      self.ISP_ENGINE_BASE = c.base;
    }
    importScripts(c.url);
    engineInfo = acceptEngine(c);
    engineError = null;
    break;
  } catch (err) {
    engineError = err;
  }
}

if (engineInfo) {
  self.postMessage({ type: 'ready', ...engineInfo });
} else {
  self.postMessage({
    type: 'error',
    fatal: true,
    msg: '笔触引擎加载失败（image2strokes 不可用）：' + ((engineError && (engineError.message || engineError)) || '未知错误'),
  });
}

self.onmessage = async function (e) {
  const d = e.data || {};
  const jobId = d.jobId;
  if (!engineInfo) {
    self.postMessage({ type: 'error', jobId, msg: '笔触引擎未就绪：' + ((engineError && engineError.message) || '未知错误') });
    return;
  }
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
    const seenBuffers = new Set();
    for (const c of res.clips) {
      const b = c.mask && c.mask.buffer;
      if (b && !seenBuffers.has(b)) { seenBuffers.add(b); transfer.push(b); }
    }
    self.postMessage({ type: 'done', jobId, res: out }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', jobId, msg: (err && err.stack) || String(err) });
  }
};
