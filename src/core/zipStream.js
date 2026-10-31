/**
 * Zero-Leak Random-Access ZIP32/ZIP64 Reader & Zero-Copy Streaming ZIP Writer
 *
 * Designed for large Minecraft archives (.zip, .mcworld, .mctemplate, .mcaddon, .mcpack):
 * - Reads Central Directory from the end of a Blob/File via Blob.slice() without loading the entire archive into JS heap.
 * - Supports UTF-8 and Chinese GB18030/GBK filenames automatically.
 * - Supports zero-copy Blob.slice() payload pass-through for untouched entries during repackaging.
 */

import { inflateSync, deflateSync } from '../vendor/fflate.js';

const SIG_LOCAL_FILE = 0x04034b50;
const SIG_CENTRAL_DIR = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const utf8Encoder = new TextEncoder();
const utf8StrictDecoder = new TextDecoder('utf-8', { fatal: true });
const utf8LooseDecoder = new TextDecoder('utf-8', { fatal: false });
let gbkDecoder = null;
try {
  gbkDecoder = new TextDecoder('gb18030', { fatal: false });
} catch {
  gbkDecoder = null;
}

// Precomputed IEEE 802.3 CRC32 lookup table
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * Computes CRC32 checksum of a Uint8Array (supports incremental crc seed).
 * @param {Uint8Array} buf
 * @param {number} [prevCrc=0]
 * @returns {number} unsigned 32-bit CRC
 */
