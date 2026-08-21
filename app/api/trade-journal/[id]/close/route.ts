import { auth } from "@/auth";
import { closeTrade } from "@/lib/server/trade-journal-service";
import { z } from "zod";

const closeTradeSchema = z.object({
  closedAt: z.string().datetime().transform((s) => new Date(s)),
  exitNetCredit: z.number().nonnegative(),
  exitCommissions: z.number().nonnegative().default(0),
  legs: z.array(
    z.object({
      legId: z.string(),
      exitPrice: z.number().nonnegative(),
      exitCommission: z.number().nonnegative().default(0),
      exitIv: z.number().optional(),
    })
  ).min(1),
});

export async function POST(
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
    const parsed = closeTradeSchema.safeParse(payload);

    if (!parsed.success) {
      return Response.json({ error: parsed.error.issues }, { status: 400 });
    }

    const trade = await closeTrade(id, session.user.id, parsed.data);
    return Response.json(trade);
  } catch (error: any) {
    if (error?.message?.includes("Trade not found")) {
      return Response.json({ error: "Trade not found" }, { status: 404 });
    }
    if (error?.message?.includes("Cannot close")) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    console.error("Error closing trade:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
