// 时间轴断言：单调、时长、字幕窗口、frameAt。
import { pipelineFor } from './lib/pipeline-cache.mjs';
import { planScenes } from '../js/core/scene-planner.js';
import { buildTimeline, frameAt } from '../js/core/timeline.js';

const PARAS = {
  illustration: ['一只圆脸小猫', '粉色的耳朵和腮红', '它正眯着眼睛笑', '看起来很开心'],
  poster: ['1927 年，一封航空邮件', '红色飞机划过深蓝色的天', 'first to arrive，先到先被看见', '用航空邮件，半盎司一角钱'],
  photo: ['一只猫在舔爪子', '它低着头，很专心', '照片比插画更难画得像'],
};
const ALL = ['illustration', 'poster', 'photo'];
const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith('-'));
let bad = 0;

for (const name of (only ? [only] : ALL)) {
  const file = name.endsWith('.raw') ? name : `dev/fixtures/${name}.raw`;
  const base = name.replace(/\.raw$/, '');
  const { res } = await pipelineFor(file);
  const paras = PARAS[base] || PARAS.illustration;
  const plan = planScenes(res, { paragraphs: paras.length, maxScenes: 8 });
  const tl = buildTimeline({ plan, strokes: res.strokes, paragraphs: paras, W: res.W, H: res.H });
  const n = res.strokes.length;
  const err = [];
  if (tl.order.length !== n) err.push('order 长度');
  if (new Set(tl.order).size !== n) err.push('order 不是排列');
  if (!(tl.totalMs > 0)) err.push('totalMs<=0');
  if (tl.totalMs > 150000 + 1) err.push('totalMs>150s');
  let from = 0;
  for (let i = 0; i < tl.scenes.length; i++) {
    const s = tl.scenes[i];
    if (s.strokeFrom !== from) err.push(`景${i} strokeFrom ${s.strokeFrom}!=${from}`);
    if (s.strokeTo < s.strokeFrom) err.push(`景${i} strokeTo<from`);
    if (!(s.end > s.start)) err.push(`景${i} end<=start`);
    if (i && s.start < tl.scenes[i - 1].end - 1e-6) err.push(`景${i} 起点倒退`);
    if (s.textStart < s.start - 1e-6 || s.textEnd > s.end + 1e-6) err.push(`景${i} 字幕越出场景`);
    for (const p of s.paragraphs) {
      if (p.start < s.start - 1e-6 || p.end > s.end + 1e-6) err.push(`景${i} 段落越界`);
      if (p.end <= p.start) err.push(`景${i} 段落时长为 0`);
    }
    from = s.strokeTo;
  }
  if (from !== n) err.push(`最后一景到 ${from}，应为 ${n}`);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(tl.t0[i]) || !Number.isFinite(tl.t1[i])) { err.push('时间 NaN'); break; }
    if (tl.t1[i] < tl.t0[i]) { err.push('t1<t0'); break; }
    if (i && tl.t0[i] < tl.t1[i - 1] - 1e-6) { err.push('笔序时间倒退'); break; }
    if (tl.msPaint[i] < 2.99 || tl.msPaint[i] > 400.01) { err.push(`msPaint 越界 ${tl.msPaint[i]}`); break; }
    if (tl.travels[i] < -1e-9) { err.push('travels<0'); break; }
  }
  for (const t of [0, tl.totalMs / 2, tl.totalMs]) {
    const f = frameAt(tl, t);
    if (!(f.done >= 0 && f.done <= n)) err.push('frameAt.done 越界');
    if (f.cur < -1 || f.cur > n) err.push('frameAt.cur 越界');
    if (!(f.u >= 0 && f.u <= 1)) err.push('frameAt.u 越界');
  }
  console.log(`${base}: mode=${plan.mode} 景=${tl.scenes.length} 总=${(tl.totalMs / 1000).toFixed(1)}s 笔=${n}${tl.limitHit ? ' (触发150s压缩)' : ''}`);
  for (const s of tl.scenes) console.log(`  景${s.index} ${(s.start / 1000).toFixed(1)}~${(s.end / 1000).toFixed(1)}s 笔${s.strokeCount} 字幕${s.paragraphs.length}段`);
  if (err.length) { console.log('  FAIL: ' + err.slice(0, 6).join('；')); bad++; }
}
process.exit(bad ? 1 : 0);
