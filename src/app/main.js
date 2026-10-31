/**
 * MCXOR Main Application Controller
 * Connects Material Design 3 UI, Dedicated Web Worker, MemoryGuard, ThemeController & PWA.
 */

import {
  DEFAULT_KEY_BYTES,
  parseKeyInput,
  generateRandomKey,
  formatKeyInfo,
} from '../core/xorCrypto.js';
import { analyzeArchiveInput, processArchiveSession } from '../core/archiveEngine.js';
import { MemoryGuard } from './memoryGuard.js';
import { normalizeFileListInput, extractDroppedInput } from './folderReader.js';
import { createDemoArchiveBlob } from './sampleGenerator.js';
import { ThemeController } from './theme.js';
import { initPwa } from './pwa.js';

// ============================================================================
// Formatting Utilities
// ============================================================================
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function stripMcCodes(str) {
  return (str || '').replace(/§[0-9a-gk-or]/gi, '').trim();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================================
// Worker Client Bridge (Module Worker with Seamless Async Fallback)
// ============================================================================
class ArchiveWorkerBridge {
  constructor({ onProgress, onAnalyzeDone, onProcessDone, onCancelled, onError }) {
    this.callbacks = { onProgress, onAnalyzeDone, onProcessDone, onCancelled, onError };
    this.worker = null;
    this.fallbackSession = null;
    this.cancelledTasks = new Set();
    this._initWorker();
  }

  _initWorker() {
    if (typeof Worker === 'undefined') return;
    try {
      const w = new Worker(new URL('../worker/archiveWorker.js', import.meta.url), {
        type: 'module',
      });
      w.addEventListener('message', (e) => this._handleMessage(e.data));
      w.addEventListener('error', () => {
        // Fallback to chunked main-thread async execution if module worker restricted
        try {
          w.terminate();
        } catch {}
        this.worker = null;
      });
      this.worker = w;
    } catch {
      this.worker = null;
    }
  }

  _handleMessage(msg) {
    if (!msg) return;
    switch (msg.type) {
      case 'TASK_PROGRESS':
        this.callbacks.onProgress(msg.progress);
        break;
      case 'ANALYZE_DONE':
        this.callbacks.onAnalyzeDone(msg.analysis);
        break;
      case 'PROCESS_DONE':
        this.callbacks.onProcessDone(msg.result);
        break;
      case 'TASK_CANCELLED':
        this.callbacks.onCancelled();
        break;
      case 'TASK_ERROR':
        this.callbacks.onError(msg.error);
        break;
      default:
        break;
    }
  }

  async analyze(taskId, payload) {
    if (this.worker) {
      this.worker.postMessage({ type: 'ANALYZE_ARCHIVE', taskId, payload });
      return;
    }
    this.fallbackSession = null;
    try {
      const { session, analysis } = await analyzeArchiveInput(payload, {
        shouldCancel: () => this.cancelledTasks.has(taskId),
        onProgress: (p) => this.callbacks.onProgress(p),
      });
      this.fallbackSession = session;
      this.callbacks.onAnalyzeDone(analysis);
    } catch (err) {
      if (err && err.message === 'OPERATION_CANCELLED') this.callbacks.onCancelled();
      else this.callbacks.onError((err && err.message) || '存档解析失败');
    } finally {
      this.cancelledTasks.delete(taskId);
    }
  }

  async process(taskId, params) {
    if (this.worker) {
      this.worker.postMessage({ type: 'PROCESS_ARCHIVE', taskId, params });
      return;
    }
    try {
      const result = await processArchiveSession(this.fallbackSession, params, {
        shouldCancel: () => this.cancelledTasks.has(taskId),
        onProgress: (p) => this.callbacks.onProgress(p),
      });
      this.callbacks.onProcessDone(result);
    } catch (err) {
      if (err && err.message === 'OPERATION_CANCELLED') this.callbacks.onCancelled();
      else this.callbacks.onError((err && err.message) || '加解密执行失败');
    } finally {
      this.cancelledTasks.delete(taskId);
    }
  }

  cancel(taskId) {
    if (taskId) this.cancelledTasks.add(taskId);
    if (this.worker) {
      this.worker.postMessage({ type: 'CANCEL_TASK', taskId });
    }
  }

  releaseMemory() {
    this.fallbackSession = null;
    this.cancelledTasks.clear();
    if (this.worker) {
      this.worker.postMessage({ type: 'RELEASE_MEMORY', requestId: Date.now() });
    }
  }
}

// ============================================================================
// Application State & DOM Wiring
// ============================================================================
const state = {
  busy: false,
  activeTaskId: null,
  analysis: null,
  operation: 'active_decrypt',
  customKeyFormat: 'hex',
  outputFormat: 'mcworld',
  displayedKeyInfo: formatKeyInfo(DEFAULT_KEY_BYTES, '网易内置默认密钥 ("88329851")'),
};

const el = {
  pwaStatusBadge: document.getElementById('pwaStatusBadge'),
  btnInstallPwa: document.getElementById('btnInstallPwa'),
  btnOpenDeployDialog: document.getElementById('btnOpenDeployDialog'),
  deployDialogBackdrop: document.getElementById('deployDialogBackdrop'),
  btnCloseDeployDialog: document.getElementById('btnCloseDeployDialog'),
  btnDoneDeployDialog: document.getElementById('btnDoneDeployDialog'),
  memoryStatsText: document.getElementById('memoryStatsText'),
  btnReleaseMemory: document.getElementById('btnReleaseMemory'),

  dropzone: document.getElementById('dropzone'),
  btnPickArchive: document.getElementById('btnPickArchive'),
  btnPickFolder: document.getElementById('btnPickFolder'),
  btnPickFiles: document.getElementById('btnPickFiles'),
  inputArchiveFile: document.getElementById('inputArchiveFile'),
  inputFolder: document.getElementById('inputFolder'),
  inputLooseFiles: document.getElementById('inputLooseFiles'),
  btnLoadEncryptedDemo: document.getElementById('btnLoadEncryptedDemo'),
  btnLoadPlainDemo: document.getElementById('btnLoadPlainDemo'),

  worldSummaryContainer: document.getElementById('worldSummaryContainer'),
  worldThumbImg: document.getElementById('worldThumbImg'),
  worldTitleText: document.getElementById('worldTitleText'),
  worldMetaText: document.getElementById('worldMetaText'),
  btnResetSession: document.getElementById('btnResetSession'),

  customKeyBox: document.getElementById('customKeyBox'),
  customKeyLabel: document.getElementById('customKeyLabel'),
  customKeyInput: document.getElementById('customKeyInput'),
  customKeyFeedback: document.getElementById('customKeyFeedback'),
  btnFillInferredKey: document.getElementById('btnFillInferredKey'),
  btnRandomKey: document.getElementById('btnRandomKey'),
  chkStripNetease: document.getElementById('chkStripNetease'),
  chkCompressDb: document.getElementById('chkCompressDb'),

  btnStartProcess: document.getElementById('btnStartProcess'),
  btnStartProcessLabel: document.getElementById('btnStartProcessLabel'),
  btnCancelTask: document.getElementById('btnCancelTask'),
  btnDownloadOutput: document.getElementById('btnDownloadOutput'),
  btnDownloadLabel: document.getElementById('btnDownloadLabel'),

  prgCardUpload: document.getElementById('prgCardUpload'),
  prgUploadPct: document.getElementById('prgUploadPct'),
  prgUploadBarAria: document.getElementById('prgUploadBarAria'),
  prgUploadFill: document.getElementById('prgUploadFill'),
  prgUploadDetail: document.getElementById('prgUploadDetail'),
  prgUploadMetric: document.getElementById('prgUploadMetric'),

  prgCardCrypto: document.getElementById('prgCardCrypto'),
  prgCryptoPct: document.getElementById('prgCryptoPct'),
  prgCryptoBarAria: document.getElementById('prgCryptoBarAria'),
  prgCryptoFill: document.getElementById('prgCryptoFill'),
  prgCryptoDetail: document.getElementById('prgCryptoDetail'),
  prgCryptoMetric: document.getElementById('prgCryptoMetric'),

  prgCardDownload: document.getElementById('prgCardDownload'),
  prgDownloadPct: document.getElementById('prgDownloadPct'),
  prgDownloadBarAria: document.getElementById('prgDownloadBarAria'),
  prgDownloadFill: document.getElementById('prgDownloadFill'),
  prgDownloadDetail: document.getElementById('prgDownloadDetail'),
  prgDownloadMetric: document.getElementById('prgDownloadMetric'),

  keySourceBadge: document.getElementById('keySourceBadge'),
  keyHexValue: document.getElementById('keyHexValue'),
  keyByteChips: document.getElementById('keyByteChips'),
  keyAsciiValue: document.getElementById('keyAsciiValue'),
  btnCopyHexKey: document.getElementById('btnCopyHexKey'),
  btnCopyAsciiKey: document.getElementById('btnCopyAsciiKey'),
  btnUseKeyForEncrypt: document.getElementById('btnUseKeyForEncrypt'),

  integrityOverallPill: document.getElementById('integrityOverallPill'),
  postAvalBanner: document.getElementById('postAvalBanner'),
  integrityCheckList: document.getElementById('integrityCheckList'),

  tabPanelFiles: document.getElementById('tabPanelFiles'),
  tabPanelLogs: document.getElementById('tabPanelLogs'),
  dbFilesContainer: document.getElementById('dbFilesContainer'),
  consoleContainer: document.getElementById('consoleContainer'),
  snackbar: document.getElementById('snackbar'),
};

// ============================================================================
// Snackbar Toast
// ============================================================================
let snackbarTimer = null;
function showToast(message) {
  if (!el.snackbar) return;
  el.snackbar.textContent = message;
  el.snackbar.classList.add('is-visible');
  clearTimeout(snackbarTimer);
  snackbarTimer = setTimeout(() => {
    el.snackbar.classList.remove('is-visible');
  }, 3200);
}

// ============================================================================
// Console Log Helper (Capped at 200 DOM lines so log DOM never leaks memory!)
// ============================================================================
function appendLog(level, message) {
  if (!el.consoleContainer) return;
  const now = new Date();
  const ts = now.toTimeString().slice(0, 8);
  const p = document.createElement('p');
  p.className = `log-line ${level ? `log-line--${level}` : ''}`;
  p.textContent = `[${ts}] ${message}`;
  el.consoleContainer.appendChild(p);
  while (el.consoleContainer.childElementCount > 200) {
    el.consoleContainer.removeChild(el.consoleContainer.firstElementChild);
  }
  el.consoleContainer.scrollTop = el.consoleContainer.scrollHeight;
}

// ============================================================================
// MemoryGuard Initialization
// ============================================================================
const memoryGuard = new MemoryGuard((stats) => {
  if (!el.memoryStatsText) return;
  el.memoryStatsText.textContent = `缓存句柄 ${stats.activeUrls} · ${formatBytes(
    stats.trackedBlobBytes
  )}`;
});

// ============================================================================
// Theme & PWA Initialization
// ============================================================================
const themeButtons = Array.from(document.querySelectorAll('[data-theme-btn]'));
const themeController = new ThemeController(({ mode }) => {
  for (const btn of themeButtons) {
    const active = btn.getAttribute('data-theme-btn') === mode;
    btn.setAttribute('aria-pressed', String(active));
    btn.classList.toggle('is-active', active);
  }
});

for (const btn of themeButtons) {
  btn.addEventListener('click', () => {
    themeController.apply(btn.getAttribute('data-theme-btn'), true);
  });
}

const pwa = initPwa({
  onInstallAvailable(available) {
    el.btnInstallPwa.hidden = !available;
  },
  onSwReady() {
    el.pwaStatusBadge.textContent = 'PWA 离线就绪';
  },
  onFileLaunched(files) {
    const normalized = normalizeFileListInput(files);
    if (normalized) startAnalyze(normalized);
  },
  onToast: showToast,
});

el.btnInstallPwa.addEventListener('click', () => pwa.triggerInstall());

// ============================================================================
// Progress Bar Updaters
// ============================================================================
function updateProgressCard(which, { percent = 0, detail = '', metric = '', active = false }) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const map = {
    upload: {
      card: el.prgCardUpload,
      pct: el.prgUploadPct,
      aria: el.prgUploadBarAria,
      fill: el.prgUploadFill,
      detail: el.prgUploadDetail,
      metric: el.prgUploadMetric,
    },
    crypto: {
      card: el.prgCardCrypto,
      pct: el.prgCryptoPct,
      aria: el.prgCryptoBarAria,
      fill: el.prgCryptoFill,
      detail: el.prgCryptoDetail,
      metric: el.prgCryptoMetric,
    },
    download: {
      card: el.prgCardDownload,
      pct: el.prgDownloadPct,
      aria: el.prgDownloadBarAria,
      fill: el.prgDownloadFill,
      detail: el.prgDownloadDetail,
      metric: el.prgDownloadMetric,
    },
  }[which];

  if (!map) return;
  map.card.classList.toggle('is-active', active);
  map.pct.textContent = `${clamped}%`;
  map.aria.setAttribute('aria-valuenow', String(clamped));
  map.fill.style.width = `${clamped}%`;
  if (detail) map.detail.textContent = detail;
  if (metric) map.metric.textContent = metric;
}

