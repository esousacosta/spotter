'use client';

import { useState } from 'react';
import type { TradeWithLegs } from '@/lib/server/trade-journal-service';

interface CreateTradeFormProps {
  onSuccess: (trade: TradeWithLegs) => void;
  onCancel: () => void;
}

// Numeric inputs report an empty string while being cleared/edited; parsing
// that yields NaN, which React logs a warning for on a controlled `value`.
// Fall back to 0 so the input always receives a valid number.
function toNumber(rawValue: string, parser: (value: string) => number) {
  const parsed = parser(rawValue);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function CreateTradeForm({ onSuccess, onCancel }: CreateTradeFormProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    symbol: '',
    strategy: '',
    quantity: 1,
    contractMultiplier: 100,
    entryNetDebit: 0,
    entryCommissions: 0,
    edgeAtEntry: 0,
    notes: '',
    legs: [
      {
        side: 'buy' as const,
        optionType: 'call' as const,
        quantity: 1,
        strike: 0,
        expirationDate: '',
        entryPrice: 0,
      },
    ],
  });

  const handleInputChange = (field: string, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleLegChange = (legIndex: number, field: string, value: any) => {
    setFormData(prev => ({
      ...prev,
      legs: prev.legs.map((leg, idx) =>
        idx === legIndex ? { ...leg, [field]: value } : leg
      ),
    }));
  };

  const addLeg = () => {
    setFormData(prev => ({
      ...prev,
      legs: [
        ...prev.legs,
        {
          side: 'buy' as const,
          optionType: 'call' as const,
          quantity: 1,
          strike: 0,
          expirationDate: '',
          entryPrice: 0,
        },
      ],
    }));
  };

  const removeLeg = (legIndex: number) => {
    if (formData.legs.length > 1) {
      setFormData(prev => ({
        ...prev,
        legs: prev.legs.filter((_, idx) => idx !== legIndex),
      }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/trade-journal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData,
          openedAt: new Date().toISOString(),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create trade');
      }

      const newTrade = await res.json();
      onSuccess(newTrade);
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
          <label>Symbol</label>
          <input
            type="text"
            required
            value={formData.symbol}
            onChange={e => handleInputChange('symbol', e.target.value)}
            placeholder="AAPL"
          />
        </div>

        <div>
          <label>Strategy</label>
          <input
            type="text"
            required
            value={formData.strategy}
            onChange={e => handleInputChange('strategy', e.target.value)}
            placeholder="forward-vol-calendar"
          />
        </div>

        <div>
          <label>Quantity</label>
          <input
            type="number"
            required
            value={formData.quantity}
            onChange={e => handleInputChange('quantity', toNumber(e.target.value, parseInt))}
          />
        </div>

        <div>
          <label>Entry Debit ($)</label>
          <input
            type="number"
            step="0.01"
            required
            value={formData.entryNetDebit}
            onChange={e => handleInputChange('entryNetDebit', toNumber(e.target.value, parseFloat))}
          />
        </div>

        <div>
          <label>Entry Commissions ($)</label>
          <input
            type="number"
            step="0.01"
            value={formData.entryCommissions}
            onChange={e => handleInputChange('entryCommissions', toNumber(e.target.value, parseFloat))}
          />
        </div>

        <div>
          <label>Edge (%)</label>
          <input
            type="number"
            step="0.01"
            value={formData.edgeAtEntry}
            onChange={e => handleInputChange('edgeAtEntry', toNumber(e.target.value, parseFloat))}
          />
        </div>
      </div>

      <div>
        <label>Notes</label>
        <textarea
          value={formData.notes}
          onChange={e => handleInputChange('notes', e.target.value)}
          placeholder="Add any notes about this trade..."
        />
      </div>

      {/* Legs Section */}
      <div>
        <h3>Option Legs</h3>
        {formData.legs.map((leg, idx) => (
          <div key={idx} className="leg-card">
            <div className="leg-card-header">
              <span>Leg {idx + 1}</span>
              {formData.legs.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeLeg(idx)}
                  className="link-button link-button--danger"
                >
                  Remove
                </button>
              )}
            </div>

            <div className="leg-fields">
              <div>
                <label>Side</label>
                <select
                  value={leg.side}
                  onChange={e => handleLegChange(idx, 'side', e.target.value)}
                >
                  <option value="buy">Buy</option>
                  <option value="sell">Sell</option>
                </select>
              </div>

              <div>
                <label>Type</label>
                <select
                  value={leg.optionType}
                  onChange={e => handleLegChange(idx, 'optionType', e.target.value)}
                >
                  <option value="call">Call</option>
                  <option value="put">Put</option>
                </select>
              </div>

              <div>
                <label>Strike</label>
                <input
                  type="number"
                  step="0.01"
                  value={leg.strike}
                  onChange={e => handleLegChange(idx, 'strike', toNumber(e.target.value, parseFloat))}
                />
              </div>

              <div>
                <label>Quantity</label>
                <input
                  type="number"
                  value={leg.quantity}
                  onChange={e => handleLegChange(idx, 'quantity', toNumber(e.target.value, parseInt))}
                />
              </div>

              <div>
                <label>Expiration</label>
                <input
                  type="date"
                  required
                  value={leg.expirationDate}
                  onChange={e => handleLegChange(idx, 'expirationDate', e.target.value)}
                />
              </div>

              <div>
                <label>Entry Price</label>
                <input
                  type="number"
                  step="0.01"
                  required
                  value={leg.entryPrice}
                  onChange={e => handleLegChange(idx, 'entryPrice', toNumber(e.target.value, parseFloat))}
                />
              </div>
            </div>
          </div>
        ))}

        <button type="button" onClick={addLeg} className="link-button">
          + Add Leg
        </button>
      </div>

      {/* Action Buttons */}
      <div className="form-actions">
        <button type="submit" disabled={loading} className="button-primary">
          {loading ? 'Creating...' : 'Create Trade'}
        </button>
        <button type="button" onClick={onCancel} className="button-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}
