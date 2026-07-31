import { NextResponse } from "next/server";
import { z } from "zod";

import { clearPreEarningsScanCache, getPreEarningsScan } from "@/lib/server/pre-earnings-scan-service";

const requestSchema = z.object({
  topN: z.number().int().positive().optional(),
  scanLimit: z.number().int().positive().max(500).optional(),
});

export async function POST(request: Request) {
  let payload: z.infer<typeof requestSchema>;
  try {
    payload = requestSchema.parse(await request.json());
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Invalid request body for pre-earnings viable endpoint.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const response = await getPreEarningsScan({
      topN: payload.topN,
      scanLimit: payload.scanLimit,
    });
    return NextResponse.json(response);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unexpected error while computing pre-earnings viable trades.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE() {
  await clearPreEarningsScanCache();
  return NextResponse.json({ ok: true });
}
