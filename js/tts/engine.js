// 浏览器内 TTS：onnxruntime-web + Piper 中文模型（fp16）+ 离线音素表。
// 全部本地推理，文字与音频都不出浏览器。
import { createSequencer } from './phonemize.js';

const DEFAULTS = {
  // 必须与模型 config 里的 audio.sample_rate 一致（assets/tts/zh-huayan.json = 16000）。
  // 写成 22050 会让配音快 1.38 倍、音高高 5.5 个半音，听着像花栗鼠。
  sampleRate: 16000,
  model: 'assets/tts/zh-huayan-fp16.onnx',
  // 模型解压后的真实字节数。GitHub Pages 等 CDN 会对 .onnx 做 gzip，
  // 此时 content-length 是压缩后大小（约 9.0MB），而 reader 读到的是解压后的
  // 字节（10.13MB），直接拿 content-length 当总量会让进度冲到 113%。
  modelBytes: 10617727,
  phonemes: 'assets/tts/zh-phonemes.json',
  wasmPath: 'js/vendor/ort/',
};

// ort 的 wasm 构建，同样按字节数分片下载
const WASM_FILE = 'ort-wasm-simd-threaded.wasm';
const WASM_BYTES = 11246032;

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

async function fetchWhole(url, onProgress, expectedBytes = 0) {
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

// ── 分片下载 ───────────────────────────────────────────────
// 国内直连 GitHub Pages 拉 10MB 模型，长连接经常下到一半被重置
// （ERR_CONNECTION_RESET，实测 200 秒的连接必断）。切成 1MB 小片各自请求，
// 单片失败只重试那一片，一次断线不会把整个下载作废。
const CHUNK_BYTES = 1 << 20;
const CHUNK_WORKERS = 3;
const CHUNK_RETRIES = 3;
const MODEL_CACHE = 'inkbrief-tts-model-v1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchChunk(url, start, end) {
  const res = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
    cache: 'no-store',
  });
  if (res.status !== 206) throw new Error(`分片状态 ${res.status}`);
  const ab = await res.arrayBuffer();
  // CDN 偶尔回短包，长度不符必须重试，不能当成功
  if (ab.byteLength !== end - start + 1) {
    throw new Error(`分片长度 ${ab.byteLength}/${end - start + 1}`);
  }
  return new Uint8Array(ab);
}

async function fetchSharded(url, total, onProgress) {
  const out = new Uint8Array(total);
  const ranges = [];
  for (let s = 0; s < total; s += CHUNK_BYTES) ranges.push([s, Math.min(s + CHUNK_BYTES, total) - 1]);
  let cursor = 0;
  let got = 0;

  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= ranges.length) return;
      const [s, e] = ranges[i];
      let err = null;
      for (let attempt = 0; attempt <= CHUNK_RETRIES; attempt++) {
        try {
          out.set(await fetchChunk(url, s, e), s);
          got += e - s + 1;
          onProgress?.(got, total);
          err = null;
          break;
        } catch (e2) {
          err = e2;
          if (attempt < CHUNK_RETRIES) await sleep(400 * 2 ** attempt);
        }
      }
      if (err) throw err;
    }
  };

  await Promise.all(Array.from({ length: Math.min(CHUNK_WORKERS, ranges.length) }, worker));
  return out.buffer;
}

async function loadModel(url, total, onProgress) {
  // 第二次打开直接读缓存，不用再走一遍慢网络
  try {
    const cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(url);
    if (hit) {
      const ab = await hit.arrayBuffer();
      if (!total || ab.byteLength === total) {
        onProgress?.(ab.byteLength, ab.byteLength);
        return ab;
      }
    }
  } catch { /* 无 Cache Storage（如隐私模式）就退化成每次都走网络 */ }

  // 先探一字节判断服务端支不支持 Range
  let sharded = false;
  if (total) {
    try {
      const probe = await fetch(url, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
      sharded = probe.status === 206;
      await probe.arrayBuffer().catch(() => {});
    } catch { sharded = false; }
  }

  const buf = sharded ? await fetchSharded(url, total, onProgress) : await fetchWhole(url, onProgress, total);

  try {
    const cache = await caches.open(MODEL_CACHE);
    await cache.put(url, new Response(buf.slice(0), {
      headers: { 'content-type': 'application/octet-stream' },
    }));
  } catch { /* 存不下不影响本次使用 */ }

  return buf;
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
      const wasmBase = new URL(base, document.baseURI).href;
      ort.env.wasm.wasmPaths = wasmBase;
      ort.env.wasm.numThreads = 1;
      ort.env.logLevel = 'error';

      onProgress?.({ phase: 'phonemes', ratio: 0.02, text: '读取音素表' });
      const table = await (await fetch(this.opts.phonemes)).json();
      const pinyinFn = globalThis.pinyinPro?.pinyin;
      if (!pinyinFn) throw new Error('拼音库未加载');
      this.seq = createSequencer(table, pinyinFn);

      // 模型 10.1MB + wasm 10.7MB，两个一起下。
      // wasm 交给 ort 自己拉同样会被长连接掐断，所以先自己分片下好，
      // 再用 blob URL 顶替，ort 就不会再去下载那 10MB 了。
      const totalLoad = this.opts.modelBytes + WASM_BYTES;
      let gotModel = 0;
      let gotWasm = 0;
      const report = () => {
        const got = gotModel + gotWasm;
        const mb = (n) => (n / 1048576).toFixed(1);
        onProgress?.({
          phase: 'engine',
          ratio: 0.06 + 0.84 * Math.min(1, got / totalLoad),
          text: `下载语音引擎 ${mb(got)} / ${mb(totalLoad)} MB`,
        });
      };
      onProgress?.({ phase: 'engine', ratio: 0.06, text: '下载语音引擎' });

      const [buf, wasmBuf] = await Promise.all([
        loadModel(this.opts.model, this.opts.modelBytes, (g) => { gotModel = g; report(); }),
        loadModel(new URL(WASM_FILE, wasmBase).href, WASM_BYTES, (g) => { gotWasm = g; report(); }),
      ]);
      ort.env.wasm.wasmPaths = {
        mjs: new URL('ort-wasm-simd-threaded.mjs', wasmBase).href,
        wasm: URL.createObjectURL(new Blob([wasmBuf], { type: 'application/wasm' })),
      };

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

// 字体等其它大文件也复用同一套分片下载 + 缓存
export { loadModel };
