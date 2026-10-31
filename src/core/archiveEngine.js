/**
 * Memory-Safe Chunked Archive Analysis & XOR Crypto Packaging Engine
 * Runs inside Web Worker (with automatic main-thread async-yield fallback).
 */

import {
  DEFAULT_KEY_BYTES,
  isTargetDbFileName,
  inspectEncryptionHeader,
  verifyLdbFooter,
  parseKeyInput,
  formatKeyInfo,
  encryptBuffer,
  decryptBuffer,
  inferArchiveXorKey,
} from './xorCrypto.js';

import {
  streamVerifyBlobRead,
  readZipCentralDirectory,
  getZipEntryPayloadRange,
  extractZipEntryBytes,
  StreamingZipBuilder,
} from './zipStream.js';

import {
  detectArchiveFormatLabel,
  locateWorldStructure,
  inspectLevelDat,
  buildIntegrityReport,
} from './integrity.js';

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Throttles progress events (~30Hz) while always delivering 0% and 100% milestones.
 */
function createProgressEmitter(onProgress) {
  let lastEmit = 0;
  return (payload, force = false) => {
    if (!onProgress) return;
    const now = performance.now();
    if (force || payload.percent >= 100 || payload.percent <= 0 || now - lastEmit >= 32) {
      lastEmit = now;
      onProgress(payload);
    }
  };
}

/**
 * Yields back to event loop periodically so cancellation messages can be processed
 * and fallback execution never blocks UI frames.
 */
function yieldTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Analyzes an uploaded archive (ZIP/.mcworld/.mctemplate/.mcaddon OR Folder/Files)
 * without keeping full file buffers in memory.
 *
 * @param {{
 *   sourceType: 'zip'|'folder'|'files',
 *   sourceName: string,
 *   zipBlob?: Blob,
 *   files?: Array<{ path: string, file: Blob }>
 * }} input
 * @param {{
 *   onProgress?: (p: object) => void,
 *   shouldCancel?: () => boolean
 * }} [hooks]
 */
