"use client";

import Link from "next/link";
import { signOut } from "next-auth/react";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  buildForwardTradeRowKey,
  isForwardTradeDrilldownEligible,
  shouldFetchForwardTradeAnalytics,
  toggleExpandedRow,
} from "@/lib/forward-trade-drilldown";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { buildMarketScanHtml, marketScanHtmlFilename } from "@/lib/market-scan-html";
import { ManualEdgeCalculator } from "@/app/components/manual-edge-calculator";
import { sortRows, toggleSort, type SortConfig } from "@/lib/table-sort";
import { loadWatchlist, saveWatchlist } from "@/lib/watchlist";
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
const FORWARD_VOL_REQUEST_TIMEOUT_MS = 60_000;

const DEFAULT_FORWARD_SORT: SortConfig<ForwardVolRow> = {
  key: "adjustedForwardVolEdge",
  direction: "desc",
};
const DEFAULT_TOP_FORWARD_SORT: SortConfig<RankedForwardVolRow> = {
  key: "adjustedForwardVolEdge",
  direction: "desc",
};
const DEFAULT_PRE_EARNINGS_SORT: SortConfig<PreEarningsRow> = {
  key: "verdict",
  direction: "desc",
};

type ForwardFilters = {
  viableOnly: boolean;
  tradeClass: "all" | "standard" | "earnings-exposed";
};

type PreEarningsFilter = "recommended" | "consider-plus" | "all";

function asPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "—";
  }
  return `${(value * 100).toFixed(2)}%`;
}

