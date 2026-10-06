import type { Assignments, Label } from "./types";

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function parseLabel(v: unknown): Label | null {
  if (!v || typeof v !== "object") return null;
  const { id, name, color } = v as Record<string, unknown>;
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return null;
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 50) return null;
  if (typeof color !== "string" || !COLOR_RE.test(color)) return null;
  return { id, name: trimmed, color };
}

export function parseAssignments(v: unknown): Assignments | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Assignments = {};
  for (const [path, ids] of Object.entries(v as Record<string, unknown>)) {
    if (path.length === 0 || path.length > 1024) return null;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) return null;
    out[path] = [...new Set(ids as string[])];
  }
  return out;
}
