# Pre-earnings Viable Trades — Detailed Technical Reference

## Purpose

The **Pre-earnings Viable Trades** tab scans a stock universe and identifies candidates based on a rule set derived from the provided calculator logic.

This feature is independent from the Forward Volatility tab and does not alter the forward-vol recommendation pipeline.

---

## Where it lives

- UI tab and table: `app/components/spotter-app.tsx`
- API endpoint: `app/api/pre-earnings-viable/route.ts`
- Upcoming earnings endpoint/tab: `app/api/upcoming-earnings/route.ts` + `app/components/spotter-app.tsx`
- Core computation: `lib/server/pre-earnings-service.ts`
- Market data access: `lib/server/market-data-provider.ts`
- Earnings calendar access: `lib/server/earnings-provider.ts`
- Types: `lib/types.ts`

---

## API contract

### Endpoint

`POST /api/pre-earnings-viable`

### Request body

```json
{
  "topN": 10
}
```

- `topN` (optional): max rows returned, default `10`, max `50`
- `scanLimit` (optional): number of S&P 500 symbols scanned; if omitted, the endpoint scans the full S&P 500 universe. Max `500`.

### Response shape

```json
{
  "asOf": "2026-07-30T20:53:59.761Z",
  "scannedSymbols": 503,
  "evaluatedSymbols": 503,
  "computedSymbols": 61,
  "viableSymbols": 35,
  "rejectedSymbols": 468,
  "rows": [
    {
      "symbol": "AAPL",
      "companyName": "Apple Inc.",
      "nextEarningsDate": "2026-08-01",
      "earningsSession": "After Market Close",
      "underlyingPrice": 325.31,
      "expectedMove": "4.61%",
      "avgVolume30": 60357101.33,
      "iv30Rv30": 1.09,
      "tsSlope0To45": -0.014,
      "avgVolumePass": true,
      "iv30Rv30Pass": false,
      "tsSlopePass": true,
      "verdict": "consider",
      "isViable": true,
      "notes": "Consider: term-structure check passed with one supporting signal."
    }
  ],
  "rejectedRows": [
    {
      "symbol": "XYZ",
      "companyName": "Example Inc.",
      "nextEarningsDate": "2026-08-01",
      "earningsSession": "After Market Close",
      "rejectionCategory": "criteria",
      "rejectionStage": "Viability rules",
      "rejectionReason": "Rejected by viability rules: IV30/RV30 1.11 is below the 1.25 threshold.",
      "wasComputed": true,
      "underlyingPrice": 103.4,
      "expectedMove": "3.12%",
      "avgVolume30": 4200000,
      "iv30Rv30": 1.11,
      "tsSlope0To45": -0.008,
      "avgVolumePass": true,
      "iv30Rv30Pass": false,
      "tsSlopePass": true,
      "verdict": "avoid"
    }
  ]
}
```

---

## New columns in the pre-earnings table

- `nextEarningsDate`: the nearest announced earnings date found from Nasdaq calendar data for that symbol.
- `earningsSession`: the published release session text (for example pre-market or after-market).

Intuition (newcomer view):

- These fields answer **“When is the catalyst?”** and **“Which part of the day is it scheduled for?”**
- They do not replace the viability indicators, but they make it easier to align execution timing with the event.

---

## Rejected tickers subtab

The **Rejected tickers** subtab shows every scanned symbol that did **not** make the viable list, together with the rejection cause.

### What appears there

1. **Criteria rejections**: the symbol was fully computed, but its verdict was `avoid`.
2. **Data rejections**: the symbol could not be fully computed because required expiries, IV points, historical bars, or other market data were missing or invalid.

### Main fields

- `rejectionCategory`: either `criteria` or `data`
- `rejectionStage`: where the pipeline rejected the symbol
- `rejectionReason`: human-readable explanation of the rejection
- `wasComputed`: whether the symbol made it through the full indicator pipeline before being rejected

Intuition (newcomer view):

- This subtab answers **“Why didn’t this ticker make the cut?”**
- It helps distinguish **bad setup quality** from **missing or insufficient data**.

---

## Upcoming announced earnings tab

The app includes a dedicated **Upcoming announced earnings** tab that lists announced S&P 500 earnings events and shows the strategy timing window used by this workflow:

- **Entry**: buy 15 minutes before close on earnings day.
- **Exit**: sell 15 minutes after next-day open.

### Endpoint

`POST /api/upcoming-earnings`

### Request body

```json
{
  "daysAhead": 21,
  "limit": 500
}
```

- `daysAhead` (optional): forward calendar horizon, default `14`, max `60`.
- `limit` (optional): max returned rows, default `300`, max `1000`.

### Why this tab exists (newcomer view)

- The pre-earnings scanner tells you **which setups look statistically viable**.
- This tab tells you **which announcements are coming soon** and reminds you of the precise timing window for this strategy.
- Together, they reduce trial-and-error and improve execution planning.

---

## End-to-end flow

1. Load S&P 500 symbols.
2. Start a background warmup of the full pre-earnings scan as soon as the app loads tickers.
3. Scan the full S&P 500 universe by default, or up to `scanLimit` symbols when a manual cap is provided (bounded-concurrency workers). The button reuses the shared warmed scan when available.
4. Reject symbols with no announced earnings date, or with earnings beyond the next 21 calendar days, before making the expensive market-data requests.
5. For each remaining in-window symbol:
   1. Fetch spot and option expirations.
   2. Filter expirations to near-term set ending at the first expiry with `DTE >= 45`.
   3. For each selected expiry, fetch calls and puts.
   4. Pick ATM call and ATM put (nearest strike to spot).
   5. Compute ATM IV per expiry as average of call IV and put IV.
   6. Build linear term structure from `{DTE, ATM IV}` points.
   7. Compute:
      - `ts_slope_0_45`
      - `iv30_rv30`
      - 30-day average volume
      - expected move from first-expiry ATM straddle midprice.
   8. Evaluate pass/fail checks and assign verdict.
