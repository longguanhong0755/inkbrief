// 时间轴：把「一段（或多段）文案 + 一张（或多张）图」排成一屏，按配音或手动时长铺开。
// 纯函数，方便离线断言（dev/timeline_check.mjs）。
//
// 时长规则（需求文档 §5.5.1）：
//   可用绘制时间 = 单屏时长 − 0.3s
//   每笔时长     = 可用绘制时间 / 该屏笔数
//   若每笔 < 0.3ms → 自动抽稀到「可用绘制时间 / 0.3ms」
//   要点：时长由文案与配音决定，绘制服从时长。绝不允许笔数把这一屏撑长。
//
// 时长优先级：手动 > 配音 > 按字数估。
// 需求文档原文写的是「时长由文字决定」，但那是在「不做 TTS」的前提下写的
// （文档 §2.2 明确说不做配音）。本产品保留配音且导出带音轨，
// 若按字数定时长，配音会被强行压成非自然语速。听感优先，取配音的自然时长。

export const TL = {
  tailMs: 300,        // 一屏末尾留给观众看的静止时间（§5.5.1：可用绘制时间 = 时长 − 0.3s）
  minDrawMs: 200,     // 再短的屏也留一点作画时间
  minStrokeMs: 0.3,   // 单笔最少分到的时间（§5.5.1：每笔 < 0.3ms 才抽稀）
  minSceneMs: 1200,   // 一屏下限（§5.5.1）
  minCaptionMs: 1500, // 单段字幕下限（§5.5.1）
  charMs: 220,        // 字速 0.22s/字 ≈ 4.5 字/秒（§5.5.1）
  gapMs: 0,           // 屏与屏之间的黑场（0 = 硬切）
  softTotalMs: 60000, // 总时长超过 60s 只提示，不阻止
};

/** 没有配音时按字数估时长 */
export function estimateDurationMs(text) {
  const t = (text || '').trim();
  if (!t) return TL.minCaptionMs;
  const han = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
  const other = Math.max(0, t.replace(/\s/g, '').length - han);
  // 中文 0.22s/字，英文数字按 0.6 倍音节速度折算；单段下限 1.5s
  return Math.max(TL.minCaptionMs, Math.round(han * TL.charMs + other * TL.charMs * 0.6));
}

/** 一屏的字幕总时长：多段时求和 */
export function captionDurationMs(paragraphs) {
  const list = (paragraphs && paragraphs.length ? paragraphs : ['']).filter((s) => s !== null && s !== undefined);
  if (!list.length) return TL.minCaptionMs;
  return list.reduce((a, s) => a + estimateDurationMs(s), 0);
}

/**
 * 一屏的实际时长：手动 > 配音 > 字幕估。
 * 手动值就是最终值，配音通过变速适配（不截断）。
 */
export function resolveSceneMs(seg) {
  const manual = Number(seg.manualMs);
  if (manual > 0) return Math.max(TL.minSceneMs, Math.round(manual));
  const audio = Number(seg.audioMs);
  if (audio > 0) return Math.max(TL.minSceneMs, Math.round(audio));
  return Math.max(TL.minSceneMs, captionDurationMs(seg.paragraphs || [seg.text]));
}

/** 配音相对最终时长的速率：>1 说明配音要加速（画面比声音长则 <1 减速） */
export function resolveSpeed(seg) {
  const audio = Number(seg.audioMs) || 0;
  const final = resolveSceneMs(seg);
  if (!audio || !final) return 1;
  return Math.min(2.5, Math.max(0.5, audio / final));
}

/**
 * 一屏用到的图（多图时按出场顺序）。
 * 契约：seg.imageIds: string[]、seg.weights: number[]（与 imageIds 等长）。
 * 兼容旧的 assetIds / assetId 单值写法。
 */
function segImageIds(seg) {
  if (Array.isArray(seg.imageIds) && seg.imageIds.length) return seg.imageIds.filter(Boolean);
  if (Array.isArray(seg.assetIds) && seg.assetIds.length) return seg.assetIds.filter(Boolean);
  if (seg.assetId) return [seg.assetId];
  return [];
}

