'use client';

import { useState } from 'react';
import type { TradeWithLegs } from '@/lib/server/trade-journal-service';

interface CloseTradeFormProps {
  trade: TradeWithLegs;
  onSuccess: (trade: TradeWithLegs) => void;
  onCancel: () => void;
}

function toNumber(rawValue: string) {
  const parsed = parseFloat(rawValue);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function CloseTradeForm({ trade, onSuccess, onCancel }: CloseTradeFormProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exitNetCredit, setExitNetCredit] = useState(0);
  const [exitCommissions, setExitCommissions] = useState(0);
  const [legExitPrices, setLegExitPrices] = useState<Record<string, number>>(
    Object.fromEntries(trade.legs.map(leg => [leg.id, 0]))
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/trade-journal/${trade.id}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          closedAt: new Date().toISOString(),
          exitNetCredit,
          exitCommissions,
          legs: trade.legs.map(leg => ({
            legId: leg.id,
            exitPrice: legExitPrices[leg.id] ?? 0,
          })),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to close trade');
      }

      const updatedTrade = await res.json();
      onSuccess(updatedTrade);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="trade-form">
      {error && <p className="error">{error}</p>}

      <div className="trade-form-grid">
        <div>
          <label>Exit Credit ($)</label>
          <input
            type="number"
            step="0.01"
            required
            value={exitNetCredit}
            onChange={e => setExitNetCredit(toNumber(e.target.value))}
          />
        </div>

        <div>
          <label>Exit Commissions ($)</label>
          <input
            type="number"
            step="0.01"
            value={exitCommissions}
            onChange={e => setExitCommissions(toNumber(e.target.value))}
          />
        </div>
      </div>

      <div>
        <h3>Leg Exit Prices</h3>
        {trade.legs.map(leg => (
          <div key={leg.id} className="leg-card">
            <div className="leg-card-header">
              <span>
                {leg.side} {leg.optionType} ${leg.strike} exp {leg.expirationDate}
              </span>
            </div>
            <div>
              <label>Exit Price</label>
              <input
                type="number"
                step="0.01"
                required
                value={legExitPrices[leg.id] ?? 0}
                onChange={e =>
                  setLegExitPrices(prev => ({ ...prev, [leg.id]: toNumber(e.target.value) }))
                }
              />
            </div>
          </div>
        ))}
      </div>

      <div className="form-actions">
        <button type="submit" disabled={loading} className="button-primary">
          {loading ? 'Closing...' : 'Confirm Close'}
        </button>
        <button type="button" onClick={onCancel} className="button-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}
