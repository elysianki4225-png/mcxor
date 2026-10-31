/**
 * Comprehensive Automated Test Suite for MCXOR Core Engine, Integrity Verifier,
 * Streaming ZIP Reader/Writer, and MemoryGuard Leak Prevention.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_KEY_BYTES,
  XOR_MAGIC_BE,
  checkFileIsEncrypt,
  verifyLdbFooter,
  parseKeyInput,
  formatKeyInfo,
  encryptBuffer,
  decryptBuffer,
  inferArchiveXorKey,
  isTargetDbFileName,
} from '../src/core/xorCrypto.js';

import {
  crc32,
  decodeZipPath,
  readZipCentralDirectory,
  extractZipEntryBytes,
  StreamingZipBuilder,
} from '../src/core/zipStream.js';

import { analyzeArchiveInput, processArchiveSession } from '../src/core/archiveEngine.js';
import {
  buildSampleBedrockLevelDat,
  buildSamplePlainLdb,
  createDemoArchiveBlob,
} from '../src/app/sampleGenerator.js';
import { MemoryGuard } from '../src/app/memoryGuard.js';

test('XOR Crypto: passive default key encrypt & decrypt roundtrip', () => {
  const original = new TextEncoder().encode('MANIFEST-000001\n');
  const encrypted = encryptBuffer(original);
  assert.equal(encrypted.byteLength, original.byteLength + 4);
  assert.equal(checkFileIsEncrypt(encrypted), true);

  const view = new DataView(encrypted.buffer, encrypted.byteOffset, 4);
  assert.equal(view.getUint32(0, false), XOR_MAGIC_BE);

  const decrypted = decryptBuffer(encrypted);
  assert.deepEqual(decrypted, original);
});

test('XOR Crypto: HTMonkeyG key normalization (>64-bit tail slice, <64-bit pad, odd hex)', () => {
  // Exact 8 bytes
  const exact = parseKeyInput('0x3838333239383531', 'hex');
  assert.equal(exact.ok, true);
  assert.deepEqual(exact.key, DEFAULT_KEY_BYTES);

  // > 8 bytes: keep trailing 8 bytes
  const longer = parseKeyInput('0xAABBCC3838333239383531', 'hex');
  assert.equal(longer.ok, true);
  assert.deepEqual(longer.key, DEFAULT_KEY_BYTES);

  // < 8 bytes + odd nibble: '0xabc' -> '0abc' -> [0x0a, 0xbc, 0, 0, 0, 0, 0, 0]
  const shorter = parseKeyInput('0xabc', 'hex');
  assert.equal(shorter.ok, true);
  assert.deepEqual(shorter.key, new Uint8Array([0x0a, 0xbc, 0, 0, 0, 0, 0, 0]));

  // More than 6 digits in filename (#6 regression check)
  assert.equal(isTargetDbFileName('0000007.ldb'), true);
  assert.equal(isTargetDbFileName('12345678.ldb'), true);
  assert.equal(isTargetDbFileName('MANIFEST-1234567'), true);
  assert.equal(isTargetDbFileName('000003.log'), false);
  assert.equal(isTargetDbFileName('LOCK'), false);
});

test('Key Inference: primary CURRENT ⊕ MANIFEST and fallback LDB footer magic recovery', () => {
  const customKey = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x12, 0x34, 0x56, 0x78]);
  const encCurrent = encryptBuffer(new TextEncoder().encode('MANIFEST-000042\n'), customKey);
  const encLdb = encryptBuffer(buildSamplePlainLdb(9, 2048), customKey);

  // 1. Primary inference via CURRENT ⊕ MANIFEST
  const res1 = inferArchiveXorKey({
    currentBytes: encCurrent,
    manifestNames: ['MANIFEST-000001', 'MANIFEST-000042'],
    ldbEncryptedSamples: [
      {
        name: '000009.ldb',
        length: encLdb.byteLength,
        header4: encLdb.subarray(0, 4),
        tail12: encLdb.subarray(encLdb.byteLength - 12),
      },
    ],
  });
  assert.equal(res1.ok, true);
  assert.equal(res1.method, 'current_manifest_xor');
  assert.equal(res1.keyInfo.hex, '0xDEADBEEF12345678');

  // 2. Fallback inference via LDB footer magic when CURRENT is missing
  const res2 = inferArchiveXorKey({
    currentBytes: null,
    manifestNames: [],
    ldbEncryptedSamples: [
      {
        name: '000009.ldb',
        length: encLdb.byteLength,
        header4: encLdb.subarray(0, 4),
        tail12: encLdb.subarray(encLdb.byteLength - 12),
      },
      {
        name: '000010.ldb',
        length: encLdb.byteLength,
        header4: encLdb.subarray(0, 4),
        tail12: encLdb.subarray(encLdb.byteLength - 12),
      },
    ],
  });
  assert.equal(res2.ok, true);
  assert.equal(res2.method, 'ldb_footer_xor');
  assert.equal(res2.keyInfo.hex, '0xDEADBEEF12345678');

  // 3. 80-byte CURRENT secondary encryption detection
  const fake80 = new Uint8Array(80);
  fake80.set([0x90, 0x1d, 0x30, 0x01], 0);
  const res3 = inferArchiveXorKey({ currentBytes: fake80, manifestNames: ['MANIFEST-000001'] });
  assert.equal(res3.ok, false);
  assert.equal(res3.errorCode, 'SECONDARY_AES_ENCRYPTION');
});

test('Full Pipeline: Demo Encrypted Archive -> Analyze -> Auto-Decrypt (.mcworld) -> Re-Encrypt (.zip)', async () => {
  const demo = createDemoArchiveBlob({ encrypted: true, useCustomKey: true });
  const expectedHex = formatKeyInfo(demo.keyBytes).hex;

  const progressPhases = new Set();
  const { session, analysis } = await analyzeArchiveInput(
    {
      sourceType: 'zip',
      sourceName: demo.fileName,
      zipBlob: demo.blob,
    },
    {
      onProgress: (p) => progressPhases.add(p.phase),
    }
  );

  assert.equal(progressPhases.has('upload'), true);
  assert.equal(analysis.encryptedCount, 5); // CURRENT + MANIFEST + 3 .ldb
  assert.equal(analysis.hasNeteaseConfig, true);
  assert.equal(analysis.inferredKey.ok, true);
  assert.equal(analysis.inferredKey.keyInfo.hex, expectedHex);
  assert.equal(analysis.integrity.canDecrypt, true);

  // Decrypt and strip netease_config, exporting as root-normalized .mcworld
  const decResult = await processArchiveSession(
    session,
    {
      operation: 'active_decrypt',
      customKeyInput: '', // auto-infer!
      outputFormat: 'mcworld',
      stripNeteaseConfig: true,
      compressModified: false,
    },
    {
      onProgress: (p) => progressPhases.add(p.phase),
    }
  );

  assert.equal(progressPhases.has('crypto'), true);
  assert.equal(progressPhases.has('download'), true);
  assert.equal(decResult.postAvalTest.passed, true);
  assert.equal(decResult.postAvalTest.validCount, 3);
  assert.ok(decResult.outputFileName.endsWith('.mcworld'));

  // Verify the output .mcworld has level.dat at ROOT and netease_config stripped, and all .ldb footers valid!
  const { session: decSession, analysis: decAnalysis } = await analyzeArchiveInput({
    sourceType: 'zip',
    sourceName: decResult.outputFileName,
    zipBlob: decResult.outputBlob,
  });

  assert.equal(decAnalysis.structure.worldPrefix, ''); // root-normalized for .mcworld!
  assert.equal(decAnalysis.hasNeteaseConfig, false);
  assert.equal(decAnalysis.encryptedCount, 0);
  assert.equal(decAnalysis.decryptedCount, 5);
  assert.equal(decAnalysis.integrity.overallStatus, 'valid');
  assert.equal(decAnalysis.integrity.canEncrypt, true);

  // Now re-encrypt with the original custom key via Active Encrypt!
  const reEncResult = await processArchiveSession(decSession, {
    operation: 'active_encrypt',
    customKeyInput: expectedHex,
    customKeyFormat: 'hex',
    outputFormat: 'zip',
    compressModified: true,
  });

  const { analysis: reEncAnalysis } = await analyzeArchiveInput({
    sourceType: 'zip',
    sourceName: reEncResult.outputFileName,
    zipBlob: reEncResult.outputBlob,
  });
  assert.equal(reEncAnalysis.encryptedCount, 5);
  assert.equal(reEncAnalysis.inferredKey.ok, true);
  assert.equal(reEncAnalysis.inferredKey.keyInfo.hex, expectedHex);
});

test('Multi-Format Input: Folder mode & GB18030 Chinese path decoding', async () => {
  // GBK bytes for "存档/level.dat": 存(B4 E6) 档(B5 B5)
  const gbkBytes = new Uint8Array([
    0xb4, 0xe6, 0xb5, 0xb5, 0x2f, 0x6c, 0x65, 0x76, 0x65, 0x6c, 0x2e, 0x64, 0x61, 0x74,
  ]);
  const decoded = decodeZipPath(gbkBytes, false);
  assert.equal(decoded, '存档/level.dat');

  // Folder virtual file array mode
  const plainLdb = buildSamplePlainLdb(42, 4096);
  assert.equal(verifyLdbFooter(plainLdb), true);

  const folderInput = {
    sourceType: 'folder',
    sourceName: '本地文件夹存档',
    files: [
      { path: '本地文件夹存档/level.dat', file: new Blob([buildSampleBedrockLevelDat('目录世界', 0)]) },
      { path: '本地文件夹存档/db/CURRENT', file: new Blob([new TextEncoder().encode('MANIFEST-000001\n')]) },
      { path: '本地文件夹存档/db/MANIFEST-000001', file: new Blob([new Uint8Array(64)]) },
      { path: '本地文件夹存档/db/000100.ldb', file: new Blob([plainLdb]) },
    ],
  };

  const { session, analysis } = await analyzeArchiveInput(folderInput);
  assert.equal(analysis.worldName, '目录世界');
  assert.equal(analysis.integrity.overallStatus, 'valid');
  assert.equal(analysis.decryptedCount, 3);

  // Passive Encrypt -> Passive Decrypt roundtrip
  const encRes = await processArchiveSession(session, {
    operation: 'passive_encrypt',
    outputFormat: 'zip',
  });
  assert.equal(encRes.keyInfo.hex, '0x3838333239383531');

  const { session: s2 } = await analyzeArchiveInput({
    sourceType: 'zip',
    sourceName: encRes.outputFileName,
    zipBlob: encRes.outputBlob,
  });
  const decRes = await processArchiveSession(s2, {
    operation: 'passive_decrypt',
    outputFormat: 'mcworld',
  });
  assert.equal(decRes.postAvalTest.passed, true);

  // Verify exact byte-for-byte match of 000100.ldb after roundtrip!
  const { entries } = await readZipCentralDirectory(decRes.outputBlob);
  const ldbEntry = entries.find((e) => e.path === 'db/000100.ldb');
  assert.ok(ldbEntry);
  const extractedLdb = await extractZipEntryBytes(decRes.outputBlob, ldbEntry, { verifyCrc: true });
  assert.equal(crc32(extractedLdb), crc32(plainLdb));
  assert.deepEqual(extractedLdb, plainLdb);
});

test('MemoryGuard: deterministic ObjectURL revocation prevents any handle leaks', () => {
  const guard = new MemoryGuard();
  for (let i = 0; i < 25; i++) {
    guard.registerBlobUrl('download-output', new Blob([new Uint8Array(1024)]));
    guard.registerBlobUrl('world-icon', new Blob([new Uint8Array(256)]));
    // Active URLs must NEVER exceed 2 regardless of iteration count!
    assert.equal(guard.getStats().activeUrls, 2);
  }
  guard.revokeAll();
  const finalStats = guard.getStats();
  assert.equal(finalStats.activeUrls, 0);
  assert.equal(finalStats.trackedBlobBytes, 0);
  assert.equal(finalStats.totalCreated, finalStats.totalRevoked);
  guard.destroy();
});

test('Large Archive Stress Test: 40 MB multi-entry archive streams cleanly without heap bloat', async () => {
  const zip = new StreamingZipBuilder();
  const key = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
  zip.addBuffer('BigWorld/level.dat', buildSampleBedrockLevelDat('超大世界压力测试', 0));
  zip.addBuffer(
    'BigWorld/db/CURRENT',
    encryptBuffer(new TextEncoder().encode('MANIFEST-000099\n'), key)
  );
  zip.addBuffer('BigWorld/db/MANIFEST-000099', encryptBuffer(new Uint8Array(512), key));

  // Add 10 untouched 3MB resource files (30MB) + 5 encrypted 2MB .ldb files (10MB) = ~40MB archive
  const untouchedChunk = new Uint8Array(3 * 1024 * 1024);
  untouchedChunk.fill(0x5a);
  for (let i = 0; i < 10; i++) {
    zip.addBuffer(`BigWorld/resource_packs/tex_${i}.bin`, untouchedChunk, { compress: false });
  }
  for (let i = 0; i < 5; i++) {
    const ldb = buildSamplePlainLdb(i + 1, 2 * 1024 * 1024);
    zip.addBuffer(`BigWorld/db/00010${i}.ldb`, encryptBuffer(ldb, key), { compress: false });
  }

  const bigBlob = zip.finalize('application/zip');
  assert.ok(bigBlob.size > 40 * 1024 * 1024);

  const heapBefore = process.memoryUsage().heapUsed;
  const { session, analysis } = await analyzeArchiveInput({
    sourceType: 'zip',
    sourceName: 'BigWorld.zip',
    zipBlob: bigBlob,
  });

  assert.equal(analysis.inferredKey.ok, true);
  assert.equal(analysis.inferredKey.keyInfo.hex, '0x1122334455667788');

  const result = await processArchiveSession(session, {
    operation: 'active_decrypt',
    outputFormat: 'mcworld',
    compressModified: false,
  });

  assert.equal(result.postAvalTest.passed, true);
  assert.equal(result.postAvalTest.validCount, 5);
  assert.ok(result.outputSize > 40 * 1024 * 1024);

  // Release references and check heap growth stays bounded well below archive size
  session.zipBlob = null;
  session.virtualEntries = [];
  const heapAfter = process.memoryUsage().heapUsed;
  const deltaMb = (heapAfter - heapBefore) / (1024 * 1024);
  assert.ok(deltaMb < 35, `Expected bounded heap delta (<35MB), got ${deltaMb.toFixed(2)}MB`);
});

test('PWA Manifest & Service Worker App Shell Integrity: all referenced static files exist', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const root = process.cwd();

  const swText = await fs.readFile(path.join(root, 'sw.js'), 'utf-8');
  const match = swText.match(/APP_SHELL_FILES\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(match, 'APP_SHELL_FILES array must exist in sw.js');

  const urls = Array.from(match[1].matchAll(/'([^']+)'/g), (m) => m[1]);
  assert.ok(urls.length >= 15);

  for (const rel of urls) {
    const clean = rel === './' ? 'index.html' : rel.replace(/^\.\//, '');
    const st = await fs.stat(path.join(root, clean));
    assert.ok(st.isFile(), `Missing Service Worker shell asset: ${rel}`);
  }

  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.webmanifest'), 'utf-8'));
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) {
    const iconPath = path.join(root, icon.src.replace(/^\.\//, ''));
    const st = await fs.stat(iconPath);
    assert.ok(st.isFile() && st.size > 0, `Missing PWA icon: ${icon.src}`);
  }
});

