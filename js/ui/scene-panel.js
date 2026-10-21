// 右侧场景设置栏：选中一屏后，把这一屏的所有设置摊开在这里改。
//
// 为什么要有它：
//   段卡在中间那一列，要改「这一屏用什么图、字幕放哪、这屏多长」得先找到那张卡，
//   找到之后还得在一堆按钮里找对应的那一个。
//   这里只显示当前选中的那一屏，一个 tab 一类设置，改完立刻能看到。
//
// 三个 tab 的分工：
//   画面 —— 这一屏用哪几张图、每张停多久（权重）、画得满不满（抽稀提示）
//   字幕 —— 怎么分句、显示在哪个位置
//   时间 —— 这屏多长、时长是谁定的、配音要变速多少
//
// 所有改动都通过回调交给上层（main.js）落地，
// 本模块自己不碰 state，只读不写——避免「界面改了但数据没改」。

const CAP_POS = [
  { key: 'bottom', label: '贴底' },
  { key: 'lower', label: '抬高' },
  { key: 'upper', label: '置顶' },
];

const TABS = [
  { key: 'visual', label: '画面' },
  { key: 'caption', label: '字幕' },
  { key: 'time', label: '时间' },
];

/**
 * @param {object} o
 * @param {HTMLElement} o.root 容器
 * @param {object} o.state 全局 state
 * @param {() => object|null} o.getSeg 取当前选中的段（返回 null 表示没选中）
 * @param {() => object|null} o.getScene 取当前选中段对应的时间轴场景
 * @param {(segId:string) => void} o.onSelect 点面板里的某一项时同步选中段
 * @param {(segId:string, imageIds:string[], weights:number[]) => void} o.onImages 改这一屏的图
 * @param {(segId:string, paragraphs:string[], capPos:string) => void} o.onCaptions 改字幕
 * @param {(segId:string, ms:number|null) => void} o.onDuration 改时长（null = 回到自动）
 * @param {(segId:string) => void} o.onVoice 给这一屏配音
 * @param {(ms:number) => void} o.onSeek 跳到某一刻
 */
