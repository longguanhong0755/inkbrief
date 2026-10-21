// 底部时间轴：整片结构一条，看得见每屏多长、画了多少笔。
//
// 交互约定（与需求文档 §5.5 一致）：
//   - 每屏一块，宽度 ∝ 时长
//   - 右边缘 8px = 改这一屏的时长
//   - 左边缘 = 拒绝（起点由前序决定，改了会造成「改一段动两段」的歧义）
//   - 中段 = 拖整块重排
//   - 点击块 = 选中这一屏，联动右侧场景栏 + 跳转播放头
//
// 拖拽期间只写 transform（rAF 节流），pointerup 才提交一次 rebuild()。

import { layoutTrack, timeToX } from '../core/timeline.js';

const ZOOMS = [
  { key: 'fit', label: '适应', scale: 0 },
  { key: '1x', label: '1×', scale: 1 },
  { key: '2x', label: '2×', scale: 2 },
  { key: '4x', label: '4×', scale: 4 },
];

const RESIZE_HANDLE = 8;    // 右边缘多宽算「改时长」
const MIN_BLOCK_W = 26;     // 块最小宽度，太窄点不中

/**
 * @param {object} o
 * @param {HTMLElement} o.root 时间轴容器
 * @param {object} o.state 全局 state
 * @param {() => void} o.onSeek 跳到某个时刻
 * @param {(segId:string) => void} o.onSelect 选中某一屏
 * @param {(from:number, to:number) => void} o.onReorder 把第 from 屏挪到第 to 屏
 * @param {(segId:string, ms:number) => void} o.onResize 改某一屏的时长
 * @param {(segId:string) => void} o.onStatus 拖到某一屏上（用于显示它当前状态）
 */