function resetProgressBars(keepUpload = false) {
  if (!keepUpload) {
    updateProgressCard('upload', {
      percent: 0,
      detail: '等待导入存档文件...',
      metric: '0 B / 0 B',
      active: false,
    });
  }
  updateProgressCard('crypto', {
    percent: 0,
    detail: '等待开始加解密计算...',
    metric: '0 / 0 文件',
    active: false,
  });
  updateProgressCard('download', {
    percent: 0,
    detail: '等待打包输出流...',
    metric: '0 / 0 项',
    active: false,
  });
}

// ============================================================================
// Key Inspector Renderer
// ============================================================================
function renderKeyInspector(keyInfo) {
  if (!keyInfo) return;
  state.displayedKeyInfo = keyInfo;
  el.keySourceBadge.textContent = `密钥来源：${keyInfo.source}`;
  el.keyHexValue.textContent = keyInfo.hex;
  el.keyAsciiValue.textContent = keyInfo.isAllPrintableAscii
    ? `${keyInfo.ascii} (可打印 ASCII)`
    : `${keyInfo.ascii} (含非可见字节)`;

  el.keyByteChips.innerHTML = keyInfo.bytes
    .map(
      (b, idx) =>
        `<div class="byte-chip">${b.toString(16).padStart(2, '0').toUpperCase()}<span>B${idx}</span></div>`
    )
    .join('');
}

