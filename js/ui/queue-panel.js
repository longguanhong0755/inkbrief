// 队列面板：把「正在跑什么、跑到哪了、哪张失败了」摆在明面上。
//
// 之前生成是一个黑盒 for 循环，跑完才有一句提示。
// 现在每一项都能看到状态、能单独取消、失败的能单独重试。

const STATUS_TEXT = {
  queued: '排队中',
  running: '进行中',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
};
export function createQueuePanel(o) {
  const root = o.root;
  let open = true;
  let items = [];

  root.innerHTML = `
    <div class="qp-head">
      <span class="qp-title">队列</span>
      <span class="qp-sum" data-sum></span>
      <div class="qp-ops">
        <button class="qp-op" type="button" data-op="cancelAll" title="取消排队中的任务">全部取消</button>
        <button class="qp-op" type="button" data-op="retryFailed" title="重试所有失败的任务">重试失败</button>
        <button class="qp-op" type="button" data-op="clear" title="清掉已结束的任务">清理</button>
        <button class="qp-fold" type="button" data-op="fold" title="收起/展开">▾</button>
      </div>
    </div>
    <div class="qp-list" data-list></div>
  `;
  const elSum = root.querySelector('[data-sum]');
  const elList = root.querySelector('[data-list]');
  const elFold = root.querySelector('[data-op="fold"]');

  root.querySelector('.qp-ops').addEventListener('click', (e) => {
    const b = e.target.closest('[data-op]');
    if (!b) return;
    const op = b.dataset.op;
    if (op === 'cancelAll') o.onCancelAll?.();
    else if (op === 'retryFailed') o.onRetryFailed?.();
    else if (op === 'clear') o.onClear?.();
    else if (op === 'fold') {
      open = !open;
      root.classList.toggle('folded', !open);
      elFold.textContent = open ? '▾' : '▸';
    }
  });

  // 单项操作（取消/重试）用事件委托，别给每项都挂监听器
  elList.addEventListener('click', (e) => {
    const b = e.target.closest('[data-item-op]');
    if (!b) return;
    const id = b.dataset.id;
    if (b.dataset.itemOp === 'cancel') o.onCancel?.(id);
    else if (b.dataset.itemOp === 'retry') o.onRetry?.(id);
    else if (b.dataset.itemOp === 'abort') o.onAbort?.(id);
  });

  function render(list) {
    items = list || [];
    const s = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
    for (const it of items) s[it.status]++;
    const parts = [];
    if (s.running) parts.push(`进行中 ${s.running}`);
    if (s.queued) parts.push(`排队 ${s.queued}`);
    if (s.done) parts.push(`完成 ${s.done}`);
    if (s.failed) parts.push(`失败 ${s.failed}`);
    if (s.cancelled) parts.push(`取消 ${s.cancelled}`);
    elSum.textContent = parts.join(' · ');

    if (!items.length) {
      elList.innerHTML = '<p class="qp-empty">还没有任务。</p>';
      return;
    }

    elList.innerHTML = items.map((it) => {
      const pct = Math.round((it.progress || 0) * 100);
      const canCancel = it.status === 'queued';
      const canAbort = it.status === 'running' && !it.aborting;
      const canRetry = it.status === 'failed' || it.status === 'cancelled';
      const statusText = it.aborting && it.status === 'running' ? '停止中' : (STATUS_TEXT[it.status] || it.status);
      const op = canCancel
        ? `<button class="qp-i" type="button" data-item-op="cancel" data-id="${it.id}" title="取消这一项">取消</button>`
        : canAbort
          ? `<button class="qp-i" type="button" data-item-op="abort" data-id="${it.id}" title="中止这一项">中止</button>`
          : canRetry
            ? `<button class="qp-i" type="button" data-item-op="retry" data-id="${it.id}" title="重试这一项">重试</button>`
            : '';
      return `
        <div class="qp-item ${it.status}" data-item="${it.id}">
          <div class="qp-item-top">
            <span class="qp-item-name">${escapeHtml(it.label)}</span>
            <span class="qp-item-status">${statusText}</span>
            ${op}
          </div>
          ${it.detail ? `<div class="qp-item-detail">${escapeHtml(it.detail)}</div>` : ''}
          ${it.status === 'running' ? `<div class="qp-bar"><i style="width:${pct}%"></i></div>` : ''}
          ${it.status === 'done' && it.attempt > 1 ? `<div class="qp-item-detail">第 ${it.attempt} 次尝试成功</div>` : ''}
          ${it.error ? `<div class="qp-item-err">${escapeHtml(it.error)}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  return {
    render,
    setItems(list) { render(list); },
    getItems() { return items; },
    setOpen(v) {
      open = !!v;
      root.classList.toggle('folded', !open);
      elFold.textContent = open ? '▾' : '▸';
    },
  };
}
