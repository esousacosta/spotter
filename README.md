# Forward Volatility Spotter

Forward Volatility Spotter is a Next.js app that screens S&P 500 symbols for calendar spread opportunities by comparing:

- short-tenor implied volatility (`IV_short`)
- forward volatility implied between short and long tenors (`FV_short,long`)

The app surfaces **Forward Volatility Edge**:

`Forward Volatility Edge = IV_short / FV_short,long - 1`

Rows are marked **Viable** only when the **adjusted edge is above 20%** (`adjustedEdge > 0.20`).

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
    "topN": 10
  }
  ```
  Scans the full S&P 500 universe by default for pre-earnings setups using the calculator logic (`avg_volume`, `iv30_rv30`, `ts_slope_0_45`) and returns top viable trades, plus a rejected-tickers list with explicit rejection reasons. Viable and rejected rows include `nextEarningsDate` and `earningsSession`. `scanLimit` remains optional if you want to cap the scan manually.

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
- Historical bars for RV30 / average-volume checks are pulled from Nasdaq's historical quote API.
- S&P 500 constituents are fetched from the datasets/s-and-p-500-companies GitHub dataset (CSV), with a Wikipedia fallback.
- Option-chain responses are cached for 60 minutes; historical-bar responses are cached for 6 hours; ticker metadata is cached for 1 hour.
- The market-data client now applies provider-specific pacing and retry/backoff when Cboe or Nasdaq return rate-limit responses.
- The pre-earnings universe scan is warmed in the background after the app loads the ticker list, so later button clicks usually reuse a shared cached scan instead of launching a cold full-universe sweep.
- The expensive market-data portion of the pre-earnings scan is limited to symbols with an announced earnings date in the next 21 calendar days; other symbols are rejected immediately as outside the current strategy window.
- The pre-earnings scan endpoint now returns the **latest cached snapshot immediately** while a background scan continues warming, instead of blocking the button until the full universe finishes.

## Testing

Run the test suite:

```bash
npm test
```

The suite includes a functional guard for UI-triggered requests: if an API call hangs, the request times out so buttons do not stay loading forever.

## Detailed feature docs

- Pre-earnings viable trades: `docs/pre-earnings-viable-trades.md`