function syncEffectiveKeyDisplay() {
  const op = state.operation;
  const customRaw = el.customKeyInput.value.trim();

  if (op === 'passive_decrypt' || op === 'passive_encrypt') {
    renderKeyInspector(
      formatKeyInfo(DEFAULT_KEY_BYTES, '被动模式 · 网易内置固定密钥 ("88329851")')
    );
    return;
  }

  if (customRaw.length > 0) {
    const parsed = parseKeyInput(customRaw, state.customKeyFormat);
    if (parsed.ok) {
      el.customKeyFeedback.textContent =
        parsed.warning ||
        `有效 64-bit 密钥：${formatKeyInfo(parsed.key).hex} (ASCII: ${formatKeyInfo(parsed.key).ascii})`;
      renderKeyInspector(
        formatKeyInfo(
          parsed.key,
          op === 'active_encrypt' ? '主动加密 · 自定义输入密钥' : '主动解密 · 自定义输入密钥'
        )
      );
      return;
    } else {
      el.customKeyFeedback.textContent = `⚠ ${parsed.error}`;
    }
  } else {
    el.customKeyFeedback.textContent =
      op === 'active_decrypt'
        ? '留空时自动采用 CURRENT ⊕ MANIFEST / LDB 尾部魔数推导出的 64-bit 密钥。'
        : '请输入用于主动加密的 64-bit 密钥，或点击右侧“填入已推导密钥 / 随机生成”。';
  }

  if (
    state.analysis &&
    state.analysis.inferredKey &&
    state.analysis.inferredKey.ok &&
    op === 'active_decrypt'
  ) {
    renderKeyInspector(state.analysis.inferredKey.keyInfo);
  } else if (state.analysis && state.analysis.inferredKey && state.analysis.inferredKey.ok) {
    renderKeyInspector(state.analysis.inferredKey.keyInfo);
  } else {
    renderKeyInspector(formatKeyInfo(DEFAULT_KEY_BYTES, '网易内置默认密钥 ("88329851")'));
  }
}