export async function analyzeArchiveInput(input, hooks = {}) {
  const emitProgress = createProgressEmitter(hooks.onProgress);
  const checkCancel = () => {
    if (hooks.shouldCancel && hooks.shouldCancel()) {
      throw new Error('OPERATION_CANCELLED');
    }
  };

  const startedAt = performance.now();
  const logs = [];
  const log = (level, msg) => logs.push({ time: Date.now(), level, message: msg });

  const formatLabel = detectArchiveFormatLabel(input.sourceName, input.sourceType);
  log('info', `读取输入源: ${input.sourceName} (${formatLabel})`);

  /** @type {Array<{ path: string, size: number, source: 'zip'|'blob', zipEntry?: object, blob?: Blob }>} */
  const virtualEntries = [];
  let totalRawSize = 0;

  if (input.sourceType === 'zip') {
    const zipBlob = input.zipBlob;
    if (!zipBlob) throw new Error('未收到压缩包文件对象');
    totalRawSize = zipBlob.size;

    emitProgress(
      {
        phase: 'upload',
        percent: 2,
        bytesLoaded: 0,
        bytesTotal: totalRawSize,
        speedBps: 0,
        currentFile: input.sourceName,
        detail: '正在流式校验文件块与读取中央目录...',
      },
      true
    );

    // 1. Stream-verify file readability (0% -> 55% of upload bar)
    await streamVerifyBlobRead(
      zipBlob,
      (loaded, total) => {
        const elapsedSec = Math.max(0.001, (performance.now() - startedAt) / 1000);
        emitProgress({
          phase: 'upload',
          percent: Math.min(55, Math.round((loaded / Math.max(1, total)) * 55)),
          bytesLoaded: loaded,
          bytesTotal: total,
          speedBps: loaded / elapsedSec,
          currentFile: input.sourceName,
          detail: '正在流式读取存档数据块...',
        });
      },
      hooks.shouldCancel
    );

    checkCancel();

    // 2. Parse Central Directory
    const { entries, isZip64 } = await readZipCentralDirectory(zipBlob);
    log(
      'info',
      `成功解析 ZIP${isZip64 ? '64' : ''} 中央目录，共包含 ${entries.length} 个条目`
    );

    for (const e of entries) {
      if (e.isDirectory) continue;
      virtualEntries.push({
        path: e.path,
        size: e.uncompressedSize,
        source: 'zip',
        zipEntry: e,
      });
    }
  } else {
    const rawFiles = input.files || [];
    if (!rawFiles.length) throw new Error('未选择任何存档文件');
    for (const item of rawFiles) {
      totalRawSize += item.file.size;
      const cleanPath = (item.path || item.file.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!cleanPath) continue;
      virtualEntries.push({
        path: cleanPath,
        size: item.file.size,
        source: 'blob',
        blob: item.file,
      });
    }
    log('info', `已载入目录/文件集合，共 ${virtualEntries.length} 个文件`);
  }

  checkCancel();

  const allPaths = virtualEntries.map((v) => v.path);
  const structure = locateWorldStructure(allPaths);

  if (structure.found) {
    log(
      'info',
      `定位世界目录成功: 模式=${structure.mode}, 根前缀="${structure.worldPrefix || '/'}", 数据库="${structure.dbPrefix || '/'}"`
    );
  } else {
    log('warn', '未能在输入中定位标准 level.dat 或 db/ 数据库结构');
  }

  /** Helper to read one virtual entry's full bytes (used only for small metadata or single 2MB db files) */
  const readEntryBytes = async (ve, verifyCrc = false) => {
    if (ve.source === 'zip') {
      return extractZipEntryBytes(input.zipBlob, ve.zipEntry, { verifyCrc });
    }
    const ab = await ve.blob.arrayBuffer();
    return new Uint8Array(ab);
  };

  // Locate metadata files relative to worldPrefix
  const wp = structure.worldPrefix;
  const levelDatEntry = virtualEntries.find((v) => v.path === wp + 'level.dat') || null;
  const levelNameTxtEntry = virtualEntries.find((v) => v.path === wp + 'levelname.txt') || null;
  const worldIconEntry =
    virtualEntries.find(
      (v) =>
        v.path.toLowerCase() === (wp + 'world_icon.jpeg').toLowerCase() ||
        v.path.toLowerCase() === (wp + 'world_icon.png').toLowerCase()
    ) || null;
  const hasNeteaseConfig = virtualEntries.some(
    (v) =>
      v.path.startsWith(wp + 'netease_config/') ||
      v.path === wp + 'netease_config' ||
      /(^|\/)netease_config(\/|$)/.test(v.path)
  );

  let levelNameTxt = '';
  if (levelNameTxtEntry && levelNameTxtEntry.size <= 64 * 1024) {
    const bytes = await readEntryBytes(levelNameTxtEntry, true);
    levelNameTxt = utf8Decoder.decode(bytes).trim();
  }

  let levelDatInfo = { exists: false, valid: false, edition: 'missing', detail: '缺失 level.dat' };
  if (levelDatEntry && levelDatEntry.size <= 16 * 1024 * 1024) {
    const bytes = await readEntryBytes(levelDatEntry, true);
    levelDatInfo = inspectLevelDat(bytes);
  }

  let worldIconBytes = null;
  let worldIconMime = null;
  if (worldIconEntry && worldIconEntry.size > 0 && worldIconEntry.size <= 4 * 1024 * 1024) {
    worldIconBytes = await readEntryBytes(worldIconEntry, false);
    worldIconMime = worldIconEntry.path.toLowerCase().endsWith('.png')
      ? 'image/png'
      : 'image/jpeg';
  }

  // Scan `db/` entries one by one (55% -> 100% of upload/scan progress bar)
  const dbPrefix = structure.dbPrefix;
  const dbCandidates = virtualEntries.filter((v) => {
    if (!structure.found) return false;
    if (!v.path.startsWith(dbPrefix)) return false;
    const rel = v.path.slice(dbPrefix.length);
    return !rel.includes('/'); // direct child of db/
  });

  let currentBytes = null;
  const manifestFiles = [];
  const encryptedFiles = [];
  const decryptedFiles = [];
  const aesModFiles = [];
  let ldbTotalCount = 0;
  let ldbPlainValidCount = 0;
  const ldbPlainInvalidFiles = [];
  const ldbEncryptedSamples = [];
  let crcVerifiedCount = (levelDatEntry ? 1 : 0) + (levelNameTxtEntry ? 1 : 0);

  let scannedDbBytes = 0;
  const totalDbBytes = dbCandidates.reduce((acc, item) => acc + item.size, 0);

  for (let i = 0; i < dbCandidates.length; i++) {
    checkCancel();
    if ((i & 7) === 7) await yieldTick();

    const ve = dbCandidates[i];
    const baseName = ve.path.slice(dbPrefix.length);

    if (/^MANIFEST-[0-9]{6,}$/.test(baseName)) {
      manifestFiles.push(baseName);
    }

    const isLdb = /\.(ldb|sst)$/i.test(baseName);
    const isTarget = isTargetDbFileName(baseName);

    if (!isTarget && !isLdb) {
      scannedDbBytes += ve.size;
      continue;
    }

    let buf;
    if (ve.source === 'zip') {
      buf = await readEntryBytes(ve, true);
      crcVerifiedCount++;
    } else {
      // For folder/raw File inputs, if it's a large .ldb, we only need first 4 bytes + last 12 bytes!
      if (baseName === 'CURRENT' || ve.size <= 4096) {
        buf = await readEntryBytes(ve, false);
      } else {
        const head = new Uint8Array(await ve.blob.slice(0, 4).arrayBuffer());
        const tail = new Uint8Array(
          await ve.blob.slice(Math.max(0, ve.size - 12), ve.size).arrayBuffer()
        );
        const hInfo = inspectEncryptionHeader(head);
        if (isTarget) {
          if (hInfo.scheme === 'aes_mod') aesModFiles.push(baseName);
          else if (hInfo.isEncrypted) encryptedFiles.push(baseName);
          else decryptedFiles.push(baseName);
        }
        if (isLdb) {
          ldbTotalCount++;
          if (hInfo.isEncrypted) {
            if (ldbEncryptedSamples.length < 16) {
              ldbEncryptedSamples.push({
                name: baseName,
                length: ve.size,
                header4: head,
                tail12: tail,
              });
            }
          } else if (verifyLdbFooter(tail)) {
            ldbPlainValidCount++;
          } else {
            ldbPlainInvalidFiles.push(baseName);
          }
        }
        scannedDbBytes += ve.size;
        const pct =
          55 + Math.round((scannedDbBytes / Math.max(1, totalDbBytes)) * 45);
        const elapsedSec = Math.max(0.001, (performance.now() - startedAt) / 1000);
        emitProgress({
          phase: 'upload',
          percent: Math.min(99, pct),
          bytesLoaded: Math.round((Math.min(99, pct) / 100) * totalRawSize),
          bytesTotal: totalRawSize,
          speedBps: totalRawSize / elapsedSec,
          currentFile: ve.path,
          detail: `正在扫描数据库文件 (${i + 1}/${dbCandidates.length}): ${baseName}`,
        });
        continue;
      }
    }

    if (baseName === 'CURRENT') {
      currentBytes = new Uint8Array(buf);
    }

    const hInfo = inspectEncryptionHeader(buf);
    if (isTarget) {
      if (hInfo.scheme === 'aes_mod') aesModFiles.push(baseName);
      else if (hInfo.isEncrypted) encryptedFiles.push(baseName);
      else decryptedFiles.push(baseName);
    }

    if (isLdb) {
      ldbTotalCount++;
      if (hInfo.isEncrypted) {
        if (ldbEncryptedSamples.length < 16) {
          ldbEncryptedSamples.push({
            name: baseName,
            length: buf.byteLength,
            header4: new Uint8Array(buf.subarray(0, Math.min(4, buf.byteLength))),
            tail12: new Uint8Array(buf.subarray(Math.max(0, buf.byteLength - 12))),
          });
        }
      } else if (verifyLdbFooter(buf)) {
        ldbPlainValidCount++;
      } else {
        ldbPlainInvalidFiles.push(baseName);
      }
    }

    // Release temporary uncompressed buffer immediately so GC reclaims memory
    buf = null;

    scannedDbBytes += ve.size;
    const pct = 55 + Math.round((scannedDbBytes / Math.max(1, totalDbBytes)) * 45);
    const elapsedSec = Math.max(0.001, (performance.now() - startedAt) / 1000);
    emitProgress({
      phase: 'upload',
      percent: Math.min(99, pct),
      bytesLoaded: Math.round((Math.min(99, pct) / 100) * totalRawSize),
      bytesTotal: totalRawSize,
      speedBps: totalRawSize / elapsedSec,
      currentFile: ve.path,
      detail: `正在检验数据库完整性 (${i + 1}/${dbCandidates.length}): ${baseName}`,
    });
  }

  // Key Inference if archive contains encrypted files
  let inferredKeyResult = null;
  if (encryptedFiles.length > 0 || aesModFiles.length > 0) {
    inferredKeyResult = inferArchiveXorKey({
      currentBytes,
      manifestNames: manifestFiles,
      ldbEncryptedSamples,
    });
    if (inferredKeyResult.ok) {
      log(
        'success',
        `推导密钥成功: ${inferredKeyResult.keyInfo.hex} (ASCII: "${inferredKeyResult.keyInfo.ascii}", 来源: ${inferredKeyResult.keyInfo.source})`
      );
    } else {
      log('warn', inferredKeyResult.errorMessage);
    }
  } else if (decryptedFiles.length > 0) {
    log('info', '当前存档处于未加密明文状态，可执行被动加密或自定义密钥主动加密');
  }

  const integrity = buildIntegrityReport({
    structure,
    levelDatInfo,
    hasCurrent: Boolean(currentBytes),
    currentLength: currentBytes ? currentBytes.byteLength : 0,
    manifestFiles,
    ldbTotalCount,
    ldbPlainValidCount,
    ldbPlainInvalidFiles,
    encryptedFiles,
    decryptedFiles,
    aesModFiles,
    hasNeteaseConfig,
    crcVerifiedCount,
  });

  if (integrity.overallStatus === 'valid') {
    log('success', '存档完整性检测通过');
  } else if (integrity.overallStatus === 'partial') {
    log('warn', '存档完整性检测完成（存在部分提示项，请留意诊断报告）');
  } else {
    log('error', '存档完整性检测存在错误项，请检查诊断列表');
  }

  const worldName =
    levelNameTxt ||
    (levelDatInfo && levelDatInfo.levelName) ||
    deriveBaseName(input.sourceName);

  // Recommend best operation automatically
  let recommendedOperation = 'active_decrypt';
  if (encryptedFiles.length > 0) {
    if (inferredKeyResult && inferredKeyResult.ok && inferredKeyResult.keyInfo.isDefaultKey) {
      recommendedOperation = 'passive_decrypt';
    } else {
      recommendedOperation = 'active_decrypt';
    }
  } else if (decryptedFiles.length > 0) {
    recommendedOperation = 'passive_encrypt';
  }

  const elapsedMs = Math.round(performance.now() - startedAt);
  emitProgress(
    {
      phase: 'upload',
      percent: 100,
      bytesLoaded: totalRawSize,
      bytesTotal: totalRawSize,
      speedBps: totalRawSize / Math.max(0.001, elapsedMs / 1000),
      currentFile: input.sourceName,
      detail: `扫描与完整性验证完成 (${(elapsedMs / 1000).toFixed(2)}s)`,
    },
    true
  );

  // Keep lightweight session descriptor inside worker for subsequent processing
  const session = {
    sourceType: input.sourceType,
    sourceName: input.sourceName,
    zipBlob: input.zipBlob || null,
    virtualEntries,
    structure,
    worldName,
    encryptedFiles,
    decryptedFiles,
    aesModFiles,
    manifestFiles,
    hasNeteaseConfig,
    inferredKeyBytes:
      inferredKeyResult && inferredKeyResult.ok ? inferredKeyResult.keyBytes : null,
    inferredKeyInfo:
      inferredKeyResult && inferredKeyResult.ok ? inferredKeyResult.keyInfo : null,
  };

  // Sample file list preview for UI (cap at 120 items so postMessage stays tiny)
  const dbPreviewList = dbCandidates.slice(0, 120).map((ve) => {
    const base = ve.path.slice(dbPrefix.length);
    let state = 'other';
    if (encryptedFiles.includes(base)) state = 'encrypted';
    else if (aesModFiles.includes(base)) state = 'aes_mod';
    else if (decryptedFiles.includes(base)) state = 'decrypted';
    return {
      name: base,
      path: ve.path,
      size: ve.size,
      state,
    };
  });

  const analysis = {
    sourceName: input.sourceName,
    sourceType: input.sourceType,
    formatLabel,
    totalRawSize,
    totalFilesCount: virtualEntries.length,
    worldName,
    gameModeLabel: (levelDatInfo && levelDatInfo.gameModeLabel) || null,
    storageVersion: (levelDatInfo && levelDatInfo.storageVersion) || null,
    worldIconBytes,
    worldIconMime,
    structure,
    hasNeteaseConfig,
    encryptedCount: encryptedFiles.length,
    decryptedCount: decryptedFiles.length,
    aesModCount: aesModFiles.length,
    ldbTotalCount,
    manifestFiles,
    inferredKey: inferredKeyResult,
    defaultKeyInfo: formatKeyInfo(DEFAULT_KEY_BYTES, '网易内置默认密钥 ("88329851")'),
    integrity,
    recommendedOperation,
    dbPreviewList,
    dbTotalEntriesCount: dbCandidates.length,
    elapsedMs,
    logs,
  };

  return { session, analysis };
}

