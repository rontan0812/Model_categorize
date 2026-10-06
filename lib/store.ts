import { Redis } from "@upstash/redis";
import type { Assignments, Label } from "./types";

const LABELS_KEY = "mc:labels";
const ASSIGN_KEY = "mc:assignments";

let client: Redis | null | undefined;

/** Upstash Redis のクライアント。環境変数が無ければ null（共有保存なし）。 */
export function getRedis(): Redis | null {
  if (client !== undefined) return client;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  client = url && token ? new Redis({ url, token }) : null;
  return client;
}

export async function listLabels(redis: Redis): Promise<Label[]> {
  const all = await redis.hgetall<Record<string, Label>>(LABELS_KEY);
  return Object.values(all ?? {}).sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

export async function saveLabel(redis: Redis, label: Label): Promise<void> {
  await redis.hset(LABELS_KEY, { [label.id]: label });
}

export async function deleteLabel(redis: Redis, id: string): Promise<void> {
  await redis.hdel(LABELS_KEY, id);
  // 削除したラベルを各ファイルの割り当てからも外す
  const all = await listAssignments(redis);
  const updates: Assignments = {};
  for (const [path, ids] of Object.entries(all)) {
    if (ids.includes(id)) updates[path] = ids.filter((x) => x !== id);
  }
  if (Object.keys(updates).length > 0) await setAssignments(redis, updates);
}

export async function listAssignments(redis: Redis): Promise<Assignments> {
  const all = await redis.hgetall<Assignments>(ASSIGN_KEY);
  return all ?? {};
}

/** 指定パスの割り当てを置き換える。空配列のパスは削除する。 */
export async function setAssignments(redis: Redis, updates: Assignments): Promise<void> {
  const toSet: Assignments = {};
  const toDelete: string[] = [];
  for (const [path, ids] of Object.entries(updates)) {
    if (ids.length === 0) toDelete.push(path);
    else toSet[path] = ids;
  }
  const p = redis.pipeline();
  if (Object.keys(toSet).length > 0) p.hset(ASSIGN_KEY, toSet);
  if (toDelete.length > 0) p.hdel(ASSIGN_KEY, ...toDelete);
  await p.exec();
}
