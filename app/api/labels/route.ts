import { deleteLabel, getRedis, listLabels, saveLabel } from "@/lib/store";
import { parseLabel } from "@/lib/validate";

export const dynamic = "force-dynamic";

function noStore() {
  return Response.json({ error: "共有ストレージが設定されていません" }, { status: 503 });
}

export async function GET() {
  const redis = getRedis();
  if (!redis) return noStore();
  return Response.json(await listLabels(redis));
}

/** ラベルの作成・更新 */
export async function PUT(req: Request) {
  const redis = getRedis();
  if (!redis) return noStore();
  const label = parseLabel(await req.json().catch(() => null));
  if (!label) return Response.json({ error: "不正なラベルです" }, { status: 400 });
  await saveLabel(redis, label);
  return Response.json(label);
}

export async function DELETE(req: Request) {
  const redis = getRedis();
  if (!redis) return noStore();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id が必要です" }, { status: 400 });
  await deleteLabel(redis, id);
  return new Response(null, { status: 204 });
}
