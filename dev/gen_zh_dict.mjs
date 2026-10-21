// 离线生成中文 TTS 的音素词典。
// 依赖（仅开发期）：@echogarden/espeak-ng-emscripten（GPL，不随产品分发）
// 产物：assets/tts/zh-phonemes.json  { chars: {字:{拼音:ipa}}, syl: {拼音:ipa} }
import fs from 'node:fs';
import path from 'node:path';
import EspeakNg from 'file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/@echogarden/espeak-ng-emscripten/espeak-ng.js';

const ESPEAK_DIR = 'C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/@echogarden/espeak-ng-emscripten/';

const m = await EspeakNg({ locateFile: (f) => ESPEAK_DIR + f });
const w = new m.eSpeakNGWorker();
w.set_voice('cmn');
const ipaOf = (s) => {
  try {
    const r = w.synthesize_ipa(s);
    return (r.ipa || '').replace(/\n/g, '').trim();
  } catch { return ''; }
};

// 1. 收集汉字：U+4E00..U+9FA5
const chars = [];
for (let cp = 0x4e00; cp <= 0x9fa5; cp++) chars.push(String.fromCodePoint(cp));

// 2. 逐字音素化
const raw = {};
let ok = 0, empty = 0;
for (const c of chars) {
  const ipa = ipaOf(c);
  if (!ipa) { empty++; continue; }
  raw[c] = ipa; ok++;
}
console.log(`汉字 ${chars.length}，有音素 ${ok}，空 ${empty}`);

fs.writeFileSync(path.resolve('dev/.cache/zh-char-ipa.json'), JSON.stringify(raw), 'utf8');
console.log('已写 dev/.cache/zh-char-ipa.json', (fs.statSync('dev/.cache/zh-char-ipa.json').size / 1024).toFixed(0) + 'KB');
