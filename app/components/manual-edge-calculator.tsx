"use client";

import { useMemo, useState } from "react";

import { computeForwardVolMetrics, getDteDays } from "@/lib/forward-vol";

function parseExpiryToUnix(dateStr: string): number | null {
  if (!dateStr) {
    return null;
  }
  // Assume standard US options expiration cutoff (4pm ET / 20:00 UTC in winter).
  const parsed = new Date(`${dateStr}T20:00:00Z`);
  const time = parsed.getTime();
  if (Number.isNaN(time)) {
    return null;
  }
  return Math.floor(time / 1000);
}

export function ManualEdgeCalculator() {
  const [shortExpiry, setShortExpiry] = useState("");
  const [shortIv, setShortIv] = useState("");
  const [longExpiry, setLongExpiry] = useState("");
  const [longIv, setLongIv] = useState("");

  const result = useMemo(() => {
    const shortIvNum = parseFloat(shortIv);
    const longIvNum = parseFloat(longIv);
    if (!shortExpiry || !longExpiry || !Number.isFinite(shortIvNum) || !Number.isFinite(longIvNum)) {
      return null;
    }

    const shortUnix = parseExpiryToUnix(shortExpiry);
    const longUnix = parseExpiryToUnix(longExpiry);
    if (shortUnix === null || longUnix === null) {
      return null;
    }

    const shortDteDays = getDteDays(shortUnix);
    const longDteDays = getDteDays(longUnix);
    const metrics = computeForwardVolMetrics(shortIvNum / 100, longIvNum / 100, shortDteDays, longDteDays);

    return { metrics, shortDteDays, longDteDays };
  }, [shortExpiry, shortIv, longExpiry, longIv]);

  return (
    <section className="panel">
      <div className="section-header">
        <div>
          <p className="eyebrow">Manual override</p>
          <h2>Manual edge calculator</h2>
          <p className="section-description">
            Enter expirations and implied volatilities directly to recompute the forward vol edge instantly
            &mdash; useful when the underlying moves during the day and the scanned results go stale.
          </p>
        </div>
      </div>

      <div className="control-bar">
        <div className="field-group">
          <label htmlFor="manual-short-expiry">Short expiration date</label>
          <input
            id="manual-short-expiry"
            type="date"
            value={shortExpiry}
            onChange={(event) => setShortExpiry(event.target.value)}
          />
        </div>
        <div className="field-group">
          <label htmlFor="manual-short-iv">Short IV (%)</label>
          <input
            id="manual-short-iv"
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            placeholder="e.g. 45.5"
            value={shortIv}
            onChange={(event) => setShortIv(event.target.value)}
          />
        </div>
        <div className="field-group">
          <label htmlFor="manual-long-expiry">Long expiration date</label>
          <input
            id="manual-long-expiry"
            type="date"
            value={longExpiry}
            onChange={(event) => setLongExpiry(event.target.value)}
          />
        </div>
        <div className="field-group">
          <label htmlFor="manual-long-iv">Long IV (%)</label>
          <input
            id="manual-long-iv"
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            placeholder="e.g. 38.2"
            value={longIv}
            onChange={(event) => setLongIv(event.target.value)}
          />
        </div>
      </div>

      {!result ? (
        <p className="section-description">
          Fill in both expiration dates and implied volatilities to see the edge.
        </p>
      ) : result.metrics.status === "invalid" ? (
        <p className="error">{result.metrics.reason}</p>
      ) : (
        <>
          <div className="summary-grid" aria-label="Manual edge calculation result">
            <article>
              <span>Short DTE</span>
              <strong>{result.shortDteDays.toFixed(1)}d</strong>
            </article>
            <article>
              <span>Long DTE</span>
              <strong>{result.longDteDays.toFixed(1)}d</strong>
            </article>
            <article>
              <span>Forward vol</span>
              <strong>{(result.metrics.forwardVol * 100).toFixed(2)}%</strong>
            </article>
            <article className={result.metrics.isViable ? "summary-positive" : "summary-negative"}>
              <span>Forward vol edge</span>
              <strong>{(result.metrics.forwardVolEdge * 100).toFixed(2)}%</strong>
              <small>{result.metrics.isViable ? "Viable (edge > 0)" : "Not viable"}</small>
            </article>
          </div>
          {result.metrics.isLowConfidence ? (
            <p className="notice notice--warning">
              Low confidence: forward variance was near zero and was clipped to a floor value.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
