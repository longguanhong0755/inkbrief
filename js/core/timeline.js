// 时间轴：把「一段文案 + 一张图」排成一屏，按配音或手动时长铺开。
// 纯函数，方便离线断言（dev/timeline_check.mjs）。

export const TL = {
  tailMs: 260,        // 一屏末尾留给观众看的静止时间
  drawRatio: 0.86,    // 最多用这一屏的多少比例时间作画
  minDrawMs: 900,     // 再短的屏也要给画笔这么久
  minStrokeMs: 0.28,  // 单笔最少分到的时间（实测：插画 0.15ms/笔，照片 0.35~0.7ms/笔）
  minSceneMs: 1000,   // 一屏下限
  gapMs: 0,           // 屏与屏之间的黑场（0 = 硬切）
};

/** 没有配音时按字数估时长 */
export function estimateDurationMs(text) {
  const t = (text || '').trim();
  if (!t) return TL.minSceneMs;
  const han = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
  const other = Math.max(0, t.replace(/\s/g, '').length - han);
  // 中文 0.24s/字，英文数字按 0.6 倍音节速度折算
  return Math.max(TL.minSceneMs, Math.round(han * 240 + other * 150 + 240));
}

/**
 * 一屏的实际时长：手动 > 配音 > 估读。
 * 手动值就是最终值，配音通过变速适配（不截断）。
 */
export function resolveSceneMs(seg) {
  const manual = Number(seg.manualMs);
  if (manual > 0) return Math.max(TL.minSceneMs, Math.round(manual));
  const audio = Number(seg.audioMs);
  if (audio > 0) return Math.max(TL.minSceneMs, Math.round(audio));
  return estimateDurationMs(seg.text);
}

/** 配音相对最终时长的速率：>1 说明配音要加速（画面比声音长则 <1 减速） */
export function resolveSpeed(seg) {
  const audio = Number(seg.audioMs) || 0;
  const final = resolveSceneMs(seg);
  if (!audio || !final) return 1;
  return Math.min(2.5, Math.max(0.5, audio / final));
}

/**
 * @param {Array} segs 每项 { id, text, hasImage, audioMs, manualMs, strokeCount }
 * @returns {{totalMs:number, scenes:Array, dropped:number, notes:string[]}}
 */
export function buildTimeline(segs, opts = {}) {
  const O = { ...TL, ...opts };
  const notes = [];
  const scenes = [];
  let t = 0;
  let droppedTotal = 0;

  for (const seg of segs) {
    if (!seg.hasImage) continue;
    const dur = resolveSceneMs(seg);
    let drawMs = Math.min(dur * O.drawRatio, Math.max(dur - O.tailMs, O.minDrawMs));
    drawMs = Math.max(O.minDrawMs, Math.min(drawMs, dur));
    if (drawMs >= dur) drawMs = Math.max(200, dur - 120);

    const n = Math.max(0, seg.strokeCount | 0);
    let keep = n;
    const capacity = Math.max(1, Math.floor(drawMs / O.minStrokeMs));
    if (n > capacity) {
      keep = capacity;
      droppedTotal += n - keep;
      notes.push(`「${(seg.text || '').slice(0, 10)}」笔数 ${n} 超过 ${drawMs | 0}ms 能画的上限，抽稀到 ${keep}`);
    }

    scenes.push({
      id: seg.id,
      index: scenes.length,
      start: t,
      dur,
      speed: resolveSpeed(seg),
      drawMs,
      strokeCount: n,
      keep,
      keepRatio: n ? keep / n : 1,
      perStrokeMs: keep ? drawMs / keep : 0,
    });
    t += dur + O.gapMs;
  }

  return { totalMs: Math.max(0, t - (scenes.length ? O.gapMs : 0)), scenes, dropped: droppedTotal, notes };
}

/** 二分：t 时刻落在哪一屏、屏内进度 */
export function sceneAt(timeline, t) {
  const { scenes } = timeline;
  if (!scenes.length) return null;
  if (t <= scenes[0].start) return { scene: scenes[0], local: 0 };
  const last = scenes[scenes.length - 1];
  if (t >= last.start + last.dur) return { scene: last, local: last.dur, ended: true };
  let lo = 0, hi = scenes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (scenes[mid].start <= t) lo = mid; else hi = mid - 1;
  }
  const sc = scenes[lo];
  return { scene: sc, local: t - sc.start };
}

/** 屏内绘画进度 0..1（超过 drawMs 就停在 1） */
export function drawProgress(scene, local) {
  if (!scene.drawMs) return 1;
  return Math.min(1, Math.max(0, local / scene.drawMs));
}
