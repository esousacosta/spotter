import { auth } from "@/auth";
import { getTradeById, listTrades, updateTrade } from "@/lib/server/trade-journal-service";
import { z } from "zod";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    const trade = await getTradeById(id, session.user.id);
    if (!trade) {
      return Response.json({ error: "Trade not found" }, { status: 404 });
    }

    return Response.json(trade);
  } catch (error) {
    console.error("Error fetching trade:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

const updateTradeSchema = z.object({
  notes: z.string().optional(),
  entryCommissions: z.number().nonnegative().optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    const payload = await request.json();
    const parsed = updateTradeSchema.safeParse(payload);

    if (!parsed.success) {
      return Response.json({ error: parsed.error.issues }, { status: 400 });
    }

    const trade = await updateTrade(id, session.user.id, parsed.data);
    return Response.json(trade);
  } catch (error: any) {
    if (error?.message?.includes("Trade not found")) {
      return Response.json({ error: "Trade not found" }, { status: 404 });
    }
    if (error?.message?.includes("Cannot update")) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    console.error("Error updating trade:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
