// TTS 音素化单元测试（纯逻辑，不加载模型）。
// 覆盖两类曾经的 bug：
//   1. 全角标点被转半角后查表 miss → 逗号问号全丢，整段没有句读
//   2. 采样率写错 → 配音快 1.38 倍、音高高 5.5 个半音
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSequencer } from '../js/tts/phonemize.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rawTable = JSON.parse(fs.readFileSync(path.join(HERE, '../assets/tts/zh-phonemes.json'), 'utf8'));

// 真实表里标点 id（4~13）与音节 id 域重叠，没法靠数值判断"这个 id 是不是标点"。
// 测试专用的表：把标点 id 挪到高位唯一值，计数才准确。
let maxSyl = 0;
for (const v of Object.values(rawTable.syl)) for (const id of v) if (id > maxSyl) maxSyl = id;
const table = {
  ...rawTable,
  punct: Object.fromEntries(
    Object.entries(rawTable.punct).map(([k, v], i) => [k, maxSyl + 10 + i]),
  ),
};

// pinyin-pro 是浏览器全局量，测试里用简易替身：只按字取声调，不判多音字
const fakePinyin = (chunk) => {
  const out = [];
  for (const ch of chunk) {
    if (/[\u4e00-\u9fa5]/.test(ch)) {
      // 固定用一声，够测「标点有没有进序列」
      const code = ch.codePointAt(0);
      out.push('shu' + ((code % 4) + 1));
    } else if (/[a-zA-Z]/.test(ch)) out.push(ch.toLowerCase());
    else if (/[0-9]/.test(ch)) out.push(ch);
  }
  return out;
};

const seq = createSequencer(table, fakePinyin);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); }
};
const T = (label) => console.log(`\n── ${label} ──`);

// 序列里某个标点出现了几次
const countPunct = (ids, ch) => ids.filter((v) => v === table.punct[ch]).length;

T('全角标点必须进音素序列');
{
  const ids = seq('今天很好。天气不错，你好吗？');
  ok('句号进序列', countPunct(ids, '。') === 1, `出现 ${countPunct(ids, '。')} 次`);
  ok('逗号进序列', countPunct(ids, '，') === 1, `出现 ${countPunct(ids, '，')} 次`);
}
{
  const ids = seq('真的吗？太好了！');
  ok('问号进序列', countPunct(ids, '？') === 1, `出现 ${countPunct(ids, '？')} 次`);
  ok('感叹号进序列', countPunct(ids, '！') === 1, `出现 ${countPunct(ids, '！')} 次`);
}
{
  const ids = seq('甲；乙：丙、丁');
  ok('分号进序列', countPunct(ids, '；') === 1);
  ok('冒号进序列', countPunct(ids, '：') === 1);
  ok('顿号进序列', countPunct(ids, '、') === 1);
}
{
  const ids = seq('等等…然后呢？');
  ok('省略号进序列', countPunct(ids, '…') === 1, `出现 ${countPunct(ids, '…')} 次`);
  ok('省略号没有被替换成句号', countPunct(ids, '。') === 0);
}
{
  const ids = seq('（括号）结束');
  ok('左括号进序列', countPunct(ids, '（') === 1);
  ok('右括号进序列', countPunct(ids, '）') === 1);
}

T('半角标点也要能查表');
{
  const ids = seq('hello, world.');
  ok('半角逗号映射到全角', countPunct(ids, '，') === 1, `出现 ${countPunct(ids, '，')} 次`);
  ok('半角句号映射到全角', countPunct(ids, '。') === 1, `出现 ${countPunct(ids, '。')} 次`);
}

T('全角字母数字仍能转半角');
{
  const ids = seq('ＡＢＣ１２３');
  // 若全角字母没转半角，pinyin 替身会返回不了任何音节
  const syls = ids.filter((v) => v !== table.bos && v !== table.eos && v !== table.space);
  ok('全角字母数字被正确处理', syls.length >= 3, `产出 ${syls.length} 个音素`);
}
{
  const ids = seq('２０２６年');
  const syls = ids.filter((v) => v !== table.bos && v !== table.eos && v !== table.space);
  ok('全角数字被逐位读出', syls.length >= 4, `产出 ${syls.length} 个音素`);
}

T('序列结构不变量');
{
  const ids = seq('你好，世界。');
  ok('以 bos 开头', ids[0] === table.bos);
  ok('以 eos 结尾', ids[ids.length - 1] === table.eos);
  ok('没有连续重复 space', !ids.some((v, i) => v === table.space && i > 0 && ids[i - 1] === table.space));
  ok('长度在合理范围', ids.length > 3 && ids.length < 200, `${ids.length} 个 id`);
}
{
  const ids = seq('');
  ok('空文本返回 [bos, eos]', ids.length === 2 && ids[0] === table.bos && ids[1] === table.eos);
}
{
  const ids = seq('。。。');
  ok('纯标点也能进序列', ids.length >= 4, `${ids.length} 个 id`);
}

T('采样率与模型 config 一致');
{
  const cfg = JSON.parse(fs.readFileSync(path.join(HERE, '../assets/tts/zh-huayan.json'), 'utf8'));
  const eng = fs.readFileSync(path.join(HERE, '../js/tts/engine.js'), 'utf8');
  const m = /sampleRate:\s*(\d+)/.exec(eng);
  ok('engine 声明了采样率', !!m, m ? m[1] : '未找到');
  ok('engine 采样率 == 模型 config',
    !!m && Number(m[1]) === cfg.audio.sample_rate,
    `engine ${m ? m[1] : '?'} vs config ${cfg.audio.sample_rate}`);
  ok('音素表 sr 与 config 一致', rawTable.sr === cfg.audio.sample_rate, `表 ${rawTable.sr} vs config ${cfg.audio.sample_rate}`);
}
{
  // 混音/变速里的默认采样率也不能再是 22050
  const mix = fs.readFileSync(path.join(HERE, '../js/audio/mix.js'), 'utf8');
  ok('mix.js 不再出现 22050', !mix.includes('22050'));
  const wsola = fs.readFileSync(path.join(HERE, '../js/audio/wsola.js'), 'utf8');
  ok('wsola.js 不再出现 22050', !wsola.includes('22050'));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
