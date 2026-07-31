"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import type {
  ForwardVolResponse,
  PreEarningsRejectedRow,
  PreEarningsRow,
  RankedForwardVolRow,
  Ticker,
  UpcomingEarningsRow,
  UpcomingEarningsResponse,
  TopForwardVolResponse,
  TopPreEarningsResponse,
} from "@/lib/types";

const DEFAULT_SYMBOL = "AAPL";
const UI_REQUEST_TIMEOUT_MS = 30_000;

function asPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "—";
  }
  return `${(value * 100).toFixed(2)}%`;
}

function asNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "—";
  }
  return value.toFixed(2);
}

function asInteger(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "—";
  }
  return Math.round(value).toString();
}

function verdictClass(row: PreEarningsRow): string {
  if (row.verdict === "recommended") {
    return "row-viable";
  }
  if (row.verdict === "consider") {
    return "row-not-viable";
  }
  return "row-invalid";
}

export function SpotterApp() {
  const [activeTab, setActiveTab] = useState<"forward" | "preearnings" | "upcomingearnings">("forward");
  const [preEarningsSubtab, setPreEarningsSubtab] = useState<"viable" | "rejected">("viable");
  const [tickers, setTickers] = useState<Ticker[]>([]);
  const [symbol, setSymbol] = useState<string>(DEFAULT_SYMBOL);
  const [data, setData] = useState<ForwardVolResponse | null>(null);
  const [topRows, setTopRows] = useState<RankedForwardVolRow[]>([]);
  const [topScanMeta, setTopScanMeta] = useState<{
    scannedSymbols: number;
    processedSymbols: number;
    successfulSymbols: number;
    isComplete: boolean;
    isWarming: boolean;
  } | null>(null);
  const [preRows, setPreRows] = useState<PreEarningsRow[]>([]);
  const [preRejectedRows, setPreRejectedRows] = useState<PreEarningsRejectedRow[]>([]);
  const [upcomingRows, setUpcomingRows] = useState<UpcomingEarningsRow[]>([]);
  const [preMeta, setPreMeta] = useState<{
    scannedSymbols: number;
    evaluatedSymbols: number;
    computedSymbols: number;
    viableSymbols: number;
    rejectedSymbols: number;
    isComplete: boolean;
    isWarming: boolean;
  } | null>(null);
  const [upcomingMeta, setUpcomingMeta] = useState<{
    daysAhead: number;
    totalRows: number;
  } | null>(null);
  const [tickersLoading, setTickersLoading] = useState(false);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [topRowsLoading, setTopRowsLoading] = useState(false);
  const [preRowsLoading, setPreRowsLoading] = useState(false);
  const [upcomingRowsLoading, setUpcomingRowsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [topError, setTopError] = useState<string | null>(null);
  const [preError, setPreError] = useState<string | null>(null);
  const [upcomingError, setUpcomingError] = useState<string | null>(null);
  const preRefreshInFlight = useRef(false);
  const topRefreshInFlight = useRef(false);

  useEffect(() => {
    async function loadTickers() {
      setTickersLoading(true);
      setError(null);

      try {
        const response = await fetchWithTimeout("/api/tickers", {}, UI_REQUEST_TIMEOUT_MS);
        if (!response.ok) {
          throw new Error(`Ticker request failed (${response.status}).`);
        }

        const payload = (await response.json()) as Ticker[];
        setTickers(payload);
        setSymbol((current) => {
          if (payload.length === 0) {
            return current;
          }

          return payload.some((ticker) => ticker.symbol === current) ? current : payload[0].symbol;
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to load tickers.";
        setError(message);
      } finally {
        setTickersLoading(false);
      }
    }

    void loadTickers();
  }, []);

  useEffect(() => {
    if (!symbol) {
      return;
    }

    async function loadForwardVol() {
      setRowsLoading(true);
      setError(null);

      try {
        const response = await fetchWithTimeout("/api/forward-vol", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol }),
        }, UI_REQUEST_TIMEOUT_MS);

        const payload = (await response.json()) as ForwardVolResponse | { error: string };
        if (!response.ok || "error" in payload) {
          const message = "error" in payload ? payload.error : "Forward volatility request failed.";
          throw new Error(message);
        }

        setData(payload);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to load forward volatility.";
        setError(message);
        setData(null);
      } finally {
        setRowsLoading(false);
      }
    }

    void loadForwardVol();
  }, [symbol]);

  useEffect(() => {
    if (activeTab !== "forward" || !topScanMeta?.isWarming) {
      return;
    }

    const interval = window.setInterval(() => {
      if (topRefreshInFlight.current) {
        return;
      }
      topRefreshInFlight.current = true;
      void loadTopRows(true).finally(() => {
        topRefreshInFlight.current = false;
      });
    }, 2500);

    return () => window.clearInterval(interval);
  }, [activeTab, topScanMeta?.isWarming]);

  useEffect(() => {
    if (activeTab !== "preearnings" || !preMeta?.isWarming) {
      return;
    }

    const interval = window.setInterval(() => {
      if (preRefreshInFlight.current) {
        return;
      }
      preRefreshInFlight.current = true;
      void loadPreEarningsRows(true).finally(() => {
        preRefreshInFlight.current = false;
      });
    }, 2500);

    return () => window.clearInterval(interval);
  }, [activeTab, preMeta?.isWarming]);

  const hasRows = useMemo(() => (data?.rows.length ?? 0) > 0, [data?.rows.length]);
  const hasTopRows = useMemo(() => topRows.length > 0, [topRows.length]);
  const hasPreRows = useMemo(() => preRows.length > 0, [preRows.length]);
  const hasPreRejectedRows = useMemo(() => preRejectedRows.length > 0, [preRejectedRows.length]);
  const hasUpcomingRows = useMemo(() => upcomingRows.length > 0, [upcomingRows.length]);

  async function loadTopRows(silent = false) {
    if (!silent) {
      setTopRowsLoading(true);
      setTopError(null);
    }

    try {
      const response = await fetchWithTimeout("/api/top-forward-vol", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }, UI_REQUEST_TIMEOUT_MS);

      const payload = (await response.json()) as TopForwardVolResponse | { error: string };
      if (!response.ok || "error" in payload) {
        const message = "error" in payload ? payload.error : "Top-forward-vol request failed.";
        throw new Error(message);
      }

      setTopRows(payload.rows);
      setTopScanMeta({
        scannedSymbols: payload.scannedSymbols,
        processedSymbols: payload.processedSymbols,
        successfulSymbols: payload.successfulSymbols,
        isComplete: payload.isComplete,
        isWarming: payload.isWarming,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load top opportunities.";
      setTopError(message);
      if (!silent) {
        setTopRows([]);
        setTopScanMeta(null);
      }
    } finally {
      if (!silent) {
        setTopRowsLoading(false);
      }
    }
  }

  async function loadPreEarningsRows(silent = false) {
    if (!silent) {
      setPreRowsLoading(true);
      setPreError(null);
    }

    try {
      const response = await fetchWithTimeout("/api/pre-earnings-viable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }, UI_REQUEST_TIMEOUT_MS);

      const payload = (await response.json()) as TopPreEarningsResponse | { error: string };
      if (!response.ok || "error" in payload) {
        const message = "error" in payload ? payload.error : "Pre-earnings request failed.";
        throw new Error(message);
      }

      setPreRows(payload.rows);
      setPreRejectedRows(payload.rejectedRows);
      setPreMeta({
        scannedSymbols: payload.scannedSymbols,
        evaluatedSymbols: payload.evaluatedSymbols,
        computedSymbols: payload.computedSymbols,
        viableSymbols: payload.viableSymbols,
        rejectedSymbols: payload.rejectedSymbols,
        isComplete: payload.isComplete,
        isWarming: payload.isWarming,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load pre-earnings trades.";
      setPreError(message);
      setPreRows([]);
      setPreRejectedRows([]);
      setPreMeta(null);
    } finally {
      if (!silent) {
        setPreRowsLoading(false);
      }
    }
  }

  async function loadUpcomingEarningsRows() {
    setUpcomingRowsLoading(true);
    setUpcomingError(null);

    try {
      const response = await fetchWithTimeout("/api/upcoming-earnings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daysAhead: 21, limit: 500 }),
      }, UI_REQUEST_TIMEOUT_MS);

      const payload = (await response.json()) as UpcomingEarningsResponse | { error: string };
      if (!response.ok || "error" in payload) {
        const message = "error" in payload ? payload.error : "Upcoming earnings request failed.";
        throw new Error(message);
      }

      setUpcomingRows(payload.rows);
      setUpcomingMeta({
        daysAhead: payload.daysAhead,
        totalRows: payload.totalRows,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load upcoming earnings.";
      setUpcomingError(message);
      setUpcomingRows([]);
      setUpcomingMeta(null);
    } finally {
      setUpcomingRowsLoading(false);
    }
  }

  return (
    <main className="container">
      <h1>Forward Volatility Spotter</h1>
      <p className="muted">Scan calendar opportunities and pre-earnings setups from one place.</p>

      <section className="tabs">
        <button
          type="button"
          className={activeTab === "forward" ? "tab-active" : ""}
          onClick={() => setActiveTab("forward")}
        >
          Forward-vol trades
        </button>
        <button
          type="button"
          className={activeTab === "preearnings" ? "tab-active" : ""}
          onClick={() => setActiveTab("preearnings")}
        >
          Pre-earnings viable trades
        </button>
        <button
          type="button"
          className={activeTab === "upcomingearnings" ? "tab-active" : ""}
          onClick={() => setActiveTab("upcomingearnings")}
        >
          Upcoming announced earnings
        </button>
      </section>

      {activeTab === "forward" ? (
        <>
          <section className="controls">
            <label htmlFor="ticker-select">S&P 500 ticker</label>
            <select
              id="ticker-select"
              value={symbol}
              onChange={(event) => setSymbol(event.target.value)}
              disabled={tickersLoading}
            >
              {tickers.length === 0 ? (
                <option value="">{tickersLoading ? "Loading tickers..." : "No tickers available"}</option>
              ) : (
                tickers.map((ticker) => (
                  <option key={ticker.symbol} value={ticker.symbol}>
                    {ticker.symbol} — {ticker.name}
                  </option>
                ))
              )}
            </select>
            <button type="button" onClick={() => void loadTopRows()} disabled={topRowsLoading}>
              {topRowsLoading ? "Scanning S&P 500..." : "Find all opportunities"}
            </button>
          </section>

          {error ? <p className="error">{error}</p> : null}
          {rowsLoading ? <p className="muted">Calculating forward volatility edge...</p> : null}
          {topRowsLoading ? <p className="muted">Scanning symbols to find top edges...</p> : null}
          {!topRowsLoading && topScanMeta?.isWarming ? (
            <p className="muted">Top-opportunities scan in progress... refreshing as new symbols complete.</p>
          ) : null}
          {topError ? <p className="error">{topError}</p> : null}
          {!rowsLoading && !hasRows ? <p className="muted">No results available for this symbol.</p> : null}

          {data && hasRows ? (
            <section className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Pair (target)</th>
                    <th>Trade Class</th>
                    <th>Actual DTEs</th>
                    <th>Next Earnings</th>
                    <th>Strike (ATM)</th>
                    <th>Short IV</th>
                    <th>Long IV</th>
                    <th>Short OI</th>
                    <th>Long OI</th>
                    <th>Forward Vol</th>
                    <th>Raw Edge</th>
                    <th>Adj Edge</th>
                    <th>Viable?</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => {
                    const rowClass =
                      row.status === "invalid"
                        ? "row-invalid"
                        : row.isViable
                          ? "row-viable"
                          : "row-not-viable";

                    return (
                      <tr key={`${row.shortTargetDte}-${row.longTargetDte}`} className={rowClass}>
                        <td>
                          {row.shortTargetDte}/{row.longTargetDte}
                        </td>
                        <td>{row.tradeClass ?? "—"}</td>
                        <td>
                          {asNumber(row.shortDteActual)} / {asNumber(row.longDteActual)}
                        </td>
                        <td>{row.nextEarningsDate ?? "—"}</td>
                        <td>{asNumber(row.selectedStrike)}</td>
                        <td>{asPct(row.ivShort)}</td>
                        <td>{asPct(row.ivLong)}</td>
                        <td>{asInteger(row.shortOpenInterest)}</td>
                        <td>{asInteger(row.longOpenInterest)}</td>
                        <td>{asPct(row.forwardVol)}</td>
                        <td>{asPct(row.rawForwardVolEdge)}</td>
                        <td>{asPct(row.adjustedForwardVolEdge)}</td>
                        <td className="viability-cell">{row.isViable ? "Yes" : "No"}</td>
                        <td>{row.notes}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          ) : null}

          {topScanMeta ? (
            <p className="muted">
              Scanned {topScanMeta.scannedSymbols} symbols, processed {topScanMeta.processedSymbols}, found valid
              opportunities for {topScanMeta.successfulSymbols}
              {topScanMeta.isComplete ? "." : " so far."}
            </p>
          ) : null}

          {hasTopRows ? (
            <section className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Company</th>
                    <th>Pair (target)</th>
                    <th>Trade Class</th>
                    <th>Actual DTEs</th>
                    <th>Next Earnings</th>
                    <th>Strike (ATM)</th>
                    <th>Short IV</th>
                    <th>Long IV</th>
                    <th>Short OI</th>
                    <th>Long OI</th>
                    <th>Forward Vol</th>
                    <th>Raw Edge</th>
                    <th>Adj Edge</th>
                    <th>Viable?</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {topRows.map((row) => {
                    const rowClass =
                      row.status === "invalid"
                        ? "row-invalid"
                        : row.isViable
                          ? "row-viable"
                          : "row-not-viable";

                    return (
                      <tr key={`${row.symbol}-${row.shortTargetDte}-${row.longTargetDte}`} className={rowClass}>
                        <td>{row.symbol}</td>
                        <td>{row.companyName}</td>
                        <td>
                          {row.shortTargetDte}/{row.longTargetDte}
                        </td>
                        <td>{row.tradeClass ?? "—"}</td>
                        <td>
                          {asNumber(row.shortDteActual)} / {asNumber(row.longDteActual)}
                        </td>
                        <td>{row.nextEarningsDate ?? "—"}</td>
                        <td>{asNumber(row.selectedStrike)}</td>
                        <td>{asPct(row.ivShort)}</td>
                        <td>{asPct(row.ivLong)}</td>
                        <td>{asInteger(row.shortOpenInterest)}</td>
                        <td>{asInteger(row.longOpenInterest)}</td>
                        <td>{asPct(row.forwardVol)}</td>
                        <td>{asPct(row.rawForwardVolEdge)}</td>
                        <td>{asPct(row.adjustedForwardVolEdge)}</td>
                        <td className="viability-cell">{row.isViable ? "Yes" : "No"}</td>
                        <td>{row.notes}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          ) : null}
        </>
      ) : activeTab === "preearnings" ? (
        <>
          <section className="controls">
            <button type="button" onClick={() => void loadPreEarningsRows()} disabled={preRowsLoading}>
              {preRowsLoading ? "Scanning pre-earnings setups..." : "Find all pre-earnings viable trades"}
            </button>
          </section>

          {preRowsLoading ? <p className="muted">Evaluating pre-earnings viability checks...</p> : null}
          {!preRowsLoading && preMeta?.isWarming ? (
            <p className="muted">
              Background scan in progress... showing current cached results while more symbols are processed.
            </p>
          ) : null}
          {preError ? <p className="error">{preError}</p> : null}
          {!preRowsLoading && !preMeta ? (
            <p className="muted">No pre-earnings viable trades found yet. Run the scan.</p>
          ) : null}

          {preMeta ? (
            <p className="muted">
              Scanned {preMeta.scannedSymbols} symbols, attempted {preMeta.evaluatedSymbols}, computed{" "}
              {preMeta.computedSymbols}, viable {preMeta.viableSymbols}, rejected {preMeta.rejectedSymbols}
              {preMeta.isComplete ? "." : " so far."}
            </p>
          ) : null}

          <section className="tabs">
            <button
              type="button"
              className={preEarningsSubtab === "viable" ? "tab-active" : ""}
              onClick={() => setPreEarningsSubtab("viable")}
            >
              Viable trades
            </button>
            <button
              type="button"
              className={preEarningsSubtab === "rejected" ? "tab-active" : ""}
              onClick={() => setPreEarningsSubtab("rejected")}
            >
              Rejected tickers
            </button>
          </section>

          {preEarningsSubtab === "viable" && hasPreRows ? (
            <section className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Company</th>
                    <th>Next Earnings</th>
                    <th>Earnings Session</th>
                    <th>Verdict</th>
                    <th>Viable?</th>
                    <th>Avg Vol 30d</th>
                    <th>IV30/RV30</th>
                    <th>TS Slope 0→45</th>
                    <th>Avg Vol Check</th>
                    <th>IV30/RV30 Check</th>
                    <th>TS Slope Check</th>
                    <th>Expected Move</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {preRows.map((row) => (
                    <tr key={row.symbol} className={verdictClass(row)}>
                      <td>{row.symbol}</td>
                      <td>{row.companyName}</td>
                      <td>{row.nextEarningsDate ?? "—"}</td>
                      <td>{row.earningsSession ?? "—"}</td>
                      <td>{row.verdict}</td>
                      <td className="viability-cell">{row.isViable ? "Yes" : "No"}</td>
                      <td>{asInteger(row.avgVolume30)}</td>
                      <td>{asNumber(row.iv30Rv30)}</td>
                      <td>{asNumber(row.tsSlope0To45)}</td>
                      <td>{row.avgVolumePass ? "PASS" : "FAIL"}</td>
                      <td>{row.iv30Rv30Pass ? "PASS" : "FAIL"}</td>
                      <td>{row.tsSlopePass ? "PASS" : "FAIL"}</td>
                      <td>{row.expectedMove ?? "—"}</td>
                      <td>{row.notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}

          {preEarningsSubtab === "viable" && !preRowsLoading && !hasPreRows ? (
            <p className="muted">No viable pre-earnings trades found in the latest scan.</p>
          ) : null}

          {preEarningsSubtab === "rejected" && hasPreRejectedRows ? (
            <section className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Company</th>
                    <th>Next Earnings</th>
                    <th>Earnings Session</th>
                    <th>Category</th>
                    <th>Stage</th>
                    <th>Verdict</th>
                    <th>Computed?</th>
                    <th>Avg Vol 30d</th>
                    <th>IV30/RV30</th>
                    <th>TS Slope 0→45</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {preRejectedRows.map((row) => (
                    <tr key={`${row.symbol}-${row.rejectionStage}-${row.rejectionCategory}`} className="row-invalid">
                      <td>{row.symbol}</td>
                      <td>{row.companyName}</td>
                      <td>{row.nextEarningsDate ?? "—"}</td>
                      <td>{row.earningsSession ?? "—"}</td>
                      <td>{row.rejectionCategory}</td>
                      <td>{row.rejectionStage}</td>
                      <td>{row.verdict ?? "—"}</td>
                      <td className="viability-cell">{row.wasComputed ? "Yes" : "No"}</td>
                      <td>{asInteger(row.avgVolume30)}</td>
                      <td>{asNumber(row.iv30Rv30)}</td>
                      <td>{asNumber(row.tsSlope0To45)}</td>
                      <td>{row.rejectionReason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}

          {preEarningsSubtab === "rejected" && !preRowsLoading && !hasPreRejectedRows ? (
            <p className="muted">No rejected tickers are available yet. Run the scan.</p>
          ) : null}
        </>
      ) : (
        <>
          <section className="controls">
            <button type="button" onClick={() => void loadUpcomingEarningsRows()} disabled={upcomingRowsLoading}>
              {upcomingRowsLoading ? "Loading upcoming earnings..." : "Load upcoming announced earnings"}
            </button>
          </section>

          <p className="muted">
            Strategy timing: buy 15 minutes before close on earnings day, then sell 15 minutes after next-day open.
          </p>

          {upcomingRowsLoading ? <p className="muted">Fetching announced earnings calendar...</p> : null}
          {upcomingError ? <p className="error">{upcomingError}</p> : null}
          {!upcomingRowsLoading && !hasUpcomingRows ? (
            <p className="muted">No upcoming announced earnings found yet. Load the calendar.</p>
          ) : null}

          {upcomingMeta ? (
            <p className="muted">
              Showing {upcomingRows.length} rows from the next {upcomingMeta.daysAhead} days ({upcomingMeta.totalRows}{" "}
              total).
            </p>
          ) : null}

          {hasUpcomingRows ? (
            <section className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Company</th>
                    <th>Earnings Date</th>
                    <th>Earnings Session</th>
                    <th>Entry Timing</th>
                    <th>Exit Timing</th>
                  </tr>
                </thead>
                <tbody>
                  {upcomingRows.map((row) => (
                    <tr key={`${row.symbol}-${row.earningsDate}`}>
                      <td>{row.symbol}</td>
                      <td>{row.companyName}</td>
                      <td>{row.earningsDate}</td>
                      <td>{row.earningsSession ?? "—"}</td>
                      <td>{row.strategyEntry}</td>
                      <td>{row.strategyExit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}
