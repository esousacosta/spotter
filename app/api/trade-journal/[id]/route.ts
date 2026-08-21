import { auth } from "@/auth";
import { deleteTrade, getTradeById, listTrades, updateTrade } from "@/lib/server/trade-journal-service";
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

const updateLegSchema = z.object({
  id: z.string().optional(),
  side: z.enum(["buy", "sell"]),
  optionType: z.enum(["call", "put"]),
  quantity: z.number().positive(),
  strike: z.number(),
  expirationDate: z.string(),
  entryPrice: z.number(),
  entryCommission: z.number().nonnegative().default(0),
  entryIv: z.number().optional(),
  openInterestAtEntry: z.number().optional(),
});

const updateTradeSchema = z.object({
  symbol: z.string().min(1).optional(),
  strategy: z.string().min(1).optional(),
  quantity: z.number().positive().optional(),
  contractMultiplier: z.number().positive().optional(),
  entryNetDebit: z.number().optional(),
  entryCommissions: z.number().nonnegative().optional(),
  edgeAtEntry: z.number().optional(),
  notes: z.string().optional(),
  legs: z.array(updateLegSchema).min(1).optional(),
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

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    await deleteTrade(id, session.user.id);
    return Response.json({ success: true });
  } catch (error: any) {
    if (error?.message?.includes("Trade not found")) {
      return Response.json({ error: "Trade not found" }, { status: 404 });
    }
    console.error("Error deleting trade:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