export function crc32(buf, prevCrc = 0) {
  let c = (prevCrc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.byteLength; i++) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Decodes ZIP entry filename handling UTF-8 and Chinese Windows GBK/GB18030 archives,
 * normalizing slashes and preventing Zip-Slip path traversal.
 * @param {Uint8Array} nameBytes
 * @param {boolean} utf8Flag
 * @returns {string}
 */
export function decodeZipPath(nameBytes, utf8Flag) {
  let decoded = '';
  if (utf8Flag) {
    decoded = utf8LooseDecoder.decode(nameBytes);
  } else {
    try {
      decoded = utf8StrictDecoder.decode(nameBytes);
    } catch {
      decoded = gbkDecoder ? gbkDecoder.decode(nameBytes) : utf8LooseDecoder.decode(nameBytes);
    }
  }
  // Normalize Windows backslashes and sanitize traversal segments
  const normalized = decoded.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/');
  const safeParts = [];
  for (const part of parts) {
    if (part === '..' || part === '.') continue;
    safeParts.push(part);
  }
  return safeParts.join('/');
}

/**
 * Reads a byte range from a Blob/File as a Uint8Array.
 * @param {Blob} blob
 * @param {number} start
 * @param {number} end
 * @returns {Promise<Uint8Array>}
 */
async function readBlobRange(blob, start, end) {
  const clampedStart = Math.max(0, start);
  const clampedEnd = Math.min(blob.size, end);
  if (clampedEnd <= clampedStart) return new Uint8Array(0);
  const ab = await blob.slice(clampedStart, clampedEnd).arrayBuffer();
  return new Uint8Array(ab);
}

/**
 * Streams a Blob in chunks (default 8 MB) to verify readability & drive accurate upload read progress
 * without ever retaining more than 1 chunk in memory.
 * @param {Blob} blob
 * @param {(loaded: number, total: number) => void} [onProgress]
 * @param {() => boolean} [shouldCancel]
 * @param {number} [chunkSize=8388608]
 */
export async function streamVerifyBlobRead(
  blob,
  onProgress,
  shouldCancel,
  chunkSize = 8 * 1024 * 1024
) {
  const total = blob.size;
  if (total === 0) {
    if (onProgress) onProgress(0, 0);
    return;
  }
  let offset = 0;
  while (offset < total) {
    if (shouldCancel && shouldCancel()) {
      throw new Error('OPERATION_CANCELLED');
    }
    const next = Math.min(total, offset + chunkSize);
    // Touch chunk header byte via slice to verify readable underlying storage without holding memory
    const probeEnd = Math.min(next, offset + 64 * 1024);
    const probe = await blob.slice(offset, probeEnd).arrayBuffer();
    if (probe.byteLength === 0 && next > offset) {
      throw new Error('读取存档文件块失败：文件可能已被移动或权限失效');
    }
    offset = next;
    if (onProgress) onProgress(offset, total);
  }
}

/**
 * Parses Central Directory of a ZIP/MCWORLD/MCTEMPLATE/MCADDON Blob using Random-Access slices.
 * Peak heap allocation: only Central Directory bytes (typically < 256 KB even for 2,000 files).
 *
 * @param {Blob} zipBlob
 * @returns {Promise<{
 *   entries: Array<{
 *     index: number,
 *     path: string,
 *     isDirectory: boolean,
 *     compressionMethod: number,
 *     generalFlag: number,
 *     crc32: number,
 *     compressedSize: number,
 *     uncompressedSize: number,
 *     localHeaderOffset: number,
 *     dosTime: number,
 *     dosDate: number
 *   }>,
 *   isZip64: boolean
 * }>}
 */
export async function readZipCentralDirectory(zipBlob) {
  const fileSize = zipBlob.size;
  if (fileSize < 22) {
    throw new Error('文件体积过小，不是有效的 ZIP / MCWORLD 压缩存档');
  }

  // Verify quick header magic (allow self-extracting prefix or standard PK header)
  const head4 = await readBlobRange(zipBlob, 0, 4);
  const headView = new DataView(head4.buffer, head4.byteOffset, head4.byteLength);
  const firstSig = headView.getUint32(0, true);
  // Empty zip (EOCD) or standard Local File Header
  if (firstSig !== SIG_LOCAL_FILE && firstSig !== SIG_EOCD) {
    // Still search EOCD in case of minor preamble, otherwise report clear format error below
  }

  const maxTailSize = Math.min(fileSize, 65557 + 20);
  const tailStart = fileSize - maxTailSize;
  const tailBuf = await readBlobRange(zipBlob, tailStart, fileSize);
  const tailView = new DataView(tailBuf.buffer, tailBuf.byteOffset, tailBuf.byteLength);

  let eocdPos = -1;
  for (let i = tailBuf.byteLength - 22; i >= 0; i--) {
    if (tailView.getUint32(i, true) === SIG_EOCD) {
      const commentLen = tailView.getUint16(i + 20, true);
      if (i + 22 + commentLen <= tailBuf.byteLength) {
        eocdPos = i;
        break;
      }
    }
  }

  if (eocdPos === -1) {
    throw new Error('无法找到 ZIP 中央目录结尾签名 (EOCD)：压缩包可能已损坏、被截断或并非 ZIP/MCWORLD 格式');
  }

  let totalEntries = tailView.getUint16(eocdPos + 10, true);
  let cdSize = tailView.getUint32(eocdPos + 12, true);
  let cdOffset = tailView.getUint32(eocdPos + 16, true);
  let isZip64 = false;

  // Check ZIP64 EOCD Locator immediately preceding EOCD (20 bytes)
  if (eocdPos >= 20 && tailView.getUint32(eocdPos - 20, true) === SIG_ZIP64_LOCATOR) {
    isZip64 = true;
    const z64OffsetLow = tailView.getUint32(eocdPos - 12, true);
    const z64OffsetHigh = tailView.getUint32(eocdPos - 8, true);
    const z64Offset = z64OffsetHigh * 0x100000000 + z64OffsetLow;
    const z64Buf = await readBlobRange(zipBlob, z64Offset, z64Offset + 56);
    if (z64Buf.byteLength >= 56) {
      const z64View = new DataView(z64Buf.buffer, z64Buf.byteOffset, 56);
      if (z64View.getUint32(0, true) === SIG_ZIP64_EOCD) {
        totalEntries = Number(z64View.getBigUint64(32, true));
        cdSize = Number(z64View.getBigUint64(40, true));
        cdOffset = Number(z64View.getBigUint64(48, true));
      }
    }
  }

  if (cdOffset + cdSize > fileSize) {
    throw new Error('ZIP 中央目录偏移超出文件大小：存档压缩包已损坏或下载不完整');
  }

  const cdBuf = await readBlobRange(zipBlob, cdOffset, cdOffset + cdSize);
  const cdView = new DataView(cdBuf.buffer, cdBuf.byteOffset, cdBuf.byteLength);

  const entries = [];
  let ptr = 0;
  let index = 0;

  while (ptr + 46 <= cdBuf.byteLength && entries.length < totalEntries + 4096) {
    const sig = cdView.getUint32(ptr, true);
    if (sig !== SIG_CENTRAL_DIR) {
      break;
    }

    const generalFlag = cdView.getUint16(ptr + 8, true);
    if (generalFlag & 0x0001) {
      throw new Error('该压缩包设置了密码保护（ZIP 传统加密），请先解压去除压缩包密码后再导入');
    }

    const compressionMethod = cdView.getUint16(ptr + 10, true);
    const dosTime = cdView.getUint16(ptr + 12, true);
    const dosDate = cdView.getUint16(ptr + 14, true);
    const entryCrc32 = cdView.getUint32(ptr + 16, true);
    let compressedSize = cdView.getUint32(ptr + 20, true);
    let uncompressedSize = cdView.getUint32(ptr + 24, true);
    const fileNameLen = cdView.getUint16(ptr + 28, true);
    const extraLen = cdView.getUint16(ptr + 30, true);
    const commentLen = cdView.getUint16(ptr + 32, true);
    let localHeaderOffset = cdView.getUint32(ptr + 42, true);

    const nameStart = ptr + 46;
    const extraStart = nameStart + fileNameLen;
    const nextPtr = extraStart + extraLen + commentLen;
    if (nextPtr > cdBuf.byteLength) {
      throw new Error('ZIP 中央目录记录截断：存档压缩包可能损坏');
    }

    const nameBytes = cdBuf.subarray(nameStart, extraStart);
    const utf8Flag = (generalFlag & 0x0800) !== 0;
    const rawPath = decodeZipPath(nameBytes, utf8Flag);

    // Parse ZIP64 Extra Field (0x0001) when any 32-bit field is 0xFFFFFFFF
    if (
      uncompressedSize === 0xffffffff ||
      compressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      isZip64 = true;
      let ep = extraStart;
      const extraEnd = extraStart + extraLen;
      while (ep + 4 <= extraEnd) {
        const headerId = cdView.getUint16(ep, true);
        const dataSize = cdView.getUint16(ep + 2, true);
        let cursor = ep + 4;
        if (headerId === 0x0001) {
          if (uncompressedSize === 0xffffffff && cursor + 8 <= ep + 4 + dataSize) {
            uncompressedSize = Number(cdView.getBigUint64(cursor, true));
            cursor += 8;
          }
          if (compressedSize === 0xffffffff && cursor + 8 <= ep + 4 + dataSize) {
            compressedSize = Number(cdView.getBigUint64(cursor, true));
            cursor += 8;
          }
          if (localHeaderOffset === 0xffffffff && cursor + 8 <= ep + 4 + dataSize) {
            localHeaderOffset = Number(cdView.getBigUint64(cursor, true));
            cursor += 8;
          }
          break;
        }
        ep += 4 + dataSize;
      }
    }

    const isDirectory = rawPath.endsWith('/') || (uncompressedSize === 0 && rawPath === '');
    if (rawPath) {
      entries.push({
        index: index++,
        path: rawPath,
        isDirectory,
        compressionMethod,
        generalFlag,
        crc32: entryCrc32,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        dosTime,
        dosDate,
      });
    }

    ptr = nextPtr;
  }

  return { entries, isZip64 };
}

/**
 * Locates exact payload byte range [dataStart, dataEnd] of an entry inside `zipBlob`
 * by reading its 30-byte Local File Header.
 * @param {Blob} zipBlob
 * @param {{ localHeaderOffset: number, compressedSize: number, path: string }} entry
 */
export async function getZipEntryPayloadRange(zipBlob, entry) {
  const lfh = await readBlobRange(zipBlob, entry.localHeaderOffset, entry.localHeaderOffset + 30);
  if (lfh.byteLength < 30) {
    throw new Error(`读取文件本地头失败: ${entry.path}`);
  }
  const view = new DataView(lfh.buffer, lfh.byteOffset, 30);
  if (view.getUint32(0, true) !== SIG_LOCAL_FILE) {
    throw new Error(`ZIP 本地文件头签名不匹配 (${entry.path})，压缩包结构损坏`);
  }
  const localNameLen = view.getUint16(26, true);
  const localExtraLen = view.getUint16(28, true);
  const dataStart = entry.localHeaderOffset + 30 + localNameLen + localExtraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > zipBlob.size) {
    throw new Error(`ZIP 条目数据超出文件边界 (${entry.path})，存档已截断`);
  }
  return { dataStart, dataEnd };
}

