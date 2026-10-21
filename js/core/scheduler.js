// 任务队列：把「给每张图分析笔触」「给每段配语音」这类长活儿排成队。
//
// 为什么要队列：
//   一次生成要跑十几张图的笔触分析，每张几秒到几十秒。
//   之前是一个 for 循环从头跑到尾，中途出错就整批停，用户既看不到
//   「跑到第几张了」，也没法只重试失败的那张。
//
// 四态：
//   queued   排队中（还没开始）
//   running  进行中（带进度）
//   done     成功
//   failed   失败（可以单独重试）
//   cancelled 已取消
//
// 取消是「协作式」：任务自己在关键节点检查 ctx.signal.aborted，
// 已经开始跑的那一步不强杀（笔触分析在 worker 里，杀不掉也不该杀）。

/** @typedef {'queued'|'running'|'done'|'failed'|'cancelled'} TaskStatus */

// 调度用 rAF（跟下一帧对齐），但 Node 里没有 rAF —— 降级成定时器，
// 这样这份逻辑能脱离浏览器直接测。
const raf = typeof requestAnimationFrame === 'function'
  ? (fn) => requestAnimationFrame(fn)
  : (fn) => setTimeout(() => fn(Date.now()), 16);

export class TaskQueue {
  /**
   * @param {object} o
   * @param {number} [o.concurrency] 同时跑几个（默认 1：笔触分析很吃 CPU）
   * @param {(items:Array) => void} [o.onChange] 队列有任何变化就调
   */
  constructor(o = {}) {
    this.concurrency = Math.max(1, Number(o.concurrency) || 1);
    this.onChange = o.onChange;
    this.items = [];
    this.running = 0;
    this._seq = 0;
    this._pumpRaf = null;   // rAF 句柄
  }

  /**
   * 加一个任务。
   * @param {object} t
   * @param {string} t.id 业务 id（同一 id 重复加会替换掉旧的）
   * @param {string} t.label 显示名
   * @param {(ctx:{signal:{aborted:boolean}, onProgress:(p:number)=>void}) => Promise<any>} t.run
   * @param {string} [t.group] 分组名（面板按组显示）
   * @param {string} [t.detail] 副标题
   */
  add(t) {
    const item = {
      id: t.id,
      label: t.label,
      detail: t.detail || '',
      group: t.group || '',
      run: t.run,
      status: 'queued',
      progress: 0,
      error: '',
      attempt: 0,
      aborting: false,
    };
    const i = this.items.findIndex((x) => x.id === t.id);
    if (i >= 0) this.items[i] = item;
    else this.items.push(item);
    this.emit();
    return item;
  }

  /** 去掉某个任务（已经跑完的清理掉） */
  remove(id) {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return;
    if (this.items[i].status === 'running') return;   // 跑着的别删
    this.items.splice(i, 1);
    this.emit();
  }

  /** 清掉所有已结束的（保留排队和进行中的） */
  clearFinished() {
    this.items = this.items.filter((x) => x.status === 'queued' || x.status === 'running');
    this.emit();
  }

  /** 开始跑。已在跑的不受影响。 */
  start() {
    this._pump();
  }

  /** 取消某个还没开始的任务 */
  cancel(id) {
    const it = this.items.find((x) => x.id === id);
    if (!it || it.status !== 'queued') return false;
    it.status = 'cancelled';
    this.emit();
    return true;
  }

  /** 取消所有排队中的（进行中的不强杀，但会标记不再继续下一项） */
  cancelAll() {
    let n = 0;
    for (const it of this.items) {
      if (it.status === 'queued') { it.status = 'cancelled'; n++; }
    }
    this.emit();
    return n;
  }

  /** 重试一个失败或取消的任务 */
  retry(id) {
    const it = this.items.find((x) => x.id === id);
    if (!it) return false;
    if (it.status !== 'failed' && it.status !== 'cancelled') return false;
    it.status = 'queued';
    it.progress = 0;
    it.error = '';
    this.emit();
    this._pump();
    return true;
  }

  /** 重试所有失败的 */
  retryFailed() {
    let n = 0;
    for (const it of this.items) {
      if (it.status === 'failed' || it.status === 'cancelled') {
        it.status = 'queued';
        it.progress = 0;
        it.error = '';
        n++;
      }
    }
    this.emit();
    if (n) this._pump();
    return n;
  }

  /** 有没有还在跑的或排队的 */
  isActive() {
    return this.items.some((x) => x.status === 'queued' || (x.status === 'running' && !x.aborting));
  }

  /**
   * 只看某类任务（比如 'stroke:' 开头的笔触分析）有没有还在跑的或排队的。
   * 「生成」按钮的文案要按这个来：配音在跑不该让「生成」变成「停止生成」。
   * @param {(item:object)=>boolean} pred
   */
  isActiveWhere(pred) {
    return this.items.some((x) =>
      (x.status === 'queued' || (x.status === 'running' && !x.aborting)) && pred(x));
  }

  /** 全部完成（没有排队/进行中的） */
  isDone() {
    return !this.isActive();
  }

  get summary() {
    const s = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
    for (const it of this.items) s[it.status]++;
    return s;
  }

  emit() {
    this.onChange?.(this.items);
  }

  /** 从队列里取下一个能跑的任务 */
  _pump() {
    // 注意：_pumpRaf 存的是 rAF 的句柄，_pump 是方法名，别混用
    if (this._pumpRaf) return;
    this._pumpRaf = raf(() => {
      this._pumpRaf = null;
      this._drain();
    });
  }

  async _drain() {
    while (this.running < this.concurrency) {
      const next = this.items.find((x) => x.status === 'queued');
      if (!next) break;
      this.running++;
      next.status = 'running';
      next.progress = 0;
      next.error = '';
      next.attempt++;
      this.emit();
      // 不 await：并发数由 running 计数控制
      this._runOne(next).finally(() => {
        this.running--;
        this.emit();
        if (this.isActive()) this._pump();
      });
    }
    this.emit();
  }

  async _runOne(item) {
    const signal = { aborted: false };
    item._signal = signal;
    try {
      await item.run({
        signal,
        onProgress: (p) => {
          if (item.status !== 'running') return;
          const v = Math.max(0, Math.min(1, Number(p) || 0));
          if (Math.abs(v - item.progress) > 0.005) {
            item.progress = v;
            this.emit();
          }
        },
      });
      // 跑完了但中途被取消 → 记成取消，不是成功
      item.status = signal.aborted ? 'cancelled' : 'done';
      item.progress = 1;
    } catch (err) {
      if (signal.aborted) {
        item.status = 'cancelled';
      } else {
        item.status = 'failed';
        item.error = String(err?.message || err || '未知错误');
      }
    } finally {
      item._signal = null;
    }
    this.emit();
  }

  /** 请求取消正在跑的任务（协作式，任务自己会检查） */
  requestAbort(id) {
    const it = this.items.find((x) => x.id === id);
    if (!it || it.status !== 'running') return false;
    if (it._signal) it._signal.aborted = true;
    it.aborting = true;      // 已经开始收尾，不再算「活跃」
    this.emit();
    return true;
  }

  /** 全部取消：排队的标取消，在跑的请求中止 */
  abortAll() {
    let n = 0;
    for (const it of this.items) {
      if (it.status === 'queued') { it.status = 'cancelled'; n++; }
      else if (it.status === 'running' && it._signal) {
        it._signal.aborted = true;
        it.aborting = true;
        n++;
      }
    }
    this.emit();
    return n;
  }
}
