"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canWriteFolder, openFolderFromInput, openFolderWritable, type OpenedFolder } from "@/lib/folder";
import {
  addLabel,
  applyChange,
  type Change,
  deleteLabel,
  editAssignments,
  emptyData,
  LABEL_FILE,
  mergeData,
  normalizeData,
  serializeData,
  updateLabel,
} from "@/lib/label-data";
import { extOf, isModelFile, MODEL_EXTENSIONS } from "@/lib/models";
import type { Label, LabelData } from "@/lib/types";

const ModelViewer = dynamic(() => import("./ModelViewer"), { ssr: false });

const PALETTE = ["#e5484d", "#f76b15", "#ffc53d", "#30a46c", "#12a594", "#0090ff", "#6e56cf", "#d6409f", "#8d8d8d"];
const UNLABELED = "\u0000unlabeled";

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function csvCell(s: string) {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function App() {
  const [folder, setFolder] = useState<OpenedFolder | null>(null);
  const [data, setData] = useState<LabelData>(emptyData);
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [filterLabels, setFilterLabels] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [newLabelName, setNewLabelName] = useState("");
  const [error, setError] = useState("");
  const [writable, setWritable] = useState(true);
  const folderInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const store = folder?.store;
  const labels = data.labels;

  useEffect(() => {
    setWritable(canWriteFolder());
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, []);

  const reload = useCallback(async () => {
    if (!store) return;
    try {
      setData(await store.load());
    } catch (e) {
      setError(`${LABEL_FILE} の読み込みに失敗しました: ${errMsg(e)}`);
    }
  }, [store]);

  // 他の人が同じフォルダ（共有ドライブ等）を編集している場合に備え、画面に戻った時に読み直す
  useEffect(() => {
    if (store?.kind !== "folder") return;
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [store, reload]);

  const open = async (opened: OpenedFolder | null) => {
    if (!opened) return;
    setFolder(opened);
    setChecked(new Set());
    setFilterLabels(new Set());
    const models = [...opened.files.keys()].filter(isModelFile).sort();
    setSelected(models[0] ?? null);
    try {
      setData(await opened.store.load());
    } catch (e) {
      setData(emptyData());
      setError(`${LABEL_FILE} の読み込みに失敗しました: ${errMsg(e)}`);
    }
  };

  const pickFolder = async () => {
    if (!writable) {
      folderInput.current?.click();
      return;
    }
    try {
      await open(await openFolderWritable());
    } catch (e) {
      setError(`フォルダを開けませんでした: ${errMsg(e)}`);
    }
  };

  /** 画面にすぐ反映し、保存後の内容（他の人の変更も含む）で置き換える */
  const change = async (c: Change) => {
    if (!store) return;
    setData((d) => applyChange(d, c));
    try {
      setData(await store.update(c));
    } catch (e) {
      setError(`保存に失敗しました: ${errMsg(e)}`);
      reload();
    }
  };

  const modelPaths = useMemo(
    () => [...(folder?.files.keys() ?? [])].filter(isModelFile).sort((a, b) => a.localeCompare(b, "ja")),
    [folder],
  );

  const labelByName = useMemo(() => new Map(labels.map((l) => [l.name, l])), [labels]);
  const labelsOf = useCallback(
    (path: string) => (data.assignments[path] ?? []).filter((n) => labelByName.has(n)),
    [data.assignments, labelByName],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return modelPaths.filter((p) => {
      if (q && !p.toLowerCase().includes(q)) return false;
      const names = labelsOf(p);
      for (const f of filterLabels) {
        if (f === UNLABELED ? names.length > 0 : !names.includes(f)) return false;
      }
      return true;
    });
  }, [modelPaths, search, filterLabels, labelsOf]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { [UNLABELED]: 0 };
    for (const p of modelPaths) {
      const names = labelsOf(p);
      if (names.length === 0) c[UNLABELED]++;
      for (const n of names) c[n] = (c[n] ?? 0) + 1;
    }
    return c;
  }, [modelPaths, labelsOf]);

  // ラベル付けの対象: チェックしたファイル、無ければ選択中のファイル
  const targets = useMemo(
    () => (checked.size > 0 ? [...checked] : selected ? [selected] : []),
    [checked, selected],
  );

  const toggleLabel = (name: string) => {
    if (targets.length === 0) return;
    const allHave = targets.every((p) => labelsOf(p).includes(name));
    change(allHave ? editAssignments(targets, [], [name]) : editAssignments(targets, [name], []));
  };

  const clearLabels = () => {
    if (targets.length === 0) return;
    change(editAssignments(targets, [], labels.map((l) => l.name)));
  };

  const onAddLabel = () => {
    const name = newLabelName.trim();
    if (!name) return;
    if (labelByName.has(name)) {
      setError(`「${name}」は既にあります`);
      return;
    }
    setNewLabelName("");
    change(addLabel({ name, color: PALETTE[labels.length % PALETTE.length] }));
  };

  const renameLabel = (label: Label) => {
    const name = window.prompt("ラベル名を変更", label.name)?.trim();
    if (!name || name === label.name) return;
    if (labelByName.has(name)) {
      setError(`「${name}」は既にあります`);
      return;
    }
    setFilterLabels((prev) => {
      if (!prev.has(label.name)) return prev;
      const next = new Set(prev);
      next.delete(label.name);
      next.add(name);
      return next;
    });
    change(updateLabel(label.name, { ...label, name }));
  };

  const removeLabel = (label: Label) => {
    const n = counts[label.name] ?? 0;
    const msg = n > 0
      ? `ラベル「${label.name}」を削除しますか？\n（${n} 件のファイルから外れます）`
      : `ラベル「${label.name}」を削除しますか？`;
    if (!window.confirm(msg)) return;
    setFilterLabels((prev) => {
      const next = new Set(prev);
      next.delete(label.name);
      return next;
    });
    change(deleteLabel(label.name));
  };

  const toggleFilter = (name: string) =>
    setFilterLabels((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const toggleChecked = (path: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const allVisibleChecked = visible.length > 0 && visible.every((p) => checked.has(p));
  const toggleAllVisible = () => setChecked(allVisibleChecked ? new Set() : new Set(visible));

  const exportCsv = () => {
    const rows = [["path", "labels"]];
    for (const p of modelPaths) rows.push([p, labelsOf(p).join(";")]);
    download(`${folder?.name || "labels"}.csv`, "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\n"), "text/csv");
  };

  const importJson = async (file: File | undefined) => {
    if (!file || !store) return;
    try {
      const incoming = normalizeData(JSON.parse(await file.text()));
      const msg = `ラベル ${incoming.labels.length} 件、割り当て ${Object.keys(incoming.assignments).length} 件を取り込みます。同じファイルの割り当ては上書きされます。`;
      if (window.confirm(msg)) await change(mergeData(incoming));
    } catch (e) {
      setError(`取り込みに失敗しました: ${errMsg(e)}`);
    }
  };

  // キーボード操作: ↑↓/j k で移動、1〜9 でラベル切り替え、Space でチェック
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, button") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "j" || e.key === "k") {
        if (visible.length === 0) return;
        e.preventDefault();
        const i = selected ? visible.indexOf(selected) : -1;
        const delta = e.key === "ArrowDown" || e.key === "j" ? 1 : -1;
        const next = visible[Math.min(visible.length - 1, Math.max(0, i + delta))];
        setSelected(next);
        listRef.current?.querySelector(`[data-path="${CSS.escape(next)}"]`)?.scrollIntoView({ block: "nearest" });
      } else if (/^[1-9]$/.test(e.key)) {
        const label = labels[Number(e.key) - 1];
        if (label) toggleLabel(label.name);
      } else if (e.key === " " && selected) {
        e.preventDefault();
        toggleChecked(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const targetLabelState = (name: string) => {
    if (targets.length === 0) return "none";
    const n = targets.filter((p) => labelsOf(p).includes(name)).length;
    return n === 0 ? "none" : n === targets.length ? "all" : "some";
  };

  return (
    <div className="app">
      <header className="header">
        <h1>Model Categorize</h1>
        <button className="primary" onClick={pickFolder}>
          フォルダを選択
        </button>
        <input
          ref={folderInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            open(e.target.files ? openFolderFromInput(e.target.files) : null);
            e.target.value = "";
          }}
        />
        {folder && (
          <span className="muted">
            📁 {folder.name}（3Dモデル {modelPaths.length} 件）
          </span>
        )}
        <span className="spacer" />
        {folder && (
          <span
            className={`badge ${store?.kind === "folder" ? "ok" : "warn"}`}
            title={store?.kind === "folder"
              ? `選んだフォルダ内の ${LABEL_FILE} に自動保存しています`
              : `このブラウザはフォルダへの書き込みに対応していないため、ブラウザ内に保存しています。Chrome か Edge を使うと ${LABEL_FILE} に保存できます`}
          >
            {store?.kind === "folder" ? `${LABEL_FILE} に自動保存` : "ブラウザ内に保存"}
          </span>
        )}
        <button onClick={exportCsv} disabled={!folder}>CSV出力</button>
        <button onClick={() => download(LABEL_FILE, serializeData(data), "application/json")} disabled={!folder}>JSON出力</button>
        <button onClick={() => importInput.current?.click()} disabled={!folder}>JSON取込</button>
        <input
          ref={importInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            importJson(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </header>

      {error && (
        <div className="error-bar" onClick={() => setError("")}>
          {error}（クリックで閉じる）
        </div>
      )}

      <div className="main">
        <aside className="sidebar">
          <section>
            <h2>ラベル</h2>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                onAddLabel();
              }}
            >
              <input
                value={newLabelName}
                onChange={(e) => setNewLabelName(e.target.value)}
                placeholder="新しいラベル名"
                maxLength={50}
                disabled={!folder}
              />
              <button type="submit" disabled={!folder || !newLabelName.trim()}>追加</button>
            </form>
            {folder && labels.length === 0 && (
              <p className="muted small">まずはラベルを作成してください（例: 人物、建物、乗り物）</p>
            )}
            <ul className="label-list">
              {labels.map((l, i) => (
                <li key={l.name}>
                  <input
                    type="color"
                    value={l.color}
                    onChange={(e) => setData((d) => applyChange(d, updateLabel(l.name, { ...l, color: e.target.value })))}
                    onBlur={(e) => change(updateLabel(l.name, { ...l, color: e.target.value }))}
                    title="色を変更"
                  />
                  <span className="label-name" onDoubleClick={() => renameLabel(l)} title="ダブルクリックで名前を変更">
                    {i < 9 && <kbd>{i + 1}</kbd>} {l.name}
                  </span>
                  <span className="muted small">{counts[l.name] ?? 0}</span>
                  <button className="icon" onClick={() => renameLabel(l)} title="名前を変更">✎</button>
                  <button className="icon" onClick={() => removeLabel(l)} title="削除">×</button>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2>絞り込み</h2>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ファイル名で検索" />
            <div className="chips">
              <button className={`chip ${filterLabels.has(UNLABELED) ? "on" : ""}`} onClick={() => toggleFilter(UNLABELED)}>
                未ラベル ({counts[UNLABELED]})
              </button>
              {labels.map((l) => (
                <button
                  key={l.name}
                  className={`chip ${filterLabels.has(l.name) ? "on" : ""}`}
                  style={{ "--c": l.color } as React.CSSProperties}
                  onClick={() => toggleFilter(l.name)}
                >
                  {l.name}
                </button>
              ))}
            </div>
            {filterLabels.size > 0 && (
              <button className="link" onClick={() => setFilterLabels(new Set())}>絞り込みを解除</button>
            )}
          </section>

          <section className="muted small help">
            <h2>操作</h2>
            <p>↑↓ / j k: ファイル移動</p>
            <p>1〜9: ラベルの付け外し</p>
            <p>Space: チェック（まとめて付ける用）</p>
            <p>対応形式: {MODEL_EXTENSIONS.map((e) => `.${e}`).join(" ")}</p>
          </section>
        </aside>

        <section className="file-pane">
          {modelPaths.length === 0 ? (
            <div className="empty">
              {folder ? (
                <p>このフォルダには 3D モデルが見つかりませんでした。</p>
              ) : (
                <>
                  <p>「フォルダを選択」から 3D モデルが入ったフォルダを選んでください。</p>
                  <p className="muted small">
                    ラベルは選んだフォルダ内の <code>{LABEL_FILE}</code> に自動で保存されます。
                    {!writable && "（このブラウザでは保存できないため、Chrome か Edge をおすすめします）"}
                  </p>
                </>
              )}
            </div>
          ) : (
            <>
              <div className="file-head">
                <label>
                  <input type="checkbox" checked={allVisibleChecked} onChange={toggleAllVisible} />
                  表示中を全選択
                </label>
                <span className="muted small">
                  {visible.length} / {modelPaths.length} 件
                  {checked.size > 0 && `・${checked.size} 件チェック中`}
                </span>
                {checked.size > 0 && <button className="link" onClick={() => setChecked(new Set())}>チェック解除</button>}
              </div>
              <div className="file-list" ref={listRef}>
                {visible.map((p) => {
                  const f = folder!.files.get(p)!;
                  return (
                    <div
                      key={p}
                      data-path={p}
                      className={`file-row ${p === selected ? "selected" : ""} ${checked.has(p) ? "checked" : ""}`}
                      onClick={() => setSelected(p)}
                    >
                      <input
                        type="checkbox"
                        checked={checked.has(p)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleChecked(p)}
                      />
                      <span className="ext">{extOf(p)}</span>
                      <span className="path" title={p}>
                        <span className="dir">{p.slice(0, p.lastIndexOf("/") + 1)}</span>
                        {p.slice(p.lastIndexOf("/") + 1)}
                      </span>
                      <span className="tags">
                        {labelsOf(p).map((n) => (
                          <span key={n} className="tag" style={{ "--c": labelByName.get(n)!.color } as React.CSSProperties}>
                            {n}
                          </span>
                        ))}
                      </span>
                      <span className="muted small size">{formatBytes(f.size)}</span>
                    </div>
                  );
                })}
                {visible.length === 0 && <div className="empty muted">条件に合うファイルはありません</div>}
              </div>
            </>
          )}
        </section>

        <section className="detail-pane">
          <ModelViewer path={selected} files={folder?.files ?? EMPTY_FILES} />
          <div className="assign">
            <div className="assign-title">
              {checked.size > 0 ? (
                <strong>チェックした {checked.size} 件にラベルを付ける</strong>
              ) : selected ? (
                <strong title={selected}>{selected.split("/").pop()}</strong>
              ) : (
                <span className="muted">ファイル未選択</span>
              )}
            </div>
            <div className="chips">
              {labels.map((l, i) => {
                const state = targetLabelState(l.name);
                return (
                  <button
                    key={l.name}
                    className={`chip ${state === "all" ? "on" : state === "some" ? "partial" : ""}`}
                    style={{ "--c": l.color } as React.CSSProperties}
                    disabled={targets.length === 0}
                    onClick={() => toggleLabel(l.name)}
                  >
                    {i < 9 && <kbd>{i + 1}</kbd>} {l.name}
                  </button>
                );
              })}
              {folder && labels.length === 0 && <span className="muted small">左の「ラベル」から作成してください</span>}
            </div>
            {targets.some((p) => labelsOf(p).length > 0) && (
              <button className="link" onClick={clearLabels}>ラベルをすべて外す</button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

const EMPTY_FILES = new Map<string, File>();
