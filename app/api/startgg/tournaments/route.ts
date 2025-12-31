import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const GRAPHQL_URL = "https://api.start.gg/gql/alpha";

const MANAGED_TOURNAMENTS_QUERY = `
  query ManagedTournaments($page: Int!, $perPage: Int!) {
    currentUser {
      id
      tournaments(query: { page: $page, perPage: $perPage }) {
        nodes {
          id
          name
          slug
          startAt
          city
          addrState
          countryCode
        }
      }
    }
  }
`;

export async function GET() {
  const accessToken = cookies().get("startgg_access_token")?.value;

  if (!accessToken) {
    return NextResponse.json({ error: "start.gg に未ログインです" }, { status: 401 });
  }

  try {
    const response = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        query: MANAGED_TOURNAMENTS_QUERY,
        variables: { page: 1, perPage: 50 },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { error: `start.gg API 呼び出しに失敗しました (${response.status})`, details: errorText },
        { status: 502 },
      );
    }

    const data = await response.json();

    if (data?.errors?.length) {
      return NextResponse.json({ error: "start.gg API がエラーを返しました", details: data.errors }, { status: 502 });
    }

    const tournaments = data?.data?.currentUser?.tournaments?.nodes ?? [];

    return NextResponse.json({ tournaments });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "start.gg 取得エラー" }, { status: 500 });
  }
}
