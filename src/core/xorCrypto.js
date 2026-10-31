/**
 * NetEase Minecraft Archive XOR Encryption & Decryption Core
 * Faithfully implements and extends HTMonkeyG/XOR-MC-Archive-Decrypt (MIT)
 *
 * Magic Header (XOR): 0x80 0x1D 0x30 0x01 (BE: 0x801D3001)
 * Secondary Mod/AES Header: 0x90 0x1D 0x30 0x01 (BE: 0x901D3001)
 * Default Passive Key: ASCII "88329851" (0x3838333239383531)
 * LevelDB Table Footer Magic: 0x57FB808B247547DB (BE) / 0xDB4775248B80FB57 (LE)
 */

export const XOR_MAGIC_BYTES = new Uint8Array([0x80, 0x1d, 0x30, 0x01]);
export const XOR_MAGIC_BE = 0x801d3001;
export const AES_MOD_MAGIC_BE = 0x901d3001;

export const DEFAULT_KEY_ASCII = '88329851';
export const DEFAULT_KEY_BYTES = new Uint8Array([0x38, 0x38, 0x33, 0x32, 0x39, 0x38, 0x35, 0x31]);

export const LDB_TABLE_MAGIC_BYTES = new Uint8Array([
  0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb,
]);

const textEncoder = new TextEncoder();

/**
 * Checks whether a filename inside `db/` should be encrypted/decrypted.
 * Matches HTMonkeyG/XOR-MC-Archive-Decrypt v4.0.2 (#6: >= 6 digits)
 * while excluding .log, LOCK, .json, .bak per leveldb-mcne.
 * @param {string} fileName
 * @returns {boolean}
 */
export function isTargetDbFileName(fileName) {
  if (!fileName) return false;
  return (
    /^CURRENT$/.test(fileName) ||
    /^MANIFEST-[0-9]{6,}$/.test(fileName) ||
    /^[0-9]{6,}\.(ldb|sst)$/i.test(fileName)
  );
}

/**
 * Inspects the first 4 bytes of a file buffer for NetEase encryption headers.
 * @param {Uint8Array} buf
 */
export function inspectEncryptionHeader(buf) {
  if (!buf || buf.byteLength < 4) {
    return { isEncrypted: false, scheme: 'plain', magicHex: null };
  }
  const view = new DataView(buf.buffer, buf.byteOffset, 4);
  const magic = view.getUint32(0, false);
  if (magic === XOR_MAGIC_BE) {
    return { isEncrypted: true, scheme: 'xor', magicHex: '0x801D3001' };
  }
  if (magic === AES_MOD_MAGIC_BE) {
    return { isEncrypted: true, scheme: 'aes_mod', magicHex: '0x901D3001' };
  }
  return { isEncrypted: false, scheme: 'plain', magicHex: null };
}

/**
 * Compatible boolean check matching XOREncryptHelper.checkFileIsEncrypt
 * @param {Uint8Array} buf
 * @returns {boolean}
 */
export function checkFileIsEncrypt(buf) {
  return inspectEncryptionHeader(buf).isEncrypted;
}

/**
 * Verifies LevelDB .ldb/.sst table footer magic number (48-byte footer ends with 8-byte magic).
 * @param {Uint8Array} buf
 * @returns {boolean}
 */
