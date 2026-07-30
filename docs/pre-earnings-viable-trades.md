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
  "topN": 10,
  "scanLimit": 120
}
```

- `topN` (optional): max rows returned, default `10`, max `50`
- `scanLimit` (optional): number of S&P 500 symbols scanned, default `120`, max `500`

### Response shape

```json
{
  "asOf": "2026-07-30T20:53:59.761Z",
  "scannedSymbols": 120,
  "evaluatedSymbols": 120,
  "viableSymbols": 35,
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
2. Scan up to `scanLimit` symbols (bounded-concurrency workers).
3. For each symbol:
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
4. Keep only viable rows (`recommended` or `consider`).
5. Rank rows and return top `N`.

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

1. Verdict priority: `recommended > consider > avoid`
2. Higher `iv30Rv30`
3. More favorable slope (more negative `tsSlope0To45`)

Only viable rows are included in the endpoint output.

---

## Data dependencies

- Option chain: Cboe delayed quotes options API
- Historical OHLCV: Nasdaq historical quote API
- Universe list: S&P 500 constituents dataset (+ fallback)

---

## Error handling model

Per-symbol failures are isolated:

- If a symbol cannot produce sufficient data, it is skipped.
- The scan continues for remaining symbols.
- `evaluatedSymbols` counts symbols that reached computed results.

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
