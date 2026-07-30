# Forward Volatility Spotter — Implementation Plan

## Status update (2026-07-30)
- Completed: app bootstrap, ticker dropdown UI, results table UI, `/api/tickers`, `/api/forward-vol`, forward-volatility engine, unit tests, and basic in-memory caching.
- Completed fix: replaced broken S&P 500 source and added fallback parsing.
- Completed fix: replaced Yahoo options dependency with Cboe delayed-options provider to remove 401/crumb failures.
- Completed feature: forward-vol calculations now use a single shared ATM strike for short/long expiries, and the UI/API expose short and long open interest.
- Completed feature: one-click "Top 10 opportunities" scan across S&P 500 with ranked table output.
- Completed feature: conservative earnings-risk exclusion (earnings on/before short expiry and unknown earnings data are excluded from recommendations with explicit reasons).
- Completed enhancement: earnings-aware trade selection (standard path for pre-earnings expiries, event-aware adjusted-edge path for earnings-exposed expiries, and expanded 15/30/45/60/75 DTE search buckets).
- Completed hardening: ex-earnings IV safeguards (anchor validity/liquidity, anchor distance and tenor-gap caps, leg/event alignment checks, multi-event window rejection, and explicit baseline-conflict handling).
- Completed feature: separate "Pre-earnings viable trades" tab and API scan using calculator-style viability checks (`avg_volume`, `iv30_rv30`, `ts_slope_0_45`).
- Completed documentation: detailed technical reference for pre-earnings feature (`docs/pre-earnings-viable-trades.md`).
- Remaining from original roadmap: deeper reliability controls (retry policy), richer integration tests, and optional provider abstraction for a paid production feed.

## 1. Goal
Build a web app where the user selects an S&P 500 ticker and gets a table of calendar-spread candidates ranked by **Forward Volatility Edge**:

- `Forward Volatility Edge = IV_short / ForwardVol(T_short, T_long) - 1`
- Positive value (`> 0`) means `IV_short > ForwardVol`, which is the requested viability signal.

---

## 2. Scope for the first increment
1. Ticker selection UI populated with S&P 500 symbols.
2. Results table for multiple short/long DTE targets (e.g., 30/60, 60/90).
3. DTE approximation when exact expiries do not exist (nearest available with constraints).

Out of scope for v1: order execution, PnL backtesting, Greeks beyond IV, auth, watchlists.

---

## 3. Recommended architecture
Use a simple full-stack architecture with server-side market-data fetching.

### Frontend
- React + TypeScript (Vite or Next.js).
- Views:
  - Ticker selector
  - Pair configuration (default target pairs)
  - Results table with viability signal
  - Loading/error states

### Backend
- Lightweight API layer (Node/Express or Next.js API routes).
- Responsibilities:
  - Fetch and cache S&P 500 ticker list.
  - Fetch option chains for selected ticker expirations.
  - Compute Forward Volatility Edge for each pair.
  - Return normalized JSON for UI.

### Data provider abstraction
Create an adapter interface so provider can be swapped:
- `getSP500Tickers(): Ticker[]`
- `getOptionExpirations(symbol): Expiration[]`
- `getOptionChain(symbol, expiration): OptionContract[]`
- `getSpotPrice(symbol): number`

Provider choices:
- **Initial**: Yahoo Finance-based adapter (fast to prototype, no paid key).
- **Production-ready alternative**: Polygon, Tradier, or OCC-compatible paid source.

---

## 4. Data model and computation rules
Use one strike per expiry for comparability (start with ATM call).

### Inputs per short/long pair
- `symbol`
- `shortTargetDte`, `longTargetDte`
- `shortExpiry`, `longExpiry`
- `shortDteActual`, `longDteActual`
- `ivShort`, `ivLong` (decimal, e.g. 0.24)

### Core formulas
- `varianceShort = ivShort^2`
- `varianceLong = ivLong^2`
- `tShort = shortDteActual / 365`
- `tLong = longDteActual / 365`
- `forwardVariance = ((varianceLong * tLong) - (varianceShort * tShort)) / (tLong - tShort)`
- `forwardVol = sqrt(max(forwardVariance, 0))`
- `forwardVolEdge = (ivShort / forwardVol) - 1`

