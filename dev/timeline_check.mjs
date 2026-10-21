// 时间轴与字幕排布的纯函数断言（Node 直接跑，不需要浏览器）。
// 覆盖需求文档 §5.5.1 的时长规则、§4.2 的数据模型、§12 的多图硬切。
import {
  TL, estimateDurationMs, captionDurationMs, resolveSceneMs, resolveSpeed,
  chunkSpans, buildTimeline, sceneAt, drawProgress, itemAt, captionAt,
  layoutTrack, timeToX,
} from '../js/core/timeline.js';
import { computeLayout } from '../js/core/compositor.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); }
};
const T = (label) => console.log(`\n── ${label} ──`);

// 造一段（与 main.js 的 makeSeg 同构）
function seg(init = {}) {
  return {
    id: init.id || 's1',
    text: init.text || '',
    paragraphs: init.paragraphs || [init.text || ''],
    mode: init.mode || 'single',
    capPos: init.capPos || 'bottom',
    imageIds: init.imageIds || ['a1'],
    weights: init.weights || (init.imageIds || ['a1']).map(() => 1),
    hasImage: init.hasImage !== false,
    audioMs: init.audioMs || 0,
    manualMs: init.manualMs ?? null,
    strokeCount: init.strokeCount || 0,
    strokeCounts: init.strokeCounts || null,
  };
}

T('§5.5.1 时长规则');
ok('尾留 0.3s', TL.tailMs === 300);
ok('单笔最少 0.3ms', TL.minStrokeMs === 0.3);
ok('一屏下限 1.2s', TL.minSceneMs === 1200);
ok('单段字幕下限 1.5s', TL.minCaptionMs === 1500);
ok('字速 0.22s/字', TL.charMs === 220);

const est = estimateDurationMs('今天聊三件小事。');
// 7 个汉字 × 220ms + 1 个标点 × 0.6 倍 = 1672ms
ok('按字数估时长：7 汉字 + 1 标点 → 1672ms', est === 1672, `${est}ms`);
ok('空文本落到 1.5s 下限', estimateDurationMs('') === 1500);
ok('单字也走 1.5s 下限', estimateDurationMs('嗨') === 1500);
ok('英文按 0.6 倍折算', estimateDurationMs('abcdefghijklmnopqrst') === Math.round(20 * 220 * 0.6),
  `${estimateDurationMs('abcdefghijklmnopqrst')}ms`);

T('时长优先级：手动 > 配音 > 按字数');
ok('手动时长优先', resolveSceneMs(seg({ manualMs: 5000, audioMs: 3000 })) === 5000);
ok('其次是配音时长', resolveSceneMs(seg({ audioMs: 3000 })) === 3000);
ok('最后才按字数估', resolveSceneMs(seg({ text: '今天聊三件小事。' })) === 1672);
ok('手动时长也守 1.2s 下限', resolveSceneMs(seg({ manualMs: 100 })) === 1200);
// speed = 配音时长 / 最终时长：>1 表示配音要加速去迁就画面
ok('配音比画面长 → 加速 2×', resolveSpeed(seg({ audioMs: 4000, manualMs: 2000 })) === 2);
ok('画面比配音长 → 减速 0.5×', resolveSpeed(seg({ audioMs: 2000, manualMs: 4000 })) === 0.5);

T('字幕分句');
const spans = chunkSpans(['第一句六个字。', '第二句更长一些。'], 4000);
ok('分成 2 条', spans.length === 2);
ok('首条从 0 开始', spans[0].start === 0);
ok('时间窗首尾相接', spans[0].start + spans[0].dur === spans[1].start, `${spans[0].dur}+${spans[1].dur}`);
ok('总时长守恒', spans[spans.length - 1].start + spans[spans.length - 1].dur === 4000);
ok('按字数比例切', spans[0].dur !== spans[1].dur);
ok('单条时整段都是它', chunkSpans(['只有一句'], 2500).length === 1);
ok('空数组不炸', chunkSpans([], 1000).length === 0);
ok('多段字幕时长求和', captionDurationMs(['第一句六个字。', '第二句更长一些。'])
  === estimateDurationMs('第一句六个字。') + estimateDurationMs('第二句更长一些。'));

T('一屏多图：按权重硬切');
const multi = buildTimeline([
  seg({
    id: 'm1', text: '两图一屏。', paragraphs: ['两图一屏。'],
    imageIds: ['a1', 'a2'], weights: [3, 1], strokeCounts: [600, 400],
  }),
]);
const sc = multi.scenes[0];
ok('生成 1 屏', multi.scenes.length === 1);
ok('有 2 个图片分片', sc.items.length === 2);
ok('权重 3:1 → 分片时长 3:1', Math.abs(sc.items[0].dur / sc.items[1].dur - 3) < 0.05,
  `${sc.items[0].dur}ms / ${sc.items[1].dur}ms`);
ok('分片起点连续', sc.items[1].start === sc.items[0].dur);
ok('分片时长之和 = 可绘制时间', sc.items[0].dur + sc.items[1].dur === sc.drawMs);
ok('画面上只暴露首图作为兼容字段', sc.assetId === 'a1');

T('§5.5.1 绘制时间 = 时长 − 0.3s');
const one = buildTimeline([seg({ id: 'o1', text: '一段话。', strokeCount: 100 })]);
ok('drawMs = dur − 300', one.scenes[0].drawMs === one.scenes[0].dur - 300,
  `${one.scenes[0].drawMs} / ${one.scenes[0].dur}`);
