/**
 * Material Design 3 Theme Controller (Light / Dark / System Auto)
 * Syncs `data-theme` attribute on <html>, persists preference, and updates PWA `<meta name="theme-color">`.
 */

const STORAGE_KEY = 'mcxor-md3-theme';
const LIGHT_CHROME = '#F5FBF6';
const DARK_CHROME = '#0E1511';

export class ThemeController {
  constructor(onThemeChange = null) {
    this.onThemeChange = onThemeChange;
    this.mediaQuery =
      typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;
    this.mode = this._loadSavedMode();

    this._onSystemChange = () => {
      if (this.mode === 'auto') {
        this.apply(this.mode, false);
      }
    };

    if (this.mediaQuery) {
      if (typeof this.mediaQuery.addEventListener === 'function') {
        this.mediaQuery.addEventListener('change', this._onSystemChange);
      } else if (typeof this.mediaQuery.addListener === 'function') {
        this.mediaQuery.addListener(this._onSystemChange);
      }
    }

    this.apply(this.mode, false);
  }

  _loadSavedMode() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'light' || saved === 'dark' || saved === 'auto') return saved;
    } catch {
      // Ignore storage access restrictions
    }
    return 'auto';
  }

  getResolvedTheme() {
    if (this.mode === 'light' || this.mode === 'dark') return this.mode;
    return this.mediaQuery && this.mediaQuery.matches ? 'dark' : 'light';
  }

  apply(mode, persist = true) {
    if (mode !== 'light' && mode !== 'dark' && mode !== 'auto') return;
    this.mode = mode;

    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, mode);
      } catch {
        // Ignore
      }
    }

    const resolved = this.getResolvedTheme();
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.setAttribute('data-theme-mode', mode);
    document.documentElement.style.colorScheme = resolved;

    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute('content', resolved === 'dark' ? DARK_CHROME : LIGHT_CHROME);
    }

    if (typeof this.onThemeChange === 'function') {
      this.onThemeChange({ mode, resolved });
    }
  }

  cycle() {
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(this.mode) + 1) % order.length];
    this.apply(next, true);
  }
}
