"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connectStore, type Store } from "@/lib/client-store";
import { extOf, isModelFile, MODEL_EXTENSIONS } from "@/lib/models";
import type { Assignments, Label } from "@/lib/types";

const ModelViewer = dynamic(() => import("./ModelViewer"), { ssr: false });

const PALETTE = ["#e5484d", "#f76b15", "#ffc53d", "#30a46c", "#12a594", "#0090ff", "#6e56cf", "#d6409f", "#8d8d8d"];
const UNLABELED = "__unlabeled__";

function newId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

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

export default function App() {
  const [store, setStore] = useState<Store | null>(null);
  const [labels, setLabels] = useState<Label[]>([]);
  const [assignments, setAssignments] = useState<Assignments>({});
  const [files, setFiles] = useState<Map<string, File>>(new Map());
  const [folderName, setFolderName] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [filterLabels, setFilterLabels] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [newLabelName, setNewLabelName] = useState("");
  const [error, setError] = useState("");
  const folderInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async (s: Store) => {
    try {
      const [l, a] = await Promise.all([s.loadLabels(), s.loadAssignments()]);
      setLabels(l);
      setAssignments(a);
    } catch (e) {
      setError(`読み込みに失敗しました: ${e instanceof Error ? e.message : e}`);
    }
  }, []);

  useEffect(() => {
    connectStore().then((s) => {
      setStore(s);
      reload(s);
    });
  }, [reload]);

  // チームで共有している場合は、他の人の変更を定期的に取り込む
  useEffect(() => {
    if (!store?.shared) return;
    const onFocus = () => reload(store);
    window.addEventListener("focus", onFocus);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") reload(store);
    }, 15000);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(timer);
    };
  }, [store, reload]);

  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, []);

  const onPickFolder = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const map = new Map<string, File>();
    for (const f of Array.from(list)) map.set(f.webkitRelativePath || f.name, f);
    const first = list[0].webkitRelativePath || list[0].name;
    setFolderName(first.split("/")[0]);
    setFiles(map);
    setChecked(new Set());
    const models = [...map.keys()].filter(isModelFile).sort();
    setSelected(models[0] ?? null);
  };

  const modelPaths = useMemo(
    () => [...files.keys()].filter(isModelFile).sort((a, b) => a.localeCompare(b, "ja")),
    [files],
  );

  const labelById = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);
  const labelsOf = useCallback(
    (path: string) => (assignments[path] ?? []).filter((id) => labelById.has(id)),
    [assignments, labelById],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return modelPaths.filter((p) => {
      if (q && !p.toLowerCase().includes(q)) return false;
      const ids = labelsOf(p);
      for (const f of filterLabels) {
        if (f === UNLABELED ? ids.length > 0 : !ids.includes(f)) return false;
      }
      return true;
    });
  }, [modelPaths, search, filterLabels, labelsOf]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { [UNLABELED]: 0 };
    for (const p of modelPaths) {
      const ids = labelsOf(p);
      if (ids.length === 0) c[UNLABELED]++;
      for (const id of ids) c[id] = (c[id] ?? 0) + 1;
    }
    return c;
  }, [modelPaths, labelsOf]);

  // ラベル付けの対象: チェックしたファイル、無ければ選択中のファイル
  const targets = useMemo(
    () => (checked.size > 0 ? [...checked] : selected ? [selected] : []),
    [checked, selected],
  );

  const persist = async (updates: Assignments) => {
    if (!store) return;
    setAssignments((prev) => {
      const next = { ...prev };
      for (const [p, ids] of Object.entries(updates)) {
        if (ids.length === 0) delete next[p];
        else next[p] = ids;
      }
      return next;
    });
    try {
      await store.patchAssignments(updates);
    } catch (e) {
      setError(`保存に失敗しました: ${e instanceof Error ? e.message : e}`);
      reload(store);
    }
  };

  const toggleLabel = (labelId: string) => {
    if (targets.length === 0) return;
    const allHave = targets.every((p) => labelsOf(p).includes(labelId));
    const updates: Assignments = {};
    for (const p of targets) {
      const cur = labelsOf(p);
      updates[p] = allHave ? cur.filter((x) => x !== labelId) : [...new Set([...cur, labelId])];
    }
    persist(updates);
  };

  const clearLabels = () => {
    if (targets.length === 0) return;
    persist(Object.fromEntries(targets.map((p) => [p, []])));
  };

  const addLabel = async () => {
    const name = newLabelName.trim();
    if (!name || !store) return;
    if (labels.some((l) => l.name === name)) {
      setError(`「${name}」は既にあります`);
      return;
    }
    const label: Label = { id: newId(), name, color: PALETTE[labels.length % PALETTE.length] };
    setLabels((prev) => [...prev, label]);
    setNewLabelName("");
    try {
      await store.saveLabel(label);
    } catch (e) {
      setError(`ラベルの保存に失敗しました: ${e instanceof Error ? e.message : e}`);
      reload(store);
    }
  };

  const updateLabel = async (label: Label) => {
    if (!store) return;
    setLabels((prev) => prev.map((l) => (l.id === label.id ? label : l)));
    try {
      await store.saveLabel(label);
    } catch (e) {
      setError(`ラベルの保存に失敗しました: ${e instanceof Error ? e.message : e}`);
      reload(store);
    }
  };

  const renameLabel = (label: Label) => {
    const name = window.prompt("ラベル名を変更", label.name)?.trim();
    if (name && name !== label.name) updateLabel({ ...label, name });
  };

  const removeLabel = async (label: Label) => {
    if (!store) return;
    const n = counts[label.id] ?? 0;
    const msg = n > 0
      ? `ラベル「${label.name}」を削除しますか？\n（このフォルダでは ${n} 件に付いています。すべてのファイルから外れます）`
      : `ラベル「${label.name}」を削除しますか？`;
    if (!window.confirm(msg)) return;
    setLabels((prev) => prev.filter((l) => l.id !== label.id));
    setFilterLabels((prev) => {
      const next = new Set(prev);
      next.delete(label.id);
      return next;
    });
    try {
      await store.deleteLabel(label.id);
    } catch (e) {
      setError(`削除に失敗しました: ${e instanceof Error ? e.message : e}`);
    }
    reload(store);
  };

  const toggleFilter = (id: string) =>
    setFilterLabels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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
  const toggleAllVisible = () =>
    setChecked(allVisibleChecked ? new Set() : new Set(visible));

  const exportCsv = () => {
    const rows = [["path", "labels"]];
    for (const p of modelPaths) rows.push([p, labelsOf(p).map((id) => labelById.get(id)!.name).join(";")]);
    download(`${folderName || "labels"}.csv`, "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\n"), "text/csv");
  };

  const exportJson = () => {
    const data = { labels, assignments };
    download("model-labels.json", JSON.stringify(data, null, 2), "application/json");
  };

  const importJson = async (file: File | undefined) => {
    if (!file || !store) return;
    try {
      const data = JSON.parse(await file.text()) as { labels?: Label[]; assignments?: Assignments };
      if (!Array.isArray(data.labels) || typeof data.assignments !== "object") throw new Error("形式が違います");
      if (!window.confirm(`ラベル ${data.labels.length} 件、割り当て ${Object.keys(data.assignments).length} 件を取り込みます。同じファイルの割り当ては上書きされます。`)) return;
      for (const l of data.labels) await store.saveLabel(l);
      await store.patchAssignments(data.assignments);
      await reload(store);
    } catch (e) {
      setError(`取り込みに失敗しました: ${e instanceof Error ? e.message : e}`);
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
        listRef.current
          ?.querySelector(`[data-path="${CSS.escape(next)}"]`)
          ?.scrollIntoView({ block: "nearest" });
      } else if (/^[1-9]$/.test(e.key)) {
        const label = labels[Number(e.key) - 1];
        if (label) toggleLabel(label.id);
      } else if (e.key === " " && selected) {
        e.preventDefault();
        toggleChecked(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const targetLabelState = (id: string) => {
    if (targets.length === 0) return "none";
    const n = targets.filter((p) => labelsOf(p).includes(id)).length;
    return n === 0 ? "none" : n === targets.length ? "all" : "some";
  };

  return (
    <div className="app">
      <header className="header">
        <h1>Model Categorize</h1>
        <button className="primary" onClick={() => folderInput.current?.click()}>
          フォルダを選択
        </button>
        <input
          ref={folderInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            onPickFolder(e.target.files);
            e.target.value = "";
          }}
        />
        {folderName && (
          <span className="muted">
            📁 {folderName}（3Dモデル {modelPaths.length} 件 / 全 {files.size} ファイル）
          </span>
        )}
        <span className="spacer" />
        {store && (
          <span className={`badge ${store.shared ? "ok" : "warn"}`} title={store.shared ? "ラベルはサーバーに保存され、チームで共有されます" : "共有ストレージが未設定のため、このブラウザ内にだけ保存されます"}>
            {store.shared ? "チーム共有" : "このブラウザのみ保存"}
          </span>
        )}
        <button onClick={exportCsv} disabled={modelPaths.length === 0}>CSV出力</button>
        <button onClick={exportJson}>JSON出力</button>
        <button onClick={() => importInput.current?.click()}>JSON取込</button>
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
                addLabel();
              }}
            >
              <input
                value={newLabelName}
                onChange={(e) => setNewLabelName(e.target.value)}
                placeholder="新しいラベル名"
                maxLength={50}
              />
              <button type="submit" disabled={!newLabelName.trim()}>追加</button>
            </form>
            {labels.length === 0 && <p className="muted small">まずはラベルを作成してください（例: 人物、建物、乗り物）</p>}
            <ul className="label-list">
              {labels.map((l, i) => (
                <li key={l.id}>
                  <input
                    type="color"
                    value={l.color}
                    onChange={(e) => setLabels((prev) => prev.map((x) => (x.id === l.id ? { ...x, color: e.target.value } : x)))}
                    onBlur={(e) => updateLabel({ ...l, color: e.target.value })}
                    title="色を変更"
                  />
                  <span className="label-name" onDoubleClick={() => renameLabel(l)} title="ダブルクリックで名前を変更">
                    {i < 9 && <kbd>{i + 1}</kbd>} {l.name}
                  </span>
                  <span className="muted small">{counts[l.id] ?? 0}</span>
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
              <button
                className={`chip ${filterLabels.has(UNLABELED) ? "on" : ""}`}
                onClick={() => toggleFilter(UNLABELED)}
              >
                未ラベル ({counts[UNLABELED]})
              </button>
              {labels.map((l) => (
                <button
                  key={l.id}
                  className={`chip ${filterLabels.has(l.id) ? "on" : ""}`}
                  style={{ "--c": l.color } as React.CSSProperties}
                  onClick={() => toggleFilter(l.id)}
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
              <p>「フォルダを選択」から 3D モデルが入ったフォルダを選んでください。</p>
              <p className="muted small">ファイルはサーバーにアップロードされず、ブラウザ内でだけ読み込まれます。保存されるのはファイルのパスとラベルだけです。</p>
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
                  const f = files.get(p)!;
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
                        {labelsOf(p).map((id) => {
                          const l = labelById.get(id)!;
                          return (
                            <span key={id} className="tag" style={{ "--c": l.color } as React.CSSProperties}>
                              {l.name}
                            </span>
                          );
                        })}
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
          <ModelViewer path={selected} files={files} />
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
                const state = targetLabelState(l.id);
                return (
                  <button
                    key={l.id}
                    className={`chip ${state === "all" ? "on" : state === "some" ? "partial" : ""}`}
                    style={{ "--c": l.color } as React.CSSProperties}
                    disabled={targets.length === 0}
                    onClick={() => toggleLabel(l.id)}
                  >
                    {i < 9 && <kbd>{i + 1}</kbd>} {l.name}
                  </button>
                );
              })}
              {labels.length === 0 && <span className="muted small">左の「ラベル」から作成してください</span>}
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
