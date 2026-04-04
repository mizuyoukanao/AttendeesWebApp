import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { fetchManagedTournaments } from "@/lib/startgg";

export async function GET(request: NextRequest) {
  const authn = requireSession(request);
  if (!authn.ok) return authn.response;
  if (authn.session.mode !== "startgg") {
    return NextResponse.json({ error: "start.gg セッションが必要です" }, { status: 403 });
  }

  const accessToken = request.cookies.get("startgg_access_token")?.value;
  if (!accessToken) {
    return NextResponse.json({ error: "start.gg に未ログインです" }, { status: 401 });
  }

  try {
    const tournaments = await fetchManagedTournaments(accessToken);
    return NextResponse.json({ tournaments });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "start.gg 取得エラー" }, { status: 500 });
  }
}
