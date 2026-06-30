import { createHash } from "crypto";

const GRAPHQL_URL = "https://api.start.gg/gql/alpha";
const PAGE_SIZE = 10;
const TOURNAMENT_CACHE_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT_CACHE_TTL_MS = 60 * 1000;
const MAX_GRAPHQL_RETRIES = 2;

export const MAX_SESSION_TOURNAMENTS = 100;

const VIEWER_QUERY = `query Viewer { currentUser { id slug name player { gamerTag } } }`;

const MANAGED_TOURNAMENTS_QUERY = `
  query ManagedTournaments($page: Int!, $perPage: Int!) {
    currentUser {
      tournaments(query: { page: $page, perPage: $perPage }) {
        nodes {
          id
          name
          startAt
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

export class StartggRateLimitError extends Error {
  status = 429;
  retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = "StartggRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

type TournamentCacheEntry = {
  expiresAt: number;
  tournaments?: ManagedTournament[];
  pending?: Promise<ManagedTournament[]>;
  rateLimitedUntil?: number;
};

const managedTournamentCache = new Map<string, TournamentCacheEntry>();

export type ManagedTournament = {
  id: string;
  name?: string;
  startAt?: number | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryAfterSeconds(response: Response): number {
  const retryAfter = response.headers.get("retry-after");
  const parsed = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return Math.ceil(parsed);
  return 60;
}

function getCacheKey(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex");
}

function cloneTournaments(tournaments: ManagedTournament[]): ManagedTournament[] {
  return tournaments.map((tournament) => ({ ...tournament }));
}

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
  let lastRateLimitRetryAfterSeconds = 60;

  for (let attempt = 0; attempt <= MAX_GRAPHQL_RETRIES; attempt += 1) {
    const response = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (response.status === 429) {
      lastRateLimitRetryAfterSeconds = getRetryAfterSeconds(response);
      if (attempt < MAX_GRAPHQL_RETRIES) {
        await sleep(Math.min(lastRateLimitRetryAfterSeconds * 1000, 2000 * (attempt + 1)));
        continue;
      }
      throw new StartggRateLimitError(
        `start.gg API のレートリミットに達しました。${lastRateLimitRetryAfterSeconds}秒ほど待ってから再取得してください。`,
        lastRateLimitRetryAfterSeconds,
      );
    }

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

  throw new StartggRateLimitError(
    `start.gg API のレートリミットに達しました。${lastRateLimitRetryAfterSeconds}秒ほど待ってから再取得してください。`,
    lastRateLimitRetryAfterSeconds,
  );
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

async function fetchManagedTournamentsUncached(accessToken: string): Promise<ManagedTournament[]> {
  let page = 1;
  const allNodes: any[] = [];
  while (true) {
    const data = await requestGraphql(accessToken, MANAGED_TOURNAMENTS_QUERY, {
      page,
      perPage: PAGE_SIZE,
    });

    const nodes = data?.data?.currentUser?.tournaments?.nodes ?? [];

    allNodes.push(...nodes);
    if (nodes.length < PAGE_SIZE) break;
    page += 1;
  }

  const tournaments = allNodes.map((tournament) => ({
    id: String(tournament.id),
    name: tournament.name,
    startAt: toStartAtNumber(tournament.startAt),
  }));

  const deduped = Array.from(new Map(tournaments.map((t) => [String(t.id), t])).values());
  return sortManagedTournamentsByRecency(deduped);
}

export async function fetchManagedTournaments(accessToken: string): Promise<ManagedTournament[]> {
  const cacheKey = getCacheKey(accessToken);
  const now = Date.now();
  const cached = managedTournamentCache.get(cacheKey);

  if (cached?.tournaments && cached.expiresAt > now) {
    return cloneTournaments(cached.tournaments);
  }

  if (cached?.rateLimitedUntil && cached.rateLimitedUntil > now) {
    const retryAfterSeconds = Math.ceil((cached.rateLimitedUntil - now) / 1000);
    throw new StartggRateLimitError(
      `start.gg API のレートリミットに達しました。${retryAfterSeconds}秒ほど待ってから再取得してください。`,
      retryAfterSeconds,
    );
  }

  if (cached?.pending) {
    return cloneTournaments(await cached.pending);
  }

  const pending = fetchManagedTournamentsUncached(accessToken)
    .then((tournaments) => {
      managedTournamentCache.set(cacheKey, {
        expiresAt: Date.now() + TOURNAMENT_CACHE_TTL_MS,
        tournaments: cloneTournaments(tournaments),
      });
      return tournaments;
    })
    .catch((error) => {
      if (error instanceof StartggRateLimitError) {
        managedTournamentCache.set(cacheKey, {
          expiresAt: Date.now() + RATE_LIMIT_CACHE_TTL_MS,
          rateLimitedUntil: Date.now() + error.retryAfterSeconds * 1000,
        });
      } else {
        managedTournamentCache.delete(cacheKey);
      }
      throw error;
    });

  managedTournamentCache.set(cacheKey, { expiresAt: now + TOURNAMENT_CACHE_TTL_MS, pending });
  return cloneTournaments(await pending);
}
