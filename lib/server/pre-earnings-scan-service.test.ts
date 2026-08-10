import fs from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const cboeProvider = {
    getOptionSnapshot: vi.fn(),
    getOptionChainCalls: vi.fn(),
    getOptionChainPuts: vi.fn(),
  };
  const ibkrProvider = {
    getOptionSnapshot: vi.fn(),
    getOptionChainCalls: vi.fn(),
    getOptionChainPuts: vi.fn(),
  };

  return {
    cacheDir: `/tmp/forward-vol-scan-test-${process.pid}`,
    source: "cboe" as "cboe" | "ibkr",
    cboeProvider,
    ibkrProvider,
    computePreEarningsRow: vi.fn(),
  };
});

vi.mock("@/lib/server/cache", () => ({
  getCacheDirectoryPath: () => mocks.cacheDir,
}));

vi.mock("@/lib/server/earnings-provider", () => ({
  getNextEarningsForSymbols: vi.fn(async () => new Map()),
}));

vi.mock("@/lib/server/market-data-provider", () => ({
  marketDataProvider: {
    getSP500Tickers: vi.fn(async () => [{ symbol: "TEST", name: "Test Corp" }]),
  },
  resolveOptionDataSource: vi.fn(async () => ({
    source: mocks.source,
    provider: mocks.source === "ibkr" ? mocks.ibkrProvider : mocks.cboeProvider,
  })),
}));

vi.mock("@/lib/server/pre-earnings-service", () => ({
  computePreEarningsRow: mocks.computePreEarningsRow,
}));

import {
  clearPreEarningsScanCache,
  getPreEarningsScan,
} from "./pre-earnings-scan-service";

function viableResult(quoteTime: string) {
  return {
    outcome: "viable" as const,
    row: {
      symbol: "TEST",
      companyName: "Test Corp",
      nextEarningsDate: null,
      earningsSession: null,
      underlyingPrice: 100,
      expectedMove: "5.00%",
      avgVolume30: 2_000_000,
      iv30Rv30: 1.5,
      tsSlope0To45: -0.01,
      avgVolumePass: true,
      iv30Rv30Pass: true,
      tsSlopePass: true,
      verdict: "recommended" as const,
      isViable: true,
      notes: "Recommended",
      quoteTime,
      isStale: false,
    },
  };
}

async function waitForCompletedScan() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await getPreEarningsScan({ scanLimit: 1 });
    if (result.isComplete) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Scan did not complete.");
}

describe("pre-earnings scan quote-source transitions", () => {
  afterEach(async () => {
    await clearPreEarningsScanCache();
    fs.rmSync(mocks.cacheDir, { recursive: true, force: true });
    mocks.source = "cboe";
    mocks.computePreEarningsRow.mockReset();
  });

  it("does not reuse delayed scan rows after IBKR becomes live", async () => {
    mocks.computePreEarningsRow.mockImplementation(
      async (_ticker, _earnings, _now, provider) =>
        viableResult(
          provider === mocks.ibkrProvider
            ? "2026-08-10T17:30:00.000Z"
            : "2026-08-10T09:30:00.000Z",
        ),
    );

    await getPreEarningsScan({ scanLimit: 1 });
    const delayed = await waitForCompletedScan();
    expect(delayed.rows[0]?.quoteTime).toBe("2026-08-10T09:30:00.000Z");

    mocks.source = "ibkr";
    const switching = await getPreEarningsScan({ scanLimit: 1 });
    expect(switching.isWarming).toBe(true);
    expect(switching.rows).toEqual([]);

    const live = await waitForCompletedScan();
    expect(live.rows[0]?.quoteTime).toBe("2026-08-10T17:30:00.000Z");
  });
});
