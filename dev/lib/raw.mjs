// .raw 读写：int32 LE W, int32 LE H, RGBA...
import fs from 'node:fs';

export function readRaw(p) {
  const b = fs.readFileSync(p);
  if (b.length < 8) throw new Error(`${p}: too short`);
  const W = b.readInt32LE(0), H = b.readInt32LE(4);
  if (b.length !== 8 + W * H * 4) throw new Error(`${p}: size mismatch ${b.length} vs ${8 + W * H * 4}`);
  return { W, H, data: b.subarray(8) };
}

export function writeRaw(p, img) {
  const b = Buffer.alloc(8 + img.W * img.H * 4);
  b.writeInt32LE(img.W, 0); b.writeInt32LE(img.H, 4);
  Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length).copy(b, 8);
  fs.writeFileSync(p, b);
}
