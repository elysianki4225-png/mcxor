/**
 * Minecraft Bedrock / NetEase Archive Structure Discovery & Integrity Verification
 * Implements HTMonkeyG's `integrityTest` + `avalTest` and adds deep Bedrock `level.dat` & container checks.
 */

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Detects archive format label from filename or input source type.
 * @param {string} sourceName
 * @param {'zip'|'folder'|'files'} sourceType
 */
export function detectArchiveFormatLabel(sourceName, sourceType) {
  if (sourceType === 'folder') return '存档文件夹 (Directory)';
  if (sourceType === 'files') return '散装存档文件 (Files)';
  const lower = (sourceName || '').toLowerCase();
  if (lower.endsWith('.mcworld')) return '基岩版世界包 (.mcworld)';
  if (lower.endsWith('.mctemplate')) return '基岩版世界模板 (.mctemplate)';
  if (lower.endsWith('.mcaddon')) return '基岩版附加包 (.mcaddon)';
  if (lower.endsWith('.mcpack')) return '基岩版资源包 (.mcpack)';
  if (lower.endsWith('.ldb')) return 'LevelDB 数据表 (.ldb)';
  if (lower.endsWith('.zip')) return 'ZIP 压缩存档 (.zip)';
  return '压缩存档包 (Archive)';
}

/**
 * Locates world root prefix and `db/` prefix across arbitrary archive layouts:
 * - Standard root: `level.dat`, `db/CURRENT` -> worldPrefix="", dbPrefix="db/"
 * - Wrapped folder: `MyWorld/level.dat`, `MyWorld/db/CURRENT` -> worldPrefix="MyWorld/", dbPrefix="MyWorld/db/"
 * - DB-only folder: `db/CURRENT` -> worldPrefix="", dbPrefix="db/"
 * - Flat DB files: `CURRENT`, `MANIFEST-000001`, `000003.ldb` -> worldPrefix="", dbPrefix=""
 *
 * @param {string[]} paths
 */
export function locateWorldStructure(paths) {
  const cleanPaths = paths.map((p) => p.replace(/\\/g, '/').replace(/^\/+/, ''));

  // 1. Prefer directories containing level.dat (pick shallowest)
  const levelDatCandidates = cleanPaths
    .filter((p) => p === 'level.dat' || p.endsWith('/level.dat'))
    .sort((a, b) => a.split('/').length - b.split('/').length);

  if (levelDatCandidates.length > 0) {
    // Prefer one that also has a sibling db/ folder
    for (const ld of levelDatCandidates) {
      const worldPrefix = ld === 'level.dat' ? '' : ld.slice(0, -'level.dat'.length);
      const expectedDbPrefix = worldPrefix + 'db/';
      const hasDb = cleanPaths.some((p) => p.startsWith(expectedDbPrefix));
      if (hasDb) {
        return {
          found: true,
          mode: 'full_world',
          worldPrefix,
          dbPrefix: expectedDbPrefix,
          hasLevelDat: true,
        };
      }
    }
    // Has level.dat even if db/ is missing (corrupted/incomplete save or Java save)
    const ld = levelDatCandidates[0];
    const worldPrefix = ld === 'level.dat' ? '' : ld.slice(0, -'level.dat'.length);
    return {
      found: true,
      mode: 'missing_db',
      worldPrefix,
      dbPrefix: worldPrefix + 'db/',
      hasLevelDat: true,
    };
  }

  // 2. Look for `.../db/CURRENT` or `.../db/MANIFEST-*` or `.../db/*.ldb`
  const dbMarker = cleanPaths
    .filter((p) => /(^|\/)db\/(CURRENT|MANIFEST-[0-9]{6,}|[0-9]{6,}\.(ldb|sst))$/i.test(p))
    .sort((a, b) => a.split('/').length - b.split('/').length)[0];

  if (dbMarker) {
    const idx = dbMarker.lastIndexOf('db/');
    const worldPrefix = dbMarker.slice(0, idx);
    const dbPrefix = worldPrefix + 'db/';
    return {
      found: true,
      mode: 'db_only',
      worldPrefix,
      dbPrefix,
      hasLevelDat: false,
    };
  }

  // 3. Look for flat `CURRENT` / `MANIFEST-*` / `*.ldb` directly in folder
  const flatMarker = cleanPaths
    .filter((p) => /(^|\/)(CURRENT|MANIFEST-[0-9]{6,}|[0-9]{6,}\.(ldb|sst))$/i.test(p))
    .sort((a, b) => a.split('/').length - b.split('/').length)[0];

  if (flatMarker) {
    const slashIdx = flatMarker.lastIndexOf('/');
    const dbPrefix = slashIdx === -1 ? '' : flatMarker.slice(0, slashIdx + 1);
    return {
      found: true,
      mode: 'flat_db_only',
      worldPrefix: dbPrefix,
      dbPrefix,
      hasLevelDat: false,
    };
  }

  return {
    found: false,
    mode: 'unrecognized',
    worldPrefix: '',
    dbPrefix: 'db/',
    hasLevelDat: false,
  };
}