/**
 * Extracts and decompresses a single entry from `zipBlob` into a Uint8Array.
 * Optionally verifies CRC32 checksum.
 * @param {Blob} zipBlob
 * @param {object} entry
 * @param {{ verifyCrc?: boolean }} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function extractZipEntryBytes(zipBlob, entry, options = {}) {
  if (entry.isDirectory || entry.compressedSize === 0) {
    return new Uint8Array(0);
  }
  const { dataStart, dataEnd } = await getZipEntryPayloadRange(zipBlob, entry);
  const rawComp = await readBlobRange(zipBlob, dataStart, dataEnd);

  let out;
  if (entry.compressionMethod === 0) {
    out = rawComp;
  } else if (entry.compressionMethod === 8) {
    try {
      out = inflateSync(rawComp);
    } catch (err) {
      throw new Error(`解压条目失败 (${entry.path}): ${err.message || 'DEFLATE 数据损坏'}`);
    }
  } else {
    throw new Error(
      `不支持的 ZIP 压缩算法 (method=${entry.compressionMethod}, 文件: ${entry.path})，请使用标准 ZIP (STORE/DEFLATE) 重新打包`
    );
  }

  if (options.verifyCrc) {
    const computed = crc32(out);
    if (computed !== entry.crc32) {
      throw new Error(
        `CRC32 校验失败 (${entry.path}): 期望 0x${entry.crc32.toString(16).toUpperCase()}, 实际 0x${computed.toString(16).toUpperCase()}`
      );
    }
  }

  return out;
}

/**
 * Converts a JS Date into MS-DOS date & time 16-bit integers.
 * @param {Date} [date]
 */
