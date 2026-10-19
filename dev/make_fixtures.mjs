// 把 image2strokes 的 .raw fixture 降采样成 512px 的小样本（仓库里只放小图）
// .raw 格式：int32 LE W, int32 LE H, RGBA...
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.env.IMG2S_DEV || path.resolve(HERE, '../../image2strokes/dev');
const DST = path.join(HERE, 'fixtures');

function readRaw(p) {
  const b = fs.readFileSync(p);
  const W = b.readInt32LE(0), H = b.readInt32LE(4);
  if (b.length !== 8 + W * H * 4) throw new Error(`${p}: size mismatch ${b.length} vs ${8 + W * H * 4}`);
  return { W, H, data: b.subarray(8) };
}

function boxResize(src, maxSide) {
  const s = Math.min(1, maxSide / Math.max(src.W, src.H));
  const W = Math.max(1, Math.round(src.W * s));
  const H = Math.max(1, Math.round(src.H * s));
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y * src.H / H), y1 = Math.max(y0 + 1, Math.floor((y + 1) * src.H / H));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * src.W / W), x1 = Math.max(x0 + 1, Math.floor((x + 1) * src.W / W));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * src.W + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; n++;
        }
      }
      const o = (y * W + x) * 4;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = 255;
    }
  }
  return { W, H, data: out };
}

function writeRaw(p, img) {
  const b = Buffer.alloc(8 + img.W * img.H * 4);
  b.writeInt32LE(img.W, 0); b.writeInt32LE(img.H, 4);
  Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length).copy(b, 8);
  fs.writeFileSync(p, b);
}

fs.mkdirSync(DST, { recursive: true });
const jobs = [
  ['illustration', 's1.raw'],
  ['photo', 's2.raw'],
  ['poster', 's3.raw'],
];
for (const [name, file] of jobs) {
  const src = readRaw(path.join(SRC, file));
  const img = boxResize(src, 512);
  const out = path.join(DST, name + '.raw');
  writeRaw(out, img);
  console.log(`${name}: ${src.W}x${src.H} -> ${img.W}x${img.H}  ${(fs.statSync(out).size / 1048576).toFixed(2)}MB`);
}