/**
 * Inspects Bedrock `level.dat` header and extracts lightweight NBT metadata (`LevelName`, `GameType`).
 * Bedrock `level.dat` starts with:
 *   int32 LE: storageVersion (typically 3..12)
 *   int32 LE: payloadLength (equals fileLength - 8)
 * Java `level.dat` starts with GZip magic `0x1F 0x8B`.
 *
 * @param {Uint8Array|null} buf
 */
export function inspectLevelDat(buf) {
  if (!buf || buf.byteLength === 0) {
    return { exists: false, valid: false, edition: 'missing', detail: '缺失 level.dat 文件' };
  }
  if (buf.byteLength >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return {
      exists: true,
      valid: false,
      edition: 'java',
      detail: '检测到 Minecraft Java 版 GZip level.dat（Java 版存档不使用网易基岩版 LevelDB 异或加密）',
    };
  }
  if (buf.byteLength < 12) {
    return {
      exists: true,
      valid: false,
      edition: 'corrupt',
      detail: `level.dat 大小异常 (${buf.byteLength} 字节)，低于基岩版最小头长度`,
    };
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const storageVersion = view.getInt32(0, true);
  const declaredLen = view.getInt32(4, true);
  const actualPayloadLen = buf.byteLength - 8;
  const lengthMatches = declaredLen === actualPayloadLen;
  const plausibleVersion = storageVersion >= 1 && storageVersion <= 20;

  const levelName = extractBedrockNbtStringTag(buf, 'LevelName');
  const gameType = extractBedrockNbtIntTag(buf, 'GameType');

  const gameModeMap = {
    0: '生存模式 (Survival)',
    1: '创造模式 (Creative)',
    2: '冒险模式 (Adventure)',
    5: '默认模式',
  };

  if (plausibleVersion && lengthMatches) {
    return {
      exists: true,
      valid: true,
      edition: 'bedrock',
      storageVersion,
      levelName,
      gameType,
      gameModeLabel: gameType != null ? gameModeMap[gameType] || `模式 ${gameType}` : null,
      detail: `基岩版 NBT 头校验通过 (Storage v${storageVersion}, 负载 ${actualPayloadLen} B)`,
    };
  }

  if (plausibleVersion) {
    return {
      exists: true,
      valid: true,
      warning: true,
      edition: 'bedrock',
      storageVersion,
      levelName,
      gameType,
      gameModeLabel: gameType != null ? gameModeMap[gameType] || `模式 ${gameType}` : null,
      detail: `基岩版 Storage v${storageVersion}（声明长度 ${declaredLen} B，实际负载 ${actualPayloadLen} B）`,
    };
  }

  return {
    exists: true,
    valid: false,
    edition: 'unknown',
    detail: `level.dat 头部异常 (version=${storageVersion}, len=${declaredLen})，可能已损坏或被二次加密`,
  };
}

/**
 * Lightweight binary scan for a Little-Endian NBT TAG_String (0x08):
 * [0x08] [nameLen: uint16 LE] [name ASCII] [valLen: uint16 LE] [val UTF-8]
 */
function extractBedrockNbtStringTag(buf, tagName) {
  const nLen = tagName.length;
  const maxEnd = buf.byteLength - (3 + nLen + 2);
  for (let i = 8; i <= maxEnd; i++) {
    if (buf[i] !== 0x08) continue;
    const len = buf[i + 1] | (buf[i + 2] << 8);
    if (len !== nLen) continue;
    let match = true;
    for (let k = 0; k < nLen; k++) {
      if (buf[i + 3 + k] !== tagName.charCodeAt(k)) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    const valPos = i + 3 + nLen;
    const valLen = buf[valPos] | (buf[valPos + 1] << 8);
    if (valPos + 2 + valLen <= buf.byteLength && valLen <= 512) {
      return utf8Decoder.decode(buf.subarray(valPos + 2, valPos + 2 + valLen)).trim();
    }
  }
  return null;
}

/**
 * Lightweight binary scan for a Little-Endian NBT TAG_Int (0x03):
 * [0x03] [nameLen: uint16 LE] [name ASCII] [val: int32 LE]
 */
function extractBedrockNbtIntTag(buf, tagName) {
  const nLen = tagName.length;
  const maxEnd = buf.byteLength - (3 + nLen + 4);
  for (let i = 8; i <= maxEnd; i++) {
    if (buf[i] !== 0x03) continue;
    const len = buf[i + 1] | (buf[i + 2] << 8);
    if (len !== nLen) continue;
    let match = true;
    for (let k = 0; k < nLen; k++) {
      if (buf[i + 3 + k] !== tagName.charCodeAt(k)) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    const valPos = i + 3 + nLen;
    const view = new DataView(buf.buffer, buf.byteOffset + valPos, 4);
    return view.getInt32(0, true);
  }
  return null;
}

/**
 * Builds the comprehensive Save Integrity Report (`integrityTest` + `avalTest` + NetEase diagnostics).
 */
export function buildIntegrityReport({
  structure,
  levelDatInfo,
  hasCurrent,
  currentLength,
  manifestFiles,
  ldbTotalCount,
  ldbPlainValidCount,
  ldbPlainInvalidFiles,
  encryptedFiles,
  decryptedFiles,
  aesModFiles,
  hasNeteaseConfig,
  crcVerifiedCount,
}) {
  const checks = [];
  let hardFail = false;
  let hasWarn = false;

  // 1. level.dat Check
  if (structure.hasLevelDat && levelDatInfo.valid) {
    checks.push({
      id: 'level_dat',
      label: 'level.dat 世界主配置',
      status: levelDatInfo.warning ? 'warn' : 'pass',
      detail: levelDatInfo.detail,
    });
    if (levelDatInfo.warning) hasWarn = true;
  } else if (structure.hasLevelDat && !levelDatInfo.valid) {
    checks.push({
      id: 'level_dat',
      label: 'level.dat 世界主配置',
      status: 'fail',
      detail: levelDatInfo.detail,
    });
    hardFail = true;
  } else if (structure.mode === 'db_only' || structure.mode === 'flat_db_only') {
    checks.push({
      id: 'level_dat',
      label: 'level.dat 世界主配置',
      status: 'warn',
      detail: '未检测到 level.dat（当前为仅 LevelDB 数据库目录模式，仍可执行数据库加解密）',
    });
    hasWarn = true;
  } else {
    checks.push({
      id: 'level_dat',
      label: 'level.dat 世界主配置',
      status: 'fail',
      detail: '缺失 level.dat，不是完整的基岩版存档目录',
    });
    hardFail = true;
  }

  // 2. db/ Directory Check
  if (structure.found && structure.mode !== 'missing_db') {
    checks.push({
      id: 'db_dir',
      label: 'LevelDB 数据库目录 (db/)',
      status: 'pass',
      detail:
        structure.dbPrefix === ''
          ? '已识别根目录数据库文件结构'
          : `已定位数据库路径: ${structure.dbPrefix}`,
    });
  } else {
    checks.push({
      id: 'db_dir',
      label: 'LevelDB 数据库目录 (db/)',
      status: 'fail',
      detail: '缺失 db/ 目录或未找到任何 LevelDB 数据库文件',
    });
    hardFail = true;
  }

  // 3. db/CURRENT Check
  if (hasCurrent) {
    if (currentLength === 80) {
      checks.push({
        id: 'db_current',
        label: 'db/CURRENT 指针文件',
        status: 'fail',
        detail: 'CURRENT 为 80 字节（网易资源中心二次加密/模组加密特征），不支持标准 XOR 推导',
      });
      hardFail = true;
    } else {
      checks.push({
        id: 'db_current',
        label: 'db/CURRENT 指针文件',
        status: 'pass',
        detail: `已找到 CURRENT 文件 (${currentLength} 字节)`,
      });
    }
  } else {
    checks.push({
      id: 'db_current',
      label: 'db/CURRENT 指针文件',
      status: ldbTotalCount > 0 ? 'warn' : 'fail',
      detail:
        ldbTotalCount > 0
          ? '缺失 db/CURRENT（可尝试通过 .ldb 尾部魔数恢复密钥，但标准完整性测试未通过）'
          : '缺失 db/CURRENT 文件',
    });
    if (ldbTotalCount > 0) hasWarn = true;
    else hardFail = true;
  }

  // 4. db/MANIFEST-* Check
  if (manifestFiles.length > 0) {
    checks.push({
      id: 'db_manifest',
      label: 'db/MANIFEST-* 清单文件',
      status: 'pass',
      detail: `已找到 ${manifestFiles.length} 个清单: ${manifestFiles.join(', ')}`,
    });
  } else {
    checks.push({
      id: 'db_manifest',
      label: 'db/MANIFEST-* 清单文件',
      status: ldbTotalCount > 0 ? 'warn' : 'fail',
      detail: '缺失 db/MANIFEST-* 描述清单文件',
    });
    if (ldbTotalCount > 0) hasWarn = true;
    else hardFail = true;
  }

  // 5. Encryption Consistency & AES-Mod Warning
  if (aesModFiles.length > 0) {
    checks.push({
      id: 'enc_state',
      label: '网易加密头魔数检测',
      status: 'fail',
      detail: `发现 ${aesModFiles.length} 个 0x901D3001 二次/AES 加密文件，无法使用 64-bit XOR 解密`,
    });
    hardFail = true;
  } else if (encryptedFiles.length > 0 && decryptedFiles.length > 0) {
    checks.push({
      id: 'enc_state',
      label: '网易加密头魔数检测',
      status: 'warn',
      detail: `混合状态：${encryptedFiles.length} 个已加密 (0x801D3001)，${decryptedFiles.length} 个未加密`,
    });
    hasWarn = true;
  } else if (encryptedFiles.length > 0) {
    checks.push({
      id: 'enc_state',
      label: '网易加密头魔数检测',
      status: 'pass',
      detail: `检测到已加密存档：共 ${encryptedFiles.length} 个加密核心文件 (魔数 0x801D3001)`,
    });
  } else if (decryptedFiles.length > 0) {
    checks.push({
      id: 'enc_state',
      label: '网易加密头魔数检测',
      status: 'pass',
      detail: `检测到未加密明文存档：共 ${decryptedFiles.length} 个核心数据库文件可加密`,
    });
  } else {
    checks.push({
      id: 'enc_state',
      label: '网易加密头魔数检测',
      status: 'fail',
      detail: '未检测到可处理的数据库核心文件',
    });
    hardFail = true;
  }

  // 6. LevelDB .ldb Table Footer Magic (`avalTest`: 0x57FB808B247547DB)
  if (ldbTotalCount === 0) {
    checks.push({
      id: 'ldb_magic',
      label: 'LevelDB (.ldb) 数据表校验',
      status: 'warn',
      detail: 'db/ 中暂无 .ldb 表文件（新建世界仅包含 .log 日志属于正常现象）',
    });
  } else if (encryptedFiles.length === 0) {
    // Plaintext save: all .ldb files should have valid LevelDB magic right now!
    if (ldbPlainInvalidFiles.length === 0) {
      checks.push({
        id: 'ldb_magic',
        label: 'LevelDB (.ldb) 魔数合理性',
        status: 'pass',
        detail: `全部 ${ldbPlainValidCount} / ${ldbTotalCount} 个 .ldb 数据表尾部魔数 (0x57FB808B247547DB) 校验通过`,
      });
    } else {
      checks.push({
        id: 'ldb_magic',
        label: 'LevelDB (.ldb) 魔数合理性',
        status: 'fail',
        detail: `发现 ${ldbPlainInvalidFiles.length} 个魔数异常的 .ldb 文件 (${ldbPlainInvalidFiles.slice(0, 3).join(', ')})，存档可能损坏`,
      });
      hardFail = true;
    }
  } else {
    checks.push({
      id: 'ldb_magic',
      label: 'LevelDB (.ldb) 数据表统计',
      status: 'pass',
      detail: `共扫描到 ${ldbTotalCount} 个 .ldb 数据表文件，解密时将逐一校验尾部魔数合理性`,
    });
  }

  // 7. NetEase Resource Center `netease_config` Advisory
  if (hasNeteaseConfig) {
    checks.push({
      id: 'netease_config',
      label: 'netease_config 资源中心目录',
      status: 'warn',
      detail:
        '检测到 netease_config 文件夹（常见于资源中心地图）：导入国际版建议开启“清理 netease_config”，导回网易版请使用相同密钥主动加密',
    });
    hasWarn = true;
  }

  // 8. Container CRC32 Info if verified
  if (crcVerifiedCount > 0) {
    checks.push({
      id: 'crc32',
      label: '容器数据块 CRC32 校验',
      status: 'pass',
      detail: `已完成 ${crcVerifiedCount} 个关键数据文件解压与 CRC32 完整性核验`,
    });
  }

  const overallStatus = hardFail ? 'invalid' : hasWarn ? 'partial' : 'valid';
  const strictHtPass =
    structure.hasLevelDat &&
    Boolean(levelDatInfo && levelDatInfo.valid) &&
    hasCurrent &&
    currentLength !== 80 &&
    manifestFiles.length > 0;

  return {
    overallStatus,
    strictHtPass,
    canDecrypt: encryptedFiles.length > 0 && aesModFiles.length === 0 && currentLength !== 80,
    canEncrypt: decryptedFiles.length > 0 && encryptedFiles.length === 0,
    checks,
  };
}