// ============================================================================
// Operation & Action Button Sync
// ============================================================================
const opTiles = Array.from(document.querySelectorAll('.op-tile[data-op]'));

function syncOperationUI() {
  const op = state.operation;
  for (const tile of opTiles) {
    const selected = tile.getAttribute('data-op') === op;
    tile.classList.toggle('is-selected', selected);
    tile.setAttribute('aria-checked', String(selected));
  }

  const isDecrypt = op === 'active_decrypt' || op === 'passive_decrypt';
  const showCustomBox = op === 'active_decrypt' || op === 'active_encrypt';
  el.customKeyBox.hidden = !showCustomBox;
  el.customKeyLabel.textContent =
    op === 'active_decrypt'
      ? '自定义 64-bit 密钥（留空则自动推导密钥）'
      : '主动加密 64-bit 密钥（必填，可随机生成或回填原密钥）';
  el.customKeyInput.placeholder =
    state.customKeyFormat === 'hex'
      ? op === 'active_decrypt'
        ? '留空自动推导；或输入十六进制如 0x4D43584F52373737'
        : '输入 64-bit 十六进制密钥，如 0x4D43584F52373737'
      : '输入 8 位 ASCII 字符密钥，如 MCXOR777';

  el.btnStartProcessLabel.textContent = isDecrypt ? '开始解密存档' : '开始加密存档';

  let canRun = false;
  if (state.analysis && !state.busy) {
    if (isDecrypt) canRun = state.analysis.integrity.canDecrypt;
    else canRun = state.analysis.integrity.canEncrypt;
  }
  el.btnStartProcess.disabled = !canRun;

  syncEffectiveKeyDisplay();
}

for (const tile of opTiles) {
  tile.addEventListener('click', () => {
    if (state.busy) return;
    state.operation = tile.getAttribute('data-op');
    syncOperationUI();
  });
}

// Key format segmented buttons (Hex / ASCII)
const keyFmtBtns = Array.from(document.querySelectorAll('[data-keyfmt]'));
for (const btn of keyFmtBtns) {
  btn.addEventListener('click', () => {
    state.customKeyFormat = btn.getAttribute('data-keyfmt');
    for (const b of keyFmtBtns) {
      const active = b === btn;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-pressed', String(active));
    }
    syncOperationUI();
  });
}

