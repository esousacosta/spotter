import { auth } from "@/auth";
import { createTrade } from "@/lib/server/trade-journal-service";
import { z } from "zod";

const createTradeSchema = z.object({
  symbol: z.string().min(1),
  strategy: z.string().min(1),
  openedAt: z.string().datetime().transform((s) => new Date(s)),
  quantity: z.number().int().refine((v) => v !== 0, "Quantity must not be zero"),
  contractMultiplier: z.number().int().positive().default(100),
  entryNetDebit: z.number().positive(),
  entryCommissions: z.number().nonnegative().default(0),
  edgeAtEntry: z.number().optional(),
  forwardVolAtEntry: z.number().optional(),
  ivShortAtEntry: z.number().optional(),
  ivLongAtEntry: z.number().optional(),
  shortDteAtEntry: z.number().optional(),
  longDteAtEntry: z.number().optional(),
  nextEarningsDateAtEntry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  tradeClassAtEntry: z.enum(["standard", "earnings-exposed"]).optional(),
  quoteTimeAtEntry: z.string().datetime().transform((s) => new Date(s)).optional(),
  notes: z.string().optional(),
  legs: z.array(
    z.object({
      side: z.enum(["buy", "sell"]),
      optionType: z.enum(["call", "put"]),
      quantity: z.number().int().positive(),
      strike: z.number().positive(),
      expirationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      entryPrice: z.number().nonnegative(),
      entryCommission: z.number().nonnegative().default(0),
      entryIv: z.number().optional(),
      openInterestAtEntry: z.number().int().optional(),
    })
  ).min(1),
});

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = await request.json();
    const parsed = createTradeSchema.safeParse(payload);

    if (!parsed.success) {
      return Response.json({ error: parsed.error.issues }, { status: 400 });
    }

    const trade = await createTrade({
      userId: session.user.id,
      ...parsed.data,
    });

    return Response.json(trade, { status: 201 });
  } catch (error) {
    console.error("Error creating trade:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
