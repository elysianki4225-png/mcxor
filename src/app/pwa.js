/**
 * PWA Lifecycle Manager
 * - Registers Service Worker (`./sw.js`) for full offline operation
 * - Handles `beforeinstallprompt` install button
 * - Supports PWA File Handling API (`window.launchQueue`) for opening .mcworld/.zip directly
 */

export function initPwa({ onInstallAvailable, onSwReady, onFileLaunched, onToast }) {
  let deferredPrompt = null;

  if (typeof window === 'undefined') {
    return { triggerInstall: async () => false };
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (onInstallAvailable) onInstallAvailable(true);
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    if (onInstallAvailable) onInstallAvailable(false);
    if (onToast) onToast('已成功安装到主屏幕 / 桌面应用，支持完全离线使用');
  });

  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', async () => {
      try {
        const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
        if (onSwReady) onSwReady(true);

        reg.addEventListener('updatefound', () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              if (onToast) onToast('离线组件已静默更新，刷新页面即可启用最新版本');
            }
          });
        });
      } catch {
        // Non-HTTPS preview or private browsing may restrict SW registration
      }
    });
  }

  // PWA File Handling API (Desktop Chrome/Edge opening .mcworld / .zip directly with installed app)
  if ('launchQueue' in window && window.launchQueue && onFileLaunched) {
    window.launchQueue.setConsumer(async (launchParams) => {
      if (!launchParams || !launchParams.files || !launchParams.files.length) return;
      try {
        const files = [];
        for (const handle of launchParams.files) {
          const f = await handle.getFile();
          files.push(f);
        }
        if (files.length) onFileLaunched(files);
      } catch {
        // Ignore cancelled file handle
      }
    });
  }

  return {
    async triggerInstall() {
      if (!deferredPrompt) return false;
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      deferredPrompt = null;
      if (onInstallAvailable) onInstallAvailable(false);
      return choice && choice.outcome === 'accepted';
    },
  };
}
