// 本地开发服务器：一个端口同时服务 inkbrief 和 image2strokes（两个项目并排时）。
// 这样 inkbrief 的 Worker 能直接加载 ../../image2strokes/js/engine.js，不用联网。
//
//   npm start                 # http://127.0.0.1:8743/inkbrief/
//   PORT=9000 npm start
//
// 支持 Range（TTS 模型 / wasm 的分片下载在本地也能走真实分支）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.ROOT || path.join(HERE, '../..'));
const PORT = Number(process.env.PORT || 8743);
const HOST = process.env.HOST || '127.0.0.1';

const MOUNTS = [
  ['/inkbrief/', path.join(ROOT, 'inkbrief')],
  ['/image2strokes/', path.join(ROOT, 'image2strokes')],
];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.map': 'application/json; charset=utf-8',
};

// 大文件让浏览器缓存，避免每次刷新重下 10MB 模型；代码/页面每次校验，改完立刻生效。
const LONG_CACHE = new Set(['.onnx', '.wasm', '.woff2', '.woff', '.ttf', '.png', '.jpg', '.jpeg']);

function resolveMount(pathname) {
  for (const [prefix, dir] of MOUNTS) {
    if (pathname === prefix.slice(0, -1)) return { dir, rel: '/', redirect: prefix };
    if (pathname.startsWith(prefix)) return { dir, rel: pathname.slice(prefix.length - 1) };
  }
  return null;
}

function send(req, res, file, ext, st) {
  const headers = {
    'content-type': TYPES[ext] || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': LONG_CACHE.has(ext) ? 'public, max-age=3600' : 'no-cache',
  };
  const range = req.headers.range;
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
      res.writeHead(206, { ...headers, 'content-length': last - start + 1, 'content-range': `bytes ${start}-${last}/${st.size}` });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file, { start, end: last }).pipe(res);
      return;
    }
  }
  res.writeHead(200, { ...headers, 'content-length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  const u = new URL(req.url, 'http://local');
  let pathname;
  try { pathname = decodeURIComponent(u.pathname); } catch { res.writeHead(400).end('bad path'); return; }

  if (pathname === '/') { res.writeHead(302, { location: '/inkbrief/' }).end(); return; }

  const mount = resolveMount(pathname);
  if (!mount) { res.writeHead(404).end('not found'); return; }
  if (mount.redirect) { res.writeHead(302, { location: mount.redirect + (u.search || '') }).end(); return; }

  let rel = mount.rel;
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(mount.dir, '.' + rel);
  if (file !== mount.dir && !file.startsWith(mount.dir + path.sep)) { res.writeHead(403).end(); return; }

  let st;
  try { st = fs.statSync(file); } catch { res.writeHead(404).end('not found'); return; }
  if (!st.isFile()) { res.writeHead(404).end('not found'); return; }

  send(req, res, file, path.extname(file).toLowerCase(), st);
}).listen(PORT, HOST, () => {
  console.log(`inkbrief dev server → http://${HOST}:${PORT}/inkbrief/`);
  for (const [prefix, dir] of MOUNTS) {
    const ok = fs.existsSync(dir);
    console.log(`  ${prefix.padEnd(17)} ${dir}${ok ? '' : '  (不存在！)'}`);
  }
  if (!fs.existsSync(MOUNTS[1][1])) {
    console.log('  ⚠ 没找到 image2strokes，inkbrief 会退到线上引擎（需要联网）');
  }
});
