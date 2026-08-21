'use client';

import type { TradeWithLegs } from '@/lib/server/trade-journal-service';

interface TradeListProps {
  trades: TradeWithLegs[];
  selectedTradeId?: string;
  onSelectTrade: (tradeId: string) => void;
}

function statusPillClass(status: TradeWithLegs['status']) {
  if (status === 'open') return 'status-pill status-pill--open';
  if (status === 'closed') return 'status-pill status-pill--closed';
  return 'status-pill status-pill--default';
}

export function TradeList({ trades, selectedTradeId, onSelectTrade }: TradeListProps) {
  return (
    <>
      {trades.map(trade => (
        <div
          key={trade.id}
          onClick={() => onSelectTrade(trade.id)}
          className={`trade-list-item ${selectedTradeId === trade.id ? 'trade-list-item--selected' : ''}`}
        >
          <div className="trade-list-item-header">
            <div>
              <h3 className="trade-list-symbol">{trade.symbol}</h3>
              <p className="trade-list-strategy">{trade.strategy}</p>
            </div>
            <span className={statusPillClass(trade.status)}>
              {trade.status.charAt(0).toUpperCase() + trade.status.slice(1)}
            </span>
          </div>

          <div className="trade-list-metrics">
            <div className="trade-list-metric">
              <span>Quantity</span>
              <strong>{trade.quantity}</strong>
            </div>
            <div className="trade-list-metric">
              <span>Entry Debit</span>
              <strong>${trade.entryNetDebit.toFixed(2)}</strong>
            </div>
            {trade.status === 'closed' && (
              <>
                <div className="trade-list-metric">
                  <span>Net PnL</span>
                  <strong className={(trade.netPnl || 0) >= 0 ? 'value-positive' : 'value-negative'}>
                    ${(trade.netPnl || 0).toFixed(2)}
                  </strong>
                </div>
                <div className="trade-list-metric">
                  <span>Return</span>
                  <strong className={(trade.returnOnDebit || 0) >= 0 ? 'value-positive' : 'value-negative'}>
                    {((trade.returnOnDebit || 0) * 100).toFixed(2)}%
                  </strong>
                </div>
              </>
            )}
          </div>
        </div>
      ))}
    </>
  );
}
