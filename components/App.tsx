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
  setManual,
  emptyData,
  LABEL_FILE,
  mergeData,
  normalizeData,
  PALETTE,
  serializeData,
  updateLabel,
} from "@/lib/label-data";
import { extOf, isModelFile, MODEL_EXTENSIONS } from "@/lib/models";
import { applyRecipeLabels, scanRecipes } from "@/lib/recipes";
import type { Label, LabelData } from "@/lib/types";

const ModelViewer = dynamic(() => import("./ModelViewer"), { ssr: false });

const UNLABELED = "\u0000unlabeled";
/** 絞り込み用: 一度も手動でラベル操作していないファイル */
const UNTOUCHED = "\u0000untouched";

/** 絞り込みの状態: 含む / 除外 */
type FilterState = "in" | "out";

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
  const [filterLabels, setFilterLabels] = useState<Map<string, FilterState>>(new Map());
  const [matchMode, setMatchMode] = useState<"and" | "or">("and");
  const [search, setSearch] = useState("");
  const [newLabelName, setNewLabelName] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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
    setFilterLabels(new Map());
    setNotice("");
    const models = [...opened.files.keys()].filter(isModelFile).sort();
    setSelected(models[0] ?? null);
    let loaded: LabelData;
    try {
      loaded = await opened.store.load();
      setData(loaded);
    } catch (e) {
      setData(emptyData());
      setError(`${LABEL_FILE} の読み込みに失敗しました: ${errMsg(e)}`);
      return;
    }
    await autoLabelFromRecipes(opened, models, loaded);
  };

  /** recipes/ の JSON の ops を、手動未操作のモデルにラベルとして付ける */
  const autoLabelFromRecipes = async (opened: OpenedFolder, models: string[], loaded: LabelData) => {
    try {
      const scan = await scanRecipes(models, opened.files);
      if (scan.labels.size === 0 && scan.broken.length === 0) return;
      const c = applyRecipeLabels(scan.labels);
      // 変化が無ければ保存しない
      if (serializeData(applyChange(loaded, c)) !== serializeData(loaded)) setData(await opened.store.update(c));
      const manual = new Set(loaded.manual);
      const applied = [...scan.labels.keys()].filter((p) => !manual.has(p)).length;
      const parts = [`レシピ ${scan.labels.size} 件の ops を、手動未操作の ${applied} 件のラベルに反映しました`];
      if (scan.labels.size > applied) parts.push(`手動操作済みの ${scan.labels.size - applied} 件はそのままです`);
      if (scan.missing > 0) parts.push(`レシピが見つからないモデル ${scan.missing} 件`);
      if (scan.broken.length > 0) parts.push(`読めなかったレシピ ${scan.broken.length} 件（${scan.broken.slice(0, 3).join(", ")}${scan.broken.length > 3 ? " ほか" : ""}）`);
      setNotice(parts.join("。"));
    } catch (e) {
      setError(`レシピからのラベル付けに失敗しました: ${errMsg(e)}`);
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
  const manualSet = useMemo(() => new Set(data.manual), [data.manual]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return modelPaths.filter((p) => {
      if (q && !p.toLowerCase().includes(q)) return false;
      const names = labelsOf(p);
      const has = (f: string) =>
        f === UNLABELED ? names.length === 0 : f === UNTOUCHED ? !manualSet.has(p) : names.includes(f);
      const include: string[] = [];
      for (const [f, state] of filterLabels) {
        if (state === "out" && has(f)) return false;
        if (state === "in") include.push(f);
      }
      if (include.length === 0) return true;
      return matchMode === "and" ? include.every(has) : include.some(has);
    });
  }, [modelPaths, search, filterLabels, matchMode, labelsOf, manualSet]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { [UNLABELED]: 0, [UNTOUCHED]: 0 };
    for (const p of modelPaths) {
      const names = labelsOf(p);
      if (names.length === 0) c[UNLABELED]++;
      if (!manualSet.has(p)) c[UNTOUCHED]++;
      for (const n of names) c[n] = (c[n] ?? 0) + 1;
    }
    return c;
  }, [modelPaths, labelsOf, manualSet]);

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

  /** ラベルは変えずに、手動操作済み（確認済み）の印だけを付け外しする */
  const markManual = (value: boolean) => {
    if (targets.length === 0) return;
    change(setManual(targets, value));
  };
  const allTargetsManual = targets.length > 0 && targets.every((p) => manualSet.has(p));

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
      const state = prev.get(label.name);
      if (!state) return prev;
      const next = new Map(prev);
      next.delete(label.name);
      next.set(name, state);
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
      const next = new Map(prev);
      next.delete(label.name);
      return next;
    });
    change(deleteLabel(label.name));
  };

  /** クリックごとに 含む → 除外 → 解除（未ラベルは 含む ↔ 解除） */
  const toggleFilter = (name: string) =>
    setFilterLabels((prev) => {
      const next = new Map(prev);
      const state = prev.get(name);
      if (!state) next.set(name, "in");
      else if (state === "in" && name !== UNLABELED) next.set(name, "out");
      else next.delete(name);
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
    const rows = [["path", "labels", "manual"]];
    for (const p of modelPaths) rows.push([p, labelsOf(p).join(";"), manualSet.has(p) ? "済" : "未操作"]);
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

      {notice && (
        <div className="notice-bar" onClick={() => setNotice("")}>
          {notice}（クリックで閉じる）
        </div>
      )}
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
            <p className="muted small hint">ラベルをクリック: 含む → 除外 → 解除</p>
            <div className="chips">
              <button className={`chip ${filterLabels.has(UNLABELED) ? "on" : ""}`} onClick={() => toggleFilter(UNLABELED)}>
                未ラベル ({counts[UNLABELED]})
              </button>
              <button
                className={`chip ${filterLabels.get(UNTOUCHED) === "in" ? "on" : filterLabels.get(UNTOUCHED) === "out" ? "out" : ""}`}
                onClick={() => toggleFilter(UNTOUCHED)}
                title="一度も手動でラベル操作していないファイル（含む → 除外 → 解除）"
              >
                {filterLabels.get(UNTOUCHED) === "out" && "除外: "}
                手動未操作 ({counts[UNTOUCHED]})
              </button>
              {labels.map((l) => {
                const state = filterLabels.get(l.name);
                return (
                  <button
                    key={l.name}
                    className={`chip ${state === "in" ? "on" : state === "out" ? "out" : ""}`}
                    style={{ "--c": l.color } as React.CSSProperties}
                    onClick={() => toggleFilter(l.name)}
                    title={state === "in" ? "含む（もう一度押すと除外）" : state === "out" ? "除外（もう一度押すと解除）" : "クリックで絞り込み"}
                  >
                    {state === "out" && "除外: "}
                    {l.name}
                  </button>
                );
              })}
            </div>
            {[...filterLabels.values()].filter((v) => v === "in").length >= 2 && (
              <div className="segmented">
                <button className={matchMode === "and" ? "on" : ""} onClick={() => setMatchMode("and")}>すべて含む</button>
                <button className={matchMode === "or" ? "on" : ""} onClick={() => setMatchMode("or")}>どれか含む</button>
              </div>
            )}
            {filterLabels.size > 0 && (
              <button className="link" onClick={() => setFilterLabels(new Map())}>絞り込みを解除</button>
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
                        {!manualSet.has(p) && (
                          <span className="tag untouched" title="一度も手動でラベル操作していません">未操作</span>
                        )}
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
            <div className="assign-actions">
              {targets.some((p) => labelsOf(p).length > 0) && (
                <button className="link" onClick={clearLabels}>ラベルをすべて外す</button>
              )}
              {targets.length > 0 &&
                (allTargetsManual ? (
                  <span className="muted small">
                    手動操作済み・<button className="link small" onClick={() => markManual(false)}>未操作に戻す</button>
                  </span>
                ) : (
                  <button className="link" onClick={() => markManual(true)} title="ラベルはそのままで、手動操作済みにします">
                    確認済みにする（ラベルはそのまま）
                  </button>
                ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

const EMPTY_FILES = new Map<string, File>();
