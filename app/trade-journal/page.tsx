'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';
import { TradeList } from './components/trade-list';
import { CreateTradeForm } from './components/create-trade-form';
import { TradeAnalytics } from './components/trade-analytics';
import type { TradeWithLegs } from '@/lib/server/trade-journal-service';

export default function TradeJournalPage() {
  const [trades, setTrades] = useState<TradeWithLegs[]>([]);
  const [selectedTrade, setSelectedTrade] = useState<TradeWithLegs | null>(null);
  const [filter, setFilter] = useState<'all' | 'open' | 'closed'>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);

  const loadTrades = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filter !== 'all') params.append('status', filter);
      const res = await fetch(`/api/trade-journal/list?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to load trades');
      const data = await res.json();
      setTrades(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTrades();
  }, [filter]);

  const handleTradeCreated = (newTrade: TradeWithLegs) => {
    setTrades([newTrade, ...trades]);
    setShowCreateForm(false);
  };

  const handleTradeSelected = async (tradeId: string) => {
    try {
      const res = await fetch(`/api/trade-journal/${tradeId}`);
      if (!res.ok) throw new Error('Failed to load trade');
      const data = await res.json();
      setSelectedTrade(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load trade');
    }
  };

  const handleTradeClosed = async (tradeId: string, updatedTrade: TradeWithLegs) => {
    setTrades(trades.map(t => t.id === tradeId ? updatedTrade : t));
    setSelectedTrade(updatedTrade);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8 flex justify-between items-start">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Trade Journal</h1>
            <p className="text-gray-600 mt-2">Track and analyze your trading performance</p>
          </div>
          <Link
            href="/"
            className="px-4 py-2 bg-gray-600 text-white rounded-lg font-semibold hover:bg-gray-700 transition"
          >
            ← Back to Spotter
          </Link>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-800">
            {error}
          </div>
        )}

        {/* Analytics Section */}
        <div className="mb-8">
          <TradeAnalytics />
        </div>

        <div className="grid grid-cols-3 gap-6">
          {/* Main Content */}
          <div className="col-span-2">
            {/* Filter Tabs */}
            <div className="mb-6 flex gap-4">
              <button
                onClick={() => setFilter('all')}
                className={`px-4 py-2 rounded-lg font-medium transition ${
                  filter === 'all'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                All Trades
              </button>
              <button
                onClick={() => setFilter('open')}
                className={`px-4 py-2 rounded-lg font-medium transition ${
                  filter === 'open'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                Open
              </button>
              <button
                onClick={() => setFilter('closed')}
                className={`px-4 py-2 rounded-lg font-medium transition ${
                  filter === 'closed'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                Closed
              </button>
            </div>

            {/* Trades List */}
            <div className="bg-white rounded-lg shadow">
              {loading ? (
                <div className="p-8 text-center text-gray-500">Loading trades...</div>
              ) : trades.length === 0 ? (
                <div className="p-8 text-center text-gray-500">
                  No trades found. Create your first trade to get started!
                </div>
              ) : (
                <TradeList
                  trades={trades}
                  selectedTradeId={selectedTrade?.id}
                  onSelectTrade={handleTradeSelected}
                />
              )}
            </div>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Create Trade Button */}
            {!showCreateForm && !selectedTrade && (
              <button
                onClick={() => setShowCreateForm(true)}
                className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 transition"
              >
                + New Trade
              </button>
            )}

            {/* Create Trade Form */}
            {showCreateForm && (
              <div className="bg-white rounded-lg shadow p-6">
                <h2 className="text-lg font-semibold mb-4">Create Trade</h2>
                <CreateTradeForm
                  onSuccess={handleTradeCreated}
                  onCancel={() => setShowCreateForm(false)}
                />
              </div>
            )}

            {/* Trade Detail */}
            {selectedTrade && (
              <div className="bg-white rounded-lg shadow p-6">
                <div className="flex justify-between items-start mb-4">
                  <h2 className="text-lg font-semibold">Trade Details</h2>
                  <button
                    onClick={() => setSelectedTrade(null)}
                    className="text-gray-500 hover:text-gray-700"
                  >
                    ✕
                  </button>
                </div>
                <div className="space-y-3 text-sm">
                  <div>
                    <p className="text-gray-600">Symbol</p>
                    <p className="font-semibold">{selectedTrade.symbol}</p>
                  </div>
                  <div>
                    <p className="text-gray-600">Strategy</p>
                    <p className="font-semibold">{selectedTrade.strategy}</p>
                  </div>
                  <div>
                    <p className="text-gray-600">Status</p>
                    <p className={`font-semibold ${
                      selectedTrade.status === 'open' ? 'text-green-600' : 'text-gray-600'
                    }`}>
                      {selectedTrade.status.charAt(0).toUpperCase() + selectedTrade.status.slice(1)}
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-600">Quantity</p>
                    <p className="font-semibold">{selectedTrade.quantity} contracts</p>
                  </div>
                  <div>
                    <p className="text-gray-600">Entry Debit</p>
                    <p className="font-semibold">${selectedTrade.entryNetDebit.toFixed(2)}</p>
                  </div>

                  {selectedTrade.status === 'closed' && (
                    <>
                      <hr className="my-3" />
                      <div>
                        <p className="text-gray-600">Exit Credit</p>
                        <p className="font-semibold">${(selectedTrade.exitNetCredit || 0).toFixed(2)}</p>
                      </div>
                      <div>
                        <p className="text-gray-600">Gross PnL</p>
                        <p className={`font-semibold ${(selectedTrade.grossPnl || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          ${(selectedTrade.grossPnl || 0).toFixed(2)}
                        </p>
                      </div>
                      <div>
                        <p className="text-gray-600">Net PnL</p>
                        <p className={`font-semibold text-lg ${(selectedTrade.netPnl || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          ${(selectedTrade.netPnl || 0).toFixed(2)}
                        </p>
                      </div>
                      <div>
                        <p className="text-gray-600">Return %</p>
                        <p className={`font-semibold ${(selectedTrade.returnOnDebit || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {((selectedTrade.returnOnDebit || 0) * 100).toFixed(2)}%
                        </p>
                      </div>
                    </>
                  )}

                  {selectedTrade.status === 'open' && (
                    <button
                      onClick={() => setSelectedTrade(null)}
                      className="w-full mt-4 bg-blue-600 text-white py-2 rounded-lg font-semibold hover:bg-blue-700 transition"
                    >
                      Close Trade
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
