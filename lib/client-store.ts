"use client";

import type { Assignments, Label } from "./types";

/** ラベルと割り当ての保存先。サーバー(共有)かブラウザ(個人)のどちらか。 */
export interface Store {
  readonly shared: boolean;
  loadLabels(): Promise<Label[]>;
  saveLabel(label: Label): Promise<void>;
  deleteLabel(id: string): Promise<void>;
  loadAssignments(): Promise<Assignments>;
  patchAssignments(updates: Assignments): Promise<void>;
}

async function check(res: Response): Promise<Response> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res;
}

const remoteStore: Store = {
  shared: true,
  async loadLabels() {
    return (await check(await fetch("/api/labels", { cache: "no-store" }))).json();
  },
  async saveLabel(label) {
    await check(
      await fetch("/api/labels", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(label),
      }),
    );
  },
  async deleteLabel(id) {
    await check(await fetch(`/api/labels?id=${encodeURIComponent(id)}`, { method: "DELETE" }));
  },
  async loadAssignments() {
    return (await check(await fetch("/api/assignments", { cache: "no-store" }))).json();
  },
  async patchAssignments(updates) {
    await check(
      await fetch("/api/assignments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      }),
    );
  },
};

const LS_LABELS = "mc:labels";
const LS_ASSIGN = "mc:assignments";

function readLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeLS(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 保存できない環境（プライベートモード等）では無視
  }
}

const localStore: Store = {
  shared: false,
  async loadLabels() {
    return readLS<Label[]>(LS_LABELS, []);
  },
  async saveLabel(label) {
    const labels = readLS<Label[]>(LS_LABELS, []).filter((l) => l.id !== label.id);
    writeLS(LS_LABELS, [...labels, label]);
  },
  async deleteLabel(id) {
    writeLS(LS_LABELS, readLS<Label[]>(LS_LABELS, []).filter((l) => l.id !== id));
    const assign = readLS<Assignments>(LS_ASSIGN, {});
    for (const path of Object.keys(assign)) {
      assign[path] = assign[path].filter((x) => x !== id);
      if (assign[path].length === 0) delete assign[path];
    }
    writeLS(LS_ASSIGN, assign);
  },
  async loadAssignments() {
    return readLS<Assignments>(LS_ASSIGN, {});
  },
  async patchAssignments(updates) {
    const assign = readLS<Assignments>(LS_ASSIGN, {});
    for (const [path, ids] of Object.entries(updates)) {
      if (ids.length === 0) delete assign[path];
      else assign[path] = ids;
    }
    writeLS(LS_ASSIGN, assign);
  },
};

export async function connectStore(): Promise<Store> {
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    if (res.ok && (await res.json()).shared) return remoteStore;
  } catch {
    // サーバーに繋がらなければローカル保存
  }
  return localStore;
}
