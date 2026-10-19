// 最小 24-bit BMP 写入（无第三方依赖）
import fs from 'node:fs';

export function writeBMP(file, W, H, rgb) {
  const rowSize = Math.ceil(W * 3 / 4) * 4;
  const size = 54 + rowSize * H;
  const b = Buffer.alloc(size);
  b.write('BM', 0, 2, 'ascii');
  b.writeUInt32LE(size, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(W, 18);
  b.writeInt32LE(H, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(0, 30);
  b.writeUInt32LE(rowSize * H, 34);
  for (let y = 0; y < H; y++) {
    const src = (H - 1 - y) * W * 3;
    const dst = 54 + y * rowSize;
    for (let x = 0; x < W; x++) {
      b[dst + x * 3] = rgb[src + x * 3 + 2];
      b[dst + x * 3 + 1] = rgb[src + x * 3 + 1];
      b[dst + x * 3 + 2] = rgb[src + x * 3];
    }
  }
  fs.writeFileSync(file, b);
}
