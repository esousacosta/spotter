import { authenticatedWatchlistStore, readJsonBody, watchlistErrorResponse } from "@/lib/server/watchlist-api";
import { watchlistSymbolSchema, watchlistSymbolsSchema } from "@/lib/watchlist-symbol";

export const runtime = "nodejs";

export async function GET() {
  const context = await authenticatedWatchlistStore();
  if ("response" in context) {
    return context.response;
  }

  return Response.json({ symbols: await context.store.list(context.userId) });
}

export async function POST(request: Request) {
  const context = await authenticatedWatchlistStore();
  if ("response" in context) {
    return context.response;
  }

  const bodyResult = await readJsonBody(request);
  if ("response" in bodyResult) {
    return bodyResult.response;
  }

  const parsed = watchlistSymbolSchema.safeParse(
    typeof bodyResult.body === "object" && bodyResult.body !== null && "symbol" in bodyResult.body
      ? bodyResult.body.symbol
      : undefined,
  );
  if (!parsed.success) {
    return Response.json({ error: "Enter a valid ticker symbol of up to 10 characters." }, { status: 400 });
  }

  try {
    return Response.json({ symbols: await context.store.add(context.userId, parsed.data) });
  } catch (error) {
    const response = watchlistErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }
}

export async function PUT(request: Request) {
  const context = await authenticatedWatchlistStore();
  if ("response" in context) {
    return context.response;
  }

  const bodyResult = await readJsonBody(request);
  if ("response" in bodyResult) {
    return bodyResult.response;
  }

  const parsed = watchlistSymbolsSchema.safeParse(
    typeof bodyResult.body === "object" && bodyResult.body !== null && "symbols" in bodyResult.body
      ? bodyResult.body.symbols
      : undefined,
  );
  if (!parsed.success) {
    return Response.json({ error: "Provide no more than 30 valid ticker symbols." }, { status: 400 });
  }

  try {
    return Response.json({ symbols: await context.store.replace(context.userId, parsed.data) });
  } catch (error) {
    const response = watchlistErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }
}
