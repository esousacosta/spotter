import type { RankedForwardVolRow } from "./types";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatNumber(value: number | null, digits = 2): string {
  return value === null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function formatPercent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(2)}%`;
}

function formatInteger(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : Math.round(value).toString();
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return "—";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().replace(".000Z", "Z");
}

function tableCell(value: string): string {
  return `<td>${escapeHtml(value)}</td>`;
}

export function buildMarketScanHtml(rows: RankedForwardVolRow[], asOf: string): string {
  const viableRows = rows.filter((row) => row.isViable);
  const generatedAt = new Date().toISOString();
  const body = viableRows
    .map((row) => {
      const cells = [
        row.symbol,
        row.companyName,
        `${row.shortTargetDte}/${row.longTargetDte}`,
        row.tradeClass ?? "—",
        `${formatNumber(row.shortDteActual)} / ${formatNumber(row.longDteActual)}`,
        row.shortExpiry ?? "—",
        row.longExpiry ?? "—",
        row.nextEarningsDate ?? "—",
        formatNumber(row.selectedStrike),
        formatPercent(row.ivShort),
        formatPercent(row.ivLong),
        formatInteger(row.shortOpenInterest),
        formatInteger(row.longOpenInterest),
        formatPercent(row.forwardVol),
        formatPercent(row.rawForwardVolEdge),
        formatPercent(row.adjustedForwardVolEdge),
        row.rankingReason ?? "—",
        formatDateTime(row.quoteTime),
        row.notes,
      ];
      return `        <tr>${cells.map(tableCell).join("")}</tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Viable market scan trades</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; padding: 2rem; color: #172033; background: #f4f7fb; }
    h1 { margin: 0 0 .35rem; font-size: 1.6rem; }
    .meta { margin: 0 0 1.5rem; color: #526078; }
    .table-wrap { overflow-x: auto; border: 1px solid #d8e0eb; border-radius: 10px; background: #fff; }
    table { width: 100%; border-collapse: collapse; white-space: nowrap; }
    th, td { border-bottom: 1px solid #e4e9f0; padding: .65rem .75rem; text-align: left; font-size: .8rem; }
    th { color: #46546b; background: #edf2f8; font-size: .7rem; text-transform: uppercase; }
    tbody tr:last-child td { border-bottom: 0; }
    tbody tr:nth-child(even) { background: #f8fafc; }
  </style>
</head>
<body>
  <h1>Viable market scan trades</h1>
  <p class="meta">Scan snapshot: ${escapeHtml(formatDateTime(asOf))} · Exported: ${escapeHtml(generatedAt)} · ${viableRows.length} trade${viableRows.length === 1 ? "" : "s"}</p>
  <div class="table-wrap">
    <table>
      <thead>
        <tr><th>Symbol</th><th>Company</th><th>Target DTE Pair</th><th>Trade Class</th><th>Actual DTEs</th><th>Short Expiry</th><th>Long Expiry</th><th>Next Earnings</th><th>Strike (ATM)</th><th>Short IV</th><th>Long IV</th><th>Short OI</th><th>Long OI</th><th>Forward Vol</th><th>Raw Edge</th><th>Adjusted Edge</th><th>Ranking Reason</th><th>Quote Time</th><th>Notes</th></tr>
      </thead>
      <tbody>
${body}
      </tbody>
    </table>
  </div>
</body>
</html>`;
}

export function marketScanHtmlFilename(asOf: string): string {
  const parsed = new Date(asOf);
  const date = Number.isNaN(parsed.getTime()) ? new Date().toISOString().slice(0, 10) : parsed.toISOString().slice(0, 10);
  return `viable-market-trades-${date}.html`;
}