function SortableHeader<T>({
  children,
  column,
  config,
  onSort,
}: {
  children: ReactNode;
  column: keyof T;
  config: SortConfig<T>;
  onSort: (column: keyof T) => void;
}) {
  const active = config.key === column;
  return (
    <th className="th-sortable" aria-sort={active ? (config.direction === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={() => onSort(column)}>
        {children}
        <span className="sort-indicator" aria-hidden="true">
          {active ? (config.direction === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );
}

function WatchlistButton({
  active,
  disabled = false,
  onClick,
  symbol,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  symbol: string;
}) {
  return (
    <button
      type="button"
      className={active ? "watchlist-toggle is-active" : "watchlist-toggle"}
      onClick={onClick}
      disabled={disabled}
      aria-label={`${active ? "Remove" : "Add"} ${symbol} ${active ? "from" : "to"} watchlist`}
      title={active ? "Remove from watchlist" : "Add to watchlist"}
    >
      <span aria-hidden="true">{active ? "★" : "☆"}</span>
    </button>
  );
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

function daysUntilEarnings(value: string | null): string {
  if (!value) {
    return "—";
  }
  const target = new Date(`${value}T00:00:00Z`).getTime();
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Number.isFinite(target) ? Math.ceil((target - todayUtc) / 86_400_000).toString() : "—";
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

function formatTimeAgo(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  if (diffMs < 0) return "just now";
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ${diffMin % 60}m ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
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
                  <tspan aria-label="Break-even point">BE</tspan> {asNumber(breakEven)}
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

type SpotterAppProps = {
  authenticationEnabled: boolean;
  user: { email: string | null } | null;
};

export function SpotterApp({ authenticationEnabled, user }: SpotterAppProps) {
  const [activeTab, setActiveTab] = useState<"forward" | "preearnings" | "upcomingearnings" | "howItWorks">("forward");
  const [preEarningsSubtab, setPreEarningsSubtab] = useState<"viable" | "rejected">("viable");
  const [tickers, setTickers] = useState<Ticker[]>([]);
  const [symbol, setSymbol] = useState<string>(DEFAULT_SYMBOL);
  const [data, setData] = useState<ForwardVolResponse | null>(null);
  const [topRows, setTopRows] = useState<RankedForwardVolRow[]>([]);
  const [topScanMeta, setTopScanMeta] = useState<{
    asOf: string;
    scannedSymbols: number;
    processedSymbols: number;
    successfulSymbols: number;
    isComplete: boolean;
    isWarming: boolean;
    isStale: boolean;
    warning: string | null;
  } | null>(null);
  const [preRows, setPreRows] = useState<PreEarningsRow[]>([]);
  const [preRejectedRows, setPreRejectedRows] = useState<PreEarningsRejectedRow[]>([]);
  const [upcomingRows, setUpcomingRows] = useState<UpcomingEarningsRow[]>([]);
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [watchlistReady, setWatchlistReady] = useState(false);
  const [watchlistSyncing, setWatchlistSyncing] = useState(false);
  const [watchlistError, setWatchlistError] = useState<string | null>(null);
  const [watchForwardRows, setWatchForwardRows] = useState<RankedForwardVolRow[]>([]);
  const [watchPreRows, setWatchPreRows] = useState<PreEarningsRow[]>([]);
  const [watchForwardError, setWatchForwardError] = useState<string | null>(null);
  const [watchPreError, setWatchPreError] = useState<string | null>(null);
  const [forwardSortConfig, setForwardSortConfig] =
    useState<SortConfig<ForwardVolRow>>(DEFAULT_FORWARD_SORT);
  const [topForwardSortConfig, setTopForwardSortConfig] =
    useState<SortConfig<RankedForwardVolRow>>(DEFAULT_TOP_FORWARD_SORT);
  const [preSortConfig, setPreSortConfig] =
    useState<SortConfig<PreEarningsRow>>(DEFAULT_PRE_EARNINGS_SORT);
  const [forwardFilters, setForwardFilters] = useState<ForwardFilters>({
    viableOnly: true,
    tradeClass: "all",
  });
  const [topForwardFilters, setTopForwardFilters] = useState<ForwardFilters>({
    viableOnly: true,
    tradeClass: "all",
  });
  const [liquidityFirst, setLiquidityFirst] = useState(false);
  const [preFilter, setPreFilter] = useState<PreEarningsFilter>("all");
  const [preMeta, setPreMeta] = useState<{
    asOf: string;
    scannedSymbols: number;
    evaluatedSymbols: number;
    computedSymbols: number;
    viableSymbols: number;
    rejectedSymbols: number;
    isComplete: boolean;
    isWarming: boolean;
    isStale: boolean;
    warning: string | null;
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
  const [cacheClearing, setCacheClearing] = useState(false);
  const [cacheNotice, setCacheNotice] = useState<string | null>(null);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const preRefreshInFlight = useRef(false);
  const topRefreshInFlight = useRef(false);
  const preScanLoaded = useRef(false);
  const topScanLoaded = useRef(false);

  type IbkrStatusPayload = { enabled: boolean; authenticated: boolean; gatewayUrl: string; error?: string };
  const [ibkrStatus, setIbkrStatus] = useState<IbkrStatusPayload | "loading" | null>("loading");
  const [quoteSourceVersion, setQuoteSourceVersion] = useState(0);
  const lastIbkrAuthenticated = useRef<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function hydrateWatchlist() {
      const guestSymbols = loadWatchlist();
      if (!user) {
        setWatchlist(guestSymbols);
        setWatchlistReady(true);
        return;
      }

      setWatchlistSyncing(true);
      setWatchlistError(null);
      try {
        const getResponse = await fetch("/api/watchlist");
        const getPayload = (await getResponse.json()) as { symbols?: string[]; error?: string };
        if (!getResponse.ok || !getPayload.symbols) {
          throw new Error(getPayload.error ?? "Failed to load watchlist.");
        }

        let symbols = getPayload.symbols;
        if (guestSymbols.length > 0) {
          const merged = [...new Set([...symbols, ...guestSymbols])].slice(0, 30);
          const putResponse = await fetch("/api/watchlist", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ symbols: merged }),
          });
          const putPayload = (await putResponse.json()) as { symbols?: string[]; error?: string };
          if (!putResponse.ok || !putPayload.symbols) {
            throw new Error(putPayload.error ?? "Failed to merge guest watchlist.");
          }
          symbols = putPayload.symbols;
        }

        if (!cancelled) {
          setWatchlist(symbols);
          if (guestSymbols.length > 0) {
            saveWatchlist([]);
          }
        }
      } catch (error) {
        if (!cancelled) {
          setWatchlistError(error instanceof Error ? error.message : "Failed to load watchlist.");
        }
      } finally {
        if (!cancelled) {
          setWatchlistReady(true);
          setWatchlistSyncing(false);
        }
      }
    }

    void hydrateWatchlist();
    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    let cancelled = false;

    async function refreshIbkrStatus(): Promise<void> {
      try {
        const response = await fetch("/api/ibkr-status", { cache: "no-store" });
        const payload = (await response.json()) as IbkrStatusPayload;
        if (cancelled) return;

        const becameLive =
          payload.authenticated && lastIbkrAuthenticated.current === false;
        lastIbkrAuthenticated.current = payload.authenticated;
        setIbkrStatus(payload);

        if (becameLive) {
          setQuoteSourceVersion((version) => version + 1);
        }
      } catch {
        if (!cancelled) {
          lastIbkrAuthenticated.current = false;
          setIbkrStatus(null);
        }
      }
    }

    void refreshIbkrStatus();
    const interval = window.setInterval(() => void refreshIbkrStatus(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

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
    const controller = new AbortController();
    let cancelled = false;
    let refreshTimer: number | null = null;
    let silentRetryDelayMs = 4_000;

    function scheduleSilentRefresh(delayMs: number): void {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      refreshTimer = window.setTimeout(() => {
        void loadForwardVol(true);
      }, delayMs);
    }

    async function loadForwardVol(silent = false) {
      if (!silent) {
        setRowsLoading(true);
        setError(null);
        setExpandedForwardRowKey(null);
      }

      try {
        const response = await fetchWithTimeout("/api/forward-vol", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol }),
          signal: controller.signal,
        }, FORWARD_VOL_REQUEST_TIMEOUT_MS);

        const payload = (await response.json()) as ForwardVolResponse | { error: string };
        if (!response.ok || "error" in payload) {
          const message = "error" in payload ? payload.error : "Forward volatility request failed.";
          throw new Error(message);
        }

        if (!cancelled) {
          setData(payload);
          if (!silent) {
            setForwardSortConfig(DEFAULT_FORWARD_SORT);
            setForwardFilters({ viableOnly: true, tradeClass: "all" });
          }
          if (payload.isStale) {
            silentRetryDelayMs = 4_000;
            scheduleSilentRefresh(silentRetryDelayMs);
          }
        }
      } catch (err) {
        if (cancelled || (err instanceof Error && err.name === "AbortError")) {
          return;
        }
        if (!silent) {
          const message = err instanceof Error ? err.message : "Failed to load forward volatility.";
          setError(message);
          setData(null);
        } else {
          scheduleSilentRefresh(silentRetryDelayMs);
          silentRetryDelayMs = Math.min(silentRetryDelayMs * 2, 30_000);
        }
      } finally {
        if (!cancelled && !silent) {
          setRowsLoading(false);
        }
      }
    }

    void loadForwardVol();
    return () => {
      cancelled = true;
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      controller.abort();
    };
  }, [quoteSourceVersion, symbol]);

  useEffect(() => {
    if (!watchlistReady || activeTab !== "forward" || watchlist.length === 0) {
      return;
    }

    const controller = new AbortController();
    void Promise.all(
      watchlist.map(async (watchSymbol) => {
        const response = await fetchWithTimeout(
          "/api/forward-vol",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ symbol: watchSymbol }),
            signal: controller.signal,
          },
          FORWARD_VOL_REQUEST_TIMEOUT_MS,
        );
        const payload = (await response.json()) as ForwardVolResponse | { error: string };
        if (!response.ok || "error" in payload) {
          throw new Error("error" in payload ? payload.error : `Failed to load ${watchSymbol}.`);
        }
        const bestRow = [...payload.rows].sort(
          (left, right) =>
            (right.adjustedForwardVolEdge ?? Number.NEGATIVE_INFINITY) -
            (left.adjustedForwardVolEdge ?? Number.NEGATIVE_INFINITY),
        )[0];
        if (!bestRow) {
          return null;
        }
        const rankedRow: RankedForwardVolRow = {
          ...bestRow,
          symbol: watchSymbol,
          companyName: tickers.find((ticker) => ticker.symbol === watchSymbol)?.name ?? watchSymbol,
          rankingReason: null,
        };
        return rankedRow;
      }),
    )
      .then((rows) => setWatchForwardRows(rows.filter((row): row is NonNullable<typeof row> => row !== null)))
      .catch((err) => {
        if (!(err instanceof Error && err.name === "AbortError")) {
          setWatchForwardError(err instanceof Error ? err.message : "Failed to load watchlist.");
        }
      });

    return () => controller.abort();
  }, [activeTab, quoteSourceVersion, tickers, watchlist, watchlistReady]);

  useEffect(() => {
    if (!watchlistReady || activeTab !== "preearnings" || watchlist.length === 0) {
      return;
    }

    const controller = new AbortController();
    void fetchWithTimeout(
      "/api/pre-earnings-viable",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols: watchlist }),
        signal: controller.signal,
      },
      FORWARD_VOL_REQUEST_TIMEOUT_MS,
    )
      .then(async (response) => {
        const payload = (await response.json()) as TopPreEarningsResponse | { error: string };
        if (!response.ok || "error" in payload) {
          throw new Error("error" in payload ? payload.error : "Failed to load pre-earnings watchlist.");
        }
        setWatchPreRows(payload.rows);
      })
      .catch((err) => {
        if (!(err instanceof Error && err.name === "AbortError")) {
          setWatchPreError(err instanceof Error ? err.message : "Failed to load pre-earnings watchlist.");
        }
      });

    return () => controller.abort();
  }, [activeTab, quoteSourceVersion, watchlist, watchlistReady]);

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
  const viableForwardRows = useMemo(() => data?.rows.filter((row) => row.isViable) ?? [], [data]);
  const rejectedForwardRows = useMemo(() => data?.rows.filter((row) => !row.isViable) ?? [], [data]);
  const viableTopRows = useMemo(() => topRows.filter((row) => row.isViable), [topRows]);
  const rejectedTopRows = useMemo(() => topRows.filter((row) => !row.isViable), [topRows]);
  const visibleForwardRows = useMemo(() => {
    const filtered = (data?.rows ?? []).filter(
      (row) =>
        (!forwardFilters.viableOnly || row.isViable) &&
        (forwardFilters.tradeClass === "all" || row.tradeClass === forwardFilters.tradeClass),
    );
    return sortRows(filtered, forwardSortConfig);
  }, [data, forwardFilters, forwardSortConfig]);
  const visibleTopRows = useMemo(() => {
    const filtered = topRows.filter(
      (row) =>
        (!topForwardFilters.viableOnly || row.isViable) &&
        (topForwardFilters.tradeClass === "all" || row.tradeClass === topForwardFilters.tradeClass),
    );
    return sortRows(filtered, topForwardSortConfig);
  }, [topForwardFilters, topForwardSortConfig, topRows]);
  const visiblePreRows = useMemo(() => {
    const filtered = preRows.filter((row) => {
      if (preFilter === "recommended") {
        return row.verdict === "recommended";
      }
      if (preFilter === "consider-plus") {
        return row.verdict === "recommended" || row.verdict === "consider";
      }
      return true;
    });
    return sortRows(filtered, preSortConfig);
  }, [preFilter, preRows, preSortConfig]);

  async function toggleWatchlistSymbol(rowSymbol: string): Promise<void> {
    if (watchlistSyncing) {
      return;
    }

    const normalized = rowSymbol.trim().toUpperCase();
    const removing = watchlist.includes(normalized);
    setWatchlistSyncing(true);
    setWatchlistError(null);
    try {
      if (user) {
        const response = await fetch(removing ? `/api/watchlist/${encodeURIComponent(normalized)}` : "/api/watchlist", {
          method: removing ? "DELETE" : "POST",
          headers: removing ? undefined : { "Content-Type": "application/json" },
          body: removing ? undefined : JSON.stringify({ symbol: normalized }),
        });
        const payload = (await response.json()) as { symbols?: string[]; error?: string };
        if (!response.ok || !payload.symbols) {
          throw new Error(payload.error ?? "Failed to update watchlist.");
        }
        setWatchlist(payload.symbols);
      } else {
        const next = removing
          ? watchlist.filter((item) => item !== normalized)
          : [...watchlist, normalized].slice(0, 30);
        saveWatchlist(next);
        setWatchlist(next);
      }

      if (removing) {
        setWatchForwardRows((rows) => rows.filter((row) => row.symbol !== normalized));
        setWatchPreRows((rows) => rows.filter((row) => row.symbol !== normalized));
      }
    } catch (error) {
      setWatchlistError(error instanceof Error ? error.message : "Failed to update watchlist.");
    } finally {
      setWatchlistSyncing(false);
    }
  }

  async function clearWatchlist(): Promise<void> {
    if (watchlistSyncing) {
      return;
    }

    setWatchlistSyncing(true);
    setWatchlistError(null);
    try {
      if (user) {
        const response = await fetch("/api/watchlist", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbols: [] }),
        });
        const payload = (await response.json()) as { symbols?: string[]; error?: string };
        if (!response.ok || !payload.symbols) {
          throw new Error(payload.error ?? "Failed to clear watchlist.");
        }
      } else {
        saveWatchlist([]);
      }

      setWatchlist([]);
      setWatchForwardRows([]);
      setWatchPreRows([]);
      setWatchForwardError(null);
      setWatchPreError(null);
    } catch (error) {
      setWatchlistError(error instanceof Error ? error.message : "Failed to clear watchlist.");
    } finally {
      setWatchlistSyncing(false);
    }
  }

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
    topScanLoaded.current = true;
    if (!silent) {
      setTopRowsLoading(true);
      setTopError(null);
      setExpandedTopRowKey(null);
      setTopForwardSortConfig(DEFAULT_TOP_FORWARD_SORT);
      setTopForwardFilters({ viableOnly: true, tradeClass: "all" });
    }

    try {
      const response = await fetchWithTimeout("/api/top-forward-vol", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ liquidityFirst }),
      }, UI_REQUEST_TIMEOUT_MS);

      const payload = (await response.json()) as TopForwardVolResponse | { error: string };
      if (!response.ok || "error" in payload) {
        const message = "error" in payload ? payload.error : "Top-forward-vol request failed.";
        throw new Error(message);
      }

      setTopRows(payload.rows);
      setTopScanMeta({
        asOf: payload.asOf,
        scannedSymbols: payload.scannedSymbols,
        processedSymbols: payload.processedSymbols,
        successfulSymbols: payload.successfulSymbols,
        isComplete: payload.isComplete,
        isWarming: payload.isWarming,
        isStale: payload.isStale ?? false,
        warning: payload.warning ?? null,
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

  function exportViableTopRows(): void {
    if (!topScanMeta || viableTopRows.length === 0) {
      return;
    }

    const html = buildMarketScanHtml(viableTopRows, topScanMeta.asOf);
    const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = marketScanHtmlFilename(topScanMeta.asOf);
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function loadPreEarningsRows(silent = false) {
    preScanLoaded.current = true;
    if (!silent) {
      setPreRowsLoading(true);
      setPreError(null);
      setPreSortConfig(DEFAULT_PRE_EARNINGS_SORT);
      setPreFilter("all");
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
        asOf: payload.asOf,
        scannedSymbols: payload.scannedSymbols,
        evaluatedSymbols: payload.evaluatedSymbols,
        computedSymbols: payload.computedSymbols,
        viableSymbols: payload.viableSymbols,
        rejectedSymbols: payload.rejectedSymbols,
        isComplete: payload.isComplete,
        isWarming: payload.isWarming,
        isStale: payload.isStale ?? false,
        warning: payload.warning ?? null,
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

  useEffect(() => {
    if (quoteSourceVersion === 0) {
      return;
    }
    if (topScanLoaded.current) {
      void loadTopRows(true);
    }
    if (preScanLoaded.current) {
      void loadPreEarningsRows(true);
    }
  }, [quoteSourceVersion]);

  async function clearServerCaches() {
    setCacheClearing(true);
    setCacheNotice(null);
    setCacheError(null);
    try {
      const [cacheResponse, topResponse, preResponse] = await Promise.all([
        fetchWithTimeout("/api/cache", { method: "DELETE" }, UI_REQUEST_TIMEOUT_MS),
        fetchWithTimeout("/api/top-forward-vol", { method: "DELETE" }, UI_REQUEST_TIMEOUT_MS),
        fetchWithTimeout("/api/pre-earnings-viable", { method: "DELETE" }, UI_REQUEST_TIMEOUT_MS),
      ]);
      if (!cacheResponse.ok || !topResponse.ok || !preResponse.ok) {
        throw new Error("Cache clear request failed.");
      }

      const payload = (await cacheResponse.json()) as { diskFilesDeleted?: number };
      setData(null);
      setTopRows([]);
      setTopScanMeta(null);
      setPreRows([]);
      setPreRejectedRows([]);
      setPreMeta(null);
      setUpcomingRows([]);
      setUpcomingMeta(null);
      setExpandedForwardRowKey(null);
      setExpandedTopRowKey(null);
      setAnalyticsByRowKey({});
      setAnalyticsLoadingByRowKey({});
      setAnalyticsErrorByRowKey({});
      setCacheNotice(
        `Cache cleared${typeof payload.diskFilesDeleted === "number" ? ` (${payload.diskFilesDeleted} disk files removed)` : ""}.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to clear server cache.";
      setCacheError(message);
    } finally {
      setCacheClearing(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            FV
          </div>
          <div>
            <p className="eyebrow">Options research workspace</p>
            <h1>Forward Volatility Spotter</h1>
            <p className="header-description">
              Screen calendar spreads, validate earnings setups, and review the reasons behind every rejection.
            </p>
          </div>
        </div>
        <div className="header-actions">
          {user ? (
            <>
              <Link className="button-secondary" href="/trade-journal">
                Trade Journal
              </Link>
              <div className="auth-status">
                <span>Signed in as {user.email}</span>
                <button type="button" onClick={() => void signOut({ redirectTo: "/" })}>
                  Log out
                </button>
              </div>
            </>
          ) : authenticationEnabled ? (
            <Link className="button-secondary auth-link" href="/login">
              Log in
            </Link>
          ) : null}
          {ibkrStatus === "loading" ? (
            <span className="quote-source-badge quote-source-badge--checking">Checking quotes...</span>
          ) : ibkrStatus === null ? null : ibkrStatus.enabled && ibkrStatus.authenticated ? (
            <span className="quote-source-badge quote-source-badge--live" title={`IBKR gateway: ${ibkrStatus.gatewayUrl}`}>
              Live quotes (IBKR)
            </span>
          ) : ibkrStatus.enabled ? (
            <span
              className="quote-source-badge quote-source-badge--error"
              title={ibkrStatus.error ?? `IBKR not authenticated - open ${ibkrStatus.gatewayUrl} to log in`}
            >
              IBKR offline - delayed
            </span>
          ) : (
            <span className="quote-source-badge quote-source-badge--delayed" title="Using Cboe delayed option data">
              Delayed quotes (Cboe)
            </span>
          )}
          <button
            type="button"
            className="button-secondary"
            onClick={() => void clearServerCaches()}
            disabled={cacheClearing}
          >
            {cacheClearing ? "Clearing..." : "Clear cache"}
          </button>
        </div>
      </header>

      {cacheNotice ? <p className="notice notice--success">{cacheNotice}</p> : null}
      {cacheError ? <p className="error">{cacheError}</p> : null}
      {!watchlistReady ? <p className="notice notice--loading">Syncing watchlist...</p> : null}
      {watchlistError ? <p className="error">{watchlistError}</p> : null}
      {watchlistReady && authenticationEnabled && !user ? (
        <p className="watchlist-sync-note">
          <Link href="/login">Log in</Link> to sync your watchlist across sessions.
        </p>
      ) : null}

      <nav className="primary-nav" aria-label="Screening workflows">
        <button
          type="button"
          className={activeTab === "forward" ? "primary-nav-item is-active" : "primary-nav-item"}
          onClick={() => setActiveTab("forward")}
          aria-pressed={activeTab === "forward"}
        >
          <span className="nav-index">01</span>
          <span>
            <strong>Forward vol</strong>
            <small>Calendar spread edges</small>
          </span>
        </button>
        <button
          type="button"
          className={activeTab === "preearnings" ? "primary-nav-item is-active" : "primary-nav-item"}
          onClick={() => setActiveTab("preearnings")}
          aria-pressed={activeTab === "preearnings"}
        >
          <span className="nav-index">02</span>
          <span>
            <strong>Pre-earnings</strong>
            <small>Viability checks</small>
          </span>
        </button>
        <button
          type="button"
          className={activeTab === "upcomingearnings" ? "primary-nav-item is-active" : "primary-nav-item"}
          onClick={() => setActiveTab("upcomingearnings")}
          aria-pressed={activeTab === "upcomingearnings"}
        >
          <span className="nav-index">03</span>
          <span>
            <strong>Earnings calendar</strong>
            <small>Upcoming announcements</small>
          </span>
        </button>
        <button
          type="button"
          className={activeTab === "howItWorks" ? "primary-nav-item is-active" : "primary-nav-item"}
          onClick={() => setActiveTab("howItWorks")}
          aria-pressed={activeTab === "howItWorks"}
        >
          <span className="nav-index">04</span>
          <span>
            <strong>How it works</strong>
            <small>Scanner explained</small>
          </span>
        </button>
      </nav>

      <div className="workspace">
        {activeTab === "forward" ? (
          <>
            <ManualEdgeCalculator />
            {watchlist.length > 0 ? (
              <section className="panel watchlist-panel">
                <div className="watchlist-header">
                  <div>
                    <p className="eyebrow">Saved symbols</p>
                    <h2>Watchlist</h2>
                  </div>
                  <button
                    type="button"
                    className="button-secondary button-compact"
                    onClick={() => void clearWatchlist()}
                    disabled={watchlistSyncing}
                  >
                    {watchlistSyncing ? "Syncing..." : "Clear watchlist"}
                  </button>
                </div>
                {watchForwardError ? <p className="error">{watchForwardError}</p> : null}
                {watchForwardRows.length > 0 ? (
                  <div className="table-wrap">
                    <table className="watchlist-table">
                      <thead>
                        <tr>
                          <th>Watch</th>
                          <th>Symbol</th>
                          <th>Company</th>
                          <th>Trade Class</th>
                          <th>Adj Edge</th>
                          <th>Forward Vol</th>
                          <th>Next Earnings</th>
                        </tr>
                      </thead>
                      <tbody>
                        {watchForwardRows.map((row) => (
                          <tr key={`${row.symbol}-${row.shortTargetDte}-${row.longTargetDte}-${row.selectedStrike}`} className={row.isViable ? "row-viable" : "row-not-viable"}>
                            <td>
                              <WatchlistButton
                                active
                                disabled={watchlistSyncing}
                                symbol={row.symbol}
                                onClick={() => void toggleWatchlistSymbol(row.symbol)}
                              />
                            </td>
                            <td className="cell-emphasis">{row.symbol}</td>
                            <td>{row.companyName}</td>
                            <td>{row.tradeClass ?? "—"}</td>
                            <td>{asPct(row.adjustedForwardVolEdge)}</td>
                            <td>{asPct(row.forwardVol)}</td>
                            <td>{row.nextEarningsDate ?? "No next earnings date available (likely too far in the future)."}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </section>
            ) : null}
            <section className="panel">
              <div className="section-header">
                <div>
                  <p className="eyebrow">Single-symbol screener</p>
                  <h2>Inspect calendar spread pairs</h2>
                  <p className="section-description">
                    Select a ticker to compare target tenors. Candidates and rejected trades are separated below.
                  </p>
                </div>
              </div>

              <div className="control-bar">
                <div className="field-group">
                  <label htmlFor="ticker-select">S&amp;P 500 ticker</label>
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
                          {ticker.symbol} - {ticker.name}
                        </option>
                      ))
                    )}
                  </select>
                </div>
                <div className="control-context">
                  <span>Automatic scan</span>
                  <strong>{rowsLoading ? "Calculating edge..." : symbol || "Choose a ticker"}</strong>
                </div>
              </div>

              {error ? <p className="error">{error}</p> : null}
              {rowsLoading ? <p className="notice notice--loading">Calculating forward volatility edge...</p> : null}
              {data?.isStale ? <p className="notice notice--warning">{data.warning}</p> : null}
              {!rowsLoading && !hasRows ? (
                <div className="empty-state">
                  <strong>No results available</strong>
                  <span>Choose another ticker or clear the cache and try again.</span>
                </div>
              ) : null}

              {data && hasRows ? (
                <>
                  <div className="summary-grid" aria-label={`${data.symbol} scan summary`}>
                    <article>
                      <span>Symbol</span>
                      <strong>{data.symbol}</strong>
                      <small>As of {formatTimeAgo(data.asOf)}</small>
                    </article>
                    <article>
                      <span>Pairs checked</span>
                      <strong>{data.rows.length}</strong>
                      <small>Target tenor combinations</small>
                    </article>
                    <article className="summary-positive">
                      <span>Candidates</span>
                      <strong>{viableForwardRows.length}</strong>
                      <small>Passed viability threshold</small>
                    </article>
                    <article className="summary-negative">
                      <span>Rejected</span>
                      <strong>{rejectedForwardRows.length}</strong>
                      <small>Review reasons and inputs</small>
                    </article>
                  </div>

                  <section className="results-section">
                    <div className="results-toolbar">
                      <div>
                        <h3>{data.symbol} trade results</h3>
                        <p>Use Details to inspect the risk profile for any calculable row.</p>
                      </div>
                      <div className="filter-chips" aria-label="Filter forward-vol results">
                        <button
                          type="button"
                          className={forwardFilters.viableOnly ? "chip chip-active" : "chip"}
                          onClick={() =>
                            setForwardFilters((current) => ({ ...current, viableOnly: !current.viableOnly }))
                          }
                          aria-pressed={forwardFilters.viableOnly}
                        >
                          Viable only
                        </button>
                        <button
                          type="button"
                          className={forwardFilters.tradeClass === "standard" ? "chip chip-active" : "chip"}
                          onClick={() =>
                            setForwardFilters((current) => ({
                              ...current,
                              tradeClass: current.tradeClass === "standard" ? "all" : "standard",
                            }))
                          }
                          aria-pressed={forwardFilters.tradeClass === "standard"}
                        >
                          Standard trades
                        </button>
                        <button
                          type="button"
                          className={forwardFilters.tradeClass === "earnings-exposed" ? "chip chip-active" : "chip"}
                          onClick={() =>
                            setForwardFilters((current) => ({
                              ...current,
                              tradeClass:
                                current.tradeClass === "earnings-exposed" ? "all" : "earnings-exposed",
                            }))
                          }
                          aria-pressed={forwardFilters.tradeClass === "earnings-exposed"}
                        >
                          Earnings-exposed
                        </button>
                      </div>
                    </div>

                    {visibleForwardRows.length > 0 ? (
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Watch</th>
                              <th>Pair (target)</th>
                              <th>Details</th>
                              <SortableHeader
                                column="tradeClass"
                                config={forwardSortConfig}
                                onSort={(column) => setForwardSortConfig((current) => toggleSort(current, column))}
                              >
                                Trade Class
                              </SortableHeader>
                              <SortableHeader
                                column="shortDteActual"
                                config={forwardSortConfig}
                                onSort={(column) => setForwardSortConfig((current) => toggleSort(current, column))}
                              >
                                Actual <AcronymHint short="DTEs" title="Days To Expiration" />
                              </SortableHeader>
                              <th>Next Earnings</th>
                              <th>Strike (ATM)</th>
                              <SortableHeader
                                column="ivShort"
                                config={forwardSortConfig}
                                onSort={(column) => setForwardSortConfig((current) => toggleSort(current, column))}
                              >
                                Short <AcronymHint short="IV" title="Implied Volatility" />
                              </SortableHeader>
                              <SortableHeader
                                column="ivLong"
                                config={forwardSortConfig}
                                onSort={(column) => setForwardSortConfig((current) => toggleSort(current, column))}
                              >
                                Long <AcronymHint short="IV" title="Implied Volatility" />
                              </SortableHeader>
                              <th>
                                Short <AcronymHint short="OI" title="Open Interest" />
                              </th>
                              <th>
                                Long <AcronymHint short="OI" title="Open Interest" />
                              </th>
                              <SortableHeader
                                column="forwardVol"
                                config={forwardSortConfig}
                                onSort={(column) => setForwardSortConfig((current) => toggleSort(current, column))}
                              >
                                Forward Vol
                              </SortableHeader>
                              <th>Raw Edge</th>
                              <SortableHeader
                                column="adjustedForwardVolEdge"
                                config={forwardSortConfig}
                                onSort={(column) => setForwardSortConfig((current) => toggleSort(current, column))}
                              >
                                Adj Edge
                              </SortableHeader>
                              <th>Status</th>
                              <th>Quote Time</th>
                              <th>Notes</th>
                            </tr>
                          </thead>
                          <tbody>
                            {visibleForwardRows.map((row, rowIndex) => {
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
                                <Fragment key={rowKey ?? `${symbol}-${row.shortTargetDte}-${row.longTargetDte}-${rowIndex}`}>
                                  <tr className={rowClass}>
                                    <td>
                                      <WatchlistButton
                                        active={watchlist.includes(symbol)}
                                        disabled={watchlistSyncing}
                                        symbol={symbol}
                                        onClick={() => void toggleWatchlistSymbol(symbol)}
                                      />
                                    </td>
                                    <td className="cell-emphasis">
                                      {row.shortTargetDte}/{row.longTargetDte}
                                    </td>
                                    <td>
                                      <button
                                        type="button"
                                        className="table-action"
                                        onClick={() => onToggleForwardRow(row)}
                                        disabled={!canDrilldown}
                                      >
                                        {isExpanded ? "Close" : "View"}
                                      </button>
                                    </td>
                                    <td>{row.tradeClass ?? "—"}</td>
                                    <td>
                                      {asNumber(row.shortDteActual)} / {asNumber(row.longDteActual)}
                                    </td>
                                    <td>{row.nextEarningsDate ?? "No next earnings date available (likely too far in the future)."}</td>
                                    <td>{asNumber(row.selectedStrike)}</td>
                                    <td>{asPct(row.ivShort)}</td>
                                    <td>{asPct(row.ivLong)}</td>
                                    <td>{asInteger(row.shortOpenInterest)}</td>
                                    <td>{asInteger(row.longOpenInterest)}</td>
                                    <td>{asPct(row.forwardVol)}</td>
                                    <td>{asPct(row.rawForwardVolEdge)}</td>
                                    <td>{asPct(row.adjustedForwardVolEdge)}</td>
                                    <td className="viability-cell">
                                      <span className="status-pill">{row.isViable ? "Candidate" : "Rejected"}</span>
                                    </td>
                                    <td>{row.quoteTime ? formatTimeAgo(row.quoteTime) : "—"}</td>
                                    <td className="notes-cell">{row.notes}</td>
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
                      </div>
                    ) : (
                      <div className="empty-state empty-state--compact">
                        <strong>
                          No matching trades
                        </strong>
                        <span>Adjust the filters to include more {data.symbol} results.</span>
                      </div>
                    )}
                  </section>
                </>
              ) : null}
            </section>

            <section className="panel">
              <div className="section-header section-header--action">
                <div>
                  <p className="eyebrow">Market-wide screener</p>
                  <h2>Rank the S&amp;P 500 universe</h2>
                  <p className="section-description">
                    Scan every symbol and review the best candidate or rejected setup returned for each company.
                  </p>
                </div>
                <button type="button" className="button-primary" onClick={() => void loadTopRows()} disabled={topRowsLoading}>
                  {topRowsLoading ? "Scanning S&P 500..." : "Run market scan"}
                </button>
              </div>

              {topRowsLoading ? <p className="notice notice--loading">Scanning symbols to find top edges...</p> : null}
              {!topRowsLoading && topScanMeta?.isWarming ? (
                <p className="notice notice--loading">
                  Market scan is in progress. Results refresh as each batch completes.
                </p>
              ) : null}
              {topError ? <p className="error">{topError}</p> : null}

              {topScanMeta ? (
                <>
                  <div className="summary-grid">
                    <article>
                      <span>Universe</span>
                      <strong>{topScanMeta.scannedSymbols}</strong>
                      <small>S&amp;P 500 symbols</small>
                    </article>
                    <article>
                      <span>Processed</span>
                      <strong>{topScanMeta.processedSymbols}</strong>
                      <small>{topScanMeta.isComplete ? "Scan complete" : "Still scanning"}</small>
                    </article>
                    <article className="summary-positive">
                      <span>Candidates</span>
                      <strong>{viableTopRows.length}</strong>
                      <small>Passed viability threshold</small>
                    </article>
                    <article className="summary-negative">
                      <span>Rejected</span>
                      <strong>{rejectedTopRows.length}</strong>
                      <small>Best row did not qualify</small>
                    </article>
                  </div>
                  <p className="scan-caption">
                    Snapshot from {formatTimeAgo(topScanMeta.asOf)}
                    {topScanMeta.isStale ? " - cached quotes are refreshing." : "."}
                  </p>
                </>
              ) : null}

              {hasTopRows ? (
                <section className="results-section">
                  <div className="results-toolbar">
                    <div>
                      <h3>Market scan results</h3>
                      <p>
                        {liquidityFirst
                          ? "Sorted by forward vol edge weighted with liquidity score."
                          : "Sorted by forward volatility edge within each result group."}
                      </p>
                    </div>
                    <div className="results-actions">
                      <button
                        type="button"
                        className="button-secondary button-compact"
                        onClick={exportViableTopRows}
                        disabled={viableTopRows.length === 0}
                      >
                        Export viable trades (HTML)
                      </button>
                      <div className="filter-chips" aria-label="Filter market scan results">
                        <button
                          type="button"
                          className={topForwardFilters.viableOnly ? "chip chip-active" : "chip"}
                          onClick={() =>
                            setTopForwardFilters((current) => ({ ...current, viableOnly: !current.viableOnly }))
                          }
                          aria-pressed={topForwardFilters.viableOnly}
                        >
                          Viable only
                        </button>
                        <button
                          type="button"
                          className={liquidityFirst ? "chip chip-active" : "chip"}
                          onClick={() => {
                            setLiquidityFirst((prev) => !prev);
                            void loadTopRows(true);
                          }}
                          aria-pressed={liquidityFirst}
                        >
                          Good liquidity first
                        </button>
                        <button
                          type="button"
                          className={topForwardFilters.tradeClass === "standard" ? "chip chip-active" : "chip"}
                          onClick={() =>
                            setTopForwardFilters((current) => ({
                              ...current,
                              tradeClass: current.tradeClass === "standard" ? "all" : "standard",
                            }))
                          }
                          aria-pressed={topForwardFilters.tradeClass === "standard"}
                        >
                          Standard trades
                        </button>
                        <button
                          type="button"
                          className={topForwardFilters.tradeClass === "earnings-exposed" ? "chip chip-active" : "chip"}
                          onClick={() =>
                            setTopForwardFilters((current) => ({
                              ...current,
                              tradeClass:
                                current.tradeClass === "earnings-exposed" ? "all" : "earnings-exposed",
                            }))
                          }
                          aria-pressed={topForwardFilters.tradeClass === "earnings-exposed"}
                        >
                          Earnings-exposed
                        </button>
                      </div>
                    </div>
                  </div>

                  {visibleTopRows.length > 0 ? (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Watch</th>
                            <SortableHeader
                              column="symbol"
                              config={topForwardSortConfig}
                              onSort={(column) =>
                                setTopForwardSortConfig((current) => toggleSort(current, column))
                              }
                            >
                              Symbol
                            </SortableHeader>
                            <th>Company</th>
                            <th>Pair (target)</th>
                            <th>Details</th>
                            <SortableHeader
                              column="tradeClass"
                              config={topForwardSortConfig}
                              onSort={(column) =>
                                setTopForwardSortConfig((current) => toggleSort(current, column))
                              }
                            >
                              Trade Class
                            </SortableHeader>
                            <SortableHeader
                              column="shortDteActual"
                              config={topForwardSortConfig}
                              onSort={(column) =>
                                setTopForwardSortConfig((current) => toggleSort(current, column))
                              }
                            >
                              Actual <AcronymHint short="DTEs" title="Days To Expiration" />
                            </SortableHeader>
                            <th>Next Earnings</th>
                            <th>Strike (ATM)</th>
                            <SortableHeader
                              column="ivShort"
                              config={topForwardSortConfig}
                              onSort={(column) =>
                                setTopForwardSortConfig((current) => toggleSort(current, column))
                              }
                            >
                              Short <AcronymHint short="IV" title="Implied Volatility" />
                            </SortableHeader>
                            <SortableHeader
                              column="ivLong"
                              config={topForwardSortConfig}
                              onSort={(column) =>
                                setTopForwardSortConfig((current) => toggleSort(current, column))
                              }
                            >
                              Long <AcronymHint short="IV" title="Implied Volatility" />
                            </SortableHeader>
                            <th>
                              Short <AcronymHint short="OI" title="Open Interest" />
                            </th>
                            <th>
                              Long <AcronymHint short="OI" title="Open Interest" />
                            </th>
                            <SortableHeader
                              column="liquidityScore"
                              config={topForwardSortConfig}
                              onSort={(column) =>
                                setTopForwardSortConfig((current) => toggleSort(current, column))
                              }
                            >
                              Liquidity{" "}
                              <span
                                className="info-icon"
                                title="Liquidity Score (0–100%): measures how easily you can enter/exit the trade. Combines open interest strength (≥500 is good) and bid-ask spread tightness (≤5% is ideal, >15% is poor). Higher score = more executable. This is a ranking weight, not a hard filter—strong-edge trades rank higher even with mediocre liquidity."
                              >
                                ℹ️
                              </span>
                            </SortableHeader>
                            <SortableHeader
                              column="forwardVol"
                              config={topForwardSortConfig}
                              onSort={(column) =>
                                setTopForwardSortConfig((current) => toggleSort(current, column))
                              }
                            >
                              Forward Vol
                            </SortableHeader>
                            <th>Raw Edge</th>
                            <SortableHeader
                              column="adjustedForwardVolEdge"
                              config={topForwardSortConfig}
                              onSort={(column) =>
                                setTopForwardSortConfig((current) => toggleSort(current, column))
                              }
                            >
                              Adj Edge
                            </SortableHeader>
                            <th>Status</th>
                            <th>Why ranked here</th>
                            <th>Quote Time</th>
                            <th>Notes</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleTopRows.map((row, rowIndex) => {
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
                              <Fragment key={rowKey ?? `${row.symbol}-${row.shortTargetDte}-${row.longTargetDte}-${rowIndex}`}>
                                <tr className={rowClass}>
                                  <td>
                                    <WatchlistButton
                                      active={watchlist.includes(row.symbol)}
                                      disabled={watchlistSyncing}
                                      symbol={row.symbol}
                                      onClick={() => void toggleWatchlistSymbol(row.symbol)}
                                    />
                                  </td>
                                  <td className="cell-emphasis">{row.symbol}</td>
                                  <td>{row.companyName}</td>
                                  <td>
                                    {row.shortTargetDte}/{row.longTargetDte}
                                  </td>
                                  <td>
                                    <button
                                      type="button"
                                      className="table-action"
                                      onClick={() => onToggleTopRow(row)}
                                      disabled={!canDrilldown}
                                    >
                                      {isExpanded ? "Close" : "View"}
                                    </button>
                                  </td>
                                  <td>{row.tradeClass ?? "—"}</td>
                                  <td>
                                    {asNumber(row.shortDteActual)} / {asNumber(row.longDteActual)}
                                  </td>
                                  <td>{row.nextEarningsDate ?? "No next earnings date available (likely too far in the future)."}</td>
                                  <td>{asNumber(row.selectedStrike)}</td>
                                  <td>{asPct(row.ivShort)}</td>
                                  <td>{asPct(row.ivLong)}</td>
                                  <td>{asInteger(row.shortOpenInterest)}</td>
                                  <td>{asInteger(row.longOpenInterest)}</td>
                                  <td title={
                                    row.shortBidAskSpreadPct != null && row.longBidAskSpreadPct != null
                                      ? `Short spread: ${asPct(row.shortBidAskSpreadPct)}, Long spread: ${asPct(row.longBidAskSpreadPct)}`
                                      : row.shortBidAskSpreadPct != null
                                        ? `Short spread: ${asPct(row.shortBidAskSpreadPct)}`
                                        : row.longBidAskSpreadPct != null
                                          ? `Long spread: ${asPct(row.longBidAskSpreadPct)}`
                                          : undefined
                                  }>
                                    {row.liquidityScore != null ? `${Math.round(row.liquidityScore * 100)}%` : "—"}
                                  </td>
                                  <td>{asPct(row.forwardVol)}</td>
                                  <td>{asPct(row.rawForwardVolEdge)}</td>
                                  <td>{asPct(row.adjustedForwardVolEdge)}</td>
                                  <td className="viability-cell">
                                    <span className="status-pill">{row.isViable ? "Candidate" : "Rejected"}</span>
                                  </td>
                                  <td className="ranking-reason">{row.rankingReason ?? "—"}</td>
                                  <td>{row.quoteTime ? formatTimeAgo(row.quoteTime) : "—"}</td>
                                  <td className="notes-cell">{row.notes}</td>
                                </tr>
                                {isExpanded ? (
                                  <tr className="row-drilldown">
                                    <td colSpan={21}>
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
                    </div>
                  ) : (
                    <div className="empty-state empty-state--compact">
                      <strong>
                        No matching market results
                      </strong>
                      <span>The active market scan has not returned rows for this group.</span>
                    </div>
                  )}
                </section>
              ) : !topRowsLoading ? (
                <div className="empty-state">
                  <strong>Ready for a market-wide scan</strong>
                  <span>Run the screener to rank the strongest edges across the S&amp;P 500.</span>
                </div>
              ) : null}
            </section>
          </>
        ) : activeTab === "preearnings" ? (
          <>
          {watchlist.length > 0 ? (
            <section className="panel watchlist-panel">
              <div className="watchlist-header">
                <div>
                  <p className="eyebrow">Saved symbols</p>
                  <h2>Watchlist</h2>
                </div>
                <button
                  type="button"
                  className="button-secondary button-compact"
                  onClick={() => void clearWatchlist()}
                  disabled={watchlistSyncing}
                >
                  {watchlistSyncing ? "Syncing..." : "Clear watchlist"}
                </button>
              </div>
              {watchPreError ? <p className="error">{watchPreError}</p> : null}
              {watchPreRows.length > 0 ? (
                <div className="table-wrap">
                  <table className="watchlist-table">
                    <thead>
                      <tr>
                        <th>Watch</th>
                        <th>Symbol</th>
                        <th>Company</th>
                        <th>Verdict</th>
                        <th>IV30/RV30</th>
                        <th>TS Slope</th>
                        <th>Days to Earnings</th>
                      </tr>
                    </thead>
                    <tbody>
                      {watchPreRows.map((row) => (
                        <tr key={`${row.symbol}-${row.nextEarningsDate}`} className={verdictClass(row)}>
                          <td>
                            <WatchlistButton
                              active
                              disabled={watchlistSyncing}
                              symbol={row.symbol}
                              onClick={() => void toggleWatchlistSymbol(row.symbol)}
                            />
                          </td>
                          <td className="cell-emphasis">{row.symbol}</td>
                          <td>{row.companyName}</td>
                          <td><span className="status-pill">{row.verdict}</span></td>
                          <td>{asNumber(row.iv30Rv30)}</td>
                          <td>{asNumber(row.tsSlope0To45)}</td>
                          <td>{daysUntilEarnings(row.nextEarningsDate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : !watchPreError ? (
                <p className="watchlist-empty">No saved symbol currently has a viable pre-earnings setup.</p>
              ) : null}
            </section>
          ) : null}
          <section className="panel">
            <div className="section-header section-header--action">
              <div>
                <p className="eyebrow">Pre-earnings screener</p>
                <h2>Validate volatility setups before earnings</h2>
                <p className="section-description">
                  Compare liquidity, implied-to-realized volatility, and term-structure checks across the universe.
                </p>
              </div>
              <button
                type="button"
                className="button-primary"
                onClick={() => void loadPreEarningsRows()}
                disabled={preRowsLoading}
              >
                {preRowsLoading ? "Scanning setups..." : "Run pre-earnings scan"}
              </button>
            </div>

            {preRowsLoading ? <p className="notice notice--loading">Evaluating pre-earnings viability checks...</p> : null}
            {!preRowsLoading && preMeta?.isWarming ? (
              <p className="notice notice--loading">
                Background scan is in progress. Cached results refresh as more symbols are processed.
              </p>
            ) : null}
            {preError ? <p className="error">{preError}</p> : null}

            {preMeta ? (
              <>
                <div className="summary-grid">
                  <article>
                    <span>Universe</span>
                    <strong>{preMeta.scannedSymbols}</strong>
                    <small>S&amp;P 500 symbols</small>
                  </article>
                  <article>
                    <span>Computed</span>
                    <strong>{preMeta.computedSymbols}</strong>
                    <small>{preMeta.evaluatedSymbols} attempted</small>
                  </article>
                  <article className="summary-positive">
                    <span>Viable</span>
                    <strong>{preMeta.viableSymbols}</strong>
                    <small>Passed all strategy checks</small>
                  </article>
                  <article className="summary-negative">
                    <span>Rejected</span>
                    <strong>{preMeta.rejectedSymbols}</strong>
                    <small>Data or criteria failures</small>
                  </article>
                </div>
                <p className="scan-caption">
                  Snapshot from {formatTimeAgo(preMeta.asOf)}
                  {preMeta.isStale ? " - cached quotes are refreshing." : "."}
                </p>
              </>
            ) : null}

            {preMeta ? (
              <section className="results-section">
                <div className="results-toolbar">
                  <div>
                    <h3>Pre-earnings results</h3>
                    <p>Rejected tickers retain the failed stage and reason for faster diagnosis.</p>
                  </div>
                  <div className="segmented-control" aria-label="Filter pre-earnings results">
                    <button
                      type="button"
                      className={preEarningsSubtab === "viable" ? "is-active" : ""}
                      onClick={() => setPreEarningsSubtab("viable")}
                      aria-pressed={preEarningsSubtab === "viable"}
                    >
                      Viable <span>{preRows.length}</span>
                    </button>
                    <button
                      type="button"
                      className={preEarningsSubtab === "rejected" ? "is-active" : ""}
                      onClick={() => setPreEarningsSubtab("rejected")}
                      aria-pressed={preEarningsSubtab === "rejected"}
                    >
                      Rejected <span>{preRejectedRows.length}</span>
                    </button>
                  </div>
                </div>

                {preEarningsSubtab === "viable" && hasPreRows ? (
                  <>
                  <div className="filter-chips filter-chips--table" aria-label="Filter viable pre-earnings results">
                    <button
                      type="button"
                      className={preFilter === "recommended" ? "chip chip-active" : "chip"}
                      onClick={() => setPreFilter("recommended")}
                      aria-pressed={preFilter === "recommended"}
                    >
                      Recommended only
                    </button>
                    <button
                      type="button"
                      className={preFilter === "consider-plus" ? "chip chip-active" : "chip"}
                      onClick={() => setPreFilter("consider-plus")}
                      aria-pressed={preFilter === "consider-plus"}
                    >
                      Consider+
                    </button>
                    <button
                      type="button"
                      className={preFilter === "all" ? "chip chip-active" : "chip"}
                      onClick={() => setPreFilter("all")}
                      aria-pressed={preFilter === "all"}
                    >
                      Show all
                    </button>
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Watch</th>
                          <SortableHeader
                            column="symbol"
                            config={preSortConfig}
                            onSort={(column) => setPreSortConfig((current) => toggleSort(current, column))}
                          >
                            Symbol
                          </SortableHeader>
                          <th>Company</th>
                          <th>Next Earnings</th>
                          <SortableHeader
                            column="nextEarningsDate"
                            config={preSortConfig}
                            onSort={(column) => setPreSortConfig((current) => toggleSort(current, column))}
                          >
                            Days to Earnings
                          </SortableHeader>
                          <th>Earnings Session</th>
                          <SortableHeader
                            column="verdict"
                            config={preSortConfig}
                            onSort={(column) => setPreSortConfig((current) => toggleSort(current, column))}
                          >
                            Verdict
                          </SortableHeader>
                          <th>Viable?</th>
                          <SortableHeader
                            column="avgVolume30"
                            config={preSortConfig}
                            onSort={(column) => setPreSortConfig((current) => toggleSort(current, column))}
                          >
                            Avg Vol 30d
                          </SortableHeader>
                          <SortableHeader
                            column="iv30Rv30"
                            config={preSortConfig}
                            onSort={(column) => setPreSortConfig((current) => toggleSort(current, column))}
                          >
                            <AcronymHint
                              short="IV30/RV30"
                              title="30-day Implied Volatility divided by 30-day Realized Volatility"
                            />
                          </SortableHeader>
                          <SortableHeader
                            column="tsSlope0To45"
                            config={preSortConfig}
                            onSort={(column) => setPreSortConfig((current) => toggleSort(current, column))}
                          >
                            <AcronymHint short="TS" title="Term Structure" /> Slope 0→45
                          </SortableHeader>
                          <th>Avg Vol Check</th>
                          <th>
                            <AcronymHint
                              short="IV30/RV30"
                              title="30-day Implied Volatility divided by 30-day Realized Volatility"
                            />{" "}
                            Check
                          </th>
                          <th>
                            <AcronymHint short="TS" title="Term Structure" /> Slope Check
                          </th>
                          <th>Expected Move</th>
                          <th>Quote Time</th>
                          <th>Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visiblePreRows.map((row) => (
                          <tr key={`${row.symbol}-${row.nextEarningsDate}`} className={verdictClass(row)}>
                            <td>
                              <WatchlistButton
                                active={watchlist.includes(row.symbol)}
                                disabled={watchlistSyncing}
                                symbol={row.symbol}
                                onClick={() => void toggleWatchlistSymbol(row.symbol)}
                              />
                            </td>
                            <td className="cell-emphasis">{row.symbol}</td>
                            <td>{row.companyName}</td>
                            <td>{row.nextEarningsDate ?? "No next earnings date available (likely too far in the future)."}</td>
                            <td>{daysUntilEarnings(row.nextEarningsDate)}</td>
                            <td>{row.earningsSession ?? "—"}</td>
                            <td>
                              <span className="status-pill">{row.verdict}</span>
                            </td>
                            <td className="viability-cell">{row.isViable ? "Yes" : "No"}</td>
                            <td>{asInteger(row.avgVolume30)}</td>
                            <td>{asNumber(row.iv30Rv30)}</td>
                            <td>{asNumber(row.tsSlope0To45)}</td>
                            <td>{row.avgVolumePass ? "PASS" : "FAIL"}</td>
                            <td>{row.iv30Rv30Pass ? "PASS" : "FAIL"}</td>
                            <td>{row.tsSlopePass ? "PASS" : "FAIL"}</td>
                            <td>{row.expectedMove ?? "—"}</td>
                            <td>{row.quoteTime ? formatTimeAgo(row.quoteTime) : "—"}</td>
                            <td className="notes-cell">{row.notes}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  </>
                ) : null}

                {preEarningsSubtab === "viable" && !hasPreRows ? (
                  <div className="empty-state empty-state--compact">
                    <strong>No viable setups</strong>
                    <span>No ticker passed every pre-earnings check in this scan.</span>
                  </div>
                ) : null}

                {preEarningsSubtab === "rejected" && hasPreRejectedRows ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Watch</th>
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
                            <AcronymHint
                              short="IV30/RV30"
                              title="30-day Implied Volatility divided by 30-day Realized Volatility"
                            />
                          </th>
                          <th>
                            <AcronymHint short="TS" title="Term Structure" /> Slope 0→45
                          </th>
                          <th>Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preRejectedRows.map((row) => (
                          <tr
                            key={`${row.symbol}-${row.rejectionStage}-${row.rejectionCategory}`}
                            className="row-invalid"
                          >
                            <td>
                              <WatchlistButton
                                active={watchlist.includes(row.symbol)}
                                disabled={watchlistSyncing}
                                symbol={row.symbol}
                                onClick={() => void toggleWatchlistSymbol(row.symbol)}
                              />
                            </td>
                            <td className="cell-emphasis">{row.symbol}</td>
                            <td>{row.companyName}</td>
                            <td>{row.nextEarningsDate ?? "No next earnings date available (likely too far in the future)."}</td>
                            <td>{row.earningsSession ?? "—"}</td>
                            <td>
                              <span className="status-pill">{row.rejectionCategory}</span>
                            </td>
                            <td>{row.rejectionStage}</td>
                            <td>{row.verdict ?? "—"}</td>
                            <td className="viability-cell">{row.wasComputed ? "Yes" : "No"}</td>
                            <td>{asInteger(row.avgVolume30)}</td>
                            <td>{asNumber(row.iv30Rv30)}</td>
                            <td>{asNumber(row.tsSlope0To45)}</td>
                            <td className="notes-cell">{row.rejectionReason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}

                {preEarningsSubtab === "rejected" && !hasPreRejectedRows ? (
                  <div className="empty-state empty-state--compact">
                    <strong>No rejected tickers</strong>
                    <span>Every evaluated ticker passed the available checks.</span>
                  </div>
                ) : null}
              </section>
            ) : !preRowsLoading ? (
              <div className="empty-state">
                <strong>Ready to evaluate earnings setups</strong>
                <span>Run the scan to compare candidates and rejected tickers side by side.</span>
              </div>
            ) : null}
          </section>
          </>
        ) : activeTab === "upcomingearnings" ? (
          <section className="panel">
            <div className="section-header section-header--action">
              <div>
                <p className="eyebrow">Earnings calendar</p>
                <h2>Plan entry and exit windows</h2>
                <p className="section-description">
                  Track announced earnings across the next three weeks with strategy timing attached.
                </p>
              </div>
              <button
                type="button"
                className="button-primary"
                onClick={() => void loadUpcomingEarningsRows()}
                disabled={upcomingRowsLoading}
              >
                {upcomingRowsLoading ? "Loading calendar..." : "Load earnings calendar"}
              </button>
            </div>

            <div className="strategy-callout">
              <span>Strategy timing</span>
              <strong>Enter 15 minutes before close on earnings day</strong>
              <span className="strategy-arrow" aria-hidden="true">
                →
              </span>
              <strong>Exit 15 minutes after the next-day open</strong>
            </div>

            {upcomingRowsLoading ? <p className="notice notice--loading">Fetching announced earnings calendar...</p> : null}
            {upcomingError ? <p className="error">{upcomingError}</p> : null}

            {upcomingMeta ? (
              <div className="summary-grid summary-grid--calendar">
                <article>
                  <span>Window</span>
                  <strong>{upcomingMeta.daysAhead} days</strong>
                  <small>Forward calendar range</small>
                </article>
                <article>
                  <span>Announcements</span>
                  <strong>{upcomingMeta.totalRows}</strong>
                  <small>Confirmed earnings events</small>
                </article>
              </div>
            ) : null}

            {hasUpcomingRows ? (
              <section className="results-section">
                <div className="results-toolbar">
                  <div>
                    <h3>Upcoming announcements</h3>
                    <p>{upcomingRows.length} scheduled events in the selected window.</p>
                  </div>
                </div>
                <div className="table-wrap">
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
                          <td className="cell-emphasis">{row.symbol}</td>
                          <td>{row.companyName}</td>
                          <td>{row.earningsDate}</td>
                          <td>{row.earningsSession ?? "—"}</td>
                          <td>{row.strategyEntry}</td>
                          <td>{row.strategyExit}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : !upcomingRowsLoading ? (
              <div className="empty-state">
                <strong>No calendar loaded</strong>
                <span>Load announced earnings to prepare the next strategy window.</span>
              </div>
            ) : null}
          </section>
        ) : (
          <section className="panel how-it-works-panel">
            <div className="section-header">
              <div>
                <p className="eyebrow">Documentation</p>
                <h2>How the market scanner works</h2>
                <p className="section-description">
                  A detailed walkthrough of every stage — from universe loading to ranked results.
                </p>
              </div>
            </div>

            <div className="how-it-works-body">

              <div className="hiw-section">
                <h3>Overview</h3>
                <p>
                  The scanner evaluates every S&amp;P 500 constituent against two complementary frameworks:
                  the <strong>Forward Volatility</strong> calendar-spread engine (tab 01) and the{" "}
                  <strong>Pre-earnings viability</strong> engine (tab 02). Both share the same market-data
                  pipeline but apply different scoring rules and serve different trade styles.
                </p>
              </div>

              <div className="hiw-section">
                <h3>End-to-end pipeline</h3>
                <ol className="hiw-steps">
                  <li>
                    <strong>Load universe.</strong> The app fetches the full S&amp;P 500 constituent list
                    from a public dataset (with a built-in fallback). This happens once at startup and is
                    cached so the dropdown is immediately available.
                  </li>
                  <li>
                    <strong>Background warm-up.</strong> As soon as the ticker list is ready the app kicks
                    off a background scan of the full universe. This spreads the expensive market-data
                    requests over time so that when you click a scan button the result is already (or nearly)
                    available.
                  </li>
                  <li>
                    <strong>Early rejection (pre-earnings only).</strong> In the Pre-earnings scanner,
                    symbols are filtered by announced earnings date before any option chain or historical bar
                    is fetched — only symbols with confirmed earnings within the next 21 calendar days
                    proceed. The Forward Vol scanner has no such filter: it evaluates every S&amp;P 500
                    symbol regardless of earnings timing.
                  </li>
                  <li>
                    <strong>Fetch option chain.</strong> For each surviving symbol the scanner calls the Cboe
                    delayed-quotes API to retrieve available expiry dates, then fetches the full call and put
                    chains for each selected expiry.
                  </li>
                  <li>
                    <strong>Select ATM contracts.</strong> For every expiry the scanner finds the call and
                    put whose strike is nearest to the current spot price. ATM implied volatility (IV) is
                    computed as the average of the call IV and the put IV for that strike.
                  </li>
                  <li>
                    <strong>Build the IV term structure.</strong> The set of{" "}
                    <code>(DTE, ATM IV)</code> points is assembled into a linear term structure.
                    Interpolation at any DTE (e.g. 30 or 45) is derived from this curve.
                  </li>
                  <li>
                    <strong>Compute indicators.</strong> Three quantitative checks are evaluated per symbol
                    (see indicator definitions below).
                  </li>
                  <li>
                    <strong>Assign verdict.</strong> Each symbol receives a{" "}
                    <em>recommended</em>, <em>consider</em>, or <em>avoid</em> verdict based on which
                    indicators pass.
                  </li>
                  <li>
                    <strong>Rank and return.</strong> Viable rows (<em>recommended</em> and{" "}
                    <em>consider</em>) are ranked and the top N are returned. Rejected symbols are included
                    in the Rejected tickers subtab with an explicit reason.
                  </li>
                </ol>
              </div>

              <div className="hiw-section">
                <h3>Indicator definitions</h3>

                <div className="hiw-indicator">
                  <h4>
                    <span className="hiw-indicator-badge">1</span>{" "}
                    Average 30-day volume{" "}
                    <code className="hiw-code-inline">avg_volume</code>
                  </h4>
                  <p>
                    The mean daily traded volume over the last 30 sessions, sourced from Nasdaq historical
                    OHLCV data.
                  </p>
                  <div className="hiw-formula">
                    <code>avgVolume30 = mean(volume[−30:])</code>
                  </div>
                  <p>
                    <strong>Pass threshold:</strong> <code>avgVolume30 ≥ 1,500,000</code>
                  </p>
                  <p className="hiw-intuition">
                    <em>Why it matters:</em> low-volume stocks have wide bid/ask spreads in the options
                    market. Even if the setup looks attractive on paper, execution quality (slippage) can
                    erase the edge. This filter ensures the stock is liquid enough to fill at a reasonable
                    price.
                  </p>
                </div>

                <div className="hiw-indicator">
                  <h4>
                    <span className="hiw-indicator-badge">2</span>{" "}
                    IV30 / RV30{" "}
                    <code className="hiw-code-inline">iv30_rv30</code>
                  </h4>
                  <p>
                    <strong>IV30</strong> is the 30-DTE implied volatility interpolated from the ATM IV term
                    structure. <strong>RV30</strong> is the Yang-Zhang annualized realized volatility
                    computed from the last 30 daily bars.
                  </p>
                  <div className="hiw-formula">
                    <code>iv30_rv30 = IV30 / RV30</code>
                  </div>
                  <p>
                    <strong>Pass threshold:</strong> <code>iv30_rv30 ≥ 1.25</code>
                  </p>
                  <p className="hiw-intuition">
                    <em>Why it matters:</em> a ratio above 1 means the market is pricing future movement
                    higher than the stock has actually been moving. A ratio of 1.25 or above signals a clear
                    volatility premium — the kind of environment where selling premium or running a
                    short-vol strategy has a statistical edge.
                  </p>
                </div>

                <div className="hiw-indicator">
                  <h4>
                    <span className="hiw-indicator-badge">3</span>{" "}
                    Term-structure slope (0 → 45 DTE){" "}
                    <code className="hiw-code-inline">ts_slope_0_45</code>
                  </h4>
                  <p>
                    The slope of the IV term structure measured between the first valid near-term expiry and
                    the 45-DTE interpolated point.
                  </p>
                  <div className="hiw-formula">
                    <code>tsSlope0To45 = (IV(45) − IV(dteFirst)) / (45 − dteFirst)</code>
                  </div>
                  <p>
                    <strong>Pass threshold:</strong> <code>tsSlope0To45 ≤ −0.00406</code>
                  </p>
                  <p className="hiw-intuition">
                    <em>Why it matters:</em> a sufficiently negative slope means front-end IV is elevated
                    relative to medium-term IV — i.e. the near-term expiry is &ldquo;expensive&rdquo;
                    relative to further-out expiries. This shape is consistent with pre-earnings richness and
                    supports short-premium strategies where you sell the expensive near-term vol.
                  </p>
                </div>
              </div>

              <div className="hiw-section">
                <h3>Forward Volatility Edge (tab 01)</h3>
                <p>
                  In addition to the three viability indicators the Forward Vol tab computes a{" "}
                  <strong>Forward Volatility Edge</strong> for every short/long expiry pair you select.
                </p>
                <div className="hiw-formula">
                  <code>forwardVariance = (IV_long² × T_long − IV_short² × T_short) / (T_long − T_short)</code>
                  <br />
                  <code>forwardVol = √max(forwardVariance, 0)</code>
                  <br />
                  <code>forwardVolEdge = IV_short / forwardVol − 1</code>
                </div>
                <p>
                  A <strong>positive edge</strong> means the short-dated IV is higher than the implied
                  forward volatility between the two expiries — the market is pricing the near leg richer
                  than the far leg, which is the core signal for a calendar spread entry.
                </p>
                <p>
                  Default target pairs are <strong>30/60</strong>, <strong>45/75</strong>, and{" "}
                  <strong>60/90</strong> DTE. When exact expiries do not exist the scanner selects the
                  nearest available expiry subject to a minimum 7-day gap between legs.
                </p>
              </div>

              <div className="hiw-section">
                <h3>Verdict logic</h3>
                <div className="hiw-verdict-grid">
                  <div className="hiw-verdict hiw-verdict--recommended">
                    <strong>Recommended</strong>
                    <p>All three indicators pass: volume ✓, IV30/RV30 ✓, term-structure slope ✓.</p>
                    <p className="hiw-intuition">Strongest-conviction bucket. All conditions align.</p>
                  </div>
                  <div className="hiw-verdict hiw-verdict--consider">
                    <strong>Consider</strong>
                    <p>
                      Term-structure slope passes <strong>and</strong> exactly one of volume or IV30/RV30
                      also passes.
                    </p>
                    <p className="hiw-intuition">
                      Worth a manual review. The curve shape supports the setup but one confirming signal is
                      missing.
                    </p>
                  </div>
                  <div className="hiw-verdict hiw-verdict--avoid">
                    <strong>Avoid</strong>
                    <p>All other combinations.</p>
                    <p className="hiw-intuition">
                      Liquidity is weak, vol premium is insufficient, or the term-structure shape is
                      unfavorable.
                    </p>
                  </div>
                </div>
              </div>

              <div className="hiw-section">
                <h3>Ranking order</h3>
                <p>Viable results are returned ranked by the following priority (highest first):</p>
                <ol className="hiw-rank-list">
                  <li>Symbols with earnings <strong>today</strong> (using the US market calendar date).</li>
                  <li>Earliest announced earnings date among remaining symbols.</li>
                  <li>
                    Verdict priority: <em>recommended</em> &gt; <em>consider</em>.
                  </li>
                  <li>Higher <code>iv30_rv30</code> ratio.</li>
                  <li>
                    More favorable term-structure slope (more negative <code>tsSlope0To45</code>).
                  </li>
                </ol>
              </div>

              <div className="hiw-section">
                <h3>Expected move</h3>
                <p>
                  Displayed as context (not a pass/fail rule). The expected move is estimated from the ATM
                  straddle price at the first near-term expiry:
                </p>
                <div className="hiw-formula">
                  <code>straddle = callMid + putMid</code>
                  <br />
                  <code>expectedMovePct = (straddle / spot) × 100</code>
                </div>
                <p>
                  This gives a quick sense of how much the market is pricing the stock to move by expiry —
                  useful for sizing and risk-management but not used in the viability verdict.
                </p>
              </div>

              <div className="hiw-section">
                <h3>Performance safeguards</h3>
                <ul className="hiw-safeguards">
                  <li>
                    <strong>In-flight deduplication.</strong> If two requests for the same symbol arrive
                    simultaneously, only one option-chain fetch is made; both callers share the result.
                  </li>
                  <li>
                    <strong>60-minute cache.</strong> Option chains and completed pre-earnings scan snapshots
                    are cached for 60 minutes and reused across button clicks and server restarts.
                  </li>
                  <li>
                    <strong>Disk persistence.</strong> Completed scan snapshots are written to disk so a
                    server restart reloads a fresh-enough scan instantly without re-fetching all data.
                  </li>
                  <li>
                    <strong>Early earnings filter (pre-earnings only).</strong> In the Pre-earnings scanner,
                    symbols outside the 21-day announced-earnings window are rejected before any option or
                    historical-bar request is made, keeping cold scans fast. The Forward Vol scanner does not
                    apply this filter.
                  </li>
                  <li>
                    <strong>Rate-limit handling.</strong> Cboe requests are paced with a 1,500 ms gap.
                    Symbols that hit HTTP 429 / Cloudflare 1015 are retried up to 5 times with progressive
                    back-off before being marked as data-failed.
                  </li>
                  <li>
                    <strong>UI timeout guard.</strong> All UI-triggered API calls are wrapped with a 30-second
                    (60 s for forward-vol) timeout so loading states cannot hang indefinitely.
                  </li>
                  <li>
                    <strong>Non-blocking scan return.</strong> The endpoint returns the latest cached
                    snapshot immediately while a background scan continues. The UI auto-refreshes
                    progress, so the button never blocks waiting for the full scan to finish.
                  </li>
                </ul>
              </div>

              <div className="hiw-section">
                <h3>Data sources</h3>
                <ul className="hiw-sources">
                  <li>
                    <strong>Option chains:</strong> Cboe delayed-quotes options API
                  </li>
                  <li>
                    <strong>Historical OHLCV (volume &amp; RV30):</strong> Nasdaq historical quote API
                  </li>
                  <li>
                    <strong>Earnings calendar:</strong> Nasdaq earnings calendar API
                  </li>
                  <li>
                    <strong>S&amp;P 500 universe:</strong> public constituents dataset with built-in fallback
                  </li>
                </ul>
                <p className="hiw-intuition">
                  All market data is delayed (not real-time). Prices and IV values reflect the latest
                  available delayed snapshot from each provider.
                </p>
              </div>

              <div className="hiw-section">
                <h3>Liquidity-weighted ranking (tab 01)</h3>
                <p>
                  Beyond the forward volatility edge, the scanner ranks results by <strong>liquidity</strong> to ensure you can actually
                  execute the trade efficiently. The "Good liquidity first" toggle weights results toward setups with:
                </p>
                <ul className="hiw-list">
                  <li>
                    <strong>Strong open interest</strong> on both legs: trades with OI ≥ 500 score higher than those below 100.
                  </li>
                  <li>
                    <strong>Tight bid-ask spreads</strong>: spreads ≤ 5% of mid-price are ideal; spreads &gt; 15% get flagged as poor liquidity.
                  </li>
                </ul>
                <p>
                  The <strong>Liquidity score</strong> (0–100%) combines both signals: open interest quality and spread width.
                  Each ranks equally: <code>liquidityScore = 0.5 × OI_score + 0.5 × spread_score</code>.
                </p>
                <p>
                  <em>How it affects ranking:</em> When "Good liquidity first" is active, results are sorted by a{" "}
                  <strong>composite metric: forwardVolEdge + 0.1 × liquidityScore</strong>. A 10% liquidity advantage can lift a
                  marginal-edge trade up the list, but a strong edge (e.g., 40%) will always rank above a weak edge (e.g., 25%)
                  even if liquidity is worse. This keeps high-conviction trades at the top while preferring executable setups within
                  the same edge tier.
                </p>
                <p>
                  <em>Data used:</em> Open interest is streamed live from the options chain; bid-ask spreads are computed from the
                  mid-market quote on each leg at the time of the scan.
                </p>
              </div>

              <div className="hiw-section">
                <h3>What this tool does not do</h3>
                <ul className="hiw-nongoals">
                  <li>Place or route trades.</li>
                  <li>Backtest strategy performance.</li>
                  <li>Enforce liquidity filters beyond the average-volume indicator.</li>
                  <li>Provide real-time streaming quotes.</li>
                </ul>
              </div>

            </div>
          </section>
        )}
      </div>
    </main>
  );
}
