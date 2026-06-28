const GRAPHQL_URL = "https://api.start.gg/gql/alpha";
const PAGE_SIZE = 10;

export const MAX_SESSION_TOURNAMENTS = 100;

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

export type ManagedTournament = {
  id: string;
  name?: string;
  slug?: string;
  startAt?: number | null;
  city?: string | null;
  addrState?: string | null;
  countryCode?: string | null;
};

function toStartAtNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function sortManagedTournamentsByRecency<T extends { id: string; startAt?: number | null }>(tournaments: T[]): T[] {
  return [...tournaments].sort((a, b) => {
    const byStartAt = toStartAtNumber(b.startAt) - toStartAtNumber(a.startAt);
    if (byStartAt !== 0) return byStartAt;
    return String(b.id).localeCompare(String(a.id));
  });
}

export function buildRollingTournamentIds(managedTournaments: ManagedTournament[], limit = MAX_SESSION_TOURNAMENTS): string[] {
  const unique = Array.from(new Map(managedTournaments.map((t) => [String(t.id), String(t.id)])).values());
  return unique.slice(0, limit);
}

export function buildSessionTournamentIds(
  managedTournaments: ManagedTournament[],
  options?: { limit?: number; pinnedTournamentId?: string },
): { allowedTournamentIds: string[]; pinnedTournamentId?: string } {
  const limit = options?.limit ?? MAX_SESSION_TOURNAMENTS;
  const pinnedTournamentId = options?.pinnedTournamentId ? String(options.pinnedTournamentId) : undefined;
  const sorted = sortManagedTournamentsByRecency(managedTournaments);
  const rolling = buildRollingTournamentIds(sorted, limit);

  if (!pinnedTournamentId) {
    return { allowedTournamentIds: rolling };
  }

  const exists = sorted.some((t) => String(t.id) === pinnedTournamentId);
  if (!exists) {
    return { allowedTournamentIds: rolling };
  }

  if (rolling.includes(pinnedTournamentId)) {
    return { allowedTournamentIds: rolling, pinnedTournamentId };
  }

  const withoutPinned = rolling.filter((id) => id !== pinnedTournamentId).slice(0, Math.max(0, limit - 1));
  return { allowedTournamentIds: [pinnedTournamentId, ...withoutPinned], pinnedTournamentId };
}

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
  const tournaments = await fetchManagedTournaments(accessToken);
  return tournaments.map((t) => String(t.id));
}

export async function fetchManagedTournaments(accessToken: string): Promise<ManagedTournament[]> {
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
      id: String(tournament.id),
      name: tournament.name,
      slug: tournament.slug,
      startAt: toStartAtNumber(tournament.startAt),
      city: tournament.city,
      addrState: tournament.addrState,
      countryCode: tournament.countryCode,
    }));

  const deduped = Array.from(new Map(managerOnly.map((t) => [String(t.id), t])).values());
  return sortManagedTournamentsByRecency(deduped);
}
