const GRAPHQL_URL = "https://api.start.gg/gql/alpha";
const PAGE_SIZE = 10;

const VIEWER_QUERY = `query Viewer { currentUser { id slug name player { gamerTag } } }`;

const MANAGED_TOURNAMENTS_QUERY = `
  query ManagedTournaments($page: Int!, $perPage: Int!, $roles: [String!]) {
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
          admins(roles: $roles) {
            id
          }
        }
      }
    }
  }
`;

export type StartggViewer = {
  id: string;
  slug?: string;
  name?: string;
  player?: { gamerTag?: string | null };
};

async function requestGraphql(accessToken: string, query: string, variables?: Record<string, unknown>) {
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`start.gg API 呼び出しに失敗しました (${response.status}): ${text}`);
  }

  const data = await response.json();
  if (data?.errors?.length) {
    throw new Error(`start.gg API エラー: ${JSON.stringify(data.errors)}`);
  }

  return data;
}

export async function fetchViewer(accessToken: string): Promise<StartggViewer | null> {
  try {
    const data = await requestGraphql(accessToken, VIEWER_QUERY);
    return data?.data?.currentUser ?? null;
  } catch {
    return null;
  }
}

export async function fetchManagedTournamentIds(accessToken: string): Promise<string[]> {
  let page = 1;
  const allNodes: any[] = [];
  let currentUserId = "";

  while (true) {
    const data = await requestGraphql(accessToken, MANAGED_TOURNAMENTS_QUERY, {
      page,
      perPage: PAGE_SIZE,
      roles: ["admin", "manager", "bracketManager"],
    });

    const currentUser = data?.data?.currentUser;
    const nodes = currentUser?.tournaments?.nodes ?? [];

    if (!currentUserId) {
      currentUserId = String(currentUser?.id || "");
    }

    allNodes.push(...nodes);
    if (nodes.length < PAGE_SIZE) break;
    page += 1;
  }

  return Array.from(new Set(
    allNodes
      .filter((tournament) => {
        const admins = Array.isArray(tournament?.admins) ? tournament.admins : [];
        return admins.some((admin: any) => String(admin?.id || "") === currentUserId);
      })
      .map((tournament) => String(tournament.id)),
  ));
}

export async function fetchManagedTournaments(accessToken: string) {
  let page = 1;
  const allNodes: any[] = [];
  let currentUserId = "";

  while (true) {
    const data = await requestGraphql(accessToken, MANAGED_TOURNAMENTS_QUERY, {
      page,
      perPage: PAGE_SIZE,
      roles: ["admin", "manager", "bracketManager"],
    });

    const currentUser = data?.data?.currentUser;
    const nodes = currentUser?.tournaments?.nodes ?? [];

    if (!currentUserId) currentUserId = String(currentUser?.id || "");
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

  return Array.from(new Map(managerOnly.map((t) => [String(t.id), t])).values());
}