### Viability flag
- `isViable = forwardVolEdge > 0`

### Guardrails
- Require `tLong > tShort`.
- Reject pair if no valid expiries/contracts.
- If `forwardVariance < 0`, mark row as invalid (term-structure inconsistency/noise) and include reason.
- Use annualized vol units consistently.

---

## 5. DTE approximation algorithm (v1)
For each target pair `(shortTarget, longTarget)`:

1. Pick short expiry nearest to `shortTarget` with minimum absolute DTE difference.
2. Pick long expiry nearest to `longTarget` **subject to** `longExpiry > shortExpiry` and `longDteActual - shortDteActual >= minGapDays` (recommend `minGapDays = 7`).
3. If multiple candidates tie, prefer the later expiry.
4. Keep pair only if both expiries found.

Default target pairs:
- 30/60
- 45/75
- 60/90

---

## 6. Contract selection rule (v1)
For each selected expiry:
1. Determine spot price.
2. From call chain, choose strike closest to spot (ATM proxy).
3. Read implied vol for that contract.

Later improvement: interpolate IV surface by delta or moneyness instead of nearest strike.

---

## 7. API design
### `GET /api/tickers`
Returns S&P 500 tickers.

Response:
- `[{ symbol, name }]`

### `POST /api/forward-vol`
Request:
- `symbol`
- `targetPairs: [{ shortDte, longDte }]` (optional; defaults applied server-side)

Response:
- `symbol`
- `asOf`
- `rows: [{ shortTargetDte, longTargetDte, shortExpiry, longExpiry, shortDteActual, longDteActual, ivShort, ivLong, forwardVol, forwardVolEdge, isViable, status, notes }]`

---

## 8. UI behavior
### Main flow
1. Load tickers on app start.
2. User selects ticker.
3. Trigger `/api/forward-vol`.
4. Render table sorted by `forwardVolEdge` descending.

### Table columns
- Pair (target)
- Actual DTEs
- Short IV
- Long IV
- Forward Vol
- Forward Vol Edge (%)
- Viable? (Yes/No)
- Notes

Use color semantics:
- Green: viable (`edge > 0`)
- Red/gray: not viable or invalid

---

## 9. Implementation phases for next agent
### Phase 1: Project bootstrap
- Scaffold full-stack TypeScript app.
- Add provider interface and one concrete provider.
- Add environment variable wiring for optional API keys.

### Phase 2: Data ingestion endpoints
- Implement `/api/tickers`.
- Implement `/api/forward-vol` without caching first.
- Add schema validation for request/response.

### Phase 3: Volatility engine
- Implement pure calculation module and unit tests for:
  - normal case
  - negative forward variance
  - equal/invalid tenors

### Phase 4: UI
- Build ticker dropdown and results table.
- Add loading, empty, and error states.
- Add pair defaults and display actual DTE substitutions.

### Phase 5: Performance/reliability
- Add short-lived caching (e.g., 5–15 min) for ticker list and option-chain fetches.
- Add request timeout/retry policy.
- Add telemetry logs around data gaps.

---

## 10. Test strategy
### Unit tests
- Formula correctness with deterministic fixtures.
- DTE approximation chooser logic.
- Viability flag threshold behavior around zero.

### Integration tests
- API route returns stable response shape for mocked provider.
- UI renders expected row states (valid/invalid/viable).

### Manual checks
- A ticker with rich chains (e.g., AAPL, MSFT) returns rows for 30/60 and 60/90.
- Missing exact expiries still yields approximate pairs.

---

## 11. Risks and mitigations
- **Unreliable free market data**: isolate with provider adapter, add fallback provider later.
- **IV missing on some contracts**: skip row with explicit note; do not silently default.
- **Noisy forward variance**: clamp display handling and expose invalid-state reason.

---

## 12. Acceptance criteria for v1
1. User can choose any S&P 500 ticker from populated list.
2. App returns at least default pair rows when option data exists.
3. Each row shows Forward Volatility Edge and viability decision.
4. DTE approximation is visible (target vs actual) and consistent.
