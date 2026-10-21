// 构建「拼音+声调 -> IPA」映射表。声调通过 IPA 里的 ɜ 等后缀体现，必须保留。
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { pinyin } = require('pinyin-pro');

const raw = JSON.parse(fs.readFileSync('dev/.cache/zh-char-ipa.json', 'utf8'));
const clean = (s) => s.replace(/[ˈˌ0-9]/g, '').replace(/_+/g, '_').replace(/^_|_$/g, '');

const votes = new Map();   // "pin1" -> Map(ipa -> count)
let miss = 0;
for (const [c, ipa] of Object.entries(raw)) {
  let py;
  try { py = pinyin(c, { toneType: 'num', type: 'array' })[0]; } catch { py = null; }
  if (!py || !/^[a-zü]+[1-5]$/.test(py)) { miss++; continue; }
  const ip = clean(ipa);
  if (!ip) { miss++; continue; }
  const key = py.replace('ü', 'v');
  if (!votes.has(key)) votes.set(key, new Map());
  const m = votes.get(key);
  m.set(ip, (m.get(ip) || 0) + 1);
}

const map = {};
const stats = { total: 0, unanimous: 0, ratioSum: 0, low: [] };
for (const [py, m] of [...votes.entries()].sort()) {
  const arr = [...m.entries()].sort((a, b) => b[1] - a[1]);
  const total = arr.reduce((s, x) => s + x[1], 0);
  const [ip, cnt] = arr[0];
  map[py] = ip;
  stats.total++;
  stats.ratioSum += cnt / total;
  if (cnt === total) stats.unanimous++;
  else if (cnt / total < 0.7) stats.low.push([py, (cnt / total * 100).toFixed(0) + '%', arr.slice(0, 3)]);
}
console.log(`条目 ${stats.total}，完全一致 ${stats.unanimous}，平均一致度 ${(stats.ratioSum / stats.total * 100).toFixed(1)}%`);
console.log(`跳过的字 ${miss}`);
console.log('\n一致度 <70%（前 10）:');
for (const [py, r, top] of stats.low.slice(0, 10)) console.log(`  ${py} ${r}  ${top.map(t => `${t[0]}(${t[1]})`).join('; ')}`);

console.log('\n=== 同音节不同声调对比（验证 ɜ 是声调标记）===');
for (const base of ['tu','bu','hao','liao','ma','shi','zhong','de','ge','yi']) {
  const row = [];
  for (let t = 1; t <= 5; t++) { const v = map[base + t]; if (v) row.push(`T${t}=${v}`); }
  console.log(`  ${base.padEnd(6)} ${row.join('   ')}`);
}

fs.writeFileSync('dev/.cache/zh-syl-toned.json', JSON.stringify(map), 'utf8');
console.log('\n写入 dev/.cache/zh-syl-toned.json', (fs.statSync('dev/.cache/zh-syl-toned.json').size / 1024).toFixed(1) + 'KB');