export function createScenePanel(o) {
  const root = o.root;
  let tab = 'visual';
  let open = false;   // 抽屉在窄屏下是否展开

  root.innerHTML = `
    <div class="sp-head">
      <h2>场景设置</h2>
      <button class="sp-close" type="button" title="收起" data-close>×</button>
    </div>
    <div class="sp-tabs" data-tabs></div>
    <div class="sp-body" data-body></div>
  `;
  const elTabs = root.querySelector('[data-tabs]');
  const elBody = root.querySelector('[data-body]');
  const elHead = root.querySelector('.sp-head h2');

  for (const t of TABS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sp-tab';
    b.textContent = t.label;
    b.dataset.tab = t.key;
    b.addEventListener('click', () => {
      tab = t.key;
      render();
    });
    elTabs.appendChild(b);
  }

  root.querySelector('[data-close]').addEventListener('click', () => {
    open = false;
    render();
  });

  function render() {
    const seg = o.getSeg?.();
    const sc = o.getScene?.();
    if (!seg) {
      root.hidden = true;
      root.classList.remove('open');
      document.querySelector('.grid')?.classList.remove('has-scene');
      return;
    }
    root.hidden = false;
    root.classList.toggle('open', open);
    // 布局要跟着变：多一列才有地方放这个栏
    document.querySelector('.grid')?.classList.add('has-scene');

    const idx = o.state.segs.findIndex((s) => s.id === seg.id);
    elHead.innerHTML = `<b>${idx >= 0 ? idx + 1 : '?'}</b> 第 ${idx + 0 >= 0 ? idx + 1 : '?'} 屏设置`;

    for (const b of elTabs.querySelectorAll('.sp-tab')) {
      b.classList.toggle('on', b.dataset.tab === tab);
    }

    if (!sc) {
      elBody.innerHTML = '<p class="sp-empty">这一屏还没配图，不会出现在成片里。回左边给它配一张。</p>';
      return;
    }

    if (tab === 'visual') renderVisual(seg, sc);
    else if (tab === 'caption') renderCaption(seg, sc);
    else renderTime(seg, sc);
  }

  // ── 画面 ──────────────────────────────────────
  function renderVisual(seg, sc) {
    const assets = o.state.assets;
    const items = sc.items || [];
    const rows = items.map((it, i) => {
      const asset = assets.find((a) => a.id === it.assetId);
      const pct = Math.round((it.weight / items.reduce((a, b) => a + b.weight, 0)) * 100);
      return `
        <div class="sp-item">
          <img class="sp-thumb" src="${asset?.url || ''}" alt="">
          <div class="sp-item-main">
            <div class="sp-item-title">图 ${assets.findIndex((a) => a.id === it.assetId) + 1}${items.length > 1 ? ` · 占 ${pct}%` : ''}</div>
            <div class="sp-item-sub">${it.strokeCount} 笔${it.keep < it.strokeCount ? `，保留 ${it.keep} 笔（抽稀 ${Math.round((1 - it.keepRatio) * 100)}%）` : '，全保留'}</div>
          </div>
          ${items.length > 1 ? `
            <label class="sp-w" title="这一张占多少时间（相对值）">
              <input type="number" step="0.1" min="0.1" value="${it.weight}" data-w="${i}">
            </label>` : ''}
        </div>
        ${it.keep < it.strokeCount ? `<p class="sp-warn">这一屏画不完 ${it.strokeCount} 笔，只能画 ${it.keep} 笔。把时长拖长一点就能多画。</p>` : ''}
      `;
    }).join('');

    elBody.innerHTML = `
      <div class="sp-sec">这一屏的画面</div>
      ${rows || '<p class="sp-empty">没有图。</p>'}
      ${items.length > 1 ? `
        <div class="sp-sec">权重怎么定的</div>
        <p class="sp-note">数字是相对值：2 和 1 表示第一张占三分之二的时间。改完立刻重排这一屏。</p>` : ''}
      <div class="sp-sec">操作</div>
      <div class="sp-actions">
        <button class="ghost" type="button" data-act="voice">${seg.audio ? '重新配音' : '给这屏配音'}</button>
        <button class="ghost" type="button" data-act="fit">按画面重排</button>
      </div>
    `;

    // 权重输入
    elBody.querySelectorAll('input[data-w]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const i = Number(inp.dataset.w);
        const weights = seg.weights.slice();
        weights[i] = Math.max(0.1, Number(inp.value) || 1);
        o.onImages?.(seg.id, seg.imageIds, weights);
        setEditing(false);
        render();
      });
    });

    elBody.querySelector('[data-act="voice"]')?.addEventListener('click', () => o.onVoice?.(seg.id));
    elBody.querySelector('[data-act="fit"]')?.addEventListener('click', () => {
      // 均分权重：多图各停一样长
      o.onImages?.(seg.id, seg.imageIds, seg.imageIds.map(() => 1));
      setEditing(false);
      render();
    });
  }

  // ── 字幕 ──────────────────────────────────────
  function renderCaption(seg, sc) {
    // 编辑态用 seg.paragraphs（保留用户新加的、还没填的空框），
    // 成片态用 sc.paragraphs（已过滤掉空句）。
    const paras = (seg.paragraphs && seg.paragraphs.length ? seg.paragraphs : ['']).map(String);
    const spans = sc.capSpans || [];
    const list = paras.map((p, i) => {
      // 空句不进成片，所以没有对应的时间片
      const span = p.trim() ? spans[i] : null;
      return `
        <div class="sp-cap" data-cap="${i}">
          <div class="sp-cap-head">
            <span class="sp-cap-no">第 ${i + 1} 句</span>
            <span class="sp-cap-dur">${span ? (span.dur / 1000).toFixed(1) + 's' : ''}</span>
            ${paras.length > 1 ? `<button class="sp-x" type="button" data-del="${i}" title="删掉这句">×</button>` : ''}
          </div>
          <textarea rows="2" data-captext="${i}" placeholder="写第 ${i + 1} 句">${escapeHtml(p)}</textarea>
        </div>
      `;
    }).join('');

    elBody.innerHTML = `
      <div class="sp-sec">字幕怎么分句</div>
      <p class="sp-note">一屏可以有多句字幕，按时间依次出现。改完这里，下面预览会跟着换。</p>
      ${list}
      <div class="sp-actions">
        <button class="ghost" type="button" data-act="add-cap">加一句字幕</button>
        <button class="ghost" type="button" data-act="split-cap">按标点自动分句</button>
      </div>
      <div class="sp-sec">字幕位置</div>
      <div class="sp-radios">
        ${CAP_POS.map((c) => `
          <label class="sp-radio">
            <input type="radio" name="capPos" value="${c.key}" ${seg.capPos === c.key ? 'checked' : ''}>
            <span>${c.label}</span>
          </label>`).join('')}
      </div>
    `;

    elBody.querySelectorAll('textarea[data-captext]').forEach((ta) => {
      ta.addEventListener('input', () => {
        const list2 = paras.slice();
        list2[Number(ta.dataset.captext)] = ta.value;
        o.onCaptions?.(seg.id, list2, seg.capPos);
      });
    });

    elBody.querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', () => {
        const list2 = paras.filter((_, i) => i !== Number(b.dataset.del));
        o.onCaptions?.(seg.id, list2.length ? list2 : [''], seg.capPos);
        // 结构性改动：句数变了，输入框数量也得变，必须重画
        setEditing(false);
        render();
      });
    });

    elBody.querySelector('[data-act="add-cap"]')?.addEventListener('click', () => {
      o.onCaptions?.(seg.id, [...paras, ''], seg.capPos);
      setEditing(false);
      render();
    });

    elBody.querySelector('[data-act="split-cap"]')?.addEventListener('click', () => {
      const full = paras.join('');
      const parts = full.split(/(?<=[。！？])/).map((s) => s.trim()).filter(Boolean);
      o.onCaptions?.(seg.id, parts.length ? parts : paras, seg.capPos);
      setEditing(false);
      render();
    });

    elBody.querySelectorAll('input[name="capPos"]').forEach((r) => {
      r.addEventListener('change', () => {
        o.onCaptions?.(seg.id, paras, r.value);
        setEditing(false);
        render();
      });
    });
  }

  // ── 时间 ──────────────────────────────────────
  function renderTime(seg, sc) {
    const audioMs = seg.audio ? Math.round(seg.audio.duration * 1000) : 0;
    const manual = Number(seg.manualMs) || 0;
    const source = manual > 0 ? '手动' : (audioMs > 0 ? '配音' : '按字数估');
    const speed = audioMs ? (audioMs / sc.dur) : 1;
    const lo = Math.round(audioMs ? audioMs * 0.55 : Math.min(sc.dur * 0.5, 6000));
    const hi = Math.round(audioMs ? Math.max(audioMs * 2, 2000) : Math.max(sc.dur * 2, 6000));
    const val = Math.round(Math.max(lo, Math.min(hi, sc.dur)));

    elBody.innerHTML = `
      <div class="sp-sec">这一屏多长</div>
      <div class="sp-time-now">
        <b>${(sc.dur / 1000).toFixed(1)}s</b>
        <span>时长来自：${source}</span>
      </div>
      <input class="sp-range" type="range" min="${lo}" max="${hi}" value="${val}" step="50">
      <p class="sp-note">
        拖滑块改这一屏的时长。
        ${audioMs ? `配音是 ${(audioMs / 1000).toFixed(1)}s，会变速到 ${speed.toFixed(2)}× 来对齐——不会截断也不会重录。` : '这一屏还没配音，时长是按字数估的。'}
      </p>
      ${manual > 0 ? '<button class="ghost" type="button" data-act="auto">恢复自动时长</button>' : ''}

      <div class="sp-sec">这一屏的时间都去哪了</div>
      <ul class="sp-break">
        <li><span>作画</span><b>${(sc.drawMs / 1000).toFixed(1)}s</b></li>
        <li><span>结尾留白</span><b>${((sc.dur - sc.drawMs) / 1000).toFixed(1)}s</b></li>
        ${sc.items.length > 1 ? sc.items.map((it, i) => `<li><span>图 ${i + 1}</span><b>${(it.dur / 1000).toFixed(1)}s</b></li>`).join('') : ''}
        ${(sc.capSpans || []).map((sp, i) => `<li><span>字幕 ${i + 1}</span><b>${(sp.dur / 1000).toFixed(1)}s</b></li>`).join('')}
      </ul>
      <div class="sp-actions">
        <button class="ghost" type="button" data-act="voice">${seg.audio ? '重新配音' : '给这屏配音'}</button>
        <button class="ghost" type="button" data-act="seek">跳到这一屏</button>
      </div>
    `;

    const range = elBody.querySelector('.sp-range');
    range?.addEventListener('input', (e) => {
      // 拖动时只改数字，不重画（重画会把滑块从手指底下抽走）
      const ms = Number(e.target.value);
      const big = elBody.querySelector('.sp-time-now b');
      if (big) big.textContent = (ms / 1000).toFixed(1) + 's';
      o.onDuration?.(seg.id, ms);
    });
    // 松手后重画一次，把明细刷新过来
    range?.addEventListener('change', () => {
      setEditing(false);
      render();
    });
    elBody.querySelector('[data-act="auto"]')?.addEventListener('click', () => {
      o.onDuration?.(seg.id, null);
      setEditing(false);
      render();
    });
    elBody.querySelector('[data-act="voice"]')?.addEventListener('click', () => o.onVoice?.(seg.id));
    elBody.querySelector('[data-act="seek"]')?.addEventListener('click', () => o.onSeek?.(sc.start));
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /**
   * 标记「用户正在面板里输入」。
   * 上层据此跳过重画本面板——否则每敲一个字就重建 DOM，输入框会失焦。
   */
  function setEditing(on) {
    o.onEditingChange?.(!!on);
  }
  // 失焦时解除标记：焦点离开面板后，数据变化要能正常重画
  root.addEventListener('focusout', (e) => {
    if (root.contains(e.relatedTarget)) return;
    setEditing(false);
  });
  root.addEventListener('focusin', () => setEditing(true));

  return {
    render,
    /** 切到某个 tab（外部点「画面/字幕/时间」时用） */
    setTab(k) { tab = k; render(); },
    getTab() { return tab; },
    /** 展开 / 收起（窄屏抽屉） */
    setOpen(v) { open = !!v; render(); },
    isOpen() { return open; },
  };
}
