import type { Label, LabelData } from "./types";

export const LABEL_FILE = "labels.json";

/** 新しいラベルに順番に割り当てる色 */
export const PALETTE = ["#e5484d", "#f76b15", "#ffc53d", "#30a46c", "#12a594", "#0090ff", "#6e56cf", "#d6409f", "#8d8d8d"];

export const emptyData = (): LabelData => ({ labels: [], assignments: {}, manual: [] });

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** 読み込んだ JSON を整える（手で編集された場合や壊れている場合に備える） */
export function normalizeData(v: unknown): LabelData {
  const out = emptyData();
  if (!v || typeof v !== "object") return out;
  const { labels, assignments, manual } = v as Record<string, unknown>;
  if (Array.isArray(labels)) {
    for (const l of labels) {
      const name = typeof l?.name === "string" ? l.name.trim() : "";
      if (!name || out.labels.some((x) => x.name === name)) continue;
      out.labels.push({ name, color: COLOR_RE.test(l?.color) ? l.color : "#8d8d8d" });
    }
  }
  if (assignments && typeof assignments === "object") {
    for (const [path, names] of Object.entries(assignments as Record<string, unknown>)) {
      if (!Array.isArray(names)) continue;
      const valid = [...new Set(names.filter((n): n is string => typeof n === "string"))];
      if (valid.length > 0) out.assignments[path] = valid;
    }
  }
  if (Array.isArray(manual)) {
    out.manual = [...new Set(manual.filter((p): p is string => typeof p === "string"))].sort();
  } else {
    // この項目ができる前のファイルは、付いているラベルがすべて手動で付けたもの
    out.manual = Object.keys(out.assignments).sort();
  }
  return out;
}

/** 人が読みやすいよう、パス順に並べて整形した JSON */
export function serializeData(data: LabelData): string {
  const j = JSON.stringify;
  const labels = data.labels.map((l) => `    ${j({ name: l.name, color: l.color })}`);
  const assignments = Object.keys(data.assignments)
    .sort()
    .map((path) => `    ${j(path)}: ${j(data.assignments[path])}`);
  const block = (lines: string[], open: string, close: string) =>
    lines.length === 0 ? open + close : `${open}\n${lines.join(",\n")}\n  ${close}`;
  const manual = [...data.manual].sort().map((path) => `    ${j(path)}`);
  return (
    `{\n  "labels": ${block(labels, "[", "]")},\n  "assignments": ${block(assignments, "{", "}")},\n` +
    `  "manual": ${block(manual, "[", "]")}\n}\n`
  );
}

// ---- 変更操作 ----
// 保存時は最新のファイルを読み直してから同じ操作を当て直すので、
// 他の人が同時に別のファイルを編集していても上書きし合わない。

export type Change = (data: LabelData) => void;

export const addLabel = (label: Label): Change => (d) => {
  if (!d.labels.some((l) => l.name === label.name)) d.labels.push(label);
};

export const updateLabel = (oldName: string, label: Label): Change => (d) => {
  const i = d.labels.findIndex((l) => l.name === oldName);
  if (i < 0) return;
  if (label.name !== oldName && d.labels.some((l) => l.name === label.name)) return;
  d.labels[i] = label;
  if (label.name !== oldName) {
    for (const [path, names] of Object.entries(d.assignments)) {
      d.assignments[path] = [...new Set(names.map((n) => (n === oldName ? label.name : n)))];
    }
  }
};

export const deleteLabel = (name: string): Change => (d) => {
  d.labels = d.labels.filter((l) => l.name !== name);
  for (const [path, names] of Object.entries(d.assignments)) {
    const rest = names.filter((n) => n !== name);
    if (rest.length === 0) delete d.assignments[path];
    else d.assignments[path] = rest;
  }
};

/** 手動操作済みの印を付ける / 外す */
export const setManual = (paths: string[], value: boolean): Change => (d) => {
  const set = new Set(d.manual);
  for (const p of paths) {
    if (value) set.add(p);
    else set.delete(p);
  }
  d.manual = [...set].sort();
};

/**
 * ファイルごとにラベルを足す/外す。
 * 画面からの操作は手動扱い（manual: true）。自動ラベル付けからは manual: false で呼ぶ。
 */
export const editAssignments = (
  paths: string[],
  add: string[],
  remove: string[],
  { manual = true }: { manual?: boolean } = {},
): Change => (d) => {
  for (const path of paths) {
    const cur = (d.assignments[path] ?? []).filter((n) => !remove.includes(n));
    const next = [...new Set([...cur, ...add])];
    if (next.length === 0) delete d.assignments[path];
    else d.assignments[path] = next;
  }
  if (manual) setManual(paths, true)(d);
};

/** 取り込んだデータを足し合わせる（同じファイルの割り当ては取り込んだ側で上書き） */
export const mergeData = (incoming: LabelData): Change => (d) => {
  for (const l of incoming.labels) if (!d.labels.some((x) => x.name === l.name)) d.labels.push(l);
  Object.assign(d.assignments, incoming.assignments);
  d.manual = [...new Set([...d.manual, ...incoming.manual])].sort();
};

export function applyChange(data: LabelData, change: Change): LabelData {
  const next = structuredClone(data);
  change(next);
  return next;
}
