// 浏览器内 TTS：onnxruntime-web + Piper 中文模型（fp16）+ 离线音素表。
// 全部本地推理，文字与音频都不出浏览器。
import { createSequencer } from './phonemize.js';

const DEFAULTS = {
  sampleRate: 22050,
  model: 'assets/tts/zh-huayan-fp16.onnx',
  // 模型解压后的真实字节数。GitHub Pages 等 CDN 会对 .onnx 做 gzip，
  // 此时 content-length 是压缩后大小（约 9.0MB），而 reader 读到的是解压后的
  // 字节（10.13MB），直接拿 content-length 当总量会让进度冲到 113%。
  modelBytes: 10617727,
  phonemes: 'assets/tts/zh-phonemes.json',
  wasmPath: 'js/vendor/ort/',
};

// 语音预设：同一个说话人模型，通过 VITS 的三参数改变听感
export const VOICES = [
  {
    id: 'wenrou',
    name: '温柔女声',
    desc: '语速偏慢、起伏柔和',
    scales: { noiseScale: 0.42, lengthScale: 1.12, noiseW: 0.55 },
  },
  {
    id: 'liluo',
    name: '利落女声',
    desc: '语速偏快、起伏明显',
    scales: { noiseScale: 0.88, lengthScale: 0.94, noiseW: 0.95 },
  },
];

async function fetchWithProgress(url, onProgress, expectedBytes = 0) {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`下载失败 ${res.status} ${url}`);
  const headerLen = Number(res.headers.get('content-length')) || 0;
  const encoding = (res.headers.get('content-encoding') || 'identity').toLowerCase();
  // 响应被压缩时 content-length 与解压后的字节数不是一回事，改用已知的真实大小
  const compressed = encoding !== 'identity' && encoding !== '';
  let total = compressed ? (expectedBytes || 0) : (headerLen || expectedBytes || 0);
  if (!res.body || !total) {
    const buf = await res.arrayBuffer();
    onProgress?.(buf.byteLength, buf.byteLength);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    // 兜底：总量估小时不让进度倒退或越过 100%
    if (got > total) total = got;
    onProgress?.(got, total);
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out.buffer;
}

export class TTSEngine {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.session = null;
    this.seq = null;
    this.loading = null;
    this.lastWarmMs = 0;
  }

  get ready() { return !!this.session; }

  async load(onProgress) {
    if (this.session) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const ort = globalThis.ort;
      if (!ort) throw new Error('onnxruntime 未加载');
      // wasmPaths 必须是绝对 URL：ort 内部用 import() 动态加载 .mjs，相对路径无法解析
      const base = this.opts.wasmPath.endsWith('/') ? this.opts.wasmPath : this.opts.wasmPath + '/';
      ort.env.wasm.wasmPaths = new URL(base, document.baseURI).href;
      ort.env.wasm.numThreads = 1;
      ort.env.logLevel = 'error';

      onProgress?.({ phase: 'phonemes', ratio: 0.02, text: '读取音素表' });
      const table = await (await fetch(this.opts.phonemes)).json();
      const pinyinFn = globalThis.pinyinPro?.pinyin;
      if (!pinyinFn) throw new Error('拼音库未加载');
      this.seq = createSequencer(table, pinyinFn);

      // 模型是下载大头，给出真实字节进度（占 0.1 ~ 0.9）
      onProgress?.({ phase: 'model', ratio: 0.06, text: '下载语音模型' });
      const buf = await fetchWithProgress(this.opts.model, (got, total) => {
        const frac = Math.min(1, got / total);
        onProgress?.({
          phase: 'model',
          ratio: 0.06 + 0.84 * frac,
          text: `下载语音模型 ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`,
        });
      }, this.opts.modelBytes);

      onProgress?.({ phase: 'init', ratio: 0.93, text: '初始化推理引擎' });
      this.session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });

      onProgress?.({ phase: 'warm', ratio: 0.97, text: '预热' });
      const t0 = performance.now();
      try { await this.synth('你好'); } catch { /* 预热失败不影响后续 */ }
      this.lastWarmMs = performance.now() - t0;
      onProgress?.({ phase: 'done', ratio: 1, text: '就绪' });
    })().catch((err) => {
      this.loading = null;
      throw err;
    });
    return this.loading;
  }

  /** 合成一句话，返回 { pcm, sampleRate, ms } */
  async synth(text, voiceOrScales) {
    if (!this.session) throw new Error('语音引擎未就绪');
    const ids = this.seq(text);
    if (ids.length <= 2) return { pcm: new Float32Array(0), sampleRate: this.opts.sampleRate, ms: 0 };

    const s = voiceOrScales?.scales || voiceOrScales || VOICES[0].scales;
    const ort = globalThis.ort;
    const T = ids.length;
    const input = new ort.Tensor('int64', BigInt64Array.from(ids.map((v) => BigInt(v))), [1, T]);
    const lens = new ort.Tensor('int64', BigInt64Array.from([BigInt(T)]), [1]);
    const scales = new ort.Tensor('float32', Float32Array.from([
      s.noiseScale ?? 0.667, s.lengthScale ?? 1.0, s.noiseW ?? 0.8,
    ]), [3]);

    const t0 = performance.now();
    const out = await this.session.run({ input, input_lengths: lens, scales });
    const ms = performance.now() - t0;
    const data = out[this.session.outputNames[0]].data;
    return { pcm: data instanceof Float32Array ? data : Float32Array.from(data), sampleRate: this.opts.sampleRate, ms };
  }
}

/** 把 TTS 估算进时长模型：返回朗读这句话大致需要多少毫秒 */
export function estimateSpeechMs(text) {
  const han = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const other = Math.max(0, text.length - han);
  return Math.max(900, han * 250 + other * 120);
}