function dateToDos(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  return { dosTime, dosDate };
}

/**
 * Zero-Copy Streaming ZIP Builder.
 *
 * Accepts either:
 *  - Pre-compressed Blob slices directly from the original ZIP (`addPassthroughBlob`) -> 0 CPU & 0 JS heap copy!
 *  - Raw Uint8Array buffers (`addBuffer`, e.g., decrypted/encrypted .ldb files) -> computes CRC32, wraps in Blob, and immediately allows the Uint8Array to be GC'd!
 */
export class StreamingZipBuilder {
  constructor() {
    /** @type {Array<Blob|Uint8Array>} */
    this.parts = [];
    /** @type {Array<Uint8Array>} */
    this.centralRecords = [];
    this.offset = 0;
    this.entryCount = 0;
    const now = dateToDos();
    this.defaultDosTime = now.dosTime;
    this.defaultDosDate = now.dosDate;
  }

  /**
   * Appends a file from a Uint8Array, optionally compressing with fast DEFLATE.
   * Immediately converts payload into a Blob slice so callers can drop the Uint8Array.
   * @param {string} outPath
   * @param {Uint8Array} plainBytes
   * @param {{ compress?: boolean, dosTime?: number, dosDate?: number }} [opts]
   */
  addBuffer(outPath, plainBytes, opts = {}) {
    const cleanPath = outPath.replace(/^\/+/, '');
    if (!cleanPath) return;

    const uncompressedSize = plainBytes.byteLength;
    const fileCrc = crc32(plainBytes);
    let method = 0;
    let payloadBytes = plainBytes;

    if (opts.compress && uncompressedSize > 64) {
      const deflated = deflateSync(plainBytes, { level: 1 });
      if (deflated.byteLength < uncompressedSize) {
        method = 8;
        payloadBytes = deflated;
      }
    }

    const payloadBlob = new Blob([payloadBytes]);
    this._appendRecord({
      path: cleanPath,
      method,
      crc32: fileCrc,
      compressedSize: payloadBlob.size,
      uncompressedSize,
      dosTime: opts.dosTime ?? this.defaultDosTime,
      dosDate: opts.dosDate ?? this.defaultDosDate,
      payloadBlob,
    });
  }

