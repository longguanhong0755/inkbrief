// 混音：把每段配音按屏起点拼成一条单声道音轨（48kHz）。
import { timeStretch, resample, normalize, fadeEdges } from './wsola.js';

export const MIX_SR = 48000;

/**
 * @param {Array} scenes timeline.scenes
 * @param {(id:string)=>object} segOf
 * @param {boolean} withAudio 是否有任何配音
 * @returns {{pcm:Float32Array, sampleRate:number, duration:number, hasAudio:boolean}}
 */
export function buildSoundtrack(scenes, segOf, { sampleRate = MIX_SR, tailMs = 0 } = {}) {
  let end = 0;
  let hasAudio = false;
  const warnings = [];
  for (const sc of scenes) end = Math.max(end, sc.start + sc.dur);
  const total = Math.max(1, Math.ceil(((end + tailMs) / 1000) * sampleRate));
  const buf = new Float32Array(total);

  for (const sc of scenes) {
    const seg = segOf(sc.id);
    const a = seg && seg.audio;
    if (!a || !a.pcm || !a.pcm.length) continue;
    hasAudio = true;

    let pcm = a.pcm;
    const speed = Number(sc.speed) || 1;
    if (Math.abs(speed - 1) > 0.004) {
      try { pcm = timeStretch(pcm, speed, a.sr || 16000); } catch { /* 保持原样 */ }
    }
    pcm = fadeEdges(pcm, a.sr || 16000, 10);
    pcm = resample(pcm, a.sr || 16000, sampleRate);
    pcm = normalize(pcm, 0.86);

    const start = Math.round((sc.start / 1000) * sampleRate);
    const room = total - start;
    if (room <= 0) {
      // 这一屏已经超出总长（正常不该发生），跳过而不是往回写
      warnings.push(`第 ${sc.index + 1} 屏没有剩余空间，配音被跳过`);
      continue;
    }
    if (pcm.length > room) {
      // 配音比这一屏长：不能静默切掉半句话。淡出收尾并报出来。
      const cutMs = Math.round(((pcm.length - room) / sampleRate) * 1000);
      warnings.push(`第 ${sc.index + 1} 屏的配音比画面长 ${cutMs}ms，结尾被淡出`);
      const out = pcm.slice(0, room);
      const fadeN = Math.min(room, Math.round(0.02 * sampleRate));
      for (let i = 0; i < fadeN; i++) {
        out[room - 1 - i] *= i / fadeN;
      }
      pcm = out;
    }
    for (let i = 0; i < pcm.length; i++) buf[start + i] += pcm[i];
  }

  // 软限幅，避免叠加削波
  let peak = 0;
  for (let i = 0; i < total; i++) { const v = Math.abs(buf[i]); if (v > peak) peak = v; }
  if (peak > 0.98) {
    const g = 0.98 / peak;
    for (let i = 0; i < total; i++) buf[i] *= g;
  }

  return { pcm: buf, sampleRate, duration: total / sampleRate, hasAudio, warnings };
}

/** 包成 AudioBuffer（导出与播放共用） */
export function toAudioBuffer(audioCtx, mix) {
  const ab = audioCtx.createBuffer(1, mix.pcm.length, mix.sampleRate);
  ab.copyToChannel(mix.pcm, 0);
  return ab;
}
