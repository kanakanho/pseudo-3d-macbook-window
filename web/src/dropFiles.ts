// ドロップされたファイルやフォルダから File の一覧を集める。
// フォルダは File and Directory Entries API (webkitGetAsEntry) で中身を再帰的にたどる。
// File はディスク上のファイルへの参照なので、ここで中身を読むことはない。

function readAll(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    // readEntries は一度に最大 100 件程度しか返さないので、空になるまで繰り返す
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        next();
      }, reject);
    next();
  });
}

function toFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walk(entry: FileSystemEntry, out: File[]) {
  if (entry.isFile) out.push(await toFile(entry as FileSystemFileEntry));
  else if (entry.isDirectory) for (const e of await readAll(entry as FileSystemDirectoryEntry)) await walk(e, out);
}

/**
 * drop イベントの DataTransfer から File を集める。
 * webkitGetAsEntry は drop イベントの処理中にしか使えないので、await より前に呼ぶこと。
 */
export function collectDroppedFiles(dt: DataTransfer): Promise<{ files: File[]; name: string }> {
  const entries = [...dt.items]
    .filter((i) => i.kind === 'file')
    .map((i) => i.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  const plain = [...dt.files];

  return (async () => {
    if (!entries.length) return { files: plain, name: 'dropped files' };
    const files: File[] = [];
    for (const e of entries) await walk(e, files);
    const name = entries.length === 1 ? entries[0].name : `${entries.length} items`;
    return { files, name };
  })();
}
