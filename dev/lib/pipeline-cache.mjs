// 离线跑管线 + v8 缓存（避免每次回归都重跑 10 秒）
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import { readRaw } from './raw.mjs';

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
  await import('../../js/vendor/pipeline.js');
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
