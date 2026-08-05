import { authenticatedWatchlistStore } from "@/lib/server/watchlist-api";
import { watchlistSymbolSchema } from "@/lib/watchlist-symbol";

export const runtime = "nodejs";

export async function DELETE(_request: Request, { params }: { params: Promise<{ symbol: string }> }) {
  const context = await authenticatedWatchlistStore();
  if ("response" in context) {
    return context.response;
  }

  const parsed = watchlistSymbolSchema.safeParse((await params).symbol);
  if (!parsed.success) {
    return Response.json({ error: "Enter a valid ticker symbol of up to 10 characters." }, { status: 400 });
  }

  return Response.json({ symbols: await context.store.remove(context.userId, parsed.data) });
}