ok('每笔分到的时间够 0.3ms', one.scenes[0].perStrokeMs >= 0.3 || one.scenes[0].keep < one.scenes[0].strokeCount,
  `${one.scenes[0].perStrokeMs.toFixed(2)}ms/笔`);

T('笔数超上限要抽稀并记账');
const heavy = buildTimeline([seg({ id: 'h1', text: '短句。', strokeCount: 100000 })]);
ok('抽稀后 keep < 原笔数', heavy.scenes[0].keep < heavy.scenes[0].strokeCount,
  `${heavy.scenes[0].keep} / ${heavy.scenes[0].strokeCount}`);
ok('记了 note', heavy.notes.length > 0, heavy.notes[0]);
ok('dropped 统计了丢掉的笔', heavy.dropped > 0, `${heavy.dropped}`);

T('分片定位：某一时刻该画哪一张');
const at0 = itemAt(sc, 0);
const at1 = itemAt(sc, sc.items[0].dur + 10);
ok('开头是第一张', at0.item.index === 0);
ok('过了第一片切到第二张', at1.item.index === 1);
ok('片内进度从 0 开始', at1.progress >= 0 && at1.progress <= 1);
ok('单图时进度 = 屏内进度', itemAt(one.scenes[0], one.scenes[0].drawMs / 2).progress > 0.4);

T('字幕定位：某一时刻该显示哪句');
const cap = buildTimeline([seg({ id: 'c1', paragraphs: ['第一句六个字。', '第二句更长一些。'], text: '第一句六个字。\n第二句更长一些。' })]);
ok('第一句在 0 时刻', captionAt(cap.scenes[0], 0).index === 0);
ok('过半后切到第二句', captionAt(cap.scenes[0], cap.scenes[0].dur * 0.8).index === 1);
ok('单句时索引恒为 0', captionAt(one.scenes[0], 100).index === 0);

T('时间轴块：宽度正比于时长');
const two = buildTimeline([
  seg({ id: 'b1', text: '一。', manualMs: 2000 }),
  seg({ id: 'b2', text: '二。', manualMs: 6000 }),
]);
const track = layoutTrack(two.scenes, { width: 800, totalMs: two.totalMs, minWidth: 20, gap: 4 });
ok('块数 = 屏数', track.blocks.length === two.scenes.length);
ok('块按顺序排开', track.blocks[0].x === 0);
ok('第二块起点 = 第一块宽 + 间隙', track.blocks[1].x === track.blocks[0].w + 4);
ok('宽 ∝ 时长：3 倍时长 = 3 倍宽',
  Math.abs(track.blocks[1].w / track.blocks[0].w - 3) < 0.01,
  `${track.blocks[0].w.toFixed(0)} / ${track.blocks[1].w.toFixed(0)}`);
ok('总宽不超容器（不含间隙）', track.contentWidth - 4 * (track.blocks.length - 1) <= 800 + 0.5,
  `${track.contentWidth.toFixed(0)}`);
ok('时间→像素可反查', Math.abs(timeToX(track, 0) - track.blocks[0].x) < 0.01);
ok('末尾时间映射到末尾', Math.abs(timeToX(track, two.totalMs) - (track.blocks[1].x + track.blocks[1].w)) < 0.01);
ok('段中点映射到块内', timeToX(track, 1000) > track.blocks[0].x && timeToX(track, 1000) < track.blocks[1].x);

T('字幕位置三档');
const lb = computeLayout(1920, 1080, { capPos: 'bottom' });
const ll = computeLayout(1920, 1080, { capPos: 'lower' });
const lu = computeLayout(1920, 1080, { capPos: 'upper' });
ok('贴底：字幕在画面下沿', lb.cap.y > 1080 * 0.75, `${lb.cap.y}`);
ok('抬高：字幕比贴底高', ll.cap.y < lb.cap.y);
ok('置顶：字幕在画面上部', lu.cap.y < 1080 * 0.15, `${lu.cap.y}`);
ok('置顶时画面区下移', lu.area.y > lb.area.y);
ok('两参调用仍返回贴底', computeLayout(1920, 1080).capPos === 'bottom');

T('软上限只警告不阻断');
const long = buildTimeline([
  seg({ id: 'l1', text: '短。', manualMs: 40000 }),
  seg({ id: 'l2', text: '短。', manualMs: 40000 }),
]);
ok('超 60s 仍生成 2 屏', long.scenes.length === 2);
ok('给了警告', long.warnings.length > 0, long.warnings[0]);

T('没图的段不进时间轴');
const noimg = buildTimeline([seg({ id: 'n1', hasImage: false, imageIds: [] })]);
ok('空时间轴', noimg.scenes.length === 0);
ok('总长 0', noimg.totalMs === 0);

T('定位：sceneAt 与 drawProgress');
const t2 = buildTimeline([
  seg({ id: 'x1', text: '一。', manualMs: 2000 }),
  seg({ id: 'x2', text: '二。', manualMs: 3000 }),
]);
ok('起点落在第一屏', sceneAt(t2, 0).scene.id === 'x1');
ok('中点落在第二屏', sceneAt(t2, 2500).scene.id === 'x2');
ok('屏内进度正确', Math.abs(sceneAt(t2, 3000).local - 1000) < 1);
ok('超界时夹到最后', sceneAt(t2, 99999).local === 3000);
ok('绘制进度封顶 1', drawProgress(t2.scenes[0], 99999) === 1);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
