// 离线跑管线 + v8 缓存（避免每次回归都重跑 10 秒）
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRaw } from './raw.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 引擎来自独立的 image2strokes 项目，不在本仓库留副本。
// 两个项目没放在同一父目录时，用 IMG2S_PIPELINE 指到 image2strokes/js/pipeline.js。
const ENGINE = process.env.IMG2S_PIPELINE || path.resolve(HERE, '../../../image2strokes/js/pipeline.js');

export const OPTS = {
  colors: 0,          // 自动（与网页默认一致）
  style: 'marker',
  detail: 1,
  targetSec: 240,
  debug: true,
  dropDead: false,
  returnKeys: false,
};

export async function pipelineFor(fixture, opts = OPTS) {
  const key = `auto-c${opts.colors || 0}-d${opts.detail || 1}-${opts.style || 'marker'}`;
  const cacheFile = path.join('dev/.cache', path.basename(fixture) + '.' + key + '.v8');
  fs.mkdirSync('dev/.cache', { recursive: true });
  if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).mtimeMs > fs.statSync(fixture).mtimeMs) {
    return { res: v8.deserialize(fs.readFileSync(cacheFile)), cached: true };
  }
  if (!fs.existsSync(ENGINE)) {
    throw new Error(`找不到 image2strokes 引擎：${ENGINE}\n用 IMG2S_PIPELINE=<path/to/pipeline.js> 指定`);
  }
  await import(pathToFileURL(ENGINE).href);
  const P = globalThis.ISP_PIPELINE;
  const img = readRaw(fixture);
  let last = '';
  const res = await P.run(img.data, img.W, img.H, opts, (p, m) => {
    const s = `${(p * 100) | 0}% ${m}`;
    if (s !== last) { last = s; process.stdout.write('\r' + s.padEnd(56)); }
  });
  process.stdout.write('\r' + ' '.repeat(56) + '\r');
  fs.writeFileSync(cacheFile, v8.serialize(res));
  return { res, cached: false };
}
