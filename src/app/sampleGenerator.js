/**
 * Synthetic Authentic NetEase Minecraft Archive Generator
 * Creates a byte-accurate sample world (.mcworld / .zip) in-memory for instant interactive testing
 * and unit-test verification.
 */

import {
  DEFAULT_KEY_BYTES,
  LDB_TABLE_MAGIC_BYTES,
  encryptBuffer,
} from '../core/xorCrypto.js';
import { StreamingZipBuilder } from '../core/zipStream.js';

const encoder = new TextEncoder();

/**
 * Builds a minimal valid Minecraft Bedrock Little-Endian `level.dat` buffer
 * containing `LevelName` (TAG_String) and `GameType` (TAG_Int).
 */
export function buildSampleBedrockLevelDat(worldName = '星河空岛 · 网易加密示例存档', gameType = 1) {
  const nameBytes = encoder.encode(worldName);
  const tagLevelNameKey = encoder.encode('LevelName');
  const tagGameTypeKey = encoder.encode('GameType');

  // Root Compound: [0x0A] [0x00 0x00] ... tags ... [0x00]
  const payloadLen =
    3 + // root compound header
    (1 + 2 + tagLevelNameKey.byteLength + 2 + nameBytes.byteLength) +
    (1 + 2 + tagGameTypeKey.byteLength + 4) +
    1; // TAG_End

  const out = new Uint8Array(8 + payloadLen);
  const view = new DataView(out.buffer);
  view.setInt32(0, 10, true); // storageVersion = 10
  view.setInt32(4, payloadLen, true); // nbt payload length

  let p = 8;
  out[p++] = 0x0a; // TAG_Compound
  view.setUint16(p, 0, true);
  p += 2;

  // TAG_String "LevelName"
  out[p++] = 0x08;
  view.setUint16(p, tagLevelNameKey.byteLength, true);
  p += 2;
  out.set(tagLevelNameKey, p);
  p += tagLevelNameKey.byteLength;
  view.setUint16(p, nameBytes.byteLength, true);
  p += 2;
  out.set(nameBytes, p);
  p += nameBytes.byteLength;

  // TAG_Int "GameType"
  out[p++] = 0x03;
  view.setUint16(p, tagGameTypeKey.byteLength, true);
  p += 2;
  out.set(tagGameTypeKey, p);
  p += tagGameTypeKey.byteLength;
  view.setInt32(p, gameType, true);
  p += 4;

  // TAG_End
  out[p++] = 0x00;

  return out;
}

/**
 * Builds a realistic LevelDB `.ldb` SSTable buffer ending with the 48-byte footer + 8-byte LevelDB magic.
 */
export function buildSamplePlainLdb(seed = 1, sizeBytes = 4096) {
  const len = Math.max(64, sizeBytes);
  const buf = new Uint8Array(len);
  for (let i = 0; i < len - 8; i++) {
    buf[i] = (i * 31 + seed * 17) & 0xff;
  }
  buf.set(LDB_TABLE_MAGIC_BYTES, len - 8);
  return buf;
}

/**
 * Creates a complete sample NetEase encrypted `.mcworld` Blob for 1-click demo testing.
 * @param {{ encrypted?: boolean, useCustomKey?: boolean }} [opts]
 */
export function createDemoArchiveBlob(opts = {}) {
  const encrypted = opts.encrypted !== false;
  const useCustomKey = opts.useCustomKey !== false;

  // Custom 64-bit Resource Center style key ("MCXOR777" = 0x4D43584F52373737) or default "88329851"
  const keyBytes = useCustomKey
    ? new Uint8Array([0x4d, 0x43, 0x58, 0x4f, 0x52, 0x37, 0x37, 0x37])
    : DEFAULT_KEY_BYTES;

  const worldTitle = encrypted
    ? '星河空岛_资源中心加密示例'
    : '星河空岛_国际版明文示例';

  const manifestName = 'MANIFEST-000012';
  const rawCurrent = encoder.encode(`${manifestName}\n`);
  const rawManifest = new Uint8Array(256);
  rawManifest.set(encoder.encode('leveldb.BytewiseComparator'), 4);

  const ldb1 = buildSamplePlainLdb(3, 8192);
  const ldb2 = buildSamplePlainLdb(7, 12288);
  const ldb3 = buildSamplePlainLdb(11, 6144);
  const logPlain = encoder.encode('LevelDB write-ahead log (unencrypted per NetEase spec)\n');

  const wrap = (b) => (encrypted ? encryptBuffer(b, keyBytes) : b);

  const zip = new StreamingZipBuilder();
  const prefix = 'StarSkyBlock_Save/';
  zip.addBuffer(`${prefix}level.dat`, buildSampleBedrockLevelDat(worldTitle, 1), {
    compress: true,
  });
  zip.addBuffer(`${prefix}levelname.txt`, encoder.encode(worldTitle), { compress: false });
  zip.addBuffer(
    `${prefix}netease_config/world_behavior.json`,
    encoder.encode(JSON.stringify({ resourceCenterMap: true, version: '3.3.35' }, null, 2)),
    { compress: true }
  );
  zip.addBuffer(`${prefix}db/CURRENT`, wrap(rawCurrent), { compress: false });
  zip.addBuffer(`${prefix}db/${manifestName}`, wrap(rawManifest), { compress: true });
  zip.addBuffer(`${prefix}db/000005.ldb`, wrap(ldb1), { compress: true });
  zip.addBuffer(`${prefix}db/000008.ldb`, wrap(ldb2), { compress: true });
  zip.addBuffer(`${prefix}db/000011.ldb`, wrap(ldb3), { compress: true });
  zip.addBuffer(`${prefix}db/000013.log`, logPlain, { compress: false });

  const blob = zip.finalize('application/zip');
  return {
    blob,
    fileName: `${worldTitle}.zip`,
    keyBytes,
  };
}
