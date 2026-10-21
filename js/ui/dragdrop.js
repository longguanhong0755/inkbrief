// 拖拽绑定：把左栏的图拖到段落卡上。
//
// 为什么用 Pointer Events 而不是 HTML5 Drag and Drop：
//   1. iOS/Android 上 HTML5 DnD 基本不触发，拖不动
//   2. 拖拽过程中拿不到连续坐标，做不出跟手的 ghost
//   3. setDragImage 做不了「缩略图 + 说明」组合 ghost
//
// 但外部文件拖入还是要用 HTML5 DnD —— 只有它能读 dataTransfer.files。
// 所以本模块只管「页面内部元素之间拖」。

const LONG_PRESS_MS = 220;   // 触屏长按多久算拖拽意图
const DRAG_THRESHOLD = 5;   // 鼠标移动多少像素才算拖（小于这个当点击）

/**
 * 让一个元素可拖。
 * @param {HTMLElement} el 源元素
 * @param {object} o
 * @param {() => object} o.getPayload 拖动开始时返回要传的数据
 * @param {(payload:object, ctx:object) => void} o.onDrop 落在目标上
 * @param {string} [o.ghostLabel] ghost 上额外显示的文字
 * @param {(el:HTMLElement) => string} [o.badgeOf] 根据当前落点算 ghost 上的提示
 */
export function makeDraggable(el, o) {
  if (!el) return null;
  el.style.touchAction = 'none';
  el.dataset.draggable = '1';

  let st = null;

  const cleanup = () => {
    if (!st) return;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    clearTimeout(st.timer);
    st.ghost?.remove();
    st.ghost = null;
    document.body.classList.remove('is-dragging');
    el.classList.remove('dragging');
    st.zone?.classList.remove('drop-on');
    st.slot?.classList.remove('drop-on');
    st = null;
  };

  const onDown = (e) => {
    // 只响应主键
    if (e.button !== undefined && e.button !== 0) return;
    // 落在可交互元素上（删除按钮等）不启动拖拽
    if (e.target.closest('button, a, input, textarea, select')) return;
    const payload = o.getPayload?.();
    if (!payload) return;

    st = {
      id: e.pointerId,
      payload,
      x0: e.clientX,
      y0: e.clientY,
      started: false,
      timer: null,
      ghost: null,
      zone: null,
      slot: null,
      under: null,
      alt: e.altKey,
      isTouch: e.pointerType === 'touch',
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);

    if (st.isTouch) {
      // 触屏：长按 220ms 才起拖；在此之前滑动 = 滚动页面
      st.timer = setTimeout(() => { if (st) start(); }, LONG_PRESS_MS);
    }
  };

  const start = () => {
    if (!st || st.started) return;
    st.started = true;
    clearTimeout(st.timer);
    st.timer = null;
    el.classList.add('dragging');
    document.body.classList.add('is-dragging');
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch { /* ignore */ } }
    st.ghost = makeGhost(el, o.ghostLabel);
    document.body.appendChild(st.ghost);
    moveGhost(st.x0, st.y0);
  };

  const moveGhost = (x, y) => {
    if (!st?.ghost) return;
    st.ghost.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
  };

  const onMove = (e) => {
    if (!st || e.pointerId !== st.id) return;
    const dx = e.clientX - st.x0;
    const dy = e.clientY - st.y0;

    if (!st.started) {
      // 触屏：没长按就移动 = 用户想滚动页面，不起拖
      if (st.isTouch) return;
      // 鼠标：移动超过阈值才起拖，否则算点击
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      start();
    }

    e.preventDefault();
    st.alt = e.altKey;
    moveGhost(e.clientX, e.clientY);
    const t = hitTest(e.clientX, e.clientY);
    const zone = t ? t.zone : null;
    if (zone !== st.zone) {
      st.zone?.classList.remove('drop-on');
      st.zone = zone;
      zone?.classList.add('drop-on');
    }
    const under = t ? t.under : null;
    st.under = under;
    const slot = under?.closest?.('[data-slot-index]');
    if (slot !== st.slot) {
      st.slot?.classList.remove('drop-on');
      st.slot = slot && zone?.contains?.(slot) ? slot : null;
      st.slot?.classList.add('drop-on');
    }
    // ghost 上的提示文字跟着落点变
    if (st.ghost && o.badgeOf && zone) {
      const b = o.badgeOf(zone, st.payload, { x: e.clientX, y: e.clientY, under });
      const el2 = st.ghost.querySelector('.ghost-badge');
      if (el2) el2.textContent = b || '';
    }
  };

  const onUp = (e) => {
    if (!st || (e && e.pointerId !== st.id)) return;
    const payload = st.payload;
    const zone = st.zone;
    const under = st.under;
    const started = st.started;
    const x = e ? e.clientX : st.x0;
    const y = e ? e.clientY : st.y0;
    cleanup();
    if (started && zone) {
      o.onDrop?.(payload, { target: zone, under, alt: e ? e.altKey : false, x, y });
    }
  };

  el.addEventListener('pointerdown', onDown);

  return {
    destroy() {
      el.removeEventListener('pointerdown', onDown);
      cleanup();
    },
  };
}

