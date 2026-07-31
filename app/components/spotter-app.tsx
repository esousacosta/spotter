"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import {
  buildForwardTradeRowKey,
  isForwardTradeDrilldownEligible,
  shouldFetchForwardTradeAnalytics,
  toggleExpandedRow,
} from "@/lib/forward-trade-drilldown";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import type {
  ForwardTradeAnalyticsResponse,
  ForwardVolResponse,
  ForwardVolRow,
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

function asSigned(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "—";
  }
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}`;
}

function asCurrency(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "—";
  }
  const prefix = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${prefix}$${Math.abs(value).toFixed(2)}`;
}

function asRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "—";
  }
  return value.toFixed(2);
}

function asIsoDateTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().replace(".000Z", "Z");
}

function AcronymHint({ short, title }: { short: string; title: string }) {
  return (
    <abbr title={title} className="acronym-hint">
      {short}
    </abbr>
  );
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

type ChartSeries = "pnl" | "delta" | "gamma" | "theta";

type ChartPoint = {
  index: number;
  x: number;
  y: number;
  value: number;
};

const CHART_WIDTH = 540;
const CHART_HEIGHT = 220;
const CHART_PADDING_TOP = 14;
const CHART_PADDING_RIGHT = 12;
const CHART_PADDING_BOTTOM = 34;
const CHART_PADDING_LEFT = 46;
const CHART_PLOT_WIDTH = CHART_WIDTH - CHART_PADDING_LEFT - CHART_PADDING_RIGHT;
const CHART_PLOT_HEIGHT = CHART_HEIGHT - CHART_PADDING_TOP - CHART_PADDING_BOTTOM;

function normalizeSeries(values: number[]): ChartPoint[] {
  if (values.length === 0) {
    return [];
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const xStep = values.length > 1 ? CHART_PLOT_WIDTH / (values.length - 1) : 0;
  return values
    .map((value, index) => {
      const x = CHART_PADDING_LEFT + index * xStep;
      const y =
        max === min
          ? CHART_PADDING_TOP + CHART_PLOT_HEIGHT / 2
          : CHART_PADDING_TOP + CHART_PLOT_HEIGHT - ((value - min) / (max - min)) * CHART_PLOT_HEIGHT;
      return { index, x, y, value };
    });
}

function formatChartYValue(series: ChartSeries, value: number): string {
  if (!Number.isFinite(value)) {
    return "—";
  }
  if (series === "pnl") {
    return asCurrency(value);
  }
  return asSigned(value);
}

function ForwardTradeDetailsPanel({
  loading,
  error,
  analytics,
}: {
  loading: boolean;
  error: string | null;
  analytics: ForwardTradeAnalyticsResponse | null;
}) {
  const [chartSeries, setChartSeries] = useState<ChartSeries>("pnl");
  const [hoveredPointIndex, setHoveredPointIndex] = useState<number | null>(null);
  const values =
    chartSeries === "pnl"
      ? analytics?.chart.yPnl ?? []
      : chartSeries === "delta"
        ? analytics?.chart.yDelta ?? []
        : chartSeries === "gamma"
          ? analytics?.chart.yGamma ?? []
          : analytics?.chart.yTheta ?? [];
  const points = normalizeSeries(values);
  const polylinePoints = points.map((point) => `${point.x},${point.y}`).join(" ");
  const isPnlChart = chartSeries === "pnl";
  const yMin = values.length > 0 ? Math.min(...values) : 0;
  const yMax = values.length > 0 ? Math.max(...values) : 0;
  const yMid = (yMin + yMax) / 2;
  const zeroYRaw =
    yMax === yMin
      ? CHART_PADDING_TOP + CHART_PLOT_HEIGHT / 2
      : CHART_PADDING_TOP + CHART_PLOT_HEIGHT - ((0 - yMin) / (yMax - yMin)) * CHART_PLOT_HEIGHT;
  const zeroY = Math.min(Math.max(zeroYRaw, CHART_PADDING_TOP), CHART_PADDING_TOP + CHART_PLOT_HEIGHT);
  const hasPositiveRegion = yMax > 0;
  const hasNegativeRegion = yMin < 0;
  const yTickValues = [yMax, yMid, yMin];
  const xTickIndexes =
    points.length > 1
      ? [0, Math.floor((points.length - 1) * 0.25), Math.floor((points.length - 1) * 0.5), Math.floor((points.length - 1) * 0.75), points.length - 1]
      : points.length === 1
        ? [0]
        : [];
  const uniqueXTickIndexes = [...new Set(xTickIndexes)];
  const hoveredScenario =
    hoveredPointIndex !== null && analytics ? analytics.scenarios[hoveredPointIndex] ?? null : null;
  const hoveredUnderlying =
    hoveredPointIndex !== null && analytics ? analytics.chart.xUnderlying[hoveredPointIndex] ?? null : null;

  if (loading) {
    return <p className="muted">Loading trade analytics…</p>;
  }

  if (error) {
    return <p className="error">{error}</p>;
  }

  if (!analytics) {
    return <p className="muted">No analytics available yet for this trade row.</p>;
  }

  return (
    <div className="trade-details-panel">
      <div className="trade-details-cards">
        <article>
          <h4>
            <AcronymHint short="POP" title="Probability of Profit" />
          </h4>
          <p>{asPct(analytics.profile.probabilityOfProfit)}</p>
        </article>
        <article>
          <h4>Break-even</h4>
          <p>{asNumber(analytics.profile.breakEven)}</p>
        </article>
        <article>
          <h4>Max profit</h4>
          <p>{asCurrency(analytics.profile.maxProfit)}</p>
        </article>
        <article>
          <h4>Max loss</h4>
          <p>{asCurrency(analytics.profile.maxLoss)}</p>
        </article>
        <article>
          <h4>Return / risk</h4>
          <p>{asRatio(analytics.profile.returnRisk)}</p>
        </article>
      </div>

      <p className="muted">
        {analytics.assumptions.pricingModel} • <AcronymHint short="POP" title="Probability of Profit" /> method:{" "}
        {analytics.assumptions.popMethod} • valuation date:{" "}
        {asIsoDateTime(analytics.valuationDate)} • r {(analytics.rates.r * 100).toFixed(2)}% • q assumed 0
      </p>

      <section className="trade-details-greeks">
        <span>
          <AcronymHint short="Δ" title="Delta: sensitivity of option price to underlying price changes" />{" "}
          {asSigned(analytics.greeksNow.delta)}
        </span>
        <span>
          <AcronymHint short="Γ" title="Gamma: rate of change of delta" /> {asSigned(analytics.greeksNow.gamma)}
        </span>
        <span>
          <AcronymHint short="Θ" title="Theta: time decay of option value per day" />{" "}
          {asSigned(analytics.greeksNow.theta)}
        </span>
        <span>
          <AcronymHint short="Vega" title="Vega: sensitivity to implied volatility changes" />{" "}
          {asSigned(analytics.greeksNow.vega)}
        </span>
        <span>
          <AcronymHint short="Rho" title="Rho: sensitivity to risk-free interest rate changes" />{" "}
          {asSigned(analytics.greeksNow.rho)}
        </span>
      </section>

      <section className="trade-details-chart">
        <div className="tabs">
          <button type="button" className={chartSeries === "pnl" ? "tab-active" : ""} onClick={() => setChartSeries("pnl")}>
            <AcronymHint short="P&L" title="Profit and Loss" />
          </button>
          <button
            type="button"
            className={chartSeries === "delta" ? "tab-active" : ""}
            onClick={() => setChartSeries("delta")}
          >
            Delta
          </button>
          <button
            type="button"
            className={chartSeries === "gamma" ? "tab-active" : ""}
            onClick={() => setChartSeries("gamma")}
          >
            Gamma
          </button>
          <button
            type="button"
            className={chartSeries === "theta" ? "tab-active" : ""}
            onClick={() => setChartSeries("theta")}
          >
            Theta
          </button>
        </div>
        <svg
          viewBox="0 0 540 220"
          role="img"
          aria-label={`Forward trade ${chartSeries} chart`}
          onMouseLeave={() => setHoveredPointIndex(null)}
        >
          {isPnlChart && hasPositiveRegion && hasNegativeRegion ? (
            <>
              <rect
                x={CHART_PADDING_LEFT}
                y={CHART_PADDING_TOP}
                width={CHART_PLOT_WIDTH}
                height={Math.max(zeroY - CHART_PADDING_TOP, 0)}
                className="trade-chart-zone-profit"
              />
              <rect
                x={CHART_PADDING_LEFT}
                y={zeroY}
                width={CHART_PLOT_WIDTH}
                height={Math.max(CHART_PADDING_TOP + CHART_PLOT_HEIGHT - zeroY, 0)}
                className="trade-chart-zone-loss"
              />
            </>
          ) : null}
          {isPnlChart && hasPositiveRegion && !hasNegativeRegion ? (
            <rect
              x={CHART_PADDING_LEFT}
              y={CHART_PADDING_TOP}
              width={CHART_PLOT_WIDTH}
              height={CHART_PLOT_HEIGHT}
              className="trade-chart-zone-profit"
            />
          ) : null}
          {isPnlChart && hasNegativeRegion && !hasPositiveRegion ? (
            <rect
              x={CHART_PADDING_LEFT}
              y={CHART_PADDING_TOP}
              width={CHART_PLOT_WIDTH}
              height={CHART_PLOT_HEIGHT}
              className="trade-chart-zone-loss"
            />
          ) : null}
          <line
            x1={CHART_PADDING_LEFT}
            y1={CHART_PADDING_TOP + CHART_PLOT_HEIGHT}
            x2={CHART_PADDING_LEFT + CHART_PLOT_WIDTH}
            y2={CHART_PADDING_TOP + CHART_PLOT_HEIGHT}
            className="trade-chart-axis"
          />
          <line
            x1={CHART_PADDING_LEFT}
            y1={CHART_PADDING_TOP}
            x2={CHART_PADDING_LEFT}
            y2={CHART_PADDING_TOP + CHART_PLOT_HEIGHT}
            className="trade-chart-axis"
          />
          {yTickValues.map((tickValue) => {
            const y =
              yMax === yMin
                ? CHART_PADDING_TOP + CHART_PLOT_HEIGHT / 2
                : CHART_PADDING_TOP + CHART_PLOT_HEIGHT - ((tickValue - yMin) / (yMax - yMin)) * CHART_PLOT_HEIGHT;
            return (
              <g key={`y-tick-${tickValue}`}>
                <line
                  x1={CHART_PADDING_LEFT}
                  y1={y}
                  x2={CHART_PADDING_LEFT + CHART_PLOT_WIDTH}
                  y2={y}
                  className="trade-chart-gridline"
                />
                <text x={4} y={Math.max(CHART_PADDING_TOP + 10, y - 4)} textAnchor="start" className="trade-chart-axis-label">
                  {formatChartYValue(chartSeries, tickValue)}
                </text>
              </g>
            );
          })}
          {uniqueXTickIndexes.map((tickIndex) => {
            const point = points[tickIndex];
            const underlying = analytics.chart.xUnderlying[tickIndex] ?? null;
            if (!point) {
              return null;
            }
            return (
              <g key={`x-tick-${tickIndex}`}>
                <line
                  x1={point.x}
                  y1={CHART_PADDING_TOP + CHART_PLOT_HEIGHT}
                  x2={point.x}
                  y2={CHART_PADDING_TOP + CHART_PLOT_HEIGHT + 5}
                  className="trade-chart-axis"
                />
                <text
                  x={point.x}
                  y={CHART_PADDING_TOP + CHART_PLOT_HEIGHT + 16}
                  textAnchor="middle"
                  className="trade-chart-axis-label"
                >
                  {asNumber(underlying)}
                </text>
              </g>
            );
          })}
          {isPnlChart && analytics.profile.breakEven !== null && analytics.chart.xUnderlying.length > 1 ? (() => {
            const minUnderlying = Math.min(...analytics.chart.xUnderlying);
            const maxUnderlying = Math.max(...analytics.chart.xUnderlying);
            const breakEven = analytics.profile.breakEven;
            if (maxUnderlying <= minUnderlying || breakEven < minUnderlying || breakEven > maxUnderlying) {
              return null;
            }
            const breakEvenX =
              CHART_PADDING_LEFT + ((breakEven - minUnderlying) / (maxUnderlying - minUnderlying)) * CHART_PLOT_WIDTH;
            return (
              <g>
                <line
                  x1={breakEvenX}
                  y1={CHART_PADDING_TOP}
                  x2={breakEvenX}
                  y2={CHART_PADDING_TOP + CHART_PLOT_HEIGHT}
                  className="trade-chart-breakeven-line"
                />
                <text x={breakEvenX} y={CHART_PADDING_TOP + 10} textAnchor="middle" className="trade-chart-breakeven-label">
                  <tspan title="Break-even point">BE</tspan> {asNumber(breakEven)}
                </text>
              </g>
            );
          })() : null}
          <polyline points={polylinePoints} fill="none" stroke="#8cb4ff" strokeWidth="2" />
          {points.map((point) => {
            const scenario = analytics.scenarios[point.index];
            if (!scenario) {
              return null;
            }
            const showPnlLabel = chartSeries === "pnl" && (point.index % 2 === 0 || point.index === points.length - 1);
            const labelYRaw = point.index % 4 < 2 ? point.y - 8 : point.y + 14;
            const labelY = Math.min(
              Math.max(labelYRaw, CHART_PADDING_TOP + 10),
              CHART_PADDING_TOP + CHART_PLOT_HEIGHT - 4,
            );

            return (
              <g key={`${chartSeries}-${point.index}`} className="trade-chart-point-group">
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={3.5}
                  tabIndex={0}
                  className="trade-chart-point"
                  onMouseEnter={() => setHoveredPointIndex(point.index)}
                  onFocus={() => setHoveredPointIndex(point.index)}
                >
                  <title>{`Move ${asPct(scenario.movePct)} | Underlying ${asNumber(
                    analytics.chart.xUnderlying[point.index] ?? null,
                  )} | P/L ${asCurrency(scenario.pnl)} | Delta ${asSigned(scenario.delta)} | Gamma ${asSigned(
                    scenario.gamma,
                  )} | Theta ${asSigned(scenario.theta)}`}</title>
                </circle>
                {showPnlLabel ? (
                  <text x={point.x} y={labelY} textAnchor="middle" className="trade-chart-label">
                    {asCurrency(point.value)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
        {chartSeries === "pnl" ? (
          <p className="trade-details-chart-info muted">
            {hoveredScenario
              ? `Move ${asPct(hoveredScenario.movePct)} • Underlying ${asNumber(hoveredUnderlying)} • P/L ${asCurrency(
                  hoveredScenario.pnl,
                )} • Delta ${asSigned(hoveredScenario.delta)} • Gamma ${asSigned(
                  hoveredScenario.gamma,
                )} • Theta ${asSigned(hoveredScenario.theta)}`
              : "Hover a P&L point to inspect move, underlying, P/L, and Greeks."}
          </p>
        ) : null}
      </section>

      <section className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Move</th>
              <th>Underlying</th>
              <th>
                <AcronymHint short="P/L" title="Profit and Loss" />
              </th>
              <th>Delta</th>
              <th>Gamma</th>
              <th>Theta</th>
              <th>Vega</th>
              <th>Rho</th>
              <th>P(S ≥ price)</th>
            </tr>
          </thead>
          <tbody>
            {analytics.scenarios.map((scenario) => (
              <tr key={`${analytics.symbol}-${scenario.underlying}`}>
                <td>{asPct(scenario.movePct)}</td>
                <td>{asNumber(scenario.underlying)}</td>
                <td>{asCurrency(scenario.pnl)}</td>
                <td>{asSigned(scenario.delta)}</td>
                <td>{asSigned(scenario.gamma)}</td>
                <td>{asSigned(scenario.theta)}</td>
                <td>{asSigned(scenario.vega)}</td>
                <td>{asSigned(scenario.rho)}</td>
                <td>{asPct(scenario.popAtOrAboveThisPrice ?? null)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {analytics.warnings.length > 0 ? (
        <ul className="trade-details-warnings">
          {analytics.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
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
  const [expandedForwardRowKey, setExpandedForwardRowKey] = useState<string | null>(null);
  const [expandedTopRowKey, setExpandedTopRowKey] = useState<string | null>(null);
  const [analyticsByRowKey, setAnalyticsByRowKey] = useState<Record<string, ForwardTradeAnalyticsResponse>>({});
  const [analyticsLoadingByRowKey, setAnalyticsLoadingByRowKey] = useState<Record<string, boolean>>({});
  const [analyticsErrorByRowKey, setAnalyticsErrorByRowKey] = useState<Record<string, string | null>>({});
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
      setExpandedForwardRowKey(null);

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

  async function ensureForwardTradeAnalytics(row: ForwardVolRow, rowSymbol: string): Promise<void> {
    const rowKey = buildForwardTradeRowKey({
      symbol: rowSymbol,
      shortExpiry: row.shortExpiry,
      longExpiry: row.longExpiry,
      selectedStrike: row.selectedStrike,
    });
    if (!rowKey || !isForwardTradeDrilldownEligible(row)) {
      return;
    }
    if (!shouldFetchForwardTradeAnalytics(rowKey, analyticsByRowKey, analyticsLoadingByRowKey)) {
      return;
    }

    setAnalyticsLoadingByRowKey((current) => ({ ...current, [rowKey]: true }));
    setAnalyticsErrorByRowKey((current) => ({ ...current, [rowKey]: null }));

    try {
      const response = await fetchWithTimeout(
        "/api/forward-trade-analytics",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol: rowSymbol,
            shortExpiry: row.shortExpiry,
            longExpiry: row.longExpiry,
            strike: row.selectedStrike,
          }),
        },
        UI_REQUEST_TIMEOUT_MS,
      );

      const payload = (await response.json()) as ForwardTradeAnalyticsResponse | { error: string };
      if (!response.ok || "error" in payload) {
        const message = "error" in payload ? payload.error : "Forward-trade analytics request failed.";
        throw new Error(message);
      }

      setAnalyticsByRowKey((current) => ({ ...current, [rowKey]: payload }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load row analytics.";
      setAnalyticsErrorByRowKey((current) => ({ ...current, [rowKey]: message }));
    } finally {
      setAnalyticsLoadingByRowKey((current) => ({ ...current, [rowKey]: false }));
    }
  }

  function onToggleForwardRow(row: ForwardVolRow): void {
    const rowKey = buildForwardTradeRowKey({
      symbol,
      shortExpiry: row.shortExpiry,
      longExpiry: row.longExpiry,
      selectedStrike: row.selectedStrike,
    });
    if (!rowKey) {
      return;
    }
    const next = toggleExpandedRow(expandedForwardRowKey, rowKey);
    setExpandedForwardRowKey(next);
    if (next === rowKey) {
      void ensureForwardTradeAnalytics(row, symbol);
    }
  }

  function onToggleTopRow(row: RankedForwardVolRow): void {
    const rowKey = buildForwardTradeRowKey({
      symbol: row.symbol,
      shortExpiry: row.shortExpiry,
      longExpiry: row.longExpiry,
      selectedStrike: row.selectedStrike,
    });
    if (!rowKey) {
      return;
    }
    const next = toggleExpandedRow(expandedTopRowKey, rowKey);
    setExpandedTopRowKey(next);
    if (next === rowKey) {
      void ensureForwardTradeAnalytics(row, row.symbol);
    }
  }

  async function loadTopRows(silent = false) {
    if (!silent) {
      setTopRowsLoading(true);
      setTopError(null);
      setExpandedTopRowKey(null);
    }

    try {
      const response = await fetchWithTimeout("/api/top-forward-vol", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topN: 10 }),
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
        body: JSON.stringify({ topN: 10 }),
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
              {topRowsLoading ? "Scanning S&P 500..." : "Find top 10 opportunities"}
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
                    <th>Details</th>
                    <th>Trade Class</th>
                    <th>
                      Actual <AcronymHint short="DTEs" title="Days To Expiration" />
                    </th>
                    <th>Next Earnings</th>
                    <th>Strike (ATM)</th>
                    <th>
                      Short <AcronymHint short="IV" title="Implied Volatility" />
                    </th>
                    <th>
                      Long <AcronymHint short="IV" title="Implied Volatility" />
                    </th>
                    <th>
                      Short <AcronymHint short="OI" title="Open Interest" />
                    </th>
                    <th>
                      Long <AcronymHint short="OI" title="Open Interest" />
                    </th>
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
                    const rowKey = buildForwardTradeRowKey({
                      symbol,
                      shortExpiry: row.shortExpiry,
                      longExpiry: row.longExpiry,
                      selectedStrike: row.selectedStrike,
                    });
                    const canDrilldown = rowKey !== null && isForwardTradeDrilldownEligible(row);
                    const isExpanded = rowKey !== null && expandedForwardRowKey === rowKey;
                    const analytics = rowKey ? analyticsByRowKey[rowKey] ?? null : null;
                    const analyticsLoading = rowKey ? analyticsLoadingByRowKey[rowKey] ?? false : false;
                    const analyticsError = rowKey ? analyticsErrorByRowKey[rowKey] ?? null : null;

                    return (
                      <Fragment key={`${row.shortTargetDte}-${row.longTargetDte}`}>
                        <tr className={rowClass}>
                          <td>
                            {row.shortTargetDte}/{row.longTargetDte}
                          </td>
                          <td>
                            <button type="button" onClick={() => onToggleForwardRow(row)} disabled={!canDrilldown}>
                              {isExpanded ? "Hide" : "Details"}
                            </button>
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
                        {isExpanded ? (
                          <tr className="row-drilldown">
                            <td colSpan={16}>
                              <ForwardTradeDetailsPanel
                                loading={analyticsLoading}
                                error={analyticsError}
                                analytics={analytics}
                              />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
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
                    <th>Details</th>
                    <th>Trade Class</th>
                    <th>
                      Actual <AcronymHint short="DTEs" title="Days To Expiration" />
                    </th>
                    <th>Next Earnings</th>
                    <th>Strike (ATM)</th>
                    <th>
                      Short <AcronymHint short="IV" title="Implied Volatility" />
                    </th>
                    <th>
                      Long <AcronymHint short="IV" title="Implied Volatility" />
                    </th>
                    <th>
                      Short <AcronymHint short="OI" title="Open Interest" />
                    </th>
                    <th>
                      Long <AcronymHint short="OI" title="Open Interest" />
                    </th>
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
                    const rowKey = buildForwardTradeRowKey({
                      symbol: row.symbol,
                      shortExpiry: row.shortExpiry,
                      longExpiry: row.longExpiry,
                      selectedStrike: row.selectedStrike,
                    });
                    const canDrilldown = rowKey !== null && isForwardTradeDrilldownEligible(row);
                    const isExpanded = rowKey !== null && expandedTopRowKey === rowKey;
                    const analytics = rowKey ? analyticsByRowKey[rowKey] ?? null : null;
                    const analyticsLoading = rowKey ? analyticsLoadingByRowKey[rowKey] ?? false : false;
                    const analyticsError = rowKey ? analyticsErrorByRowKey[rowKey] ?? null : null;

                    return (
                      <Fragment key={`${row.symbol}-${row.shortTargetDte}-${row.longTargetDte}`}>
                        <tr className={rowClass}>
                          <td>{row.symbol}</td>
                          <td>{row.companyName}</td>
                          <td>
                            {row.shortTargetDte}/{row.longTargetDte}
                          </td>
                          <td>
                            <button type="button" onClick={() => onToggleTopRow(row)} disabled={!canDrilldown}>
                              {isExpanded ? "Hide" : "Details"}
                            </button>
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
                        {isExpanded ? (
                          <tr className="row-drilldown">
                            <td colSpan={17}>
                              <ForwardTradeDetailsPanel
                                loading={analyticsLoading}
                                error={analyticsError}
                                analytics={analytics}
                              />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
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
              {preRowsLoading ? "Scanning pre-earnings setups..." : "Find top 10 pre-earnings viable trades"}
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
                    <th>
                      <AcronymHint short="IV30/RV30" title="30-day Implied Volatility divided by 30-day Realized Volatility" />
                    </th>
                    <th>
                      <AcronymHint short="TS" title="Term Structure" /> Slope 0→45
                    </th>
                    <th>Avg Vol Check</th>
                    <th>
                      <AcronymHint short="IV30/RV30" title="30-day Implied Volatility divided by 30-day Realized Volatility" /> Check
                    </th>
                    <th>
                      <AcronymHint short="TS" title="Term Structure" /> Slope Check
                    </th>
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
                    <th>
                      <AcronymHint short="IV30/RV30" title="30-day Implied Volatility divided by 30-day Realized Volatility" />
                    </th>
                    <th>
                      <AcronymHint short="TS" title="Term Structure" /> Slope 0→45
                    </th>
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
