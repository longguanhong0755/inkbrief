// 撤销/重做栈。
//
// 为什么用「快照 + 对比」而不是逐个操作写反向补丁：
//   这个工具的改动点太散——分段、删段、合并、排序、拖拽绑图、字幕分句、
//   字幕位置、时长滑块、换图……每处都手写一遍反向逻辑，漏一处就永久错乱。
//   快照法只需要在「改之前拍一张、改之后拍一张」，漏不掉。
//
// 快照只存轻量状态：
//   段：id / imageIds / weights / paragraphs / capPos / manualMs
//   素材：整个对象数组（按引用存，不拷贝画布和笔触）
//   笔触、音频这些大块数据不进来——它们不会被「撤销」改坏，
//   真被删了图，素材对象还在快照里（引用），能原样恢复。

/** 比较两份快照是否一样（只看 JSON 里的轻量字段） */
function sameSnapshot(a, b) {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export class UndoStack {
  /**
   * @param {object} o
   * @param {() => object} o.capture 拍当前状态
   * @param {(snap:object) => void} o.restore 恢复到一个状态
   * @param {(info:{canUndo:boolean, canRedo:boolean, undoLabel:string, redoLabel:string}) => void} [o.onChange]
   * @param {number} [o.limit] 最多记多少步
   */
  constructor(o) {
    this.capture = o.capture;
    this.restore = o.restore;
    this.onChange = o.onChange;
    this.limit = o.limit || 60;
    this.past = [];
    this.future = [];
  }

  /**
   * 在撤销栈里跑一个会改状态的操作。
   * @param {string} label 操作名（显示在提示里）
   * @param {() => any} fn 真正干活的函数
   * @param {string} [coalesceKey] 相同 key 的连续操作会合并成一步
   *   （比如连续打字，撤销一次应该回到打字前，而不是只撤一个字符）
   */
  run(label, fn, coalesceKey = null) {
    const before = this.capture();
    let result;
    try {
      result = fn();
    } catch (err) {
      // 操作失败：把状态摆回去，别留下半截改动
      this.restore(before);
      throw err;
    }
    const after = this.capture();
    // 没真改变就别占历史（点「上移」在第一段上这种）
    if (sameSnapshot(before, after)) return result;

    const last = this.past[this.past.length - 1];
    if (coalesceKey && last && last.coalesceKey === coalesceKey) {
      // 合并：保留最初的 before，把 after 推到最新
      last.after = after;
      last.label = label;
      this.future.length = 0;
      this.emit();
      return result;
    }

    this.past.push({ label, before, after, coalesceKey });
    if (this.past.length > this.limit) this.past.shift();
    this.future.length = 0;   // 新的操作会作废「重做」这条路
    this.emit();
    return result;
  }

  /**
   * 跑一个操作，但「撤销要回到的状态」由调用方指定。
   *
   * 用在滑块这类场景：拖动过程中值已经改掉了，等松手才记一步，
   * 但撤销要回到的是**拖动前**的值，不是「松手前一刻」的值。
   *
   * @param {string} label
   * @param {() => any} fn
   * @param {() => object} makeBefore 造出「撤销要回到的那份状态」
   */
  runWithBefore(label, fn, makeBefore) {
    const before = this.capture();
    let result;
    try {
      result = fn();
    } catch (err) {
      this.restore(before);
      throw err;
    }
    const after = this.capture();
    if (sameSnapshot(before, after)) return result;

    const realBefore = makeBefore ? makeBefore(before) : before;
    this.past.push({ label, before: realBefore, after, coalesceKey: null });
    if (this.past.length > this.limit) this.past.shift();
    this.future.length = 0;
    this.emit();
    return result;
  }

  undo() {
    const e = this.past.pop();
    if (!e) return null;
    this.restore(e.before);
    this.future.push(e);
    this.emit();
    return e.label;
  }

  redo() {
    const e = this.future.pop();
    if (!e) return null;
    this.restore(e.after);
    this.past.push(e);
    this.emit();
    return e.label;
  }

  canUndo() { return this.past.length > 0; }
  canRedo() { return this.future.length > 0; }
  undoLabel() { return this.past.length ? this.past[this.past.length - 1].label : ''; }
  redoLabel() { return this.future.length ? this.future[this.future.length - 1].label : ''; }

  /** 清空历史（重新分段、换了稿子之后，旧的撤销路径就没意义了） */
  clear() {
    this.past.length = 0;
    this.future.length = 0;
    this.emit();
  }

  emit() {
    this.onChange?.({
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      undoLabel: this.undoLabel(),
      redoLabel: this.redoLabel(),
    });
  }
}
