'use client';

import { useState } from 'react';
import type { TradeWithLegs } from '@/lib/server/trade-journal-service';

interface CreateTradeFormProps {
  onSuccess: (trade: TradeWithLegs) => void;
  onCancel: () => void;
}

export function CreateTradeForm({ onSuccess, onCancel }: CreateTradeFormProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [legCount, setLegCount] = useState(1);

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
    setLegCount(prev => prev + 1);
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
    <form onSubmit={handleSubmit} className="space-y-4 text-sm">
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded text-red-800">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-gray-700 font-medium mb-1">Symbol</label>
          <input
            type="text"
            required
            value={formData.symbol}
            onChange={e => handleInputChange('symbol', e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="AAPL"
          />
        </div>

        <div>
          <label className="block text-gray-700 font-medium mb-1">Strategy</label>
          <input
            type="text"
            required
            value={formData.strategy}
            onChange={e => handleInputChange('strategy', e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="forward-vol-calendar"
          />
        </div>

        <div>
          <label className="block text-gray-700 font-medium mb-1">Quantity</label>
          <input
            type="number"
            required
            value={formData.quantity}
            onChange={e => handleInputChange('quantity', parseInt(e.target.value))}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div>
          <label className="block text-gray-700 font-medium mb-1">Entry Debit ($)</label>
          <input
            type="number"
            step="0.01"
            required
            value={formData.entryNetDebit}
            onChange={e => handleInputChange('entryNetDebit', parseFloat(e.target.value))}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div>
          <label className="block text-gray-700 font-medium mb-1">Entry Commissions ($)</label>
          <input
            type="number"
            step="0.01"
            value={formData.entryCommissions}
            onChange={e => handleInputChange('entryCommissions', parseFloat(e.target.value))}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div>
          <label className="block text-gray-700 font-medium mb-1">Edge (%)</label>
          <input
            type="number"
            step="0.01"
            value={formData.edgeAtEntry}
            onChange={e => handleInputChange('edgeAtEntry', parseFloat(e.target.value))}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      <div>
        <label className="block text-gray-700 font-medium mb-1">Notes</label>
        <textarea
          value={formData.notes}
          onChange={e => handleInputChange('notes', e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 h-16 resize-none"
          placeholder="Add any notes about this trade..."
        />
      </div>

      {/* Legs Section */}
      <div className="border-t pt-4">
        <h3 className="font-semibold mb-3">Option Legs</h3>
        {formData.legs.map((leg, idx) => (
          <div key={idx} className="border rounded-lg p-3 mb-3 bg-gray-50">
            <div className="flex justify-between items-center mb-3">
              <span className="font-medium">Leg {idx + 1}</span>
              {formData.legs.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeLeg(idx)}
                  className="text-red-600 hover:text-red-700 text-sm font-medium"
                >
                  Remove
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-gray-600 block mb-1">Side</label>
                <select
                  value={leg.side}
                  onChange={e => handleLegChange(idx, 'side', e.target.value)}
                  className="w-full px-2 py-1 border border-gray-300 rounded text-sm"
                >
                  <option value="buy">Buy</option>
                  <option value="sell">Sell</option>
                </select>
              </div>

              <div>
                <label className="text-xs text-gray-600 block mb-1">Type</label>
                <select
                  value={leg.optionType}
                  onChange={e => handleLegChange(idx, 'optionType', e.target.value)}
                  className="w-full px-2 py-1 border border-gray-300 rounded text-sm"
                >
                  <option value="call">Call</option>
                  <option value="put">Put</option>
                </select>
              </div>

              <div>
                <label className="text-xs text-gray-600 block mb-1">Strike</label>
                <input
                  type="number"
                  step="0.01"
                  value={leg.strike}
                  onChange={e => handleLegChange(idx, 'strike', parseFloat(e.target.value))}
                  className="w-full px-2 py-1 border border-gray-300 rounded text-sm"
                />
              </div>

              <div>
                <label className="text-xs text-gray-600 block mb-1">Quantity</label>
                <input
                  type="number"
                  value={leg.quantity}
                  onChange={e => handleLegChange(idx, 'quantity', parseInt(e.target.value))}
                  className="w-full px-2 py-1 border border-gray-300 rounded text-sm"
                />
              </div>

              <div>
                <label className="text-xs text-gray-600 block mb-1">Expiration</label>
                <input
                  type="date"
                  required
                  value={leg.expirationDate}
                  onChange={e => handleLegChange(idx, 'expirationDate', e.target.value)}
                  className="w-full px-2 py-1 border border-gray-300 rounded text-sm"
                />
              </div>

              <div>
                <label className="text-xs text-gray-600 block mb-1">Entry Price</label>
                <input
                  type="number"
                  step="0.01"
                  required
                  value={leg.entryPrice}
                  onChange={e => handleLegChange(idx, 'entryPrice', parseFloat(e.target.value))}
                  className="w-full px-2 py-1 border border-gray-300 rounded text-sm"
                />
              </div>
            </div>
          </div>
        ))}

        <button
          type="button"
          onClick={addLeg}
          className="text-blue-600 hover:text-blue-700 text-sm font-medium"
        >
          + Add Leg
        </button>
      </div>

      {/* Action Buttons */}
      <div className="flex gap-2 pt-4">
        <button
          type="submit"
          disabled={loading}
          className="flex-1 bg-blue-600 text-white py-2 rounded-lg font-semibold hover:bg-blue-700 disabled:bg-gray-400 transition"
        >
          {loading ? 'Creating...' : 'Create Trade'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 bg-gray-300 text-gray-700 py-2 rounded-lg font-semibold hover:bg-gray-400 transition"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
