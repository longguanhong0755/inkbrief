// 把「拼音+声调 -> IPA」表编译成「音节 -> 音素 id 序列」，供浏览器直接查表。
// 音素表来自模型的 phoneme_id_map，未收录字符一律丢弃（与 piper 推理一致）。
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync('dev/.cache/zh_x_low_fp32.onnx.json', 'utf8'));
const pmap = cfg.phoneme_id_map;
const syl = JSON.parse(fs.readFileSync('dev/.cache/zh-syl-toned.json', 'utf8'));

const idOf = (ch) => (pmap[ch] ? pmap[ch][0] : null);
const BOS = idOf('^'), EOS = idOf('$'), SP = idOf(' ');
const PAD = idOf('_');

const out = {};
const dropped = new Set();
for (const [py, ipa] of Object.entries(syl)) {
  const ids = [];
  for (const ch of ipa) {
    const id = idOf(ch);
    if (id === null || id === PAD) { if (id === null) dropped.add(ch); continue; }
    ids.push(id);
  }
  if (ids.length) out[py] = ids;
}
console.log('音节条目', Object.keys(out).length);
console.log('被丢弃的字符:', [...dropped].map(c => `${c}(U+${c.codePointAt(0).toString(16)})`).join(' ') || '无');
console.log('特殊 id: BOS', BOS, 'EOS', EOS, 'SPACE', SP, 'PAD', PAD);

// 标点映射
const punct = { '，': ',', '。': '.', '！': '!', '？': '?', '；': ';', '：': ':', '、': ',', '—': '-', '…': '.', '“': null, '”': null, '《': null, '》': null, '（': '(', '）': ')', '·': null };
const punctIds = {};
for (const [zh, en] of Object.entries(punct)) {
  if (en && pmap[en]) punctIds[zh] = pmap[en][0];
}

// 抽样打印
const show = (k) => out[k] ? `${out[k].join(' ')}` : '(无)';
for (const k of ['ni3','hao3','jin1','tian1','tu2','pian4','shi4','shang4','chuan2','bu4','yao4','hang2','xing2','zhong4','le5','yi1','ge4']) {
  console.log(`  ${k.padEnd(7)} ${syl[k] || '-'.padEnd(14)} -> ${show(k)}`);
}

const payload = { model: 'zh_CN-huayan-x_low-fp16', bos: BOS, eos: EOS, space: SP, syl: out, punct: punctIds, sr: cfg.audio.sample_rate };
fs.mkdirSync('assets/tts', { recursive: true });
fs.writeFileSync('assets/tts/zh-phonemes.json', JSON.stringify(payload));
console.log('\n写入 assets/tts/zh-phonemes.json', (fs.statSync('assets/tts/zh-phonemes.json').size / 1024).toFixed(1) + 'KB');
