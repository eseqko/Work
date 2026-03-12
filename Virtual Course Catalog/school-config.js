/* ═══════════════════════════════════════════
   SchoolConfig — shared school identity module
   Loaded by setup.html, index.html, editor.html
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
    },

    /** Full initialization: apply theme + identity. */
    init() {
      this.applyTheme();
      this.applyIdentity();
    },

    /** Expose color utilities for setup preview. */
    colorUtils: { hexToHSL, hslToHex, darken, lighten }
  };

  window.SchoolConfig = SchoolConfig;
})();