/**
 * 找一个能接收这次拖拽的落点元素。
 * 规则：从里往外找，找带 data-drop-accept 的最近祖先。
 * 返回时同时带上「指针真正压着的那个元素」，
 * 因为槽位（data-slot-index）在 drop-accept 容器里面，
 * 判断插前还是插后要看它自己的位置。
 */
export function hitTest(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const t = el.closest('[data-drop-accept]');
  if (!t) return null;
  return { zone: t, under: el };
}

/**
 * 做一个跟手的 ghost：源元素的小图 + 徽标。
 */
function makeGhost(src, label) {
  const g = document.createElement('div');
  g.className = 'drag-ghost';
  const img = src.querySelector('img');
  if (img) {
    const im = document.createElement('img');
    im.src = img.src;
    g.appendChild(im);
  }
  const b = document.createElement('span');
  b.className = 'ghost-badge';
  b.textContent = label || '';
  g.appendChild(b);
  return g;
}

/**
 * 给一个容器挂上「能接收拖拽」的标记。
 * @param {HTMLElement} el
 * @param {string} accept 传给 onDrop 的类型标识
 */
export function makeDropzone(el, accept) {
  if (!el) return null;
  el.dataset.dropAccept = accept;
  return { el };
}

/**
 * 拖到段卡的哪个位置 → 什么操作。
 * 落点规则：
 *   - 落在某个已有槽位上：左半 = 插到它前面，右半 = 插到它后面
 *   - 落在卡片空白处：追加为多图
 *   - 按住 Alt：替换那一槽
 *
 * @param {HTMLElement} zone 接收区（段卡）
 * @param {HTMLElement} under 指针真正压着的元素（可能是槽位）
 * @param {number} x 指针横坐标（视口坐标）
 * @returns {{op:'insert'|'append'|'replace', index:number, slotIndex:number|null}}
 */
export function resolveDrop(zone, under, x) {
  const slot = under?.closest?.('[data-slot-index]');
  if (slot && zone?.contains?.(slot)) {
    const i = Number(slot.dataset.slotIndex);
    const r = slot.getBoundingClientRect();
    const left = x < r.left + r.width / 2;
    return { op: 'insert', index: left ? i : i + 1, slotIndex: i };
  }
  return { op: 'append', index: Infinity, slotIndex: null };
}

/**
 * 把一张图按落点规则写进某段的 imageIds。
 *
 * 语义：这张图在目标段的位置由落点决定。
 *   - 落在某个槽位上 → 放到它前面/后面
 *   - 落在空白处     → 放到最后
 * 同一张图在同一段里永远只有一份：已经在这一段的图会被「挪」到新位置，
 * 而不是变成两个一样的槽位。
 *
 * @param {object} seg 目标段
 * @param {string} assetId 要加/挪的图
 * @param {{op:string,index:number,slotIndex:number|null}} drop
 * @param {boolean} alt 按住 Alt = 替换那一槽
 * @returns {string[]} 新的 imageIds
 */
export function applyDrop(seg, assetId, drop, alt = false) {
  const ids = [...(seg.imageIds || [])];
  const already = ids.indexOf(assetId);

  // ── Alt：替换那一槽 ──
  if (alt && drop.slotIndex != null) {
    if (ids[drop.slotIndex] === assetId) return ids;
    ids[drop.slotIndex] = assetId;
    return ids;
  }

  // 已经在这一段 → 挪到新位置
  if (already >= 0) {
    if (already === drop.slotIndex) return ids;
    ids.splice(already, 1);
    let at = drop.op === 'insert' ? drop.index : ids.length;
    if (at > already) at -= 1;                // 移除旧位后目标下标左移
    at = Math.max(0, Math.min(ids.length, at));
    ids.splice(at, 0, assetId);
    return ids;
  }

  // 还没有 → 新增
  if (drop.op === 'insert' && drop.index >= 0 && drop.index <= ids.length) {
    ids.splice(drop.index, 0, assetId);
    return ids;
  }
  ids.push(assetId);
  return ids;
}