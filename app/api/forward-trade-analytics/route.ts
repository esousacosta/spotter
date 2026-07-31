import { NextResponse } from "next/server";
import { z } from "zod";

import {
  ForwardTradeAnalyticsError,
  getForwardTradeAnalytics,
} from "@/lib/server/forward-trade-analytics-service";
import type { ForwardTradeAnalyticsRequest, ForwardTradeAnalyticsResponse } from "@/lib/types";

const requestSchema = z
  .object({
    symbol: z.string().min(1).max(10),
    shortExpiry: z.iso.date(),
    longExpiry: z.iso.date(),
    strike: z.number().positive(),
    asOf: z.iso.datetime().optional(),
    maxMovePct: z.number().min(0.05).max(0.8).optional(),
    steps: z.number().int().min(11).max(101).optional(),
    valuationDateMode: z.enum(["shortExpiry", "custom"]).optional(),
    valuationDate: z.iso.datetime().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.valuationDateMode === "custom" && !value.valuationDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["valuationDate"],
        message: "valuationDate is required when valuationDateMode=custom.",
      });
    }
  });

export async function POST(request: Request) {
  let payload: ForwardTradeAnalyticsRequest;
  try {
    payload = requestSchema.parse(await request.json());
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid request body for forward trade analytics endpoint.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const rowKey = `${payload.symbol}|${payload.shortExpiry}|${payload.longExpiry}|${payload.strike}`;
  try {
    const response: ForwardTradeAnalyticsResponse = await getForwardTradeAnalytics(payload);
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof ForwardTradeAnalyticsError) {
      if (error.status >= 500) {
        console.error(`[forward-trade-analytics] ${rowKey}: ${error.message}`);
      }
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message =
      error instanceof Error ? error.message : "Unexpected error while computing forward-trade analytics.";
    console.error(`[forward-trade-analytics] ${rowKey}: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
