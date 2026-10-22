// 引擎契约测试：image2strokes 的 run() 接口和 inkbrief 的依赖声明是否还对得上。
// 不联网也能跑（默认测同源兄弟目录里的代码）；--remote 额外测生产锁定的 commit。
//
//   node dev/engine_contract.mjs
//   node dev/engine_contract.mjs --remote
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const I2S = path.resolve(ROOT, '../image2strokes');
const CONFIG = path.join(ROOT, 'js/engine-config.js');
const ENGINE_ENTRY = path.join(I2S, 'js/engine.js');
const PIPELINE = path.join(I2S, 'js/pipeline.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); }
};

// 1) 读配置（engine-config.js 是 classic 脚本，设置 self.INK_ENGINE）
const sandbox = { self: {} };
new Function('self', fs.readFileSync(CONFIG, 'utf8'))(sandbox.self);
const CFG = sandbox.self.INK_ENGINE;
ok('依赖配置可读', !!CFG && typeof CFG.api === 'number', JSON.stringify({ api: CFG?.api, pin: CFG?.pin }));
ok('配置里有 pinned commit', /^[0-9a-f]{7,40}$/.test(CFG?.pin || ''), CFG?.pin);

// 2) image2strokes 的稳定入口必须存在，并且指向 pipeline + 声明同一个 api
ok('image2strokes/js/engine.js 存在', fs.existsSync(ENGINE_ENTRY), ENGINE_ENTRY);
if (fs.existsSync(ENGINE_ENTRY)) {
  const src = fs.readFileSync(ENGINE_ENTRY, 'utf8');
  const m = /pipeline\.js\?v=(\d+)/.exec(src);
  ok('engine.js 指向 pipeline.js', !!m, m ? `?v=${m[1]}` : '没找到 pipeline.js?v=');
  const a = /self\.ISP_PIPELINE\.api\s*=\s*(\d+)/.exec(src);
  ok('engine.js 声明 api', !!a && Number(a[1]) === CFG.api, a ? `api=${a[1]} / 期望 ${CFG.api}` : '没找到 api');
}

// 3) inkbrief 的 Worker 确实走 engine-config + engine.js
const worker = fs.readFileSync(path.join(ROOT, 'js/worker.js'), 'utf8');
ok('Worker 读取 engine-config', /importScripts\('engine-config\.js\?v=/.test(worker));
ok('Worker 加载 engine.js', /engine\.js\?v=/.test(worker));
ok('Worker 校验 api', /P\.api\s*!=\s*null\s*&&\s*P\.api\s*!==\s*ENGINE_API/.test(worker));

// 4) 真的跑一遍 pipeline（小图，验证 run 的入参/返回结构）
async function runEngine(P, label) {
  const W = 32, H = 32;
  const px = new Uint8ClampedArray(W * H * 4);
  const colors = [[220, 40, 40], [40, 160, 60], [40, 80, 200], [245, 240, 230]];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = colors[(y < H / 2 ? 0 : 2) + (x < W / 2 ? 0 : 1)];
      const i = (y * W + x) * 4;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
  }
  const res = await P.run(px, W, H, {
    colors: 4, style: 'marker', detail: 1, maxStrokes: 300, dropDead: false, returnKeys: false,
  }, () => {});
  ok(`${label}: 返回尺寸`, res && res.W === W && res.H === H, res ? `${res.W}x${res.H}` : '空返回');
  ok(`${label}: 有笔触`, res && Array.isArray(res.strokes) && res.strokes.length > 0, res ? `${res.strokes.length} 笔` : '');
  ok(`${label}: 有裁剪组`, res && Array.isArray(res.clips));
  const s = res && res.strokes && res.strokes[0];
  ok(`${label}: 单笔结构`, !!s && Array.isArray(s.rib) && Array.isArray(s.color), s ? `rib ${s.rib.length} 点` : '');
}

if (fs.existsSync(PIPELINE)) {  await import(pathToFileURL(PIPELINE).href);
  const P = globalThis.ISP_PIPELINE;
  ok('本地 pipeline 导出 run', !!P && typeof P.run === 'function');
  if (P && typeof P.run === 'function') await runEngine(P, '本地引擎');
} else {
  fail++;
  console.log(`  FAIL 找不到 image2strokes/js/pipeline.js（${PIPELINE}）—— 两个项目要并排放在同一父目录`);
}

// 5) --remote：生产锁定的 jsDelivr 版本也必须能跑
if (process.argv.includes('--remote')) {
  console.log(`\n── 远程锁定版本 ${CFG.pin} ──`);
  const res = await fetch(CFG.pinUrl, { redirect: 'follow' });
  ok('pin URL 可下载', res.ok, `${res.status} ${CFG.pinUrl}`);
  if (res.ok) {
    const dir = path.join(ROOT, 'dev/.cache');
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `engine-pin-${CFG.pin}.js`);
    fs.writeFileSync(tmp, await res.text());
    await import(pathToFileURL(tmp).href + '?t=' + Date.now());
    const P = globalThis.ISP_PIPELINE;
    ok('pin 版本导出 run', !!P && typeof P.run === 'function');
    if (P && typeof P.run === 'function') await runEngine(P, 'pin 引擎');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
