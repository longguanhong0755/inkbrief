// 支持 Range 的本地静态服务器。
// 用途：python 的 http.server 不返回 206，分片下载在本地永远走不到，
// 用这个才能验证 Range 分支。默认 8743，避免和 e2e 的 8742 冲突。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.env.ROOT || process.cwd());
const port = Number(process.env.PORT || 8743);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp4': 'video/mp4',
};

const hits = new Map();
let wasmFull = 0;

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://local');
  let p = decodeURIComponent(u.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }

  let st;
  try { st = fs.statSync(file); } catch { res.writeHead(404).end('not found'); return; }
  if (!st.isFile()) { res.writeHead(404).end('not found'); return; }

  const ext = path.extname(file).toLowerCase();
  const type = TYPES[ext] || 'application/octet-stream';
  const range = req.headers.range;
  const key = p.split('/').pop();
  hits.set(key, (hits.get(key) || 0) + 1);

  if (range) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(String(range).trim());
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : st.size - 1;
      if (start >= st.size || start > end) {
        res.writeHead(416, { 'content-range': `bytes */${st.size}` }).end();
        return;
      }
      const last = Math.min(end, st.size - 1);
      res.writeHead(206, {
        'content-type': type,
        'content-length': last - start + 1,
        'content-range': `bytes ${start}-${last}/${st.size}`,
        'accept-ranges': 'bytes',
      });
      fs.createReadStream(file, { start, end: last }).pipe(res);
      return;
    }
  }

  // 没有 Range 的整包请求：wasm 出现这个说明 ort 又自己去拉了，blob 替换没生效
  if (ext === '.wasm') {
    wasmFull++;
    console.log(`[warn] ${key} 整包请求 ×${wasmFull}（期望为 0）`);
  }
  res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`range server → http://127.0.0.1:${port}  root=${root}`);
  process.on('SIGINT', () => {
    console.log('\n请求统计：', [...hits.entries()].filter(([k]) => /wasm|onnx/.test(k)));
    process.exit(0);
  });
});