6. Keep only viable rows (`recommended` or `consider`).
7. Rank rows and return top `N`.

---

## Indicator definitions

## 1. Average volume check (`avg_volume`)

- Source: 30 most recent daily bars from Nasdaq historical API.
- Metric:

`avgVolume30 = mean(volume[-30:])`

- Pass threshold:

`avgVolume30 >= 1,500,000`

- Intuition (newcomer view):
  - This asks: **“Is this stock liquid enough to trade without big slippage?”**
  - Higher average volume usually means tighter markets and easier fills.
  - If this fails, the setup might still look good on paper, but execution quality can be poor.

---

## 2. IV30 / RV30 check (`iv30_rv30`)

- `IV30`: 30-DTE implied volatility from linear interpolation over ATM IV term points.
- `RV30`: Yang-Zhang annualized realized volatility over 30 days.
- Metric:

`iv30_rv30 = IV30 / RV30`

- Pass threshold:

`iv30_rv30 >= 1.25`

- Intuition (newcomer view):
  - This asks: **“Are options priced rich versus how much the stock has actually been moving?”**
  - `IV30` is market-implied future volatility; `RV30` is recent realized volatility.
  - A ratio above 1 means implied vol is above realized; `>= 1.25` requires a clear premium cushion.

---

## 3. Term structure slope check (`ts_slope_0_45`)

Using first valid option tenor (`dteFirst`) and 45-DTE interpolated IV:

`tsSlope0To45 = (IV(45) - IV(dteFirst)) / (45 - dteFirst)`

Pass threshold:

`tsSlope0To45 <= -0.00406`

- Intuition (newcomer view):
  - This asks: **“Does near-term IV stand above medium-term IV?”**
  - A sufficiently negative slope means the front end is elevated relative to farther expiries.
  - This is consistent with pre-event richness and supports short-premium style setups.

---

## Expected move

From first filtered expiry:

1. Find ATM call and ATM put.
2. Compute each midprice from bid/ask.
3. Compute straddle mid:

`straddle = callMid + putMid`

4. Convert to percent of spot:

`expectedMovePct = (straddle / spot) * 100`

Displayed as a formatted percent string when both mids are available.

- Intuition (newcomer view):
  - This is a quick estimate of how much the market is pricing the stock to move by that expiry.
  - It is a context indicator, not a pass/fail rule in this feature.

---

## Verdict logic

Using pass flags:

- `avgVolumePass`
- `iv30Rv30Pass`
- `tsSlopePass`

### Recommended

All three pass.

- Intuition:
  - Liquidity is strong, options look rich relative to realized movement, and the IV curve shape supports the setup.

### Consider

`tsSlopePass == true` and exactly one of `avgVolumePass`, `iv30Rv30Pass` is true.

- Intuition:
  - The curve shape is supportive, but one confirming condition is missing.
  - This is a “review manually” bucket, not a strongest-conviction signal.

### Avoid

All other combinations.

- Intuition:
  - Either liquidity is weak, the vol premium is not convincing, or the term-structure shape is not favorable.
  - The model treats these as low-priority for this strategy profile.

`isViable` is true for `recommended` and `consider`, false for `avoid`.

---

## Ranking logic

Returned rows are ranked by:

1. **Announced earnings today first** (using the US market calendar date)
2. Then earliest announced earnings date
3. Verdict priority: `recommended > consider > avoid`
4. Higher `iv30Rv30`
5. More favorable slope (more negative `tsSlope0To45`)

Only viable rows are included in the endpoint output.

Rejected rows are returned separately in `rejectedRows`.

---

## Data dependencies

- Option chain: Cboe delayed quotes options API
- Historical OHLCV: Nasdaq historical quote API
- Universe list: S&P 500 constituents dataset (+ fallback)

## Performance safeguards

- In-flight cache deduplication prevents the same symbol from triggering duplicate concurrent option-chain fetches.
- The full-universe pre-earnings scan is cached in memory for a short interval and reused across button clicks.
- The app warms that shared scan in the background right after ticker load, which spreads requests over time instead of concentrating them on button click.
- Symbols outside the current 21-day announced-earnings window are rejected before any option-chain or historical-bar fetches happen.
- The scan endpoint returns the latest cached snapshot immediately and the UI polls for refreshes while the background scan is still running, so the button does not wait for the full scan to complete.

---

## Error handling model

Per-symbol failures are isolated:

- If a symbol cannot produce sufficient data, it is skipped.
- The scan continues for remaining symbols.
- `evaluatedSymbols` counts symbols that were attempted by the scanner.
- `computedSymbols` counts symbols that made it all the way through the data pipeline and produced a computed pre-earnings row.
- `rejectedSymbols` counts symbols returned in the rejected-tickers list.

Common reasons a symbol is attempted but not computed:

- no usable near-term option expiries after filtering,
- not enough expiries with valid ATM call/put IV data,
- insufficient valid historical bars for RV30 / average-volume inputs,
- provider request failures for options or historical data.

---

## Non-goals

This feature currently does **not**:

- place trades,
- enforce advanced liquidity filters beyond the indicator set,
- backtest performance.

---

## Notes for future agents

If thresholds are changed, update these constants in `lib/server/pre-earnings-service.ts`:

- `MIN_AVG_VOLUME`
- `MIN_IV30_RV30`
- `MAX_TS_SLOPE_0_45`

If ranking rules are changed, update `rankScore` and comparator logic in:

- `app/api/pre-earnings-viable/route.ts`