export function verifyLdbFooter(buf) {
  if (!buf || buf.byteLength < 8) return false;
  const start = buf.byteLength - 8;
  for (let i = 0; i < 8; i++) {
    if (buf[start + i] !== LDB_TABLE_MAGIC_BYTES[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Normalizes a key buffer to 8 bytes (64-bit) following HTMonkeyG's rules:
 * - > 8 bytes: keep trailing 8 bytes
 * - < 8 bytes: right-pad with 0x00 to 8 bytes
 * @param {Uint8Array} raw
 * @returns {Uint8Array}
 */
export function normalizeKeyTo8Bytes(raw) {
  if (!raw || raw.byteLength === 0) return null;
  if (raw.byteLength === 8) return new Uint8Array(raw);
  if (raw.byteLength > 8) {
    return new Uint8Array(raw.subarray(raw.byteLength - 8));
  }
  const padded = new Uint8Array(8);
  padded.set(raw, 0);
  return padded;
}

/**
 * Parses a user-entered key in Hex (default, compatible with main.js parseHexKeyInput)
 * or ASCII mode into an 8-byte Uint8Array.
 * @param {string} input
 * @param {'hex'|'ascii'} [format='hex']
 * @returns {{ ok: boolean, key?: Uint8Array, warning?: string, error?: string }}
 */
export function parseKeyInput(input, format = 'hex') {
  if (typeof input !== 'string') {
    return { ok: false, error: '密钥输入无效' };
  }
  const trimmed = input.trim();
  if (!trimmed.length) {
    return { ok: false, error: '密钥不能为空' };
  }

  if (format === 'ascii') {
    const raw = textEncoder.encode(trimmed);
    if (!raw.byteLength) return { ok: false, error: 'ASCII 密钥不能为空' };
    let warning = '';
    if (raw.byteLength > 8) warning = '输入超过 8 字节 (64-bit)，已按规范截取末尾 8 字节';
    else if (raw.byteLength < 8) warning = '输入不足 8 字节 (64-bit)，已在末尾补 0x00 至 8 字节';
    return { ok: true, key: normalizeKeyTo8Bytes(raw), warning };
  }

  // Hex mode: strip 0x prefix and spaces/hyphens
  let clean = trimmed.replace(/^(0x|0X)/, '').replace(/[\s_-]+/g, '');
  if (!clean.length || !/^[0-9a-fA-F]+$/.test(clean)) {
    return { ok: false, error: '请输入合法的十六进制密钥（例如 0x3838333239383531）' };
  }
  if (clean.length & 1) {
    clean = '0' + clean;
  }
  const byteLen = clean.length >> 1;
  const raw = new Uint8Array(byteLen);
  for (let i = 0; i < byteLen; i++) {
    raw[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  let warning = '';
  if (byteLen > 8) warning = '密钥大于 64-bit，已按原项目规范截取后 64-bit 作为有效密钥';
  else if (byteLen < 8) warning = '密钥小于 64-bit，已在低位补零填充为 64-bit (8字节)';

  return { ok: true, key: normalizeKeyTo8Bytes(raw), warning };
}

/**
 * Generates a cryptographically strong random 8-byte key.
 * @returns {Uint8Array}
 */
export function generateRandomKey() {
  const key = new Uint8Array(8);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(key);
  } else {
    for (let i = 0; i < 8; i++) key[i] = Math.floor(Math.random() * 256);
  }
  return key;
}

/**
 * Formats an 8-byte key into rich human-readable metadata for UI display.
 * @param {Uint8Array|null} keyBytes
 * @param {string} [source='unknown']
 */
export function formatKeyInfo(keyBytes, source = 'unknown') {
  if (!keyBytes || !keyBytes.byteLength) return null;
  const hexParts = Array.from(keyBytes, (b) => b.toString(16).padStart(2, '0').toUpperCase());
  const rawHex = hexParts.join('');
  const spacedHex = hexParts.join(' ');
  let ascii = '';
  let isAllPrintableAscii = true;
  for (let i = 0; i < keyBytes.byteLength; i++) {
    const c = keyBytes[i];
    if (c >= 0x20 && c <= 0x7e) {
      ascii += String.fromCharCode(c);
    } else {
      ascii += '·';
      isAllPrintableAscii = false;
    }
  }
  let isDefaultKey = keyBytes.byteLength === DEFAULT_KEY_BYTES.byteLength;
  if (isDefaultKey) {
    for (let i = 0; i < 8; i++) {
      if (keyBytes[i] !== DEFAULT_KEY_BYTES[i]) {
        isDefaultKey = false;
        break;
      }
    }
  }

  return {
    hex: '0x' + rawHex,
    hexLower: '0x' + rawHex.toLowerCase(),
    rawHex,
    spacedHex,
    ascii,
    isAllPrintableAscii,
    isDefaultKey,
    bitLength: keyBytes.byteLength * 8,
    bytes: Array.from(keyBytes),
    source,
  };
}

/**
 * Encrypts a plaintext buffer using 8-byte cyclic XOR and prepends 0x801D3001.
 * Allocates exactly ONE output Uint8Array to avoid intermediate memory churn.
 * @param {Uint8Array} plainBuf
 * @param {Uint8Array} [key]
 * @returns {Uint8Array}
 */
export function encryptBuffer(plainBuf, key = DEFAULT_KEY_BYTES) {
  const activeKey = key && key.byteLength ? key : DEFAULT_KEY_BYTES;
  const keyLen = activeKey.byteLength;
  const len = plainBuf.byteLength;
  const out = new Uint8Array(4 + len);
  out[0] = 0x80;
  out[1] = 0x1d;
  out[2] = 0x30;
  out[3] = 0x01;

  if (keyLen === 8) {
    const k0 = activeKey[0], k1 = activeKey[1], k2 = activeKey[2], k3 = activeKey[3];
    const k4 = activeKey[4], k5 = activeKey[5], k6 = activeKey[6], k7 = activeKey[7];
    let i = 0;
    const limit = len - (len & 7);
    for (; i < limit; i += 8) {
      out[4 + i] = plainBuf[i] ^ k0;
      out[5 + i] = plainBuf[i + 1] ^ k1;
      out[6 + i] = plainBuf[i + 2] ^ k2;
      out[7 + i] = plainBuf[i + 3] ^ k3;
      out[8 + i] = plainBuf[i + 4] ^ k4;
      out[9 + i] = plainBuf[i + 5] ^ k5;
      out[10 + i] = plainBuf[i + 6] ^ k6;
      out[11 + i] = plainBuf[i + 7] ^ k7;
    }
    for (; i < len; i++) {
      out[4 + i] = plainBuf[i] ^ activeKey[i & 7];
    }
  } else {
    for (let i = 0; i < len; i++) {
      out[4 + i] = plainBuf[i] ^ activeKey[i % keyLen];
    }
  }
  return out;
}

/**
 * Decrypts a NetEase XOR-encrypted buffer (strips 4-byte magic header + cyclic XOR).
 * Allocates exactly ONE output Uint8Array. Returns null if header is not encrypted.
 * @param {Uint8Array} encBuf
 * @param {Uint8Array} [key]
 * @returns {Uint8Array|null}
 */
export function decryptBuffer(encBuf, key = DEFAULT_KEY_BYTES) {
  if (!checkFileIsEncrypt(encBuf)) return null;
  const activeKey = key && key.byteLength ? key : DEFAULT_KEY_BYTES;
  const keyLen = activeKey.byteLength;
  const len = encBuf.byteLength - 4;
  const out = new Uint8Array(len);

  if (keyLen === 8) {
    const k0 = activeKey[0], k1 = activeKey[1], k2 = activeKey[2], k3 = activeKey[3];
    const k4 = activeKey[4], k5 = activeKey[5], k6 = activeKey[6], k7 = activeKey[7];
    let i = 0;
    const limit = len - (len & 7);
    for (; i < limit; i += 8) {
      out[i] = encBuf[4 + i] ^ k0;
      out[i + 1] = encBuf[5 + i] ^ k1;
      out[i + 2] = encBuf[6 + i] ^ k2;
      out[i + 3] = encBuf[7 + i] ^ k3;
      out[i + 4] = encBuf[8 + i] ^ k4;
      out[i + 5] = encBuf[9 + i] ^ k5;
      out[i + 6] = encBuf[10 + i] ^ k6;
      out[i + 7] = encBuf[11 + i] ^ k7;
    }
    for (; i < len; i++) {
      out[i] = encBuf[4 + i] ^ activeKey[i & 7];
    }
  } else {
    for (let i = 0; i < len; i++) {
      out[i] = encBuf[4 + i] ^ activeKey[i % keyLen];
    }
  }
  return out;
}

/**
 * Tests whether a candidate 8-byte key decrypts encrypted .ldb tail samples to valid LevelDB footers.
 * @param {Uint8Array} key
 * @param {Array<{name: string, length: number, tail12: Uint8Array}>} ldbSamples
 */
function countMatchingLdbSamples(key, ldbSamples) {
  if (!ldbSamples || !ldbSamples.length) return { matched: 0, total: 0 };
  let matched = 0;
  let total = 0;
  for (const s of ldbSamples) {
    if (!s || s.length < 12 || !s.tail12 || s.tail12.byteLength < 8) continue;
    total++;
    const payloadLen = s.length - 4;
    const tail8 = s.tail12.subarray(s.tail12.byteLength - 8);
    let ok = true;
    for (let j = 0; j < 8; j++) {
      const idx = payloadLen - 8 + j;
      if ((tail8[j] ^ key[idx & 7]) !== LDB_TABLE_MAGIC_BYTES[j]) {
        ok = false;
        break;
      }
    }
    if (ok) matched++;
  }
  return { matched, total };
}

/**
 * Infers the 8-byte XOR key from `db/CURRENT` + `db/MANIFEST-*` (primary HTMonkeyG algorithm),
 * with cross-verification and fallback recovery via `.ldb` LevelDB Table Magic Footers.
 *
 * @param {{
 *   currentBytes?: Uint8Array | null,
 *   manifestNames?: string[],
 *   ldbEncryptedSamples?: Array<{name: string, length: number, header4: Uint8Array, tail12: Uint8Array}>
 * }} params
 */
export function inferArchiveXorKey({
  currentBytes = null,
  manifestNames = [],
  ldbEncryptedSamples = [],
}) {
  const headerInfo = currentBytes ? inspectEncryptionHeader(currentBytes) : null;

  // Check Resource Center secondary mod encryption indicator (80-byte CURRENT or 0x901D3001)
  const is80ByteCurrent = Boolean(currentBytes && currentBytes.byteLength === 80);

  // 1. Primary Method: CURRENT (skip 4-byte magic) XOR MANIFEST-xxxxxx\n
  if (currentBytes && headerInfo && headerInfo.isEncrypted && currentBytes.byteLength >= 12) {
    const after = currentBytes.subarray(4);
    const suffixes = ['\n', '\r\n', ''];

    for (const manifest of manifestNames) {
      for (const suffix of suffixes) {
        const expectedPlain = textEncoder.encode(manifest + suffix);
        if (expectedPlain.byteLength !== after.byteLength) continue;
        if (expectedPlain.byteLength < 8) continue;

        const xored = new Uint8Array(after.byteLength);
        for (let i = 0; i < after.byteLength; i++) {
          xored[i] = expectedPlain[i] ^ after[i];
        }

        let periodic = true;
        for (let i = 8; i < xored.byteLength; i++) {
          if (xored[i] !== xored[i & 0x07]) {
            periodic = false;
            break;
          }
        }
        if (!periodic) continue;

        const keyBytes = new Uint8Array(xored.subarray(0, 8));
        const ldbCheck = countMatchingLdbSamples(keyBytes, ldbEncryptedSamples);
        if (ldbCheck.total > 0 && ldbCheck.matched === 0) {
          // Candidate did not match LDB footers; keep searching other MANIFESTs
          continue;
        }

        const keyInfo = formatKeyInfo(
          keyBytes,
          keyBytes.every((b, idx) => b === DEFAULT_KEY_BYTES[idx])
            ? '被动默认密钥 (CURRENT ⊕ MANIFEST 验证一致)'
            : `主动推导密钥 (CURRENT ⊕ ${manifest})`
        );

        return {
          ok: true,
          keyBytes,
          keyInfo,
          method: 'current_manifest_xor',
          matchedManifest: manifest,
          ldbVerifiedCount: ldbCheck.matched,
          ldbTotalSamples: ldbCheck.total,
        };
      }
    }
  }

  // 2. Fallback Method: Infer 8-byte key directly from encrypted .ldb footer magic (0x57FB808B247547DB)
  if (ldbEncryptedSamples && ldbEncryptedSamples.length > 0) {
    for (const sample of ldbEncryptedSamples) {
      const hInfo = inspectEncryptionHeader(sample.header4);
      if (!hInfo.isEncrypted || hInfo.scheme === 'aes_mod') continue;
      if (sample.length < 12 || !sample.tail12 || sample.tail12.byteLength < 8) continue;

      const payloadLen = sample.length - 4;
      const tail8 = sample.tail12.subarray(sample.tail12.byteLength - 8);
      const candidateKey = new Uint8Array(8);
      for (let j = 0; j < 8; j++) {
        const pos = payloadLen - 8 + j;
        candidateKey[pos & 7] = tail8[j] ^ LDB_TABLE_MAGIC_BYTES[j];
      }

      const ldbCheck = countMatchingLdbSamples(candidateKey, ldbEncryptedSamples);
      // Verify either multiple LDBs agree, or decrypted CURRENT begins with "MANIFEST-"
      let currentStartsWithManifest = false;
      if (currentBytes && currentBytes.byteLength >= 13 && checkFileIsEncrypt(currentBytes)) {
        const decCur = decryptBuffer(currentBytes, candidateKey);
        if (decCur) {
          const text = new TextDecoder('utf-8', { fatal: false }).decode(decCur);
          if (/^MANIFEST-[0-9]{6,}/.test(text.trim())) {
            currentStartsWithManifest = true;
          }
        }
      }

      if (currentStartsWithManifest || ldbCheck.matched >= Math.min(2, ldbCheck.total)) {
        const keyInfo = formatKeyInfo(
          candidateKey,
          `LDB 魔数推导 (${sample.name} 尾部特征恢复)`
        );
        return {
          ok: true,
          keyBytes: candidateKey,
          keyInfo,
          method: 'ldb_footer_xor',
          matchedManifest: null,
          ldbVerifiedCount: ldbCheck.matched,
          ldbTotalSamples: ldbCheck.total,
        };
      }
    }
  }

  // 3. Detailed Failure Diagnostics matching HTMonkeyG README
  if (is80ByteCurrent || (headerInfo && headerInfo.scheme === 'aes_mod')) {
    return {
      ok: false,
      errorCode: 'SECONDARY_AES_ENCRYPTION',
      errorMessage:
        '检测到资源中心二次加密特征（80 字节 CURRENT 文件或 0x901D3001 AES-128 头），该格式采用模组级加密，无法通过 64-bit XOR 推导密钥。',
    };
  }

  return {
    ok: false,
    errorCode: 'KEY_INFERENCE_FAILED',
    errorMessage:
      '自动推导密钥失败：CURRENT 与 MANIFEST 文件长度或 8 字节异或周期不匹配，您可以尝试手动输入 64-bit 十六进制密钥或尝试被动解密。',
  };
}
