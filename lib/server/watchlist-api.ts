import { auth } from "@/auth";
import { isAuthenticationEnabled } from "@/lib/server/auth-settings";
import { getDatabase } from "@/lib/server/db/client";
import { createWatchlistStore, WatchlistLimitError } from "@/lib/server/watchlist-store";

export async function authenticatedWatchlistStore() {
  if (!isAuthenticationEnabled()) {
    return { response: Response.json({ error: "Authentication is not enabled." }, { status: 404 }) };
  }

  const session = await auth();
  if (!session?.user?.id) {
    return { response: Response.json({ error: "Authentication required." }, { status: 401 }) };
  }

  return {
    store: createWatchlistStore(getDatabase()),
    userId: session.user.id,
  };
}

export function watchlistErrorResponse(error: unknown): Response | null {
  if (error instanceof WatchlistLimitError) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  return null;
}

export async function readJsonBody(request: Request): Promise<
  | { body: unknown }
  | {
      response: Response;
    }
> {
  try {
    return { body: await request.json() };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { response: Response.json({ error: "Invalid JSON body." }, { status: 400 }) };
    }
    throw error;
  }
}
