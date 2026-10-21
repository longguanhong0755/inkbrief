// 文本 -> 音素 id 序列。
// 中文：拼音（pinyin-pro 按词组判多音字）-> 音节表 -> 音素 id。
// 数字：按位读（2026 -> 二零二六）。英文：按字母名读中文音。
// 表由 dev/build_phoneme_ids.mjs 离线生成，见 assets/tts/zh-phonemes.json。

const DIGITS = ['ling2', 'yi1', 'er4', 'san1', 'si4', 'wu3', 'liu4', 'qi1', 'ba1', 'jiu3'];
const LETTERS = {
  a: ['ei1'], b: ['bi1'], c: ['xi1'], d: ['di1'], e: ['yi1'], f: ['ai4', 'fu1'],
  g: ['ji1'], h: ['ai4', 'chi3'], i: ['ai4'], j: ['jie2'], k: ['kai1'],
  l: ['ai4', 'lu4'], m: ['ai4', 'mu3'], n: ['en1'], o: ['ou1'], p: ['pi1'],
  q: ['qiu1'], r: ['a4'], s: ['ai4', 'si1'], t: ['ti1'], u: ['you1'],
  v: ['wei1'], w: ['da1', 'bu4', 'liu2'], x: ['ai4', 'ke4', 'si1'], y: ['wai4'], z: ['zei2'],
};

// 轻声（5）常缺条目，按顺序回退
const TONE_FALLBACK = [4, 1, 2, 3];

// 半角标点 → 音素表里的全角键。
// 音素表的 punct 键全是全角（，。！？；：、—…（）），
// 查表前先做这一步映射，半角输入才不会查不到。
const PUNCT_FALLBACK = {
  ',': '，', '.': '。', '!': '！', '?': '？', ';': '；', ':': '：',
  '(': '（', ')': '）', '—': '—', '…': '…',
};

// 标点与空白（切块用）：全角半角都要覆盖
const PUNCT_CLASS = '，。！？；：、（）—…,.!?;:"\'()';
const SPLIT_RE = /([，。！？；：、（）—…,.!?;:"'()\s]+)/;
const IS_PUNCT_RE = /^[，。！？；：、（）—…,.!?;:"'()\s]+$/;

const isHan = (c) => c >= '\u4e00' && c <= '\u9fa5';

export function createSequencer(table, pinyinFn) {
  const { syl } = table;
  const push = (ids, arr) => { for (const v of arr) ids.push(v); };

  function sylIds(token) {
    const key = token.replace(/ü/g, 'v');
    if (syl[key]) return syl[key];
    const m = /^([a-z]+)([1-5])$/.exec(key);
    if (m) {
      // 韵母简写兜底：zhi/chi/shi/ri/zi/ci/si 的 i 与普通 i 同表，无需特判
      for (const t of TONE_FALLBACK) {
        const v = syl[m[1] + t];
        if (v) return v;
      }
      // 再兜一层：去掉声调符号后按无调音节查（表里不存在则返回空）
      if (syl[m[1]]) return syl[m[1]];
    }
    return null;
  }

  function emitWord(word, ids) {
    // 纯数字：逐位读
    if (/^\d+$/.test(word)) {
      for (const d of word) push(ids, sylIds(DIGITS[+d]));
      return true;
    }
    // 小数/百分比等含数字的混排：拆开逐段处理
    if (/\d/.test(word) && /[a-z]/i.test(word)) {
      const parts = word.match(/\d+|[a-zA-Z]+|[^\da-zA-Z]+/g) || [];
      for (const p of parts) emitWord(p, ids);
      return true;
    }
    // 纯英文：按字母名读
    if (/^[a-zA-Z]+$/.test(word)) {
      for (const ch of word.toLowerCase()) {
        const seq = LETTERS[ch];
        if (seq) for (const s of seq) { const v = sylIds(s); if (v) push(ids, v); }
      }
      return true;
    }
    return false;
  }

  return function sequenceOf(text) {
    const ids = [table.bos];
    if (!text || !text.trim()) { ids.push(table.eos); return ids; }

    // 归一化：
    // - 全角字母数字转半角（拼音库只认半角）
    // - 全角标点**保持全角**：音素表的 punct 键就是全角，转半角就查不到了
    // - 省略号保留（表里有「…」的键），破折号统一成「—」
    const norm = text
      .replace(/[\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/g, (c) =>
        String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/\u3000/g, ' ')
      .replace(/[“”‘’]/g, '')
      .replace(/[–—]/g, '—');

    // 按标点与空白切块，保留标点
    const chunks = norm.split(SPLIT_RE).filter((s) => s.length);

    for (const chunk of chunks) {
      if (!chunk.trim()) { continue; }
      // 标点
      if (IS_PUNCT_RE.test(chunk)) {
        for (const ch of chunk) {
          const key = table.punct[ch] !== undefined ? ch : PUNCT_FALLBACK[ch];
          if (key !== undefined && table.punct[key] !== undefined) ids.push(table.punct[key]);
        }
        continue;
      }
      // 中文段：整体交给 pinyin-pro，按词组判多音字
      if (pinyinFn && /[\u4e00-\u9fa5]/.test(chunk)) {
        let arr = [];
        try {
          arr = pinyinFn(chunk, { toneType: 'num', type: 'array', nonZh: 'consecutive' });
        } catch { arr = []; }
        let any = false;
        for (const tok of arr) {
          if (/^[a-zü]+[1-5]$/.test(tok)) {
            const v = sylIds(tok);
            if (v) { push(ids, v); ids.push(table.space); any = true; }
            else if (/^[a-zü]+$/.test(tok)) {
              const v2 = sylIds(tok + '4') || sylIds(tok + '1');
              if (v2) { push(ids, v2); ids.push(table.space); any = true; }
            }
          } else if (/^[a-zA-Z0-9.%]+$/.test(tok)) {
            if (emitWord(tok, ids)) { ids.push(table.space); any = true; }
          }
        }
        // pinyin-pro 失败时退回逐字
        if (!any) {
          for (const ch of chunk) {
            if (!isHan(ch)) continue;
            let t = [];
            try { t = pinyinFn(ch, { toneType: 'num', type: 'array' }) || []; } catch { t = []; }
            for (const tok of t) {
              if (/^[a-zü]+[1-5]$/.test(tok)) {
                const v = sylIds(tok);
                if (v) { push(ids, v); ids.push(table.space); }
              }
            }
          }
        }
        continue;
      }
      // 纯非中文段
      emitWord(chunk, ids);
    }

    // 去掉连续重复的分隔与首尾分隔
    const out = [ids[0]];
    for (let i = 1; i < ids.length; i++) {
      if (ids[i] === table.eos) continue;
      if (ids[i] === table.space && out[out.length - 1] === table.space) continue;
      out.push(ids[i]);
    }
    while (out.length > 1 && out[out.length - 1] === table.space) out.pop();
    out.push(table.eos);
    return out;
  };
}