export function createTimelineView(o) {
  const root = o.root;
  let zoom = 0;          // 0 = 适应
  let selected = null;   // 选中的段 id
  let drag = null;       // 拖拽中的状态
  let track = null;      // 最近一次算出的轨道布局（给 updateHead 复用，避免每帧重排）

  root.innerHTML = `
    <div class="tl-bar">
      <span class="tl-title">时间轴</span>
      <span class="tl-total" data-total></span>
      <div class="tl-zooms" data-zooms></div>
    </div>
    <div class="tl-scroll" data-scroll>
      <div class="tl-track" data-track></div>
    </div>
  `;
  const elTotal = root.querySelector('[data-total]');
  const elScroll = root.querySelector('[data-scroll]');
  const elTrack = root.querySelector('[data-track]');
  const elZooms = root.querySelector('[data-zooms]');

  // 缩放按钮
  for (const z of ZOOMS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tl-zoom';
    b.textContent = z.label;
    b.dataset.zoom = z.key;
    b.addEventListener('click', () => {
      zoom = z.scale;
      render();
    });
    elZooms.appendChild(b);
  }

  /** 算轨道布局：适应模式按容器宽度，缩放模式按「每秒多少像素」 */
  function computeTrack() {
    const tl = o.state.timeline;
    const avail = Math.max(240, elScroll.clientWidth - 24);
    const totalMs = tl.totalMs || 1;
    let pxPerMs = zoom > 0 ? zoom : avail / totalMs;
    // 适应模式下，若总时长太短导致块宽不够点，就放大到刚好
    const minPx = MIN_BLOCK_W + 4;
    if (pxPerMs * totalMs < minPx * tl.scenes.length) {
      pxPerMs = (minPx * tl.scenes.length) / totalMs;
    }
    return {
      track: layoutTrack(tl.scenes, {
        width: avail, totalMs, minWidth: MIN_BLOCK_W, gap: 4, pxPerMs,
      }),
      pxPerMs,
      avail,
      totalMs,
    };
  }

  /** 画一遍时间轴 */
  function render() {
    const tl = o.state.timeline;
    if (!tl || !tl.scenes.length) {
      elTrack.innerHTML = '<p class="tl-empty">还没有内容。先粘文案分段、配图，再点「生成」。</p>';
      elTotal.textContent = '';
      elScroll.classList.remove('has-blocks');
      track = null;
      return;
    }
    elScroll.classList.add('has-blocks');

    const calc = computeTrack();
    track = calc;

    elTrack.style.width = Math.ceil(calc.track.contentWidth) + 'px';
    elTotal.textContent = `${tl.scenes.length} 屏 · ${(tl.totalMs / 1000).toFixed(1)}s`;

    elTrack.innerHTML = '';
    for (const sc of tl.scenes) {
      const b = calc.track.blocks.find((x) => x.id === sc.id);
      if (!b) continue;
      const el = document.createElement('div');
      el.className = 'tl-block';
      el.dataset.segid = sc.id;
      el.dataset.idx = String(sc.index);
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', `第 ${sc.index + 1} 屏，时长 ${(sc.dur / 1000).toFixed(1)} 秒`);
      el.style.width = Math.round(b.w) + 'px';
      el.style.left = Math.round(b.x) + 'px';
      if (selected === sc.id) el.classList.add('sel');
      if (drag && drag.kind === 'move' && drag.segId === sc.id) el.classList.add('moving');

      const keepPct = sc.strokeCount ? Math.round((sc.keep / sc.strokeCount) * 100) : 100;
      el.innerHTML = `
        <span class="tl-no">${sc.index + 1}</span>
        <span class="tl-dur">${(sc.dur / 1000).toFixed(1)}s</span>
        <span class="tl-meta">${sc.keep}/${sc.strokeCount} 笔${keepPct < 100 ? ` · ${keepPct}%` : ''}</span>
        <span class="tl-grip" data-grip></span>
      `;
      elTrack.appendChild(el);
    }

    // 播放头
    const head = document.createElement('div');
    head.className = 'tl-head';
    head.style.transform = `translateX(${timeToX(calc.track, o.state.ms)}px)`;
    elTrack.appendChild(head);

    for (const z of ZOOMS) {
      elZooms.querySelector(`[data-zoom="${z.key}"]`)?.classList.toggle('on', z.scale === zoom);
    }
  }

  /** 命中测试：点在块的哪一部分 */
  function hit(e) {
    const block = e.target.closest('.tl-block');
    if (!block) return null;
    const r = block.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (x >= r.width - RESIZE_HANDLE) return { kind: 'resize', el: block, rect: r };
    if (x <= RESIZE_HANDLE) return { kind: 'left', el: block, rect: r };
    return { kind: 'move', el: block, rect: r };
  }

  const onDown = (e) => {
    if (e.button !== 0) return;
    const h = hit(e);
    if (!h) return;
    const segId = h.el.dataset.segid;
    const tl = o.state.timeline;
    if (!tl) return;
    const sc = tl.scenes.find((s) => s.id === segId);
    if (!sc) return;

    if (h.kind === 'left') {
      // 左边缘：明确拒绝，但要说清楚为什么
      o.onStatus?.(segId, '这一屏的起点由上一屏决定，起点不能在这里拖');
      return;
    }

    e.preventDefault();
    const blocks = [...elTrack.querySelectorAll('.tl-block')];
    drag = {
      kind: h.kind,
      segId,
      el: h.el,
      startX: e.clientX,
      fromIndex: sc.index,
      toIndex: sc.index,
      width: h.rect.width,
      ms: sc.dur,
      pxPerMs: track?.pxPerMs || 1,
      blocks,
      moved: false,
    };
    elTrack.classList.add('dragging');
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  /** 找出指针当前落在哪一块（跳过正在拖的那一块自己） */
  function blockUnder(x, y, self) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const b = el.closest('.tl-block');
    if (!b || b === self) return null;
    return b;
  }

  const onMove = (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    if (!drag.moved && Math.abs(dx) < 4) return;
    drag.moved = true;

    if (drag.kind === 'resize') {
      // 改时长：像素差 → 毫秒（按当前缩放比例）
      const delta = Math.round(dx / drag.pxPerMs);
      const next = Math.max(600, drag.ms + delta);
      drag.nextMs = next;
      drag.el.classList.add('resizing');
      const label = drag.el.querySelector('.tl-dur');
      if (label) label.textContent = (next / 1000).toFixed(1) + 's';
      return;
    }

    // 移动整块：只改 transform，pointerup 才提交
    drag.el.classList.add('moving');
    drag.el.style.transform = `translateX(${dx}px)`;
    // 算落在哪一块上（自己不算，拖动块 pointer-events:none，elementFromPoint 会穿透）
    const over = blockUnder(e.clientX, e.clientY, drag.el);
    if (over) {
      drag.toIndex = Number(over.dataset.idx ?? 0);
      for (const b of drag.blocks) b.classList.remove('drop-target');
      over.classList.add('drop-target');
    }
  };

  const onUp = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    elTrack.classList.remove('dragging');
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    d.el.classList.remove('moving', 'resizing');
    d.el.style.transform = '';
    for (const b of d.blocks) b.classList.remove('drop-target');

    if (!d.moved) {
      // 只是点了一下：选中 + 跳播放头
      selected = d.segId;
      o.onSelect?.(d.segId);
      const tl = o.state.timeline;
      const sc = tl?.scenes.find((s) => s.id === d.segId);
      if (sc) o.onSeek?.(sc.start);
      render();
      return;
    }

    if (d.kind === 'resize') {
      if (d.nextMs && d.nextMs !== d.ms) o.onResize?.(d.segId, d.nextMs);
      return;
    }

    // 重排：算目标位置
    if (d.toIndex !== d.fromIndex) o.onReorder?.(d.fromIndex, d.toIndex);
  };

  elTrack.addEventListener('pointerdown', onDown);

  // 点击（键盘可达）
  elTrack.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const block = e.target.closest('.tl-block');
    if (!block) return;
    e.preventDefault();
    const segId = block.dataset.segid;
    selected = segId;
    o.onSelect?.(segId);
    const tl = o.state.timeline;
    const sc = tl?.scenes.find((s) => s.id === segId);
    if (sc) o.onSeek?.(sc.start);
    render();
  });

  // 窗口尺寸变了要重排（适应模式依赖容器宽度）
  const onResize = () => render();
  window.addEventListener('resize', onResize);

  return {
    render,
    /** 只挪播放头（播放时每帧调，不重建 DOM、不重排） */
    updateHead() {
      if (!track) return;
      const head = elTrack.querySelector('.tl-head');
      if (!head) return;
      head.style.transform = `translateX(${timeToX(track.track, o.state.ms)}px)`;
    },
    setSelected(segId) {
      selected = segId;
      render();
    },
    getSelected() { return selected; },
    destroy() {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    },
  };
}
