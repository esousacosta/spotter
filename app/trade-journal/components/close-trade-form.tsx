'use client';

import { useState } from 'react';
import type { TradeWithLegs } from '@/lib/server/trade-journal-service';

interface CloseTradeFormProps {
  trade: TradeWithLegs;
  onSuccess: (trade: TradeWithLegs) => void;
  onCancel: () => void;
}

// Numeric fields are kept as raw strings while the user is typing so the
// input can be freely cleared without React snapping a coerced number back
// into the field on every keystroke. They are only parsed into numbers,
// falling back to 0, when the form is submitted.
function parseNumberField(rawValue: string) {
  const parsed = parseFloat(rawValue);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function CloseTradeForm({ trade, onSuccess, onCancel }: CloseTradeFormProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exitNetCredit, setExitNetCredit] = useState('0');
  const [exitCommissions, setExitCommissions] = useState('0');
  const [legExitPrices, setLegExitPrices] = useState<Record<string, string>>(
    Object.fromEntries(trade.legs.map(leg => [leg.id, '0']))
  );
  const [legExitCommissions, setLegExitCommissions] = useState<Record<string, string>>(
    Object.fromEntries(trade.legs.map(leg => [leg.id, '0']))
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
          exitNetCredit: parseNumberField(exitNetCredit),
          exitCommissions: parseNumberField(exitCommissions),
          legs: trade.legs.map(leg => ({
            legId: leg.id,
            exitPrice: parseNumberField(legExitPrices[leg.id] ?? '0'),
            exitCommission: parseNumberField(legExitCommissions[leg.id] ?? '0'),
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
            onChange={e => setExitNetCredit(e.target.value)}
          />
        </div>

        <div>
          <label>Exit Commissions ($)</label>
          <input
            type="number"
            step="0.01"
            value={exitCommissions}
            onChange={e => setExitCommissions(e.target.value)}
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
                value={legExitPrices[leg.id] ?? '0'}
                onChange={e =>
                  setLegExitPrices(prev => ({ ...prev, [leg.id]: e.target.value }))
                }
              />
            </div>
            <div>
              <label>Exit Commission ($)</label>
              <input
                type="number"
                step="0.01"
                value={legExitCommissions[leg.id] ?? '0'}
                onChange={e =>
                  setLegExitCommissions(prev => ({ ...prev, [leg.id]: e.target.value }))
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