el.customKeyInput.addEventListener('input', () => syncEffectiveKeyDisplay());

el.btnFillInferredKey.addEventListener('click', () => {
  if (state.analysis && state.analysis.inferredKey && state.analysis.inferredKey.ok) {
    state.customKeyFormat = 'hex';
    for (const b of keyFmtBtns) {
      const active = b.getAttribute('data-keyfmt') === 'hex';
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-pressed', String(active));
    }
    el.customKeyInput.value = state.analysis.inferredKey.keyInfo.hex;
    syncOperationUI();
    showToast(`已填入推导密钥 ${state.analysis.inferredKey.keyInfo.hex}`);
  } else {
    el.customKeyInput.value = '0x3838333239383531';
    syncOperationUI();
    showToast('当前无主动推导密钥，已填入默认密钥 0x3838333239383531');
  }
});

el.btnRandomKey.addEventListener('click', () => {
  const rnd = formatKeyInfo(generateRandomKey());
  state.customKeyFormat = 'hex';
  for (const b of keyFmtBtns) {
    const active = b.getAttribute('data-keyfmt') === 'hex';
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-pressed', String(active));
  }
  el.customKeyInput.value = rnd.hex;
  syncOperationUI();
  showToast(`已生成随机 64-bit 密钥：${rnd.hex}`);
});

// Output format segmented buttons (.mcworld / .zip)
const outFmtBtns = Array.from(document.querySelectorAll('[data-outfmt]'));
for (const btn of outFmtBtns) {
  btn.addEventListener('click', () => {
    state.outputFormat = btn.getAttribute('data-outfmt');
    for (const b of outFmtBtns) {
      const active = b === btn;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-pressed', String(active));
    }
  });
}

// ============================================================================
// Integrity & DB File List Renderers
// ============================================================================
function renderIntegrityReport(integrity) {
  const pillMap = {
    valid: { cls: 'status-pill--pass', text: '完整性通过' },
    partial: { cls: 'status-pill--warn', text: '存在提示项' },
    invalid: { cls: 'status-pill--fail', text: '校验未通过' },
  };
  const cfg = pillMap[integrity.overallStatus] || pillMap.partial;
  el.integrityOverallPill.className = `status-pill ${cfg.cls}`;
  el.integrityOverallPill.textContent = cfg.text;

  const iconChar = { pass: '✓', warn: '!', fail: '✕' };
  el.integrityCheckList.innerHTML = integrity.checks
    .map(
      (c) => `
      <div class="check-item check-item--${c.status}">
        <span class="check-item__badge">${iconChar[c.status] || '•'}</span>
        <div>
          <div class="check-item__title">${escapeHtml(c.label)}</div>
          <div class="check-item__detail">${escapeHtml(c.detail)}</div>
        </div>
      </div>`
    )
    .join('');
}

function renderDbFilesList(previewList, totalCount) {
  if (!previewList || previewList.length === 0) {
    el.dbFilesContainer.innerHTML =
      '<div class="empty-placeholder">未在 db/ 目录中发现数据库文件</div>';
    return;
  }

  const badgeFor = (st) => {
    if (st === 'encrypted') {
      return '<span class="status-pill status-pill--warn">已加密 0x801D3001</span>';
    }
    if (st === 'aes_mod') {
      return '<span class="status-pill status-pill--fail">二次加密 0x901D3001</span>';
    }
    if (st === 'decrypted') {
      return '<span class="status-pill status-pill--pass">未加密明文</span>';
    }
    return '<span class="status-pill status-pill--neutral">日志/辅助</span>';
  };

  let html = previewList
    .map(
      (item) => `
      <div class="db-row">
        <span class="db-row__name" title="${escapeHtml(item.path)}">${escapeHtml(item.name)}</span>
        <div class="db-row__right">
          <span class="mono" style="color: var(--md-sys-color-on-surface-variant)">${formatBytes(item.size)}</span>
          ${badgeFor(item.state)}
        </div>
      </div>`
    )
    .join('');

  if (totalCount > previewList.length) {
    html += `<div class="db-row"><span class="db-row__name">... 其余 ${
      totalCount - previewList.length
    } 个数据库文件已省略展示</span></div>`;
  }
  el.dbFilesContainer.innerHTML = html;
}

