# Forward Volatility Spotter

Forward Volatility Spotter is a Next.js app that screens S&P 500 symbols for calendar spread opportunities by comparing:

- short-tenor implied volatility (`IV_short`)
- forward volatility implied between short and long tenors (`FV_short,long`)

The app surfaces **Forward Volatility Edge**:

`Forward Volatility Edge = IV_short / FV_short,long - 1`

Positive values indicate the requested viability condition (`IV_short > FV_short,long`).

For each tenor pair, both options are now selected at the **same shared ATM strike** (closest strike to spot that exists in both expiries).
The recommendation pipeline now uses an earnings-aware model:

- expirations **before** earnings are scored on the standard path
- expirations **after** earnings are scored with an ex-earnings adjustment using a pre-earnings anchor IV and variance-consistent adjustment of both short IV and forward-vol comparison
- missing/unreliable earnings data is rejected conservatively

## Ex-earnings adjustment reference

For earnings-exposed trades (short expiry after earnings), the model applies a variance-consistent adjustment:

1. Find a **pre-earnings anchor expiry** (latest expiry before earnings) at the **same strike** and read `ivAnchor`.
2. Compute total variances:
   - `shortTotal = ivShort² * Tshort`
   - `longTotal = ivLong² * Tlong`
   - `baselineShort = ivAnchor² * Tshort`
3. Estimate event variance from short tenor:
   - `eventVar = max(shortTotal - baselineShort, 0)`
4. Remove one event variance component from both tenors:
   - `shortAdjTotal = shortTotal - eventVar`
   - `longAdjTotal = longTotal - eventVar`
5. Recompute adjusted quantities:
   - `adjustedShortIv = sqrt(shortAdjTotal / Tshort)`
   - `adjustedForwardVar = (longAdjTotal - shortAdjTotal) / (Tlong - Tshort)`
   - `adjustedForwardVol = sqrt(adjustedForwardVar)`
6. Score using adjusted edge:
   - `adjustedEdge = adjustedShortIv / adjustedForwardVol - 1`

This is stricter than the old one-sided haircut because it adjusts both the short leg and the forward-vol comparison basis.

### Safeguards on the ex-earnings path

The adjustment is only attempted when guard clauses pass:

- a valid pre-earnings anchor expiry exists
- anchor strike liquidity is present (open interest > 0)
- anchor is not too far from earnings and not from an older cycle
- anchor tenor is close enough to short tenor
- both legs span the same post-earnings window
- the long window is short enough to avoid multi-event ambiguity
- baseline/short variance relationship is internally consistent

If any guard fails, the trade is rejected with an explicit reason.

## Getting Started

Install dependencies and run the app:

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Implemented endpoints

- `GET /api/tickers`  
  Returns S&P 500 constituents used by the ticker dropdown.

- `POST /api/forward-vol`  
  Request body:
  ```json
  {
    "symbol": "AAPL",
    "targetPairs": [{ "shortDte": 30, "longDte": 60 }]
  }
  ```
  `targetPairs` is optional; defaults cover 15/30/45/60/75 short-DTE buckets via calendar pairs.
  Response rows include `nextEarningsDate`, `tradeClass`, `rawForwardVolEdge`, `adjustedForwardVolEdge`, `selectedStrike`, `shortOpenInterest`, and `longOpenInterest`.

- `POST /api/top-forward-vol`  
  Request body:
  ```json
  {
    "topN": 10
  }
  ```
  Scans S&P 500 symbols, takes each symbol's best valid row, and returns the top `N` by Forward Volatility Edge.

- `POST /api/pre-earnings-viable`  
  Request body:
  ```json
  {
    "topN": 10,
    "scanLimit": 120
  }
  ```
  Scans a configurable subset of S&P 500 symbols for pre-earnings setups using the calculator logic (`avg_volume`, `iv30_rv30`, `ts_slope_0_45`) and returns top viable trades, now including `nextEarningsDate` and `earningsSession` per row.

- `POST /api/upcoming-earnings`  
  Request body:
  ```json
  {
    "daysAhead": 21,
    "limit": 500
  }
  ```
  Returns upcoming announced S&P 500 earnings events, plus strategy timing fields for the pre-earnings workflow (entry: 15 minutes before close on earnings day, exit: 15 minutes after next-day open).

## Notes

- Option-chain market data is pulled from the Cboe delayed quotes API.
- Earnings calendar data is pulled from Nasdaq's earnings calendar API.
- S&P 500 constituents are fetched from the datasets/s-and-p-500-companies GitHub dataset (CSV), with a Wikipedia fallback.
- Responses are cached in memory for 10 minutes to reduce repeated provider calls.

## Testing

Run the unit tests for the volatility engine:

```bash
npm test
```

## Detailed feature docs

- Pre-earnings viable trades: `docs/pre-earnings-viable-trades.md`
