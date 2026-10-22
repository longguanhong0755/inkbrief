// 把生产锁定的引擎版本抬到 image2strokes 当前的 HEAD。
//   npm run engine:bump            # 用 ../image2strokes 的 HEAD
//   npm run engine:bump -- <sha>   # 指定 commit
//
// 只改 js/engine-config.js 里的 pin；改完记得跑 npm run check:pin 再提交。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const I2S = path.resolve(ROOT, '../image2strokes');
const CONFIG = path.join(ROOT, 'js/engine-config.js');

let sha = process.argv[2];
if (!sha) {
  try {
    sha = execFileSync('git', ['-C', I2S, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (err) {
    console.error('读不到 image2strokes 的 HEAD：' + err.message);
    process.exit(1);
  }
  const dirty = execFileSync('git', ['-C', I2S, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (dirty) {
    console.log('⚠ image2strokes 工作区有未提交改动；pin 只能指向已提交、已推送的 commit。');
  }
}
if (!/^[0-9a-f]{7,40}$/.test(sha)) {
  console.error(`不是合法 commit：${sha}`);
  process.exit(1);
}

const src = fs.readFileSync(CONFIG, 'utf8');
const next = src.replace(/(const pin = ')[0-9a-f]{7,40}(';)/, `$1${sha}$2`);
if (next === src) {
  console.error('没找到 engine-config.js 里的 `const pin = \'...\';`');
  process.exit(1);
}
fs.writeFileSync(CONFIG, next);
console.log(`pin → ${sha}`);
console.log('下一步：npm run check:pin（会真的下载并跑一遍这个版本）');
console.log('确认 image2strokes 已把该 commit 推到 GitHub（jsDelivr 从 GitHub 取）。');
console.log('想立刻绕过 10 分钟浏览器缓存：把 js/worker.js 里的 engine-config.js?v=11 抬一下。');