  /**
   * Appends a pre-compressed (or stored) payload Blob directly from a source ZIP without copying into RAM!
   * @param {string} outPath
   * @param {Blob} compressedBlob
   * @param {{ method: number, crc32: number, uncompressedSize: number, dosTime?: number, dosDate?: number }} meta
   */
  addPassthroughBlob(outPath, compressedBlob, meta) {
    const cleanPath = outPath.replace(/^\/+/, '');
    if (!cleanPath) return;

    this._appendRecord({
      path: cleanPath,
      method: meta.method,
      crc32: meta.crc32 >>> 0,
      compressedSize: compressedBlob.size,
      uncompressedSize: meta.uncompressedSize,
      dosTime: meta.dosTime ?? this.defaultDosTime,
      dosDate: meta.dosDate ?? this.defaultDosDate,
      payloadBlob: compressedBlob,
    });
  }

  _appendRecord({
    path,
    method,
    crc32: entryCrc,
    compressedSize,
    uncompressedSize,
    dosTime,
    dosDate,
    payloadBlob,
  }) {
    const nameBytes = utf8Encoder.encode(path);
    const utf8Flag = 0x0800; // Bit 11 = UTF-8 filename, Bit 3 = 0 (sizes known in local header)
    const localHeaderOffset = this.offset;

    // 30-byte Local File Header + filename
    const lfh = new Uint8Array(30 + nameBytes.byteLength);
    const lfhView = new DataView(lfh.buffer);
    lfhView.setUint32(0, SIG_LOCAL_FILE, true);
    lfhView.setUint16(4, 20, true); // version needed 2.0
    lfhView.setUint16(6, utf8Flag, true);
    lfhView.setUint16(8, method, true);
    lfhView.setUint16(10, dosTime, true);
    lfhView.setUint16(12, dosDate, true);
    lfhView.setUint32(14, entryCrc >>> 0, true);
    lfhView.setUint32(18, compressedSize >>> 0, true);
    lfhView.setUint32(22, uncompressedSize >>> 0, true);
    lfhView.setUint16(26, nameBytes.byteLength, true);
    lfhView.setUint16(28, 0, true); // extra len = 0
    lfh.set(nameBytes, 30);

    this.parts.push(lfh, payloadBlob);
    this.offset += lfh.byteLength + payloadBlob.size;

    // Central Directory Header (46 bytes + filename + optional ZIP64 extra if offset >= 4GB)
    const needZip64Offset = localHeaderOffset >= 0xffffffff;
    const extraLen = needZip64Offset ? 12 : 0;
    const cdh = new Uint8Array(46 + nameBytes.byteLength + extraLen);
    const cdhView = new DataView(cdh.buffer);
    cdhView.setUint32(0, SIG_CENTRAL_DIR, true);
    cdhView.setUint16(4, 45, true); // version made by
    cdhView.setUint16(6, needZip64Offset ? 45 : 20, true); // version needed
    cdhView.setUint16(8, utf8Flag, true);
    cdhView.setUint16(10, method, true);
    cdhView.setUint16(12, dosTime, true);
    cdhView.setUint16(14, dosDate, true);
    cdhView.setUint32(16, entryCrc >>> 0, true);
    cdhView.setUint32(20, compressedSize >>> 0, true);
    cdhView.setUint32(24, uncompressedSize >>> 0, true);
    cdhView.setUint16(28, nameBytes.byteLength, true);
    cdhView.setUint16(30, extraLen, true);
    cdhView.setUint16(32, 0, true); // comment len
    cdhView.setUint16(34, 0, true); // disk number
    cdhView.setUint16(36, 0, true); // internal attrs
    cdhView.setUint32(38, 0, true); // external attrs
    cdhView.setUint32(42, needZip64Offset ? 0xffffffff : localHeaderOffset >>> 0, true);
    cdh.set(nameBytes, 46);

    if (needZip64Offset) {
      const extPos = 46 + nameBytes.byteLength;
      cdhView.setUint16(extPos, 0x0001, true);
      cdhView.setUint16(extPos + 2, 8, true);
      cdhView.setBigUint64(extPos + 4, BigInt(localHeaderOffset), true);
    }

    this.centralRecords.push(cdh);
    this.entryCount++;
  }

