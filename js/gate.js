/* ==========================================================================
   js/gate.js —— 内测授权门（只在打包后的在线版里出现）
   做法：把游戏的全部脚本（数据 / 引擎 / UI）用 AES-GCM 加密成 secure/app.bin，
   密码经 PBKDF2-SHA256 派生密钥。没有密码，拿到的是密文——不是被 CSS 挡住的明文。

   三条原则：
     1. **密码不进页面**：页面里只有 salt / iv / 迭代次数，没有明文密码，也没有可逆的校验值
     2. **错了就是解不开**：AES-GCM 自带认证标签，密码错则解密抛错，不需要额外比对
     3. **不挡住试玩**：勾「记住这台设备」后 7 天内不用再输（存的是派生密钥，不是密码）

   局限（写在这里，免得误以为这是服务器鉴权）：
     静态托管没有后端。图片与音频（assets/、vendor/）仍是公开文件，
     别人能直接抓到素材，但拿不到规则 / 数值 / 卡表 / 剧情文本，也跑不起来游戏。
     需要真正的账号级保护时，应改用 Cloudflare Access 之类的网关（见 PLAYTEST.md）。
   ========================================================================== */
(function (root) {
  'use strict';

  const UNLOCK_KEY = 'cf37_unlock';
  const LOCK_KEY = 'cf37_gate_lock';
  const KEEP_DAYS = 7;
  const MAX_TRIES = 5;
  const LOCK_MS = 30 * 1000;

  const doc = root.document;
  const store = (() => { try { return root.localStorage || null; } catch (e) { return null; } })();

  // 构建号做 cache-buster：GitHub Pages 的 CDN 会缓存 meta.json 与 app.bin，
  // 两者如果一新一旧，解密会失败并显示成「密码不对」——那是误导。
  const STAMP = (() => {
    const b = root.CF_BUILD || {};
    const t = String(b.builtAt || '').replace(/[^0-9]/g, '');
    const v = [b.commit, t].filter(Boolean).join('-').replace(/[^\w.-]/g, '');
    return v ? '?v=' + encodeURIComponent(v) : '';
  })();

  const el = (tag, cls, html) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };

  const b64 = {
    enc(buf) {
      const b = new Uint8Array(buf);
      let s = '';
      for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
      return root.btoa(s);
    },
    dec(str) {
      const s = root.atob(String(str || ''));
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out;
    }
  };

  /* ------------------------------ 本机授权记忆 ------------------------------ */
  function readUnlock() {
    if (!store) return null;
    try {
      const raw = store.getItem(UNLOCK_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (!d || !d.k || !d.exp || d.exp < Date.now()) { store.removeItem(UNLOCK_KEY); return null; }
      return d;
    } catch (e) { return null; }
  }

  function saveUnlock(key, build) {
    if (!store) return;
    try {
      store.setItem(UNLOCK_KEY, JSON.stringify({
        k: b64.enc(key),
        exp: Date.now() + KEEP_DAYS * 864e5,
        commit: build || '',
        at: Date.now()
      }));
    } catch (e) { /* 配额满 / 隐私模式：不记也行，下次再输一遍 */ }
  }

  function clearUnlock() {
    if (!store) return;
    try { store.removeItem(UNLOCK_KEY); } catch (e) {}
  }

  /* ------------------------------ 尝试次数 ------------------------------ */
  function readLock() {
    if (!store) return { tries: 0, until: 0 };
    try {
      const d = JSON.parse(store.getItem(LOCK_KEY) || '{}');
      return { tries: (d && d.tries) | 0, until: (d && d.until) | 0 };
    } catch (e) { return { tries: 0, until: 0 }; }
  }
  function writeLock(v) {
    if (!store) return;
    try { store.setItem(LOCK_KEY, JSON.stringify(v)); } catch (e) {}
  }

  /* ------------------------------ 解密 ------------------------------ */
  async function deriveKey(pass, meta) {
    const subtle = root.crypto && root.crypto.subtle;
    if (!subtle) throw new Error('nocrypto');
    const base = await subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'PBKDF2', salt: b64.dec(meta.salt), iterations: meta.iter | 0 || 250000, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      true,                       // 需要导出：勾了「记住」就存派生密钥
      ['decrypt']
    );
  }

  async function decryptBundle(key, meta) {
    const res = await root.fetch('secure/app.bin' + STAMP, { cache: 'no-store' });
    if (!res.ok) throw new Error('fetch');
    const buf = await res.arrayBuffer();
    return root.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64.dec(meta.iv), tagLength: 128 },
      key,
      buf
    );
  }

  function inject(buf) {
    return new Promise((resolve, reject) => {
      const url = root.URL.createObjectURL(new root.Blob([buf], { type: 'text/javascript' }));
      const s = doc.createElement('script');
      s.src = url;
      s.async = false;
      s.onload = () => { try { root.URL.revokeObjectURL(url); } catch (e) {} resolve(); };
      s.onerror = () => { try { root.URL.revokeObjectURL(url); } catch (e) {} reject(new Error('inject')); };
      doc.body.appendChild(s);
    });
  }

  /* ------------------------------ 授权面板 ------------------------------ */
  function panel() {
    const build = root.CF_BUILD || {};
    const wrap = el('div');
    wrap.className = 'gate';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', '内测授权');
    wrap.innerHTML = `
      <div class="gate-box">
        <div class="gate-stamp">机密 · 仅限受邀请的采风人</div>
        <div class="gate-mark">37</div>
        <h1>采风人 · 37号仓库</h1>
        <p class="gate-sub">内测试玩版 · 需要授权密码</p>
        <p class="gate-note">游戏包在本机解密后才加载。密码向对接人索取，输一次即可（可记住 7 天）。</p>
        <form class="gate-form" autocomplete="off">
          <label for="gate-pass">授权密码</label>
          <input id="gate-pass" type="password" name="pass" inputmode="text"
                 autocomplete="current-password" spellcheck="false" placeholder="向对接人索取">
          <label class="gate-keep"><input type="checkbox" name="keep" checked> 记住这台设备 ${KEEP_DAYS} 天</label>
          <button class="btn" type="submit">进入仓库</button>
        </form>
        <p class="gate-msg" role="status" aria-live="polite"></p>
        <p class="gate-foot">
          <span>v${(build.version || '?')}${build.commit ? ' · 构建 ' + build.commit : ''}</span>
          <span>密码只在本机派生密钥，不上传；忘记设备：GATE.clearUnlock()</span>
        </p>
      </div>`;
    doc.body.appendChild(wrap);
    doc.documentElement.classList.add('gate-open');
    return wrap;
  }

  function setMsg(wrap, text, kind) {
    const m = wrap.querySelector('.gate-msg');
    if (!m) return;
    m.textContent = text || '';
    m.className = 'gate-msg' + (kind ? ' ' + kind : '');
  }

  function setBusy(wrap, busy, label) {
    const b = wrap.querySelector('.gate-form button');
    const i = wrap.querySelector('#gate-pass');
    const k = wrap.querySelector('.gate-keep');
    if (b) { b.disabled = busy; b.textContent = busy ? (label || '解密中…') : '进入仓库'; }
    if (i) i.disabled = busy;
    if (k) k.disabled = busy;
    wrap.classList.toggle('is-busy', !!busy);
  }

  function finish(wrap) {
    doc.documentElement.classList.remove('gate-open');
    if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
  }

  /* ------------------------------ 主流程 ------------------------------ */
  async function main() {
    let meta;
    try {
      const res = await root.fetch('secure/meta.json' + STAMP, { cache: 'no-store' });
      if (!res.ok) throw new Error('meta');
      meta = await res.json();
    } catch (e) {
      // 打包出错 / 文件被删：给出人话，而不是白屏
      const w = panel();
      w.querySelector('.gate-form').style.display = 'none';
      setMsg(w, '授权文件读不到（secure/meta.json）。请联系发布者重新打包。', 'bad');
      return;
    }

    const wrap = panel();
    const form = wrap.querySelector('form');
    const input = wrap.querySelector('#gate-pass');

    // 本机已授权：直接尝试解密；失败（换了构建 / 密钥过期）就回到表单
    const saved = readUnlock();
    if (saved) {
      try {
        setBusy(wrap, true, '校验本机授权…');
        const key = await root.crypto.subtle.importKey('raw', b64.dec(saved.k), { name: 'AES-GCM' }, true, ['decrypt']);
        const buf = await decryptBundle(key, meta);
        await inject(buf);
        finish(wrap);
        return;
      } catch (e) {
        clearUnlock();
        setBusy(wrap, false);
        setMsg(wrap, '这台设备的授权已过期或版本已更新，请重新输入密码。', 'warn');
      }
    }

    const lock = readLock();
    let tries = lock.tries || 0;
    let until = lock.until || 0;

    function refreshLock() {
      if (until && until > Date.now()) {
        const left = Math.ceil((until - Date.now()) / 1000);
        setBusy(wrap, true, `请稍候 ${left}s`);
        setTimeout(() => { setBusy(wrap, false); refreshLock(); }, 800);
        return true;
      }
      if (until && until <= Date.now()) { until = 0; tries = 0; writeLock({ tries: 0, until: 0 }); }
      return false;
    }
    refreshLock();

    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      if (refreshLock()) return;
      const pass = String(input.value || '');
      if (!pass) { setMsg(wrap, '请输入授权密码。', 'bad'); input.focus(); return; }
      setBusy(wrap, true, '解密中…');
      setMsg(wrap, '');
      try {
        const key = await deriveKey(pass, meta);
        const buf = await decryptBundle(key, meta);
        await inject(buf);
        writeLock({ tries: 0, until: 0 });
        if (wrap.querySelector('.gate-keep input').checked) {
          try {
            const raw = await root.crypto.subtle.exportKey('raw', key);
            saveUnlock(raw, (root.CF_BUILD || {}).commit || '');
          } catch (e) { /* 导出失败就不记 */ }
        } else {
          clearUnlock();
        }
        finish(wrap);
        return;
      } catch (err) {
        const msg = String((err && err.message) || '');
        if (msg === 'fetch') {
          setMsg(wrap, '游戏包读取失败（网络中断？）。刷新页面再试。', 'bad');
          setBusy(wrap, false);
          return;
        }
        tries++;
        if (tries >= MAX_TRIES) { until = Date.now() + LOCK_MS; writeLock({ tries, until }); }
        else writeLock({ tries, until: 0 });
        input.value = '';
        setBusy(wrap, false);
        if (until) { setMsg(wrap, `密码不对。连续 ${MAX_TRIES} 次错误，请等 ${LOCK_MS / 1000} 秒。`, 'bad'); refreshLock(); }
        else setMsg(wrap, `密码不对（还可以试 ${MAX_TRIES - tries} 次）。`, 'bad');
        input.focus();
      }
    });

    setTimeout(() => { try { input.focus({ preventScroll: true }); } catch (e) {} }, 30);
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', main);
  else main();

  // 供自动化测试与「忘记这台设备」使用
  root.GATE = {
    clearUnlock,
    locked() { const l = readLock(); return !!(l.until && l.until > Date.now()); }
  };
})(typeof window !== 'undefined' ? window : this);
