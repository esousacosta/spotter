import { NextResponse } from "next/server";

import { clearAppCache } from "@/lib/server/cache";
import { clearPreEarningsScanCache } from "@/lib/server/pre-earnings-scan-service";

export async function DELETE() {
  const cacheStats = await clearAppCache();
  await clearPreEarningsScanCache();
  return NextResponse.json({
    ok: true,
    ...cacheStats,
  });
}