// ============================================================================
// Worker Bridge Callbacks
// ============================================================================
const workerBridge = new ArchiveWorkerBridge({
  onProgress(p) {
    if (!p) return;
    if (p.phase === 'upload') {
      const speedTxt = p.speedBps ? ` · ${formatBytes(p.speedBps)}/s` : '';
      updateProgressCard('upload', {
        percent: p.percent,
        detail: p.detail || p.currentFile || '正在读取...',
        metric: `${formatBytes(p.bytesLoaded)} / ${formatBytes(p.bytesTotal)}${speedTxt}`,
        active: p.percent < 100,
      });
    } else if (p.phase === 'crypto') {
      updateProgressCard('crypto', {
        percent: p.percent,
        detail: p.detail || p.currentFile || '正在处理核心文件...',
        metric: `${p.filesDone || 0} / ${p.filesTotal || 0} 文件`,
        active: p.percent < 100,
      });
    } else if (p.phase === 'download') {
      updateProgressCard('download', {
        percent: p.percent,
        detail: p.detail || p.currentFile || '正在流式打包...',
        metric: `${p.filesDone || 0} / ${p.filesTotal || 0} 项 (${formatBytes(p.bytesLoaded)})`,
        active: p.percent < 100,
      });
    }
  },

  onAnalyzeDone(analysis) {
    state.busy = false;
    state.activeTaskId = null;
    state.analysis = analysis;
    el.btnCancelTask.hidden = true;
    el.postAvalBanner.hidden = true;

    // Revoke any previous download output URL to prevent stale memory retention
    memoryGuard.revokeSlot('download-output');
    el.btnDownloadOutput.hidden = true;

    // Render World Thumbnail safely via MemoryGuard
    if (analysis.worldIconBytes && analysis.worldIconBytes.byteLength > 0) {
      const iconBlob = new Blob([analysis.worldIconBytes], {
        type: analysis.worldIconMime || 'image/jpeg',
      });
      el.worldThumbImg.src = memoryGuard.registerBlobUrl('world-icon', iconBlob);
    } else {
      memoryGuard.revokeSlot('world-icon');
      el.worldThumbImg.src = './icons/icon.svg';
    }

    const cleanTitle = stripMcCodes(analysis.worldName) || analysis.sourceName;
    el.worldTitleText.textContent = cleanTitle;

    const metaItems = [
      `格式：${analysis.formatLabel}`,
      `总大小：${formatBytes(analysis.totalRawSize)}`,
      `文件数：${analysis.totalFilesCount}`,
      `加密核心文件：${analysis.encryptedCount} 个`,
      `明文核心文件：${analysis.decryptedCount} 个`,
    ];
    if (analysis.gameModeLabel) metaItems.push(`模式：${analysis.gameModeLabel}`);
    el.worldMetaText.innerHTML = metaItems
      .map((m) => `<span>${escapeHtml(m)}</span>`)
      .join('');
    el.worldSummaryContainer.hidden = false;

    // Auto-select recommended operation & netease_config toggle hint
    state.operation = analysis.recommendedOperation;
    if (analysis.hasNeteaseConfig && analysis.encryptedCount > 0) {
      el.chkStripNetease.checked = true;
    } else {
      el.chkStripNetease.checked = false;
    }

    renderIntegrityReport(analysis.integrity);
    renderDbFilesList(analysis.dbPreviewList, analysis.dbTotalEntriesCount);

    if (analysis.logs) {
      for (const item of analysis.logs) appendLog(item.level, item.message);
    }

    syncOperationUI();
    showToast(`存档解析完成：${cleanTitle}`);
  },

  onProcessDone(result) {
    state.busy = false;
    state.activeTaskId = null;
    el.btnCancelTask.hidden = true;
    syncOperationUI();

    if (result.keyInfo) {
      renderKeyInspector(result.keyInfo);
    }

    if (result.logs) {
      for (const item of result.logs) appendLog(item.level, item.message);
    }

    // Show post-decryption LevelDB magic `avalTest` result banner
    if (result.postAvalTest && result.postAvalTest.applicable) {
      el.postAvalBanner.hidden = false;
      if (result.postAvalTest.passed) {
        el.postAvalBanner.innerHTML = `
          <div class="check-item check-item--pass">
            <span class="check-item__badge">✓</span>
            <div>
              <div class="check-item__title">解密后 LevelDB 合理性测试通过 (avalTest)</div>
              <div class="check-item__detail">全部 ${result.postAvalTest.validCount} / ${result.postAvalTest.checkedCount} 个 .ldb 数据表尾部 64-bit 魔数 (0x57FB808B247547DB) 核验无误</div>
            </div>
          </div>`;
      } else {
        el.postAvalBanner.innerHTML = `
          <div class="check-item check-item--fail">
            <span class="check-item__badge">✕</span>
            <div>
              <div class="check-item__title">发现魔数不对应的 .ldb 文件</div>
              <div class="check-item__detail">共 ${result.postAvalTest.invalidFiles.length} 个文件未通过魔数校验 (${escapeHtml(result.postAvalTest.invalidFiles.slice(0, 3).join(', '))})，可能密钥有误或原存档损坏</div>
            </div>
          </div>`;
      }
    }

    // Register download ObjectURL via MemoryGuard (automatically revoking any previous one!)
    const downloadUrl = memoryGuard.registerBlobUrl('download-output', result.outputBlob);
    el.btnDownloadOutput.href = downloadUrl;
    el.btnDownloadOutput.download = result.outputFileName;
    el.btnDownloadLabel.textContent = `下载 ${result.outputFileName} (${formatBytes(
      result.outputSize
    )})`;
    el.btnDownloadOutput.hidden = false;

    // Trigger immediate download cleanly
    el.btnDownloadOutput.click();
    showToast(
      `${result.isDecrypt ? '解密' : '加密'}完成！已自动触发下载 (${formatBytes(result.outputSize)})`
    );
  },

  onCancelled() {
    state.busy = false;
    state.activeTaskId = null;
    el.btnCancelTask.hidden = true;
    syncOperationUI();
    appendLog('warn', '已中止当前处理任务并清理临时缓冲区');
    showToast('任务已中止');
  },

  onError(errorMsg) {
    state.busy = false;
    state.activeTaskId = null;
    el.btnCancelTask.hidden = true;
    syncOperationUI();
    appendLog('error', errorMsg);
    showToast(`错误：${errorMsg}`);
  },
});

