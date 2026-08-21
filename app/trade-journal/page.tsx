'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';
import { TradeList } from './components/trade-list';
import { CreateTradeForm } from './components/create-trade-form';
import { CloseTradeForm } from './components/close-trade-form';
import { EditTradeForm } from './components/edit-trade-form';
import { TradeAnalytics } from './components/trade-analytics';
import type { TradeWithLegs } from '@/lib/server/trade-journal-service';

export default function TradeJournalPage() {
  const [trades, setTrades] = useState<TradeWithLegs[]>([]);
  const [selectedTrade, setSelectedTrade] = useState<TradeWithLegs | null>(null);
  const [filter, setFilter] = useState<'all' | 'open' | 'closed'>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showCloseForm, setShowCloseForm] = useState(false);
  const [showEditForm, setShowEditForm] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
    setShowCreateForm(false);
    setShowCloseForm(false);
    setShowEditForm(false);
    try {
      const res = await fetch(`/api/trade-journal/${tradeId}`);
      if (!res.ok) throw new Error('Failed to load trade');
      const data = await res.json();
      setSelectedTrade(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load trade');
    }
  };

  const handleTradeClosed = (tradeId: string, updatedTrade: TradeWithLegs) => {
    setTrades(trades.map(t => (t.id === tradeId ? updatedTrade : t)));
    setSelectedTrade(updatedTrade);
    setShowCloseForm(false);
  };

  const handleTradeUpdated = (tradeId: string, updatedTrade: TradeWithLegs) => {
    setTrades(trades.map(t => (t.id === tradeId ? updatedTrade : t)));
    setSelectedTrade(updatedTrade);
    setShowEditForm(false);
  };

  const handleDeleteTrade = async (tradeId: string) => {
    if (!confirm('Delete this trade? This cannot be undone.')) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/trade-journal/${tradeId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete trade');
      setTrades(trades.filter(t => t.id !== tradeId));
      setSelectedTrade(null);
      setShowCloseForm(false);
      setShowEditForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete trade');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <div>
            <p className="eyebrow">Options research workspace</p>
            <h1>Trade Journal</h1>
            <p className="header-description">Track and analyze your trading performance</p>
          </div>
        </div>
        <div className="header-actions">
          <Link className="button-secondary" href="/">
            ← Back to Spotter
          </Link>
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      <div className="workspace">
        <section className="panel">
          <div className="section-header">
            <p className="eyebrow">Performance</p>
            <h2>Analytics</h2>
          </div>
          <TradeAnalytics />
        </section>

        <div className="trade-journal-layout">
          {/* Main Content */}
          <section className="panel">
            <div className="section-header--action">
            <div>
              <p className="eyebrow">History</p>
              <h2>Trades</h2>
            </div>
            </div>

            <div className="filter-tabs">
            <button
              onClick={() => setFilter('all')}
              className={`filter-tab ${filter === 'all' ? 'filter-tab--active' : ''}`}
            >
              All Trades
            </button>
            <button
              onClick={() => setFilter('open')}
              className={`filter-tab ${filter === 'open' ? 'filter-tab--active' : ''}`}
            >
              Open
            </button>
            <button
              onClick={() => setFilter('closed')}
              className={`filter-tab ${filter === 'closed' ? 'filter-tab--active' : ''}`}
            >
              Closed
            </button>
            </div>

            {loading ? (
            <p className="notice notice--loading">Loading trades...</p>
            ) : trades.length === 0 ? (
            <div className="empty-state">
              <strong>No trades found</strong>
              <span>Create your first trade to get started!</span>
            </div>
            ) : (
            <div className="trade-list">
              <TradeList
                trades={trades}
                selectedTradeId={selectedTrade?.id}
                onSelectTrade={handleTradeSelected}
              />
            </div>
            )}
          </section>

          {/* Sidebar */}
          <div style={{ display: 'grid', gap: '1rem' }}>
            {/* Create Trade Button */}
            {!showCreateForm && (
            <button
              onClick={() => {
                setSelectedTrade(null);
                setShowCloseForm(false);
                setShowEditForm(false);
                setShowCreateForm(true);
              }}
              className="button-primary"
              style={{ width: '100%' }}
            >
              + New Trade
            </button>
            )}

            {/* Create Trade Form */}
            {showCreateForm && (
            <section className="panel">
              <div className="section-header">
                <h2>Create Trade</h2>
              </div>
              <CreateTradeForm
                onSuccess={handleTradeCreated}
                onCancel={() => setShowCreateForm(false)}
              />
            </section>
            )}

            {/* Trade Detail */}
            {selectedTrade && (
            <section className="panel">
              <div className="section-header--action">
                <h2>{showEditForm ? 'Edit Trade' : 'Trade Details'}</h2>
                <button
                  onClick={() => {
                    setSelectedTrade(null);
                    setShowCloseForm(false);
                    setShowEditForm(false);
                  }}
                  className="icon-button"
                  aria-label="Close trade details"
                >
                  ✕
                </button>
              </div>

              {showEditForm ? (
                <EditTradeForm
                  trade={selectedTrade}
                  onSuccess={updatedTrade => handleTradeUpdated(selectedTrade.id, updatedTrade)}
                  onCancel={() => setShowEditForm(false)}
                />
              ) : showCloseForm ? (
                <CloseTradeForm
                  trade={selectedTrade}
                  onSuccess={updatedTrade => handleTradeClosed(selectedTrade.id, updatedTrade)}
                  onCancel={() => setShowCloseForm(false)}
                />
              ) : (
                <div className="trade-detail-list">
                  <div className="trade-detail-field">
                    <span>Symbol</span>
                    <strong>{selectedTrade.symbol}</strong>
                  </div>
                  <div className="trade-detail-field">
                    <span>Strategy</span>
                    <strong>{selectedTrade.strategy}</strong>
                  </div>
                  <div className="trade-detail-field">
                    <span>Status</span>
                    <strong className={selectedTrade.status === 'open' ? 'value-positive' : ''}>
                      {selectedTrade.status.charAt(0).toUpperCase() + selectedTrade.status.slice(1)}
                    </strong>
                  </div>
                  <div className="trade-detail-field">
                    <span>Quantity</span>
                    <strong>{selectedTrade.quantity} contracts</strong>
                  </div>
                  <div className="trade-detail-field">
                    <span>Entry Debit</span>
                    <strong>${selectedTrade.entryNetDebit.toFixed(2)}</strong>
                  </div>

                  {selectedTrade.notes && (
                    <div className="trade-detail-field">
                      <span>Notes</span>
                      <strong>{selectedTrade.notes}</strong>
                    </div>
                  )}

                  <hr className="trade-detail-divider" />

                  <div className="trade-detail-field">
                    <span>Legs</span>
                    <div className="leg-summary-list">
                      {selectedTrade.legs.map(leg => (
                        <div key={leg.id} className="leg-summary-row">
                          <span className={`leg-summary-side leg-summary-side--${leg.side}`}>
                            {leg.side} {leg.optionType}
                          </span>
                          <div className="leg-summary-details">
                            <span>Strike <strong>${leg.strike}</strong></span>
                            <span>Qty <strong>{leg.quantity}</strong></span>
                            <span>Exp <strong>{leg.expirationDate}</strong></span>
                            <span>Entry <strong>${leg.entryPrice.toFixed(2)}</strong></span>
                            {leg.exitPrice != null && (
                              <span>Exit <strong>${leg.exitPrice.toFixed(2)}</strong></span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {selectedTrade.status === 'closed' && (
                    <>
                      <hr className="trade-detail-divider" />
                      <div className="trade-detail-field">
                        <span>Exit Credit</span>
                        <strong>${(selectedTrade.exitNetCredit || 0).toFixed(2)}</strong>
                      </div>
                      <div className="trade-detail-field">
                        <span>Gross PnL</span>
                        <strong className={(selectedTrade.grossPnl || 0) >= 0 ? 'value-positive' : 'value-negative'}>
                          ${(selectedTrade.grossPnl || 0).toFixed(2)}
                        </strong>
                      </div>
                      <div className="trade-detail-field">
                        <span>Net PnL</span>
                        <strong
                          className={`trade-detail-emphasis ${(selectedTrade.netPnl || 0) >= 0 ? 'value-positive' : 'value-negative'}`}
                        >
                          ${(selectedTrade.netPnl || 0).toFixed(2)}
                        </strong>
                      </div>
                      <div className="trade-detail-field">
                        <span>Return %</span>
                        <strong className={(selectedTrade.returnOnDebit || 0) >= 0 ? 'value-positive' : 'value-negative'}>
                          {((selectedTrade.returnOnDebit || 0) * 100).toFixed(2)}%
                        </strong>
                      </div>
                    </>
                  )}

                  <div className="form-actions">
                    {selectedTrade.status === 'open' && (
                      <>
                        <button onClick={() => setShowEditForm(true)} className="button-secondary">
                          Edit Trade
                        </button>
                        <button onClick={() => setShowCloseForm(true)} className="button-primary">
                          Close Trade
                        </button>
                      </>
                    )}
                    <button
                      onClick={() => handleDeleteTrade(selectedTrade.id)}
                      disabled={deleting}
                      className="button-secondary"
                      style={{ color: 'var(--red)' }}
                    >
                      {deleting ? 'Deleting...' : 'Delete Trade'}
                    </button>
                  </div>
                </div>
              )}
            </section>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
