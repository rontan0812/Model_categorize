import { getRedis, listAssignments, setAssignments } from "@/lib/store";
import { parseAssignments } from "@/lib/validate";

export const dynamic = "force-dynamic";

function noStore() {
  return Response.json({ error: "共有ストレージが設定されていません" }, { status: 503 });
}

export async function GET() {
  const redis = getRedis();
  if (!redis) return noStore();
  return Response.json(await listAssignments(redis));
}

/** { "パス": ["ラベルID", ...] } の形で、指定したファイルの割り当てを置き換える */
export async function PATCH(req: Request) {
  const redis = getRedis();
  if (!redis) return noStore();
  const updates = parseAssignments(await req.json().catch(() => null));
  if (!updates) return Response.json({ error: "不正なデータです" }, { status: 400 });
  await setAssignments(redis, updates);
  return new Response(null, { status: 204 });
}
