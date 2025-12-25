import { cookies } from "next/headers";
import { NextResponse } from "next/server";

function readUserCookie() {
  const encoded = cookies().get("startgg_user")?.value;
  if (!encoded) return null;
  try {
    const json = Buffer.from(encoded, "base64").toString("utf-8");
    return JSON.parse(json);
  } catch (error) {
    return null;
  }
}

export async function GET() {
  const accessToken = cookies().get("startgg_access_token")?.value;
  const user = readUserCookie();

  return NextResponse.json({
    authenticated: Boolean(accessToken),
    user,
  });
}
