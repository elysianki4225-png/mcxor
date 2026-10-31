/**
 * Multi-Format Input Normalizer & Recursive Directory Drop Reader
 * Handles:
 *  - Archive files: .zip, .mcworld, .mctemplate, .mcaddon, .mcpack
 *  - Dropped folders: recursive FileSystemDirectoryEntry.createReader() looping readEntries() until empty!
 *  - <input webkitdirectory> FileList
 *  - Loose files (e.g., CURRENT + MANIFEST-* + *.ldb)
 */

const ARCHIVE_EXT_RE = /\.(zip|mcworld|mctemplate|mcaddon|mcpack)$/i;

/**
 * Checks whether a single File is a ZIP-container Minecraft archive.
 * @param {File} file
 */
export function isZipArchiveFile(file) {
  if (!file || !file.name) return false;
  if (ARCHIVE_EXT_RE.test(file.name)) return true;
  if (file.type === 'application/zip' || file.type === 'application/x-zip-compressed') {
    return true;
  }
  return false;
}

/**
 * Normalizes a FileList (from <input type="file"> or <input webkitdirectory>)
 * into an engine input payload.
 * @param {FileList|File[]} fileList
 */
export function normalizeFileListInput(fileList) {
  const arr = Array.from(fileList || []);
  if (!arr.length) return null;

  // Single archive file (.zip / .mcworld / .mctemplate / .mcaddon / .mcpack)
  if (arr.length === 1 && !arr[0].webkitRelativePath && isZipArchiveFile(arr[0])) {
    return {
      sourceType: 'zip',
      sourceName: arr[0].name,
      zipBlob: arr[0],
    };
  }

  // Folder selection via webkitdirectory
  const hasRelPath = arr.some((f) => Boolean(f.webkitRelativePath));
  if (hasRelPath) {
    const firstRel = arr[0].webkitRelativePath || '';
    const rootFolder = firstRel.split('/')[0] || '存档文件夹';
    return {
      sourceType: 'folder',
      sourceName: rootFolder,
      files: arr.map((f) => ({
        path: f.webkitRelativePath || f.name,
        file: f,
      })),
    };
  }

  // Loose files selected
  return {
    sourceType: 'files',
    sourceName: arr.length === 1 ? arr[0].name : `${arr.length} 个散装存档文件`,
    files: arr.map((f) => ({
      path: f.name,
      file: f,
    })),
  };
}

/**
 * Reads all entries from a DirectoryReader (looping until readEntries returns [] —
 * critical because Chromium caps a single readEntries() call at 100 entries!).
 * @param {FileSystemDirectoryReader} reader
 * @returns {Promise<FileSystemEntry[]>}
 */
function readAllDirectoryEntries(reader) {
  return new Promise((resolve, reject) => {
    const all = [];
    const pump = () => {
      reader.readEntries(
        (batch) => {
          if (!batch || batch.length === 0) {
            resolve(all);
          } else {
            all.push(...batch);
            pump();
          }
        },
        (err) => reject(err)
      );
    };
    pump();
  });
}

function entryToFile(fileEntry) {
  return new Promise((resolve, reject) => {
    fileEntry.file(resolve, reject);
  });
}

async function traverseEntry(entry, prefix = '', out = []) {
  if (!entry) return out;
  if (entry.isFile) {
    const file = await entryToFile(entry);
    out.push({
      path: prefix + entry.name,
      file,
    });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    const children = await readAllDirectoryEntries(reader);
    const nextPrefix = `${prefix}${entry.name}/`;
    for (const child of children) {
      await traverseEntry(child, nextPrefix, out);
    }
  }
  return out;
}

/**
 * Extracts normalized input from a DragEvent `dataTransfer`, supporting both
 * dropped archive files AND dropped unpacked world folders!
 * @param {DataTransfer} dataTransfer
 */
export async function extractDroppedInput(dataTransfer) {
  if (!dataTransfer) return null;

  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  if (items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
    const entries = items
      .map((item) => (item.kind === 'file' ? item.webkitGetAsEntry() : null))
      .filter(Boolean);

    if (entries.length === 1 && entries[0].isFile) {
      const singleFile = await entryToFile(entries[0]);
      if (isZipArchiveFile(singleFile)) {
        return {
          sourceType: 'zip',
          sourceName: singleFile.name,
          zipBlob: singleFile,
        };
      }
      return {
        sourceType: 'files',
        sourceName: singleFile.name,
        files: [{ path: singleFile.name, file: singleFile }],
      };
    }

    if (entries.some((e) => e.isDirectory)) {
      const collected = [];
      for (const entry of entries) {
        await traverseEntry(entry, '', collected);
      }
      return {
        sourceType: 'folder',
        sourceName: entries[0].name || '拖拽文件夹',
        files: collected,
      };
    }
  }

  return normalizeFileListInput(dataTransfer.files);
}
