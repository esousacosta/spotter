'use client';

import type { TradeWithLegs } from '@/lib/server/trade-journal-service';

interface TradeListProps {
  trades: TradeWithLegs[];
  selectedTradeId?: string;
  onSelectTrade: (tradeId: string) => void;
}

export function TradeList({ trades, selectedTradeId, onSelectTrade }: TradeListProps) {
  return (
    <div className="divide-y">
      {trades.map(trade => (
        <div
          key={trade.id}
          onClick={() => onSelectTrade(trade.id)}
          className={`p-4 cursor-pointer transition ${
            selectedTradeId === trade.id
              ? 'bg-blue-50 border-l-4 border-blue-600'
              : 'hover:bg-gray-50'
          }`}
        >
          <div className="flex justify-between items-start mb-2">
            <div>
              <h3 className="font-semibold text-gray-900">{trade.symbol}</h3>
              <p className="text-sm text-gray-600">{trade.strategy}</p>
            </div>
            <div className="text-right">
              <span className={`inline-block px-2 py-1 rounded text-xs font-semibold ${
                trade.status === 'open'
                  ? 'bg-green-100 text-green-800'
                  : trade.status === 'closed'
                  ? 'bg-blue-100 text-blue-800'
                  : 'bg-gray-100 text-gray-800'
              }`}>
                {trade.status.charAt(0).toUpperCase() + trade.status.slice(1)}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-gray-600">Quantity</p>
              <p className="font-semibold">{trade.quantity}</p>
            </div>
            <div>
              <p className="text-gray-600">Entry Debit</p>
              <p className="font-semibold">${trade.entryNetDebit.toFixed(2)}</p>
            </div>
            {trade.status === 'closed' && (
              <>
                <div>
                  <p className="text-gray-600">Net PnL</p>
                  <p className={`font-semibold ${(trade.netPnl || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    ${(trade.netPnl || 0).toFixed(2)}
                  </p>
                </div>
                <div>
                  <p className="text-gray-600">Return</p>
                  <p className={`font-semibold ${(trade.returnOnDebit || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {((trade.returnOnDebit || 0) * 100).toFixed(2)}%
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