/**
 * Processes an analyzed archive session:
 * - Phase 2 (`crypto` progress bar): Decrypts or encrypts `db/` files one at a time + verifies `.ldb` magic footers.
 * - Phase 3 (`download` progress bar): Repackages into `.mcworld` or `.zip` using zero-copy Blob slices.
 *
 * @param {object} session
 * @param {{
 *   operation: 'active_decrypt'|'passive_decrypt'|'passive_encrypt'|'active_encrypt',
 *   customKeyInput?: string,
 *   customKeyFormat?: 'hex'|'ascii',
 *   outputFormat?: 'mcworld'|'zip',
 *   stripNeteaseConfig?: boolean,
 *   compressModified?: boolean
 * }} params
 * @param {{
 *   onProgress?: (p: object) => void,
 *   shouldCancel?: () => boolean
 * }} [hooks]
 */
export async function processArchiveSession(session, params, hooks = {}) {
  if (!session) throw new Error('请先导入存档文件');

  const emitProgress = createProgressEmitter(hooks.onProgress);
  const checkCancel = () => {
    if (hooks.shouldCancel && hooks.shouldCancel()) {
      throw new Error('OPERATION_CANCELLED');
    }
  };

  const logs = [];
  const log = (level, message) => logs.push({ time: Date.now(), level, message });
  const startedAt = performance.now();

  const op = params.operation || 'active_decrypt';
  const isDecrypt = op === 'active_decrypt' || op === 'passive_decrypt';

  // Resolve 8-byte key
  let activeKeyBytes = null;
  let activeKeyInfo = null;

  if (op === 'passive_decrypt' || op === 'passive_encrypt') {
    activeKeyBytes = DEFAULT_KEY_BYTES;
    activeKeyInfo = formatKeyInfo(DEFAULT_KEY_BYTES, '被动模式 · 网易内置密钥 ("88329851")');
  } else if (op === 'active_decrypt') {
    const customTxt = (params.customKeyInput || '').trim();
    if (customTxt.length > 0) {
      const parsed = parseKeyInput(customTxt, params.customKeyFormat || 'hex');
      if (!parsed.ok) throw new Error(parsed.error);
      activeKeyBytes = parsed.key;
      activeKeyInfo = formatKeyInfo(activeKeyBytes, '主动解密 · 用户自定义密钥');
      if (parsed.warning) log('warn', parsed.warning);
    } else if (session.inferredKeyBytes) {
      activeKeyBytes = session.inferredKeyBytes;
      activeKeyInfo = session.inferredKeyInfo;
    } else {
      throw new Error(
        '自适应推导密钥不可用：请在密钥输入框填写 64-bit 十六进制密钥，或切换至被动解密尝试'
      );
    }
  } else if (op === 'active_encrypt') {
    const customTxt = (params.customKeyInput || '').trim();
    if (!customTxt.length) {
      throw new Error('主动加密需要输入 64-bit 密钥（或点击随机生成密钥）');
    }
    const parsed = parseKeyInput(customTxt, params.customKeyFormat || 'hex');
    if (!parsed.ok) throw new Error(parsed.error);
    activeKeyBytes = parsed.key;
    activeKeyInfo = formatKeyInfo(activeKeyBytes, '主动加密 · 用户自定义密钥');
    if (parsed.warning) log('warn', parsed.warning);
  } else {
    throw new Error(`未知操作类型: ${op}`);
  }

  // Validate file state matching HTMonkeyG rules
  if (isDecrypt) {
    if (session.aesModFiles.length > 0) {
      throw new Error('检测到 0x901D3001 资源中心二次加密文件，本工具不支持解密该 AES 模组格式');
    }
    if (session.encryptedFiles.length === 0) {
      throw new Error('未找到加密的数据库文件，该存档可能已经处于解密状态');
    }
  } else {
    if (session.encryptedFiles.length > 0 || session.aesModFiles.length > 0) {
      throw new Error('找到已加密文件，无法再次执行加密（请先解密后再使用新密钥加密）');
    }
    if (session.decryptedFiles.length === 0) {
      throw new Error('未找到准备加密的核心数据库文件 (CURRENT / MANIFEST-* / *.ldb)');
    }
  }

  const dbPrefix = session.structure.dbPrefix;
  const targetNamesSet = new Set(
    isDecrypt ? session.encryptedFiles : session.decryptedFiles
  );

  const targetEntries = session.virtualEntries.filter((ve) => {
    if (!ve.path.startsWith(dbPrefix)) return false;
    const rel = ve.path.slice(dbPrefix.length);
    return !rel.includes('/') && targetNamesSet.has(rel);
  });

  log(
    'info',
    `开始执行${isDecrypt ? '解密' : '加密'}，使用密钥 ${activeKeyInfo.hex}，目标核心文件 ${targetEntries.length} 个`
  );

  // =========================================================================
  // PHASE 2: File-by-File XOR Decryption / Encryption (`crypto` progress bar)
  // =========================================================================
  /** @type {Map<string, { blob: Blob, uncompressedSize: number, crc32: number, method: number }>} */
  const processedBlobs = new Map();

  let ldbCheckedCount = 0;
  let ldbValidCount = 0;
  const ldbInvalidFiles = [];

  const totalCryptoBytes = targetEntries.reduce((sum, e) => sum + e.size, 0);
  let doneCryptoBytes = 0;

  emitProgress(
    {
      phase: 'crypto',
      percent: 0,
      filesDone: 0,
      filesTotal: targetEntries.length,
      bytesLoaded: 0,
      bytesTotal: totalCryptoBytes,
      currentFile: '',
      detail: `准备${isDecrypt ? '解密' : '加密'} ${targetEntries.length} 个数据库核心文件...`,
    },
    true
  );

  for (let i = 0; i < targetEntries.length; i++) {
    checkCancel();
    if ((i & 3) === 3) await yieldTick();

    const ve = targetEntries[i];
    const baseName = ve.path.slice(dbPrefix.length);

    let rawBytes;
    if (ve.source === 'zip') {
      rawBytes = await extractZipEntryBytes(session.zipBlob, ve.zipEntry, { verifyCrc: false });
    } else {
      rawBytes = new Uint8Array(await ve.blob.arrayBuffer());
    }

    let transformed;
    if (isDecrypt) {
      transformed = decryptBuffer(rawBytes, activeKeyBytes);
      if (!transformed) {
        throw new Error(`解密文件失败（未识别加密魔数头）: ${baseName}`);
      }
      if (/\.(ldb|sst)$/i.test(baseName)) {
        ldbCheckedCount++;
        if (verifyLdbFooter(transformed)) {
          ldbValidCount++;
        } else {
          ldbInvalidFiles.push(baseName);
        }
      }
    } else {
      transformed = encryptBuffer(rawBytes, activeKeyBytes);
    }

    // Free input buffer reference immediately
    rawBytes = null;

    // Store temporarily as an isolated Blob slice so V8 TypedArray heap is freed each iteration
    processedBlobs.set(ve.path, {
      plainBlob: new Blob([transformed]),
      size: transformed.byteLength,
    });
    transformed = null;

    doneCryptoBytes += ve.size;
    const pct = Math.round(((i + 1) / Math.max(1, targetEntries.length)) * 100);
    emitProgress({
      phase: 'crypto',
      percent: Math.min(99, pct),
      filesDone: i + 1,
      filesTotal: targetEntries.length,
      bytesLoaded: doneCryptoBytes,
      bytesTotal: totalCryptoBytes,
      currentFile: baseName,
      detail: `正在${isDecrypt ? '解密' : '加密'} (${i + 1}/${targetEntries.length}): ${baseName}`,
    });
  }

  emitProgress(
    {
      phase: 'crypto',
      percent: 100,
      filesDone: targetEntries.length,
      filesTotal: targetEntries.length,
      bytesLoaded: totalCryptoBytes,
      bytesTotal: totalCryptoBytes,
      currentFile: 'Done',
      detail: `${isDecrypt ? '解密' : '加密'}计算完成 (${targetEntries.length}/${targetEntries.length} 个文件)`,
    },
    true
  );

  if (isDecrypt && ldbCheckedCount > 0) {
    if (ldbInvalidFiles.length === 0) {
      log(
        'success',
        `ldb 合理性测试通过：全部 ${ldbValidCount}/${ldbCheckedCount} 个 .ldb 文件尾部魔数 (0x57FB808B247547DB) 校验正确`
      );
    } else {
      log(
        'error',
        `发现 ${ldbInvalidFiles.length}/${ldbCheckedCount} 个魔数不对应的 .ldb 文件 (${ldbInvalidFiles.slice(0, 3).join(', ')})，可能密钥不正确或存档本身已损坏`
      );
    }
  }

  // =========================================================================
  // PHASE 3: Streaming Packaging & Download Prep (`download` progress bar)
  // =========================================================================
  const outputFormat = params.outputFormat === 'mcworld' ? 'mcworld' : 'zip';
  const stripNetease = Boolean(params.stripNeteaseConfig);
  const compressModified = Boolean(params.compressModified);
  const worldPrefix = session.structure.worldPrefix || '';

  const zipBuilder = new StreamingZipBuilder();
  const entriesToPack = session.virtualEntries.filter((ve) => {
    if (stripNetease) {
      if (
        ve.path.startsWith(worldPrefix + 'netease_config/') ||
        ve.path === worldPrefix + 'netease_config' ||
        /(^|\/)netease_config(\/|$)/.test(ve.path)
      ) {
        return false;
      }
    }
    return true;
  });

  if (stripNetease && entriesToPack.length < session.virtualEntries.length) {
    log(
      'info',
      `已按选项移除 ${session.virtualEntries.length - entriesToPack.length} 个 netease_config 相关文件以兼容国际版`
    );
  }

  const totalPackBytes = entriesToPack.reduce((sum, e) => sum + e.size, 0);
  let donePackBytes = 0;

  emitProgress(
    {
      phase: 'download',
      percent: 0,
      filesDone: 0,
      filesTotal: entriesToPack.length,
      bytesLoaded: 0,
      bytesTotal: totalPackBytes,
      currentFile: '',
      detail: '正在流式构建输出存档包...',
    },
    true
  );

  for (let i = 0; i < entriesToPack.length; i++) {
    checkCancel();
    if ((i & 15) === 15) await yieldTick();

    const ve = entriesToPack[i];
    // For .mcworld (or when worldPrefix exists and user exports .mcworld), normalize root so level.dat is at archive root!
    let outPath = ve.path;
    if (outputFormat === 'mcworld' && worldPrefix && outPath.startsWith(worldPrefix)) {
      outPath = outPath.slice(worldPrefix.length);
    } else if (
      outputFormat === 'zip' &&
      session.structure.mode === 'flat_db_only' &&
      !outPath.startsWith('db/')
    ) {
      outPath = 'db/' + outPath;
    }

    const modified = processedBlobs.get(ve.path);
    if (modified) {
      const plainBytes = new Uint8Array(await modified.plainBlob.arrayBuffer());
      zipBuilder.addBuffer(outPath, plainBytes, {
        compress: compressModified,
        dosTime: ve.zipEntry ? ve.zipEntry.dosTime : undefined,
        dosDate: ve.zipEntry ? ve.zipEntry.dosDate : undefined,
      });
      // Immediately drop processed Blob entry once written to builder
      processedBlobs.delete(ve.path);
    } else if (ve.source === 'zip' && session.zipBlob) {
      // Zero-copy slice directly from original ZIP Blob on disk!
      const { dataStart, dataEnd } = await getZipEntryPayloadRange(
        session.zipBlob,
        ve.zipEntry
      );
      const rawSlice = session.zipBlob.slice(dataStart, dataEnd);
      zipBuilder.addPassthroughBlob(outPath, rawSlice, {
        method: ve.zipEntry.compressionMethod,
        crc32: ve.zipEntry.crc32,
        uncompressedSize: ve.zipEntry.uncompressedSize,
        dosTime: ve.zipEntry.dosTime,
        dosDate: ve.zipEntry.dosDate,
      });
    } else {
      const plainBytes = new Uint8Array(await ve.blob.arrayBuffer());
      zipBuilder.addBuffer(outPath, plainBytes, { compress: compressModified });
    }

    donePackBytes += ve.size;
    const pct = Math.round(((i + 1) / Math.max(1, entriesToPack.length)) * 96);
    emitProgress({
      phase: 'download',
      percent: Math.min(96, pct),
      filesDone: i + 1,
      filesTotal: entriesToPack.length,
      bytesLoaded: donePackBytes,
      bytesTotal: totalPackBytes,
      currentFile: outPath,
      detail: `正在打包存档条目 (${i + 1}/${entriesToPack.length}): ${outPath}`,
    });
  }

  processedBlobs.clear();

  const mimeType =
    outputFormat === 'mcworld' ? 'application/vnd.minecraft.world' : 'application/zip';
  const outputBlob = zipBuilder.finalize(mimeType);

  const safeWorldTitle = sanitizeFileName(session.worldName || 'MCArchive');
  const suffix = isDecrypt ? '_Decrypted' : '_Encrypted';
  const ext = outputFormat === 'mcworld' ? '.mcworld' : '.zip';
  const outputFileName = `${safeWorldTitle}${suffix}${ext}`;

  const totalElapsedMs = Math.round(performance.now() - startedAt);
  log(
    'success',
    `打包完成: ${outputFileName} (${formatBytesShort(outputBlob.size)}, 耗时 ${(totalElapsedMs / 1000).toFixed(2)}s)`
  );

  emitProgress(
    {
      phase: 'download',
      percent: 100,
      filesDone: entriesToPack.length,
      filesTotal: entriesToPack.length,
      bytesLoaded: outputBlob.size,
      bytesTotal: outputBlob.size,
      currentFile: outputFileName,
      detail: `打包就绪，已生成下载流 (${formatBytesShort(outputBlob.size)})`,
    },
    true
  );

  return {
    outputBlob,
    outputFileName,
    outputSize: outputBlob.size,
    operation: op,
    isDecrypt,
    keyInfo: activeKeyInfo,
    postAvalTest: {
      applicable: isDecrypt && ldbCheckedCount > 0,
      passed: ldbInvalidFiles.length === 0,
      checkedCount: ldbCheckedCount,
      validCount: ldbValidCount,
      invalidFiles: ldbInvalidFiles,
    },
    processedDbCount: targetEntries.length,
    totalPackedCount: entriesToPack.length,
    elapsedMs: totalElapsedMs,
    logs,
  };
}

function deriveBaseName(name) {
  if (!name) return 'MinecraftWorld';
  return name.replace(/\.(mcworld|mctemplate|mcaddon|mcpack|zip)$/i, '') || 'MinecraftWorld';
}

function sanitizeFileName(name) {
  return (
    name
      .replace(/§[0-9a-gk-or]/gi, '') // strip Minecraft color formatting codes like §a §l!
      .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_')
      .trim()
      .slice(0, 64) || 'MCArchive'
  );
}

function formatBytesShort(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