  /**
   * Finalizes the Central Directory + EOCD (with automatic ZIP64 EOCD when > 65535 entries or > 4GB)
   * and returns a single immutable Blob while clearing internal references.
   * @param {string} [mimeType='application/zip']
   * @returns {Blob}
   */
  finalize(mimeType = 'application/zip') {
    const cdOffset = this.offset;
    let cdSize = 0;
    for (const rec of this.centralRecords) {
      cdSize += rec.byteLength;
    }
    const cdBlob = new Blob(this.centralRecords);
    this.parts.push(cdBlob);

    const needZip64 =
      this.entryCount >= 0xffff || cdSize >= 0xffffffff || cdOffset >= 0xffffffff;

    if (needZip64) {
      const z64 = new Uint8Array(56 + 20);
      const zv = new DataView(z64.buffer);
      const z64EocdOffset = cdOffset + cdSize;
      // ZIP64 EOCD (56 bytes)
      zv.setUint32(0, SIG_ZIP64_EOCD, true);
      zv.setBigUint64(4, 44n, true);
      zv.setUint16(12, 45, true);
      zv.setUint16(14, 45, true);
      zv.setUint32(16, 0, true);
      zv.setUint32(20, 0, true);
      zv.setBigUint64(24, BigInt(this.entryCount), true);
      zv.setBigUint64(32, BigInt(this.entryCount), true);
      zv.setBigUint64(40, BigInt(cdSize), true);
      zv.setBigUint64(48, BigInt(cdOffset), true);
      // ZIP64 EOCD Locator (20 bytes)
      zv.setUint32(56, SIG_ZIP64_LOCATOR, true);
      zv.setUint32(60, 0, true);
      zv.setBigUint64(64, BigInt(z64EocdOffset), true);
      zv.setUint32(72, 1, true);
      this.parts.push(z64);
    }

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, SIG_EOCD, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, needZip64 ? 0xffff : this.entryCount, true);
    ev.setUint16(10, needZip64 ? 0xffff : this.entryCount, true);
    ev.setUint32(12, needZip64 ? 0xffffffff : cdSize >>> 0, true);
    ev.setUint32(16, needZip64 ? 0xffffffff : cdOffset >>> 0, true);
    ev.setUint16(20, 0, true);
    this.parts.push(eocd);

    const outBlob = new Blob(this.parts, { type: mimeType });
    // Release internal part arrays immediately so GC reclaims references
    this.parts = [];
    this.centralRecords = [];
    return outBlob;
  }
}
