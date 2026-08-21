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

  if (loading || !analytics) {
    return null;
  }

  return (
    <div className="grid grid-cols-4 gap-4">
      <div className="bg-white rounded-lg shadow p-6">
        <p className="text-gray-600 text-sm font-medium mb-2">Total Net PnL</p>
        <p className={`text-3xl font-bold ${analytics.totalNetPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
          ${analytics.totalNetPnl.toFixed(2)}
        </p>
      </div>

      <div className="bg-white rounded-lg shadow p-6">
        <p className="text-gray-600 text-sm font-medium mb-2">Win Rate</p>
        <p className="text-3xl font-bold text-blue-600">
          {(analytics.winRate * 100).toFixed(1)}%
        </p>
        <p className="text-xs text-gray-500 mt-1">
          {analytics.winCount} wins / {analytics.closedTradeCount} trades
        </p>
      </div>

      <div className="bg-white rounded-lg shadow p-6">
        <p className="text-gray-600 text-sm font-medium mb-2">Profit Factor</p>
        <p className="text-3xl font-bold text-purple-600">
          {analytics.profitFactor.toFixed(2)}
        </p>
      </div>

      <div className="bg-white rounded-lg shadow p-6">
        <p className="text-gray-600 text-sm font-medium mb-2">Average Win / Loss</p>
        <div className="space-y-1">
          <p className="text-sm font-semibold text-green-600">
            W: ${analytics.averageWin.toFixed(2)}
          </p>
          <p className="text-sm font-semibold text-red-600">
            L: $({Math.abs(analytics.averageLoss).toFixed(2)})
          </p>
        </div>
      </div>
    </div>
  );
}
