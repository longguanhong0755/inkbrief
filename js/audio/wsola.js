// WSOLA 变速不变调。
// rate > 1 加快（输出更短），rate < 1 放慢（输出更长），音高不变。
// 无依赖、纯 Float32Array，可在主线程或 Worker 里跑。

const FRAME_MS = 46;

function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/**
 * @param {Float32Array} input 单声道 PCM，取值 -1..1
 * @param {number} rate 时长倍率：输出时长 ≈ 输入时长 / rate
 * @param {number} sr 采样率（默认与 TTS 模型一致：16000）
 * @returns {Float32Array}
 */
export function timeStretch(input, rate, sr = 16000) {
  const len = input.length;
  if (!len) return new Float32Array(0);
  if (!isFinite(rate) || rate <= 0) rate = 1;
  if (Math.abs(rate - 1) < 0.005) return input.slice();

  let N = Math.round((FRAME_MS / 1000) * sr);
  if (N % 2) N += 1;
  if (len < N * 2) {
    // 太短：直接线性重采样（音高会略变，但短音无从处理）
    const outLen = Math.max(1, Math.round(len / rate));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const p = i * rate;
      const i0 = Math.floor(p), f = p - i0;
      out[i] = (input[i0] || 0) * (1 - f) + (input[Math.min(i0 + 1, len - 1)] || 0) * f;
    }
    return out;
  }

  const Hs = N >> 1;                 // 合成步进（50% 重叠）
  const Ha = Hs / rate;              // 分析步进
  const win = hann(N);
  const outLen = Math.max(N, Math.round(len / rate));
  const acc = new Float32Array(outLen + N);
  const norm = new Float32Array(outLen + N);
  const tol = Math.round(N / 4);
  const prevEnd0 = -1;

  let prevEnd = prevEnd0;
  let inPos = 0;

  for (let outPos = 0; outPos + N <= outLen + Hs; outPos += Hs) {
    const base = Math.round(inPos);
    let best = Math.max(0, Math.min(base, len - N));

    if (prevEnd >= 0 && prevEnd + N <= len) {
      // 在 base 附近找与「上一帧的自然延续」最相似的起点，保证相位连续
      let bestScore = -Infinity;
      for (let d = -tol; d <= tol; d += 2) {
        const cand = base + d;
        if (cand < 0 || cand + N > len) continue;
        let s = 0;
        for (let i = 0; i < N; i += 4) s += input[prevEnd + i] * input[cand + i];
        if (s > bestScore) { bestScore = s; best = cand; }
      }
    }

    for (let i = 0; i < N; i++) {
      const v = input[best + i] * win[i];
      acc[outPos + i] += v;
      norm[outPos + i] += win[i];
    }
    prevEnd = best + Hs;
    inPos += Ha;
  }

  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const w = norm[i];
    out[i] = w > 1e-4 ? acc[i] / w : (acc[i] || 0);
  }
  return out;
}

/** 线性重采样到目标采样率（用于把 16000 的 TTS 输出送到 48000 的混音图） */
export function resample(input, from, to) {
  if (from === to) return input.slice();
  const ratio = to / from;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLen);
  const last = input.length - 1;
  for (let i = 0; i < outLen; i++) {
    const p = i / ratio;
    const i0 = Math.floor(p);
    const f = p - i0;
    const a = input[i0] ?? 0;
    const b = input[Math.min(i0 + 1, last)] ?? a;
    out[i] = a + (b - a) * f;
  }
  return out;
}

/** 峰值归一化到目标电平，避免不同句子音量忽大忽小 */
export function normalize(input, target = 0.9) {
  let peak = 0;
  for (let i = 0; i < input.length; i++) {
    const a = Math.abs(input[i]);
    if (a > peak) peak = a;
  }
  if (peak < 1e-5) return input;
  const g = target / peak;
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i] * g;
  return out;
}

/** 句首句尾加淡入淡出，去掉合成边界的咔哒声 */
export function fadeEdges(input, sr, ms = 12) {
  const n = Math.min(Math.round((ms / 1000) * sr), Math.floor(input.length / 2));
  if (n < 2) return input;
  const out = input.slice();
  for (let i = 0; i < n; i++) {
    const g = i / n;
    out[i] *= g;
    out[out.length - 1 - i] *= g;
  }
  return out;
}
