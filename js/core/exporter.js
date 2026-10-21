// 导出：画面 + 混音音轨 -> MP4。
//
// 两条路：
//   exportVideoOffline  WebCodecs 硬编 + mp4-muxer 封装（首选）
//       逐帧喂给编码器，不受墙钟限制：机器慢只是多花 CPU 时间，
//       不会像 MediaRecorder 那样掉帧、不会让音画错位。
//   exportVideo         MediaRecorder 兜底
//       按真实时间录一遍，兼容性最好但慢机只掉帧。
//
// 编码器能力要分开探（probeCodecs）：
//   Safari 16.4 起有 VideoEncoder，但 AudioEncoder 要到 26 才有。
//   合起来判（有 VideoEncoder 就算支持）会让 Safari 上音频轨道整个丢掉。

import { Muxer, ArrayBufferTarget } from '../vendor/mp4-muxer/mp4-muxer.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((resolve) => {
  let done = false;
  const f = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(f);
  setTimeout(f, 120);   // 后台标签页 rAF 会停，用定时器兜底
});

export function pickMime() {
  const cands = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of cands) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch { /* ignore */ }
  }
  return '';
}

// ── WebCodecs 能力探测 ─────────────────────────────────

const VIDEO_CODECS = [
  { mux: 'avc', webcodecs: 'avc1.640028', label: 'H.264 High' },
  { mux: 'avc', webcodecs: 'avc1.4d002a', label: 'H.264 Main' },
  { mux: 'avc', webcodecs: 'avc1.42001f', label: 'H.264 Baseline' },
  { mux: 'vp9', webcodecs: 'vp09.00.10.08', label: 'VP9' },
  { mux: 'av1', webcodecs: 'av01.0.04M.08', label: 'AV1' },
];

const AUDIO_CODECS = [
  { mux: 'aac', webcodecs: 'mp4a.40.2', label: 'AAC-LC', samplesPerChunk: 1024 },
  { mux: 'opus', webcodecs: 'opus', label: 'Opus', samplesPerChunk: 960 },
];

/**
 * 探测 WebCodecs 能力。Video 和 Audio 分开判断。
 * @returns {Promise<{hasVideoEncoder:boolean, hasAudioEncoder:boolean, video:object|null, audio:object|null}>}
 */
export async function probeCodecs() {
  const out = {
    hasVideoEncoder: typeof VideoEncoder !== 'undefined',
    hasAudioEncoder: typeof AudioEncoder !== 'undefined',
    video: null,
    audio: null,
  };
  if (!out.hasVideoEncoder) return out;

  // 视频：挑第一个支持的（按常见 1080p 试，探到就够）
  for (const c of VIDEO_CODECS) {
    try {
      const s = await VideoEncoder.isConfigSupported({
        codec: c.webcodecs, width: 1920, height: 1080,
        bitrate: 8_000_000, framerate: 30,
      });
      if (s?.supported) { out.video = { ...c, config: s.config }; break; }
    } catch { /* 这个 codec 不可用，试下一个 */ }
  }

  if (out.hasAudioEncoder) {
    for (const c of AUDIO_CODECS) {
      try {
        const s = await AudioEncoder.isConfigSupported({
          codec: c.webcodecs, sampleRate: 48000, numberOfChannels: 1, bitrate: 128_000,
        });
        if (s?.supported) { out.audio = { ...c, config: s.config }; break; }
      } catch { /* 试下一个 */ }
    }
  }
  return out;
}

/**
 * WebCodecs 离线编码导出。
 *
 * 做法：把画面按固定帧率逐帧画到各画幅的画布，每帧 new 一个 VideoFrame 喂给
 * 对应的 VideoEncoder；音频按 AudioBuffer 切片喂给 AudioEncoder；
 * 编码结果各自塞进 mp4-muxer 封成 MP4。
 *
 * 多画幅（横屏 + 竖屏一次出）时：每一路视频各有自己的画布、编码器和封装器，
 * 音频只编一遍，同一份数据喂给所有封装器。
 *
 * 注意 renderAt 每帧只调一次：笔触渲染器的进度是共享的，
 * 同一帧调两次会重复 seek 一次，白白多花一倍时间。
 *
 * @param {object} o
 * @param {Array<{canvas:HTMLCanvasElement, label?:string}>} o.views  一路或多路画面
 * @param {AudioBuffer|null} o.audio  完整混音（没有就 null）
 * @param {number} o.totalMs
 * @param {(ms:number)=>void} o.renderAt  把这一帧画到所有 view 的画布上
 * @param {(p:{ratio:number,ms:number,frame:number,totalFrames:number,etaMs:number,stage:string})=>void} [o.onProgress]
 * @param {{aborted:boolean}} [o.signal]
 * @param {number} [o.fps]
 * @param {number} [o.videoBitrate]
 */
