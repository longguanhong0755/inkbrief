// WSOLA 变速不变调的自检：输出长度、音高保持、能量连续性。
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../js/audio/wsola.js', import.meta.url), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { timeStretch } = mod;

const SR = 22050;

function tone(freq, sec, sr = SR, amp = 0.5) {
  const n = Math.round(sec * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

// 自相关估基频（取中段，避免边界）
function f0(x, sr = SR) {
  const mid = Math.floor(x.length / 2);
  const seg = x.slice(mid - 2048, mid + 2048);
  let mean = 0;
  for (const v of seg) mean += v;
  mean /= seg.length;
  const z = seg.map((v) => v - mean);
  const lo = Math.floor(sr / 500), hi = Math.floor(sr / 60);
  let best = -1, bestLag = 0;
  for (let lag = lo; lag <= hi; lag++) {
    let s = 0;
    for (let i = 0; i + lag < z.length; i++) s += z[i] * z[i + lag];
    s /= (z.length - lag);
    if (s > best) { best = s; bestLag = lag; }
  }
  return bestLag ? sr / bestLag : 0;
}

const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / Math.max(1, x.length));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); }
};

console.log('=== 时长与音高 ===');
for (const rate of [0.75, 1.0, 1.25, 1.5, 2.0]) {
  const input = tone(440, 1.2);
  const out = timeStretch(input, rate, SR);
  const want = input.length / rate;
  const err = Math.abs(out.length - want) / want;
  const pitch = f0(out);
  const pitchErr = Math.abs(pitch - 440) / 440;
  ok(`rate=${rate} 时长`, err < 0.03, `期望 ${(want / SR).toFixed(3)}s 实际 ${(out.length / SR).toFixed(3)}s 误差 ${(err * 100).toFixed(1)}%`);
  ok(`rate=${rate} 音高`, pitchErr < 0.06, `输出 ${pitch.toFixed(0)}Hz（输入 440）`);
  ok(`rate=${rate} 能量`, rms(out) > 0.2 && rms(out) < 0.6, `RMS ${rms(out).toFixed(3)}`);
}

console.log('\n=== 边界 ===');
ok('rate=1 原样返回', timeStretch(tone(440, 0.5), 1.0, SR).length === tone(440, 0.5).length);
ok('空输入', timeStretch(new Float32Array(0), 1.5, SR).length === 0);
const shortIn = tone(300, 0.05);   // 短于两帧，走重采样分支
const shortOut = timeStretch(shortIn, 1.5, SR);
ok('超短输入不崩', shortOut.length > 0 && shortOut.every((v) => isFinite(v)), `${shortOut.length} 样本`);
const tiny = timeStretch(new Float32Array([0.1, -0.1, 0.2]), 1.5, SR);
ok('3 样本输入', tiny.length > 0 && tiny.every((v) => isFinite(v)));
ok('非法 rate 归 1', timeStretch(tone(440, 0.3), 0, SR).length === tone(440, 0.3).length);
ok('NaN rate 归 1', timeStretch(tone(440, 0.3), NaN, SR).length === tone(440, 0.3).length);

console.log('\n=== 无 NaN / 削波 ===');
for (const rate of [0.5, 0.75, 1.5, 2.5]) {
  const out = timeStretch(tone(220, 0.8), rate, SR);
  let bad = 0, peak = 0;
  for (const v of out) { if (!isFinite(v)) bad++; if (Math.abs(v) > peak) peak = Math.abs(v); }
  ok(`rate=${rate} 数值健康`, bad === 0 && peak <= 0.62, `坏值 ${bad} 峰值 ${peak.toFixed(3)}`);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
