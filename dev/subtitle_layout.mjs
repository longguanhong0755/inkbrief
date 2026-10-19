// 字幕排版纯函数测试：换行、字号、标点、溢出、空串、英文。
import { layoutText, wrapText, syntheticMeasure, CAPTION_BOX, HEAD_PUNCT } from '../js/core/subtitle.js';

let bad = 0;
function ok(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) bad++;
}
const M = (ch, size) => syntheticMeasure(ch, size);
const maxW = CAPTION_BOX.w;

const a = layoutText('一只圆脸小猫', maxW, M);
ok('短句 46px 一行', a.size === 46 && a.lines.length === 1, `size=${a.size} lines=${a.lines.length}`);
ok('短句块高不超', a.totalH <= CAPTION_BOX.h, String(a.totalH));

const long = '这是一段用来测试自动换行和字号回退的比较长的中文文案'.repeat(2);
const b = layoutText(long, maxW, M);
ok('长句能放下', b.lines.length <= 3 && b.totalH <= CAPTION_BOX.h, `size=${b.size} lines=${b.lines.length} h=${b.totalH}`);
for (const line of b.lines) {
  ok('行宽不超上限', line.width <= maxW * 1.16 + 0.01, line.width.toFixed(1));
  ok('行首不是标点', !HEAD_PUNCT.includes([...line.text][0]), line.text.slice(0, 6));
}

const huge = '很长的文案'.repeat(100);
const c = layoutText(huge, maxW, M);
ok('超长文案标记溢出', c.overflow === true, `size=${c.size} lines=${c.lines.length}`);
ok('超长文案最后一行省略号', c.lines[c.lines.length - 1].text.endsWith('…'));
ok('超长文案块高不超', c.totalH <= CAPTION_BOX.h, String(c.totalH));

const en = 'The quick brown fox jumps over the lazy dog. '.repeat(8);
const d = layoutText(en, maxW, M);
ok('英文能换行', d.lines.length >= 2, `size=${d.size} lines=${d.lines.length}`);
ok('英文行宽不超', d.lines.every((l) => l.width <= maxW * 1.16 + 0.01));

const punct = '测试，'.repeat(80);
const e = layoutText(punct, maxW, M);
ok('标点不落行首', e.lines.every((l) => !HEAD_PUNCT.includes([...l.text][0])));

const empty = layoutText('', maxW, M);
ok('空串不崩', empty.lines.length === 1 && empty.lines[0].text === '');

const forced = layoutText('第一行\n第二行', maxW, M);
ok('强制换行生效', forced.lines.length >= 2, `lines=${forced.lines.length}`);

const wrap = wrapText('abc def ghi', 1000, (ch) => M(ch, 46));
ok('wrap 保留文本', wrap.join('') === 'abc def ghi', wrap.join('|'));

// 每个字的位置都在安全区内
for (const line of b.lines) for (const ch of line.chars) {
  if (ch.x < CAPTION_BOX.x - 1 || ch.x + ch.w > CAPTION_BOX.x + CAPTION_BOX.w + 1) {
    ok('字位置越界', false, `${ch.ch}@${ch.x.toFixed(0)}`);
    break;
  }
}
process.exit(bad ? 1 : 0);