// ============================================================================
// Actions: Start Analyze, Start Process, Cancel, Release Memory
// ============================================================================
function startAnalyze(normalizedInput) {
  if (!normalizedInput) return;
  if (state.busy && state.activeTaskId) {
    workerBridge.cancel(state.activeTaskId);
  }
  memoryGuard.revokeSlot('download-output');
  el.btnDownloadOutput.hidden = true;
  el.postAvalBanner.hidden = true;
  resetProgressBars(false);

  const taskId = `analyze-${Date.now()}`;
  state.busy = true;
  state.activeTaskId = taskId;
  el.btnStartProcess.disabled = true;
  el.btnCancelTask.hidden = false;

  appendLog('info', `准备导入并扫描: ${normalizedInput.sourceName}`);
  workerBridge.analyze(taskId, normalizedInput);
}

el.btnStartProcess.addEventListener('click', () => {
  if (state.busy || !state.analysis) return;

  memoryGuard.revokeSlot('download-output');
  el.btnDownloadOutput.hidden = true;
  resetProgressBars(true);

  const taskId = `process-${Date.now()}`;
  state.busy = true;
  state.activeTaskId = taskId;
  el.btnStartProcess.disabled = true;
  el.btnCancelTask.hidden = false;

  workerBridge.process(taskId, {
    operation: state.operation,
    customKeyInput: el.customKeyInput.value,
    customKeyFormat: state.customKeyFormat,
    outputFormat: state.outputFormat,
    stripNeteaseConfig: el.chkStripNetease.checked,
    compressModified: el.chkCompressDb.checked,
  });
});

el.btnCancelTask.addEventListener('click', () => {
  if (state.activeTaskId) {
    workerBridge.cancel(state.activeTaskId);
  }
});

function releaseAllSessionMemory(toastMsg = '已释放全部缓存句柄与 Worker 会话内存') {
  if (state.busy && state.activeTaskId) {
    workerBridge.cancel(state.activeTaskId);
  }
  state.busy = false;
  state.activeTaskId = null;
  state.analysis = null;
  workerBridge.releaseMemory();
  memoryGuard.revokeAll();

  el.worldThumbImg.src = './icons/icon.svg';
  el.worldSummaryContainer.hidden = true;
  el.btnDownloadOutput.removeAttribute('href');
  el.btnDownloadOutput.hidden = true;
  el.btnCancelTask.hidden = true;
  el.postAvalBanner.hidden = true;
  el.integrityOverallPill.className = 'status-pill status-pill--neutral';
  el.integrityOverallPill.textContent = '待检测';
  el.integrityCheckList.innerHTML =
    '<div class="empty-placeholder">导入存档后将自动执行结构完整性核验、CRC32 校验与 LevelDB 表魔数诊断</div>';
  el.dbFilesContainer.innerHTML =
    '<div class="empty-placeholder">导入存档后在此列出 db/ 目录核心文件与魔数状态</div>';

  // Reset file input values so re-selecting the exact same file fires `change`
  el.inputArchiveFile.value = '';
  el.inputFolder.value = '';
  el.inputLooseFiles.value = '';

  resetProgressBars(false);
  syncOperationUI();
  appendLog('info', '已清空当前会话并释放全部 Blob / ObjectURL 句柄');
  if (toastMsg) showToast(toastMsg);
}

el.btnReleaseMemory.addEventListener('click', () => releaseAllSessionMemory());
el.btnResetSession.addEventListener('click', () => releaseAllSessionMemory('已重置存档工作台'));