export async function exportVideoOffline(o) {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('这个浏览器不支持 WebCodecs 离线导出');
  }
  const codecs = await probeCodecs();
  if (!codecs.video) throw new Error('这个浏览器没有可用的视频编码器');

  const views = o.views || [];
  if (!views.length) throw new Error('没有要导出的画幅');

  const fps = Math.max(1, Math.min(60, Number(o.fps) || 30));
  const totalMs = Math.max(1, o.totalMs);
  const totalFrames = Math.max(1, Math.round((totalMs / 1000) * fps));
  const frameDurUs = 1_000_000 / fps;
  const wantAudio = !!o.audio && !!codecs.audio;

  const t0 = performance.now();
  let encodeError = null;

  // ── 每路视频：自己的封装器 + 编码器 ──
  const lanes = views.map((view) => {
    const W = view.canvas.width, H = view.canvas.height;
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
      video: { codec: codecs.video.mux, width: W, height: H, frameRate: fps },
      ...(wantAudio ? {
        audio: {
          codec: codecs.audio.mux,
          numberOfChannels: o.audio.numberOfChannels,
          sampleRate: o.audio.sampleRate,
        },
      } : {}),
    });
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        try { muxer.addVideoChunk(chunk, meta); } catch (e) { encodeError = e; }
      },
      error: (e) => { encodeError = e; },
    });
    encoder.configure({
      codec: codecs.video.webcodecs,
      width: W, height: H,
      bitrate: o.videoBitrate || Math.round(Math.max(2_500_000, W * H * fps * 0.11)),
      framerate: fps,
      latencyMode: 'quality',
    });
    return { view, muxer, target, encoder, canvas: view.canvas, W, H };
  });

  // ── 音频：只编一遍，喂给所有封装器 ──
  let audioEncoder = null;
  if (wantAudio) {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        for (const lane of lanes) {
          try { lane.muxer.addAudioChunk(chunk, meta); } catch (e) { encodeError = e; }
        }
      },
      error: (e) => { encodeError = e; },
    });
    audioEncoder.configure({
      codec: codecs.audio.webcodecs,
      sampleRate: o.audio.sampleRate,
      numberOfChannels: o.audio.numberOfChannels,
      bitrate: 128_000,
    });
  }

  const check = () => {
    if (o.signal?.aborted) throw new Error('已取消');
    if (encodeError) throw encodeError;
  };

  const closeAll = () => {
    for (const lane of lanes) {
      try { if (lane.encoder.state !== 'closed') lane.encoder.close(); } catch { /* ignore */ }
    }
    try { if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close(); } catch { /* ignore */ }
  };

  try {
    // ── 逐帧画 + 编码 ──
    for (let i = 0; i < totalFrames; i++) {
      check();
      const ms = (i / fps) * 1000;

      // 画面状态只算一次（笔触进度共享），各画幅分别绘制
      o.renderAt(Math.min(ms, totalMs));

      for (const lane of lanes) {
        const frame = new VideoFrame(lane.canvas, {
          timestamp: Math.round(i * frameDurUs),
          duration: Math.round(frameDurUs),
        });
        lane.encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
        frame.close();
      }

      // 编码器内部有队列，队列太长就等一等，别把内存撑爆
      if (lanes.some((l) => l.encoder.encodeQueueSize > 8)) {
        await new Promise((r) => setTimeout(r, 0));
        while (lanes.some((l) => l.encoder.encodeQueueSize > 4)) {
          await new Promise((r) => setTimeout(r, 4));
          check();
        }
      }

      if (i % 3 === 0 || i === totalFrames - 1) {
        const done = i + 1;
        const ratio = done / totalFrames;
        const elapsed = performance.now() - t0;
        o.onProgress?.({
          ratio, ms, frame: done, totalFrames,
          etaMs: Math.max(0, elapsed / ratio - elapsed),
          stage: '画面编码',
        });
        // 让出主线程，别把 UI 卡死
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    // ── 音频编码 ──
    if (audioEncoder) {
      o.onProgress?.({ ratio: 1, ms: totalMs, frame: totalFrames, totalFrames, etaMs: 0, stage: '音频编码' });
      const sr = o.audio.sampleRate;
      const ch = o.audio.numberOfChannels;
      // AAC 编码器要固定 1024 采样一帧，Opus 是 960（20ms@48k），喂别的会报错
      const CHUNK = codecs.audio.samplesPerChunk || 1024;
      const totalSamples = o.audio.length;
      for (let off = 0; off < totalSamples; off += CHUNK) {
        check();
        const n = Math.min(CHUNK, totalSamples - off);
        // AudioData 要一整块连续内存。
        // f32-planar 的布局是「所有声道的第 0 个采样挨在一起、再是第 1 个采样」，
        // 不是「声道 0 整段、声道 1 整段」——那样接上去会变成左右声道错位。
        const plane = new Float32Array(n * ch);
        for (let c = 0; c < ch; c++) {
          plane.set(o.audio.getChannelData(c).subarray(off, off + n), c * n);
        }
        const data = new AudioData({
          format: 'f32-planar',
          sampleRate: sr,
          numberOfFrames: n,
          numberOfChannels: ch,
          timestamp: Math.round((off / sr) * 1_000_000),
          data: plane,
        });
        audioEncoder.encode(data);
        data.close();
        if (audioEncoder.encodeQueueSize > 16) {
          while (audioEncoder.encodeQueueSize > 8) {
            await new Promise((r) => setTimeout(r, 4));
            check();
          }
        }
      }
    }

    // 等编码器把队列吐干净
    for (const lane of lanes) await lane.encoder.flush();
    if (audioEncoder) await audioEncoder.flush();
    check();

    const videos = lanes.map((lane) => {
      lane.muxer.finalize();
      return {
        blob: new Blob([lane.target.buffer], { type: 'video/mp4' }),
        mime: 'video/mp4',
        ext: 'mp4',
        width: lane.W,
        height: lane.H,
        label: lane.view.label || `${lane.W}×${lane.H}`,
      };
    });

    return {
      videos,
      blob: videos[0].blob,        // 单画幅时与 exportVideo 的返回形状一致
      mime: videos[0].mime,
      ext: videos[0].ext,
      ms: performance.now() - t0,
      audioMs: o.audio ? o.audio.duration * 1000 : 0,
      offline: true,
      hasAudio: wantAudio,
      frames: totalFrames,
    };
  } catch (err) {
    closeAll();
    throw err;
  } finally {
    closeAll();
  }
}

/**
 * MediaRecorder 兜底导出。返回形状与 exportVideoOffline 一致。
 * @param {object} o
 * @param {HTMLCanvasElement} o.canvas
 * @param {AudioBuffer} o.audio 完整混音
 * @param {number} o.totalMs
 * @param {(ms:number)=>void} o.renderAt
 * @param {(p:{ratio:number,ms:number})=>void} [o.onProgress]
 * @param {{aborted:boolean}} [o.signal]
 */
export async function exportVideo(o) {
  const mime = pickMime();
  if (!mime) throw new Error('当前浏览器不支持录制视频');

  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC({ sampleRate: 48000 });
  if (ctx.state === 'suspended') await ctx.resume();

  const dest = ctx.createMediaStreamDestination();
  const src = ctx.createBufferSource();
  src.buffer = o.audio;
  src.connect(dest);

  const vStream = o.canvas.captureStream(30);
  const tracks = [...vStream.getVideoTracks(), ...dest.stream.getAudioTracks()];
  const stream = new MediaStream(tracks);

  const rec = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: 12_000_000,
    audioBitsPerSecond: 128_000,
  });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((res) => { rec.onstop = () => res(); });

  let started = false;
  const t0 = performance.now();

  // 先画第一帧再开录，避免开头空白
  o.renderAt(0);
  await nextFrame();

  try {
    rec.start(200);
    started = true;

    const audioStart = ctx.currentTime + 0.05;
    src.start(audioStart);

    for (;;) {
      if (o.signal?.aborted) throw new Error('已取消');
      const ms = Math.max(0, (ctx.currentTime - audioStart) * 1000);
      o.renderAt(Math.min(ms, o.totalMs));
      o.onProgress?.({ ratio: Math.min(1, ms / o.totalMs), ms });
      if (ms >= o.totalMs) break;
      await nextFrame();
    }

    o.renderAt(o.totalMs);
    await sleep(320);
    rec.stop();
    await stopped;
  } catch (err) {
    if (started) {
      try { if (rec.state !== 'inactive') rec.stop(); } catch { /* ignore */ }
      await stopped.catch(() => {});
    }
    throw err;
  } finally {
    try { src.stop(); } catch { /* ignore */ }
    for (const t of tracks) { try { t.stop(); } catch { /* ignore */ } }
    try { await ctx.close(); } catch { /* ignore */ }
  }

  const blob = new Blob(chunks, { type: mime.split(';')[0] });
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  return {
    blob, mime, ext,
    ms: performance.now() - t0,
    audioMs: o.audio.duration * 1000,
    width: o.canvas.width,
    height: o.canvas.height,
    label: `${o.canvas.width}×${o.canvas.height}`,
  };
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // 立即移除会让部分浏览器中断下载，留一段时间再清理
  setTimeout(() => {
    try { a.remove(); } catch { /* ignore */ }
    URL.revokeObjectURL(url);
  }, 120_000);
}
