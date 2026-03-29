import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const GRAPHQL_URL = "https://api.start.gg/gql/alpha";
const PAGE_SIZE = 10;

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
          admins {
            id
          }
        }
      }
    }
  }
`;

async function requestManagedPage(accessToken: string, page: number) {
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query: MANAGED_TOURNAMENTS_QUERY,
      variables: { page, perPage: PAGE_SIZE },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`start.gg API 呼び出しに失敗しました (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  if (data?.errors?.length) {
    throw new Error(`start.gg API エラー: ${JSON.stringify(data.errors)}`);
  }
  return data;
}

export async function GET() {
  const accessToken = cookies().get("startgg_access_token")?.value;

  if (!accessToken) {
    return NextResponse.json({ error: "start.gg に未ログインです" }, { status: 401 });
  }

  try {
    let page = 1;
    const allNodes: any[] = [];
    let currentUserId = "";

    while (true) {
      const data = await requestManagedPage(accessToken, page);
      const currentUser = data?.data?.currentUser;
      const nodes = currentUser?.tournaments?.nodes ?? [];

      if (!currentUserId) {
        currentUserId = String(currentUser?.id || "");
      }

      allNodes.push(...nodes);
      if (nodes.length < PAGE_SIZE) break;
      page += 1;
    }

    const managerOnly = allNodes
      .filter((tournament) => {
        const admins = Array.isArray(tournament?.admins) ? tournament.admins : [];
        return admins.some((admin: any) => String(admin?.id || "") === currentUserId);
      })
      .map((tournament) => ({
        id: tournament.id,
        name: tournament.name,
        slug: tournament.slug,
        startAt: tournament.startAt,
        city: tournament.city,
        addrState: tournament.addrState,
        countryCode: tournament.countryCode,
      }));

    const deduped = Array.from(new Map(managerOnly.map((t) => [String(t.id), t])).values());
    return NextResponse.json({ tournaments: deduped });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "start.gg 取得エラー" }, { status: 500 });
  }
}
