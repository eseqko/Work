/* ═══════════════════════════════════════════
   SchoolConfig — shared school identity module
   Loaded by setup.html, catalog.html, editor.html, hub.html, hub-editor.html, index.html (dashboard)
═══════════════════════════════════════════ */
(function () {
  'use strict';

  const LS_KEY = 'school_config';

  const DEFAULTS = {
    schoolName: 'Your School',
    shortName: '',
    mascot: '',
    mascotEmoji: '',
    motto: '',
    schoolYear: new Date().getFullYear() + '–' + (new Date().getFullYear() + 1),
    address: '',
    phone: '',
    website: '',
    logo: '',
    colors: { primary: '#1a3a5c', secondary: '#c8a227' },
    setupComplete: false
  };

  /* ── Color helpers ── */
  function hexToHSL(hex) {
    let r = parseInt(hex.slice(1, 3), 16) / 255;
    let g = parseInt(hex.slice(3, 5), 16) / 255;
    let b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    if (max === min) { h = s = 0; }
    else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }
    return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
  }

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = n => {
      const k = (n + h / 30) % 12;
      const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
      return Math.round(255 * color).toString(16).padStart(2, '0');
    };
    return '#' + f(0) + f(8) + f(4);
  }

  function darken(hex, amount) {
    const [h, s, l] = hexToHSL(hex);
    return hslToHex(h, s, Math.max(0, l - amount));
  }

  function lighten(hex, amount) {
    const [h, s, l] = hexToHSL(hex);
    return hslToHex(h, Math.max(0, s - 20), Math.min(100, l + amount));
  }

  /* ── Core API ── */
  const SchoolConfig = {
    _cache: null,

    load() {
      if (this._cache) return this._cache;
      try {
        const raw = localStorage.getItem(LS_KEY);
        this._cache = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
      } catch {
        this._cache = { ...DEFAULTS };
      }
      return this._cache;
    },

    save(config) {
      this._cache = { ...DEFAULTS, ...config };
      localStorage.setItem(LS_KEY, JSON.stringify(this._cache));
    },

    get(key) {
      return this.load()[key];
    },

    isSetupComplete() {
      return this.load().setupComplete === true;
    },

    /** Redirect to setup.html if school is not configured yet. */
    requireSetup() {
      if (!this.isSetupComplete()) {
        const here = window.location.pathname;
        if (!here.endsWith('setup.html')) {
          window.location.href = 'setup.html';
        }
      }
    },

    /** Apply school colors to CSS custom properties on :root. */
    applyTheme() {
      const cfg = this.load();
      const primary = cfg.colors.primary;
      const secondary = cfg.colors.secondary;
      const root = document.documentElement.style;
      root.setProperty('--navy', primary);
      root.setProperty('--navy-dark', darken(primary, 12));
      root.setProperty('--gold', secondary);
      root.setProperty('--gold-light', lighten(secondary, 35));
    },

    /** Apply school name/mascot to common page elements. */
    applyIdentity() {
      const cfg = this.load();
      if (!cfg.setupComplete) return;

      document.title = document.title
        .replace(/Jefferson High School|Jefferson HS/g, cfg.schoolName);

      document.querySelectorAll('[data-school-name]').forEach(el => {
        el.textContent = cfg.schoolName;
      });
      document.querySelectorAll('[data-school-short]').forEach(el => {
        el.textContent = cfg.shortName || cfg.schoolName;
      });
      document.querySelectorAll('[data-school-emoji]').forEach(el => {
        el.textContent = cfg.mascotEmoji || '';
      });
      document.querySelectorAll('[data-school-mascot]').forEach(el => {
        el.textContent = (cfg.mascotEmoji ? cfg.mascotEmoji + ' ' : '') +
          (cfg.mascot ? 'Go ' + cfg.mascot + '!' : '');
      });
      document.querySelectorAll('[data-school-year]').forEach(el => {
        el.textContent = cfg.schoolYear;
      });
      document.querySelectorAll('[data-school-motto]').forEach(el => {
        el.textContent = cfg.motto;
      });
      document.querySelectorAll('[data-school-address]').forEach(el => {
        el.textContent = cfg.address || '';
      });
      document.querySelectorAll('[data-school-phone]').forEach(el => {
        el.textContent = cfg.phone || '';
      });
      document.querySelectorAll('[data-school-website]').forEach(el => {
        el.textContent = cfg.website || '';
      });
      document.querySelectorAll('[data-school-logo]').forEach(el => {
        if (cfg.logo) {
          el.setAttribute('src', cfg.logo);
          el.style.display = '';
        } else {
          el.removeAttribute('src');
          el.style.display = 'none';
        }
      });
    },

    /** Inject a subtle uniform watermark using the school logo. */
    applyWatermark() {
      const cfg = this.load();
      const ID = 'sc-watermark';
      const STID = 'sc-watermark-style';
      const existing = document.getElementById(ID);
      if (existing) existing.remove();
      if (!cfg.logo) return;
      if (!document.getElementById(STID)) {
        const s = document.createElement('style');
        s.id = STID;
        s.textContent =
          '#' + ID + '{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:55vw;max-width:520px;opacity:.04;pointer-events:none;z-index:0;filter:grayscale(100%) contrast(.85)}' +
          '#' + ID + ' img{width:100%;height:auto;display:block}' +
          '@media print{#' + ID + '{opacity:.06;-webkit-print-color-adjust:exact;print-color-adjust:exact}}';
        document.head.appendChild(s);
      }
      const attach = () => {
        if (document.getElementById(ID)) return;
        const wm = document.createElement('div');
        wm.id = ID;
        wm.setAttribute('aria-hidden', 'true');
        const img = document.createElement('img');
        img.src = cfg.logo;
        img.alt = '';
        wm.appendChild(img);
        document.body.appendChild(wm);
      };
      if (document.body) attach();
      else document.addEventListener('DOMContentLoaded', attach, { once: true });
    },

    /** Full initialization: apply theme + identity + watermark. */
    init() {
      this.applyTheme();
      this.applyIdentity();
      this.applyWatermark();
    },

    /** Expose color utilities for setup preview. */
    colorUtils: { hexToHSL, hslToHex, darken, lighten }
  };

  window.SchoolConfig = SchoolConfig;
})();
