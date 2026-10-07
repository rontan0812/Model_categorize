import { type Change, PALETTE } from "./label-data";

/**
 * レシピ（JSON）の ops からラベルを自動で付ける。
 *
 * 想定しているフォルダ構成:
 *   <選んだフォルダ>/models/foo.stl
 *   <選んだフォルダ>/recipes/foo.json   … { "ops": [...] }
 */

const RECIPE_DIR = "recipes";
const MODEL_DIR = "models";

function stripExt(path: string) {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(0, dot) : path;
}

const baseName = (path: string) => stripExt(path).split("/").pop()!;

/**
 * モデルに対応するレシピのパスを探す。
 * まず models/ を recipes/ に置き換えた同じ位置（サブフォルダも同じ構成）を見て、
 * 無ければ recipes/ 以下から同じ名前の .json を探す（同名が複数あれば対応付けない）。
 */
export function recipeIndex(files: Iterable<string>) {
  const byBase = new Map<string, string[]>();
  const all = new Set<string>();
  for (const p of files) {
    const parts = p.split("/");
    if (!p.toLowerCase().endsWith(".json") || !parts.slice(0, -1).includes(RECIPE_DIR)) continue;
    all.add(p);
    const b = baseName(p);
    byBase.set(b, [...(byBase.get(b) ?? []), p]);
  }
  return (modelPath: string): string | null => {
    const parts = stripExt(modelPath).split("/");
    const i = parts.indexOf(MODEL_DIR);
    if (i >= 0) {
      const same = [...parts.slice(0, i), RECIPE_DIR, ...parts.slice(i + 1)].join("/") + ".json";
      if (all.has(same)) return same;
    }
    const candidates = byBase.get(baseName(modelPath)) ?? [];
    return candidates.length === 1 ? candidates[0] : null;
  };
}

/** ops の要素をラベル名にする（文字列ならそのまま、オブジェクトなら op / type / name などの値） */
export function opsToLabels(recipe: unknown): string[] {
  const ops = (recipe as { ops?: unknown } | null)?.ops;
  if (!Array.isArray(ops)) return [];
  const names: string[] = [];
  for (const op of ops) {
    let name: unknown = op;
    if (op && typeof op === "object") {
      const o = op as Record<string, unknown>;
      name = [o.op, o.type, o.name, o.kind, o.operation].find((v) => typeof v === "string");
    }
    if (typeof name === "number") name = String(name);
    if (typeof name === "string" && name.trim()) names.push(name.trim().slice(0, 50));
  }
  return [...new Set(names)];
}

export type RecipeScan = {
  /** モデルのパス -> ops から作ったラベル名 */
  labels: Map<string, string[]>;
  /** レシピが見つからなかったモデルの数 */
  missing: number;
  /** 読めなかったレシピ */
  broken: string[];
};

export async function scanRecipes(modelPaths: string[], files: Map<string, File>): Promise<RecipeScan> {
  const find = recipeIndex(files.keys());
  const result: RecipeScan = { labels: new Map(), missing: 0, broken: [] };
  await Promise.all(
    modelPaths.map(async (m) => {
      const r = find(m);
      if (!r) {
        result.missing++;
        return;
      }
      try {
        result.labels.set(m, opsToLabels(JSON.parse(await files.get(r)!.text())));
      } catch {
        result.broken.push(r);
      }
    }),
  );
  return result;
}

/**
 * レシピのラベルを当てる。人が手動で操作したファイルは変更しない。
 * 手動未操作のファイルはレシピの内容に置き換える（レシピが更新されたら追従する）。
 */
export const applyRecipeLabels = (labels: Map<string, string[]>): Change => (d) => {
  const manual = new Set(d.manual);
  for (const [path, names] of labels) {
    if (manual.has(path)) continue;
    for (const name of names) {
      if (!d.labels.some((l) => l.name === name)) {
        d.labels.push({ name, color: PALETTE[d.labels.length % PALETTE.length] });
      }
    }
    if (names.length === 0) delete d.assignments[path];
    else d.assignments[path] = names;
  }
};
