/* ==========================================================================
   js/recorder.js —— 内测记录器（纯本机 / 无后端 / 可离线）
   目的：把「试玩时看到的那个问题」连同当时的局势一起留下来，
   一条记录就能让对接人复现，不必再问「你当时在第几层、什么牌、多少污染」。

   三条原则（和 diag.js 一致）：
     1. **只存本机**：数据只进 localStorage，不联网、不上报
     2. **一条也能带走**：Markdown / JSON / 提示词三种导出，直接粘给人或 AI
     3. **有上限**：最多 200 条，超了丢最旧的

   对外 API（window.REC）：
     REC.sevs() / REC.areas()          可选类型 / 位置
     REC.session() / REC.setSession({who,note})
     REC.entries() / REC.add({text,sev,area})
     REC.update(id, patch) / REC.remove(id) / REC.clear()
     REC.stats()
     REC.markdown() / REC.brief() / REC.jsonText()
     REC.importText(text)              合并导入（按 id 去重）
     REC.copy(text) / REC.download(name, text, mime)
     REC.build()                       版本 / 构建号 / 地址
   ========================================================================== */
(function (root) {
  'use strict';

  const KEY = 'cf37_pt_v1';
  const MAX_ENTRIES = 200;
  const MAX_TEXT = 1200;
  const MAX_WHO = 40;

  const SEVS = [
    { id: 'bug', label: 'Bug', hint: '报错 / 卡死 / 数值不对' },
    { id: 'block', label: '卡住', hint: '流程走不下去、不知道点哪' },
    { id: 'ux', label: '手感', hint: '按钮、布局、动画、提示' },
    { id: 'balance', label: '平衡', hint: '某张牌 / 某场战斗过强过弱' },
    { id: 'text', label: '文案', hint: '错字、语感、和设定不符' },
    { id: 'other', label: '其他', hint: '建议、想法' }
  ];
  const AREAS = ['战斗', '地图', '商店', '休整', '事件', '档案', '开场', '界面', '其他'];
  const SEV_LABEL = SEVS.reduce((o, s) => { o[s.id] = s.label; return o; }, {});

  const store = (() => { try { return root.localStorage || null; } catch (e) { return null; } })();
  let cache = null;

  /* ------------------------------ 基础 ------------------------------ */
  function empty() {
    return {
      v: 1,
      session: { id: 'S' + Date.now().toString(36), who: '', note: '', startedAt: Date.now() },
      entries: [],
      updatedAt: 0
    };
  }

  function load() {
    if (!store) return empty();
    try {
      const raw = store.getItem(KEY);
      if (!raw) return empty();
      const d = JSON.parse(raw);
      if (!d || typeof d !== 'object') return empty();
      const base = empty();
      const session = Object.assign(base.session, d.session || {});
      const entries = Array.isArray(d.entries) ? d.entries.filter(e => e && typeof e.text === 'string' && e.text.trim()) : [];
      return { v: 1, session, entries: entries.slice(-MAX_ENTRIES), updatedAt: +d.updatedAt || 0 };
    } catch (e) { return empty(); }
  }

  function data() { if (!cache) cache = load(); return cache; }

  function save() {
    const d = data();
    d.updatedAt = Date.now();
    if (!store) return;
    try { store.setItem(KEY, JSON.stringify(d)); } catch (e) { /* 配额满了不能影响游戏 */ }
  }

  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; }

  function newId(d) {
    let i = 1, id = '';
    do { id = 'N' + Date.now().toString(36) + '-' + i++; } while (d.entries.some(e => e.id === id));
    return id;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmt(t) {
    const d = new Date(t || Date.now());
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* ------------------------------ 环境 ------------------------------ */
  function device() {
    const nav = root.navigator || {};
    const ua = String(nav.userAgent || '');
    const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS'
      : /Android/.test(ua) ? 'Android'
        : /Mac OS X/.test(ua) ? 'macOS'
          : /Windows/.test(ua) ? 'Windows'
            : /Linux/.test(ua) ? 'Linux'
              : String(nav.platform || '未知');
    const browser = /Edg\//.test(ua) ? 'Edge'
      : /Chrome\//.test(ua) ? 'Chrome'
        : /Firefox\//.test(ua) ? 'Firefox'
          : /Safari\//.test(ua) ? 'Safari'
            : '浏览器';
    const vp = root.innerWidth && root.innerHeight ? root.innerWidth + '×' + root.innerHeight : '';
    return { os, browser, viewport: vp, dpr: root.devicePixelRatio || 1, ua: clip(ua, 180) };
  }

  function build() {
    const b = root.CF_BUILD || {};
    let url = '';
    try { url = String((root.location && root.location.href) || '').split('#')[0].split('?')[0]; } catch (e) { url = ''; }
    return {
      version: (root.G && root.G.VERSION) || b.version || '',
      commit: b.commit || '',
      builtAt: b.builtAt || '',
      url: b.url || url
    };
  }

  function capture() {
    try {
      if (root.G && typeof root.G.ptContext === 'function') return root.G.ptContext();
    } catch (e) { /* 快照失败不该拦住记录 */ }
    return null;
  }

  function guessArea() {
    const sc = root.G && root.G.S && root.G.S.scene;
    const map = {
      battle: '战斗', map: '地图', shop: '商店', rest: '休整', event: '事件', select: '档案',
      reward: '战斗', chest: '地图', actintro: '地图', archive: '档案', intro: '开场',
      title: '界面', victory: '界面', gameover: '界面'
    };
    return map[sc] || '其他';
  }

  /* ------------------------------ 跨会话的「试玩人」 ------------------------------ */
  const WHO_KEY = 'cf37_pt_who';
  function savedWho() {
    if (!store) return '';
    try { return clip(store.getItem(WHO_KEY) || '', MAX_WHO); } catch (e) { return ''; }
  }

  /* ------------------------------ 写 ------------------------------ */
  function session() {
    const d = data();
    if (!d.session.who) d.session.who = savedWho();
    return Object.assign({}, d.session, { device: device(), build: build() });
  }

  function setSession(patch) {
    const d = data();
    const p = patch || {};
    if (p.who != null) {
      d.session.who = clip(String(p.who).trim(), MAX_WHO);
      if (store) { try { store.setItem(WHO_KEY, d.session.who); } catch (e) {} }
    }
    if (p.note != null) d.session.note = clip(String(p.note).trim(), 400);
    save();
    return session();
  }

  function add(input) {
    const src = input || {};
    const text = clip(String(src.text == null ? '' : src.text).trim(), MAX_TEXT);
    if (!text) return { ok: false, err: 'empty' };
    const d = data();
    const sev = SEV_LABEL[src.sev] ? src.sev : 'other';
    const area = AREAS.indexOf(src.area) >= 0 ? src.area : guessArea();
    const entry = {
      id: newId(d),
      t: Date.now(),
      sev,
      area,
      text,
      who: clip(String(src.who == null ? d.session.who : src.who).trim(), MAX_WHO),
      ctx: src.ctx === undefined ? capture() : src.ctx,
      b: build().commit || ''
    };
    d.entries.push(entry);
    while (d.entries.length > MAX_ENTRIES) d.entries.shift();
    save();
    return { ok: true, entry, total: d.entries.length };
  }

  function update(id, patch) {
    const d = data();
    const e = d.entries.find(x => x.id === id);
    if (!e) return { ok: false, err: 'notfound' };
    const p = patch || {};
    if (p.text != null) {
      const t = clip(String(p.text).trim(), MAX_TEXT);
      if (!t) return { ok: false, err: 'empty' };
      e.text = t;
    }
    if (p.sev != null && SEV_LABEL[p.sev]) e.sev = p.sev;
    if (p.area != null && AREAS.indexOf(p.area) >= 0) e.area = p.area;
    save();
    return { ok: true, entry: e };
  }

  function remove(id) {
    const d = data();
    const i = d.entries.findIndex(x => x.id === id);
    if (i < 0) return { ok: false, err: 'notfound' };
    d.entries.splice(i, 1);
    save();
    return { ok: true, total: d.entries.length };
  }

  function clear() {
    const d = data();
    d.entries = [];
    save();
    return { ok: true, total: 0 };
  }

  /* ------------------------------ 读 ------------------------------ */
  function entries() { return data().entries.slice(); }

  function stats() {
    const d = data();
    const sev = {}, area = {};
    SEVS.forEach(s => { sev[s.id] = 0; });
    AREAS.forEach(a => { area[a] = 0; });
    d.entries.forEach(e => {
      sev[e.sev] = (sev[e.sev] || 0) + 1;
      area[e.area] = (area[e.area] || 0) + 1;
    });
    return {
      total: d.entries.length,
      sev, area,
      withCtx: d.entries.filter(e => e.ctx).length,
      first: d.entries.length ? d.entries[0].t : 0,
      last: d.entries.length ? d.entries[d.entries.length - 1].t : 0,
      startedAt: d.session.startedAt || 0
    };
  }

  /* ------------------------------ 导出 ------------------------------ */
  function ctxLine(ctx) {
    if (!ctx) return '';
    let s = '';
    try { s = JSON.stringify(ctx); } catch (e) { return ''; }
    return s.length > 900 ? s.slice(0, 900) + '…' : s;
  }

  function header() {
    const s = session(), b = s.build, dev = s.device;
    const st = stats();
    const lines = [];
    lines.push('# 采风人·37号仓库 · 内测记录');
    lines.push('');
    lines.push('- 版本：v' + (b.version || '?') + (b.commit ? '（构建 ' + b.commit + (b.builtAt ? ' · ' + b.builtAt : '') + '）' : ''));
    if (b.url) lines.push('- 地址：' + b.url);
    lines.push('- 试玩人：' + (s.who || '未填'));
    lines.push('- 设备：' + [dev.os, dev.browser, dev.viewport].filter(Boolean).join(' · '));
    lines.push('- 会话开始：' + fmt(st.startedAt));
    const parts = SEVS.filter(x => st.sev[x.id]).map(x => x.label + ' ' + st.sev[x.id]);
    lines.push('- 记录条数：' + st.total + (parts.length ? '（' + parts.join(' / ') + '）' : ''));
    if (s.note) lines.push('- 本次重点：' + s.note);
    lines.push('');
    return lines.join('\n');
  }

  function markdown() {
    const d = data();
    const out = [header()];
    if (!d.entries.length) {
      out.push('（还没有记录。）');
      return out.join('\n');
    }
    d.entries.forEach((e, i) => {
      out.push('## ' + (i + 1) + '. [' + (SEV_LABEL[e.sev] || e.sev) + '] ' + e.area + ' · ' + fmt(e.t));
      if (e.who) out.push('*试玩人：' + e.who + '*');
      out.push('');
      out.push(e.text);
      const c = ctxLine(e.ctx);
      if (c) {
        out.push('');
        out.push('```json');
        out.push(c);
        out.push('```');
      }
      out.push('');
    });
    const diagStats = (() => { try { return root.DIAG && root.DIAG.stats ? root.DIAG.stats() : null; } catch (e) { return null; } })();
    if (diagStats && (diagStats.total || diagStats.notes)) {
      out.push('---');
      out.push('诊断附录（自动）：事件 ' + (diagStats.total || 0) + ' 条' + (diagStats.byKind ? '（' + diagStats.byKind + '）' : '') + '；更完整的反馈包请在游戏内点「导出反馈包」。');
      out.push('');
    }
    return out.join('\n');
  }

  /** 直接可以粘给 AI 的一段话：先给结论口径，再给记录本体。 */
  function brief() {
    const b = build();
    const md = markdown();
    return [
      '这是《采风人·37号仓库》的内测记录（v' + (b.version || '?') + (b.commit ? ' / ' + b.commit : '') + '）。',
      '请按这个顺序处理：①「卡住」——先让流程能走通；②「Bug」——找根因并补回归测试；③「平衡」——用 tools/check-balance.js 与 tools/check-archetype.js 复核，不要凭感觉改数值；④「手感 / 文案」——小步修改，保持既有风格。',
      '每条记录都带了当时的局势快照（场景 / 角色 / 幕与层 / 种子 / 生命 / 污染 / 牌组），需要复现时可以用 ?seed=<种子>&char=<角色> 直接开同一局。',
      '',
      md
    ].join('\n');
  }

  function jsonText() {
    const s = session(), st = stats();
    let diag = null;
    try { diag = root.DIAG && root.DIAG.stats ? root.DIAG.stats() : null; } catch (e) { diag = null; }
    return JSON.stringify({
      game: 'caifengren-37',
      kind: 'playtest',
      v: 1,
      exportedAt: new Date().toISOString(),
      build: s.build,
      session: { who: s.who, note: s.note, startedAt: s.startedAt, device: s.device },
      stats: st,
      diagStats: diag,
      entries: entries()
    }, null, 2);
  }

  /* ------------------------------ 导入 / 合并 ------------------------------ */
  function importText(text) {
    let parsed = null;
    try { parsed = JSON.parse(String(text || '')); } catch (e) { return { ok: false, err: 'json' }; }
    const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.entries) ? parsed.entries : null);
    if (!list) return { ok: false, err: 'shape' };
    const d = data();
    let added = 0, skipped = 0;
    list.forEach(raw => {
      if (!raw || typeof raw !== 'object') { skipped++; return; }
      const txt = clip(String(raw.text == null ? '' : raw.text).trim(), MAX_TEXT);
      if (!txt) { skipped++; return; }
      const id = raw.id ? String(raw.id) : '';
      if (id && d.entries.some(e => e.id === id)) { skipped++; return; }
      const sev = SEV_LABEL[raw.sev] ? raw.sev : 'other';
      const area = AREAS.indexOf(raw.area) >= 0 ? raw.area : '其他';
      d.entries.push({
        id: id || newId(d),
        t: +raw.t || Date.now(),
        sev, area, text: txt,
        who: clip(raw.who || '', MAX_WHO),
        ctx: raw.ctx || null,
        b: clip(raw.b || '', 20)
      });
      added++;
    });
    while (d.entries.length > MAX_ENTRIES) d.entries.shift();
    d.entries.sort((a, b2) => (a.t || 0) - (b2.t || 0));
    if (parsed && parsed.session && parsed.session.who && !d.session.who) d.session.who = clip(parsed.session.who, MAX_WHO);
    save();
    return { ok: true, added, skipped, total: d.entries.length };
  }

  /* ------------------------------ 剪贴板 / 下载 ------------------------------ */
  function copy(text) {
    const s = String(text == null ? '' : text);
    try {
      if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
        return root.navigator.clipboard.writeText(s).then(() => true, () => fallbackCopy(s));
      }
    } catch (e) { /* 落到 fallback */ }
    return Promise.resolve(fallbackCopy(s));
  }

  function fallbackCopy(s) {
    try {
      const doc = root.document;
      if (!doc) return false;
      const ta = doc.createElement('textarea');
      ta.value = s;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      doc.body.appendChild(ta);
      ta.select();
      const ok = doc.execCommand('copy');
      doc.body.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  }

  function download(name, text, mime) {
    try {
      const doc = root.document;
      if (!doc) return false;
      const blob = new root.Blob([text], { type: mime || 'text/plain;charset=utf-8' });
      const url = root.URL.createObjectURL(blob);
      const a = doc.createElement('a');
      a.href = url; a.download = name;
      doc.body.appendChild(a); a.click(); doc.body.removeChild(a);
      setTimeout(() => { try { root.URL.revokeObjectURL(url); } catch (e) {} }, 1200);
      return true;
    } catch (e) { return false; }
  }

  function stamp() {
    const d = new Date();
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
  }

  function reset() { cache = null; }

  root.REC = {
    v: 1,
    MAX_ENTRIES,
    sevs() { return SEVS.slice(); },
    areas() { return AREAS.slice(); },
    session, setSession,
    entries, add, update, remove, clear,
    stats, markdown, brief, jsonText,
    importText, copy, download, stamp, build, device,
    reset,
    _key: KEY
  };
})(typeof window !== 'undefined' ? window : this);