/** 一屏用到的图的停留权重（默认全 1） */
function segWeights(seg, n) {
  if (Array.isArray(seg.weights) && seg.weights.length === n) {
    return seg.weights.map((w) => Math.max(0.05, Number(w) || 1));
  }
  return new Array(n).fill(1);
}

/** 一屏的文案分段（多字幕时按顺序） */
function segParagraphs(seg) {
  if (Array.isArray(seg.paragraphs) && seg.paragraphs.length) {
    const list = seg.paragraphs.filter((s) => s !== null && s !== undefined && String(s).trim() !== '');
    if (list.length) return list.map(String);
  }
  return [seg.text || ''];
}

/**
 * 字幕分段点：把一屏的时长按各段字数比例切开。
 * @param {string[]} paragraphs
 * @param {number} durMs 这一屏的总时长
 * @returns {Array<{text:string,start:number,dur:number,index:number}>}
 */
export function chunkSpans(paragraphs, durMs) {
  const list = (paragraphs || []).map(String);
  if (!list.length) return [];
  const total = Math.max(1, durMs);
  const weights = list.map((s) => Math.max(1, s.replace(/\s/g, '').length));
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = [];
  let t = 0;
  for (let i = 0; i < list.length; i++) {
    const d = i === list.length - 1 ? total - t : Math.round((total * weights[i]) / sum);
    out.push({ text: list[i], start: t, dur: d, index: i });
    t += d;
  }
  return out;
}

/**
 * 排一屏。
 * @param {Array} segs 每项 {
 *   id, text, paragraphs?, assetIds?, assetId?, weights?, mode?,
 *   hasImage, audioMs, manualMs, strokeCount, strokeCounts?, capPos?
 * }
 * @returns {{totalMs:number, scenes:Array, dropped:number, notes:string[], warnings:string[]}}
 */
export function buildTimeline(segs, opts = {}) {
  const O = { ...TL, ...opts };
  const notes = [];
  const warnings = [];
  const scenes = [];
  let t = 0;
  let droppedTotal = 0;

  for (const seg of segs) {
    const imageIds = segImageIds(seg);
    if (!seg.hasImage || !imageIds.length) continue;

    const paragraphs = segParagraphs(seg);
    const dur = resolveSceneMs(seg);

    // 可用绘制时间 = 时长 − 0.3s（§5.5.1）
    let drawMs = Math.max(O.minDrawMs, dur - O.tailMs);
    drawMs = Math.min(drawMs, dur);

    // 多图：按权重切分绘制时间（硬切，需求文档 §12）
    const weights = segWeights(seg, imageIds.length);
    const wSum = weights.reduce((a, b) => a + b, 0);

    // 每张图的笔数：单图时用 strokeCount，多图时优先用 strokeCounts
    const perAssetStrokes = (Array.isArray(seg.strokeCounts) && seg.strokeCounts.length === imageIds.length)
      ? seg.strokeCounts.map((n) => Number(n) || 0)
      : (imageIds.length === 1 ? [Number(seg.strokeCount) || 0] : imageIds.map(() => 0));

    const items = [];
    let acc = 0;
    let sceneStrokeCount = 0;
    let sceneKeep = 0;

    for (let i = 0; i < imageIds.length; i++) {
      const share = drawMs * (weights[i] / wSum);
      const slice = i === imageIds.length - 1 ? drawMs - acc : Math.round(share);
      const n = perAssetStrokes[i] || 0;
      // 每笔分到多少时间：这一片时长 / 该片的笔数
      const capacity = Math.max(1, Math.floor(slice / O.minStrokeMs));
      const keep = Math.min(n, capacity);
      if (n > capacity) {
        droppedTotal += n - keep;
        notes.push(`「${(paragraphs[0] || '').slice(0, 10)}」第 ${i + 1} 张图笔数 ${n} 超过 ${slice | 0}ms 能画的上限，抽稀到 ${keep}`);
      }
      items.push({
        assetId: imageIds[i],
        index: i,
        start: acc,          // 相对本屏绘制起点
        dur: slice,
        weight: weights[i],
        strokeCount: n,
        keep,
        keepRatio: n ? keep / n : 1,
        perStrokeMs: keep ? slice / keep : 0,
      });
      sceneStrokeCount += n;
      sceneKeep += keep;
      acc += slice;
    }

    const capSpans = chunkSpans(paragraphs, dur);

    scenes.push({
      id: seg.id,
      index: scenes.length,
      start: t,
      dur,
      speed: resolveSpeed(seg),
      drawMs,
      strokeCount: sceneStrokeCount,
      keep: sceneKeep,
      keepRatio: sceneStrokeCount ? sceneKeep / sceneStrokeCount : 1,
      perStrokeMs: sceneKeep ? drawMs / sceneKeep : 0,
      // 多图
      assetId: imageIds[0],
      imageIds,
      items,
      // 字幕
      text: paragraphs.join(''),
      paragraphs,
      capSpans,
      capPos: seg.capPos || 'bottom',
      mode: seg.mode || (imageIds.length > 1 ? 'multiImage' : (paragraphs.length > 1 ? 'multiCaption' : 'single')),
      warnings: [],
    });
    t += dur + O.gapMs;
  }

  const totalMs = Math.max(0, t - (scenes.length ? O.gapMs : 0));
  if (totalMs > O.softTotalMs) {
    warnings.push(`总时长 ${(totalMs / 1000).toFixed(1)}s，短视频平台建议控制在 60s 以内`);
  }
  return { totalMs, scenes, dropped: droppedTotal, notes, warnings };
}

