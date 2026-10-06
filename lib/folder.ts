"use client";

import { applyChange, type Change, emptyData, LABEL_FILE, normalizeData, serializeData } from "./label-data";
import type { LabelData } from "./types";

declare global {
  interface Window {
    showDirectoryPicker?: (opts?: { mode?: "read" | "readwrite"; id?: string }) => Promise<FileSystemDirectoryHandle>;
  }
}

/** ラベルの保存先 */
export interface LabelStore {
  /** "folder": フォルダ内の labels.json / "browser": このブラウザ内 */
  readonly kind: "folder" | "browser";
  load(): Promise<LabelData>;
  /** 最新の保存内容に変更を当てて保存し、保存後の内容を返す */
  update(change: Change): Promise<LabelData>;
}

export type OpenedFolder = {
  name: string;
  /** フォルダからの相対パス -> ファイル */
  files: Map<string, File>;
  store: LabelStore;
};

export const canWriteFolder = () => typeof window !== "undefined" && !!window.showDirectoryPicker;

async function collectFiles(dir: FileSystemDirectoryHandle, prefix: string, out: Map<string, File>) {
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === "file") out.set(prefix + name, await (handle as FileSystemFileHandle).getFile());
    else await collectFiles(handle as FileSystemDirectoryHandle, `${prefix}${name}/`, out);
  }
}

class FolderStore implements LabelStore {
  readonly kind = "folder";
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private dir: FileSystemDirectoryHandle) {}

  async load(): Promise<LabelData> {
    try {
      const fh = await this.dir.getFileHandle(LABEL_FILE);
      const text = await (await fh.getFile()).text();
      return normalizeData(JSON.parse(text));
    } catch (e) {
      if (e instanceof DOMException && e.name === "NotFoundError") return emptyData();
      if (e instanceof SyntaxError) throw new Error(`${LABEL_FILE} の形式が壊れています`);
      throw e;
    }
  }

  update(change: Change): Promise<LabelData> {
    // 書き込みは1つずつ順番に行う
    const run = async () => {
      const next = applyChange(await this.load(), change);
      const fh = await this.dir.getFileHandle(LABEL_FILE, { create: true });
      const w = await fh.createWritable();
      await w.write(serializeData(next));
      await w.close();
      return next;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}

class BrowserStore implements LabelStore {
  readonly kind = "browser";
  private key: string;
  constructor(folderName: string) {
    this.key = `mc:${folderName}`;
  }
  async load(): Promise<LabelData> {
    try {
      const raw = localStorage.getItem(this.key);
      return raw ? normalizeData(JSON.parse(raw)) : emptyData();
    } catch {
      return emptyData();
    }
  }
  async update(change: Change): Promise<LabelData> {
    const next = applyChange(await this.load(), change);
    try {
      localStorage.setItem(this.key, serializeData(next));
    } catch {
      throw new Error("ブラウザに保存できませんでした");
    }
    return next;
  }
}

/** Chrome / Edge: 書き込み可能でフォルダを開く。キャンセル時は null */
export async function openFolderWritable(): Promise<OpenedFolder | null> {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await window.showDirectoryPicker!({ mode: "readwrite", id: "models" });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return null;
    throw e;
  }
  const files = new Map<string, File>();
  await collectFiles(dir, "", files);
  return { name: dir.name, files, store: new FolderStore(dir) };
}

/** それ以外のブラウザ: <input webkitdirectory> で選んだファイルから開く（保存はブラウザ内） */
export function openFolderFromInput(list: FileList): OpenedFolder | null {
  if (list.length === 0) return null;
  const files = new Map<string, File>();
  let name = "";
  for (const f of Array.from(list)) {
    const rel = f.webkitRelativePath || f.name;
    const i = rel.indexOf("/");
    name ||= i < 0 ? "" : rel.slice(0, i);
    files.set(i < 0 ? rel : rel.slice(i + 1), f);
  }
  return { name, files, store: new BrowserStore(name) };
}
