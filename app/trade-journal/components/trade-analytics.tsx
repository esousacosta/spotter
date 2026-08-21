'use client';

import { useEffect, useState } from 'react';
import type { TradeAnalytics } from '@/lib/server/trade-journal-service';

export function TradeAnalytics() {
  const [analytics, setAnalytics] = useState<TradeAnalytics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadAnalytics = async () => {
      try {
        const res = await fetch('/api/trade-journal/analytics');
        if (res.ok) {
          const data = await res.json();
          setAnalytics(data);
        }
      } catch (err) {
        console.error('Failed to load analytics:', err);
      } finally {
        setLoading(false);
      }
    };

    loadAnalytics();
  }, []);

  if (loading) {
    return <p className="muted">Loading analytics…</p>;
  }

  if (!analytics) {
    return <p className="muted">No analytics available yet.</p>;
  }

  return (
    <div className="summary-grid">
      <article className={analytics.totalNetPnl >= 0 ? 'summary-positive' : 'summary-negative'}>
        <span>Total Net PnL</span>
        <strong>${analytics.totalNetPnl.toFixed(2)}</strong>
      </article>

      <article>
        <span>Win Rate</span>
        <strong>{(analytics.winRate * 100).toFixed(1)}%</strong>
        <small>
          {analytics.winCount} wins / {analytics.closedTradeCount} trades
        </small>
      </article>

      <article>
        <span>Profit Factor</span>
        <strong>{analytics.profitFactor.toFixed(2)}</strong>
      </article>

      <article>
        <span>Average Win / Loss</span>
        <strong className="value-positive" style={{ fontSize: '1rem' }}>
          W: ${analytics.averageWin.toFixed(2)}
        </strong>
        <small className="value-negative">
          L: (${Math.abs(analytics.averageLoss).toFixed(2)})
        </small>
      </article>
    </div>
  );
}