/**
 * 某一时刻该画哪一张图、画到第几笔。
 * 多图时一屏内硬切：每张图有自己的时间片。
 * @returns {{item:object, local:number, progress:number}|null}
 */
export function itemAt(scene, local) {
  const items = scene.items || [];
  if (!items.length) return null;
  if (items.length === 1) {
    const p = drawProgress(scene, local);
    return { item: items[0], local, progress: p };
  }
  // 多图：local 落在哪一片
  const draw = Math.max(0, Math.min(local, scene.drawMs));
  let cur = items[0];
  for (const it of items) {
    if (draw >= it.start) cur = it; else break;
  }
  const p = cur.dur > 0 ? Math.max(0, Math.min(1, (draw - cur.start) / cur.dur)) : 0;
  return { item: cur, local: draw - cur.start, progress: p };
}

/**
 * 某一时刻该显示哪句字幕。
 * @returns {{text:string, index:number, start:number, dur:number}|null}
 */
export function captionAt(scene, local) {
  const spans = scene.capSpans || [];
  if (!spans.length) return null;
  if (spans.length === 1) return spans[0];
  let cur = spans[0];
  for (const s of spans) {
    if (local >= s.start) cur = s; else break;
  }
  return cur;
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

/**
 * 时间轴块的布局：块宽正比于时长。
 * @param {Array} scenes
 * @param {object} o {width, totalMs, minWidth, gap}
 * @returns {{blocks:Array, contentWidth:number, scale:number}}
 */
export function layoutTrack(scenes, o = {}) {
  const list = scenes || [];
  const width = Math.max(0, Number(o.width) || 0);
  const gap = o.gap === undefined ? 4 : Number(o.gap) || 0;
  const minWidth = o.minWidth === undefined ? 40 : Number(o.minWidth) || 0;
  const totalMs = Math.max(1, Number(o.totalMs) || list.reduce((a, s) => a + s.dur, 0) || 1);

  const blocks = [];
  let x = 0;
  for (const sc of list) {
    const w = Math.max(minWidth, (sc.dur / totalMs) * width);
    blocks.push({ id: sc.id, index: sc.index, x, w, dur: sc.dur, start: sc.start });
    x += w + gap;
  }
  const contentWidth = Math.max(0, x - (list.length ? gap : 0));
  return { blocks, contentWidth, scale: width / totalMs };
}

/**
 * 在时间轴上把某个时刻映射到像素位置（用于画播放头）。
 */
export function timeToX(track, ms) {
  const t = Math.max(0, Number(ms) || 0);
  for (const b of track.blocks) {
    if (t >= b.start && t <= b.start + b.dur) {
      return b.x + (b.dur ? ((t - b.start) / b.dur) * b.w : 0);
    }
  }
  const last = track.blocks[track.blocks.length - 1];
  if (!last) return 0;
  return t < track.blocks[0].start ? track.blocks[0].x : last.x + last.w;
}