// ============================================================================
// Upload Pickers, Drag & Drop, Demo Buttons
// ============================================================================
el.btnPickArchive.addEventListener('click', () => el.inputArchiveFile.click());
el.btnPickFolder.addEventListener('click', () => {
  if (!('webkitdirectory' in el.inputFolder)) {
    showToast('当前浏览器内核不支持直接选择文件夹，请将存档压缩为 .zip 后导入');
    return;
  }
  el.inputFolder.click();
});
el.btnPickFiles.addEventListener('click', () => el.inputLooseFiles.click());

for (const inputEl of [el.inputArchiveFile, el.inputFolder, el.inputLooseFiles]) {
  inputEl.addEventListener('change', () => {
    const normalized = normalizeFileListInput(inputEl.files);
    inputEl.value = '';
    if (normalized) startAnalyze(normalized);
  });
}

// Drag & Drop support (archive files + whole unpacked world folders!)
['dragenter', 'dragover'].forEach((evtName) => {
  el.dropzone.addEventListener(evtName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.dropzone.classList.add('is-dragover');
  });
});

['dragleave', 'dragend'].forEach((evtName) => {
  el.dropzone.addEventListener(evtName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.dropzone.classList.remove('is-dragover');
  });
});

el.dropzone.addEventListener('drop', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  el.dropzone.classList.remove('is-dragover');
  try {
    const normalized = await extractDroppedInput(e.dataTransfer);
    if (normalized) startAnalyze(normalized);
  } catch (err) {
    showToast(`读取拖拽内容失败：${(err && err.message) || '未知错误'}`);
  }
});

// 1-Click Synthetic Demo Loaders
el.btnLoadEncryptedDemo.addEventListener('click', () => {
  const demo = createDemoArchiveBlob({ encrypted: true, useCustomKey: true });
  startAnalyze({
    sourceType: 'zip',
    sourceName: demo.fileName,
    zipBlob: demo.blob,
  });
});

el.btnLoadPlainDemo.addEventListener('click', () => {
  const demo = createDemoArchiveBlob({ encrypted: false });
  startAnalyze({
    sourceType: 'zip',
    sourceName: demo.fileName,
    zipBlob: demo.blob,
  });
});

// ============================================================================
// Key Copy & Use-For-Encrypt Actions
// ============================================================================
async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`已复制${label}：${text}`);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast(`已复制${label}`);
  }
}

el.btnCopyHexKey.addEventListener('click', () => {
  if (state.displayedKeyInfo) copyText(state.displayedKeyInfo.hex, '十六进制密钥');
});

el.btnCopyAsciiKey.addEventListener('click', () => {
  if (state.displayedKeyInfo) copyText(state.displayedKeyInfo.ascii, ' ASCII 密钥');
});

el.btnUseKeyForEncrypt.addEventListener('click', () => {
  if (!state.displayedKeyInfo) return;
  state.operation = 'active_encrypt';
  state.customKeyFormat = 'hex';
  for (const b of keyFmtBtns) {
    const active = b.getAttribute('data-keyfmt') === 'hex';
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-pressed', String(active));
  }
  el.customKeyInput.value = state.displayedKeyInfo.hex;
  syncOperationUI();
  showToast(`已切换至主动加密并填入密钥 ${state.displayedKeyInfo.hex}`);
});

// ============================================================================
// Inspector Tabs (DB Files vs Console Logs) & Deploy Modal
// ============================================================================
const tabBtns = Array.from(document.querySelectorAll('[data-tab]'));
for (const btn of tabBtns) {
  btn.addEventListener('click', () => {
    const target = btn.getAttribute('data-tab');
    for (const b of tabBtns) {
      const active = b === btn;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    }
    el.tabPanelFiles.hidden = target !== 'files';
    el.tabPanelLogs.hidden = target !== 'logs';
  });
}

function toggleDeployDialog(open) {
  el.deployDialogBackdrop.hidden = !open;
}

el.btnOpenDeployDialog.addEventListener('click', () => toggleDeployDialog(true));
el.btnCloseDeployDialog.addEventListener('click', () => toggleDeployDialog(false));
el.btnDoneDeployDialog.addEventListener('click', () => toggleDeployDialog(false));
el.deployDialogBackdrop.addEventListener('click', (e) => {
  if (e.target === el.deployDialogBackdrop) toggleDeployDialog(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.deployDialogBackdrop.hidden) {
    toggleDeployDialog(false);
  }
});

for (const copyBtn of document.querySelectorAll('[data-copy-target]')) {
  copyBtn.addEventListener('click', () => {
    const id = copyBtn.getAttribute('data-copy-target');
    const codeEl = document.getElementById(id);
    if (codeEl) copyText(codeEl.textContent.trim(), '部署命令');
  });
}

// Initial Render
syncOperationUI();
