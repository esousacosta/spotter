import { auth } from "@/auth";
import { listTrades } from "@/lib/server/trade-journal-service";
import { z } from "zod";

const listTradesSchema = z.object({
  status: z.enum(["open", "closed", "cancelled"]).optional(),
  symbol: z.string().optional(),
  startDate: z.string().datetime().transform((s) => new Date(s)).optional(),
  endDate: z.string().datetime().transform((s) => new Date(s)).optional(),
  limit: z.number().int().positive().max(100).default(50),
  offset: z.number().int().nonnegative().default(0),
});

export async function GET(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const queryParams = {
      status: (url.searchParams.get("status") as "open" | "closed" | "cancelled" | null) || undefined,
      symbol: url.searchParams.get("symbol") || undefined,
      startDate: url.searchParams.get("startDate") || undefined,
      endDate: url.searchParams.get("endDate") || undefined,
      limit: url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!) : undefined,
      offset: url.searchParams.get("offset") ? parseInt(url.searchParams.get("offset")!) : undefined,
    };

    const parsed = listTradesSchema.safeParse(queryParams);

    if (!parsed.success) {
      return Response.json({ error: parsed.error.issues }, { status: 400 });
    }

    const trades = await listTrades(session.user.id, parsed.data);
    return Response.json(trades);
  } catch (error) {
    console.error("Error listing trades:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
