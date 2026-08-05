export type Ticker = {
  symbol: string;
  name: string;
};

export type TargetPair = {
  shortDte: number;
  longDte: number;
};

export type RejectionReason =
  | "no_valid_expiry_pair"
  | "earnings_ineligible"
  | "missing_shared_atm_strike"
  | "invalid_forward_variance"
  | "below_viability_threshold"
  | "stale_or_missing_quote"
  | "failed_earnings_safeguards"
  | "failed_earnings_evaluation";

export type ForwardVolRow = {
  shortTargetDte: number;
  longTargetDte: number;
  nextEarningsDate: string | null;
  tradeClass: "standard" | "earnings-exposed" | null;
  selectedStrike: number | null;
  shortExpiry: string | null;
  longExpiry: string | null;
  shortDteActual: number | null;
  longDteActual: number | null;
  ivShort: number | null;
  ivLong: number | null;
  shortOpenInterest: number | null;
  longOpenInterest: number | null;
  forwardVol: number | null;
  rawForwardVolEdge: number | null;
  adjustedForwardVolEdge: number | null;
  forwardVolEdge: number | null;
  isViable: boolean;
  status: "ok" | "invalid";
  notes: string;
  quoteTime: string | null;
  isStale?: boolean;
  rejectionReason?: RejectionReason | null;
};

export type ForwardVolResponse = {
  symbol: string;
  asOf: string;
  quoteAsOf?: string | null;
  isStale?: boolean;
  warning?: string | null;
  rows: ForwardVolRow[];
};

export type RankedForwardVolRow = ForwardVolRow & {
  symbol: string;
  companyName: string;
  rankingReason: string | null;
};

export type ScanStats = {
  totalScanned: number;
  rejectionCounts: Record<string, number>;
  topRejectionReasons: Array<{ reason: string; count: number }>;
};

export type TopForwardVolResponse = {
  asOf: string;
  scannedSymbols: number;
  processedSymbols: number;
  successfulSymbols: number;
  isComplete: boolean;
  isWarming: boolean;
  isStale?: boolean;
  warning?: string | null;
  scanStats?: ScanStats | null;
  rows: RankedForwardVolRow[];
};

export type ForwardTradeAnalyticsRequest = {
  symbol: string;
  shortExpiry: string;
  longExpiry: string;
  strike: number;
  asOf?: string;
  maxMovePct?: number;
  steps?: number;
  valuationDateMode?: "shortExpiry" | "custom";
  valuationDate?: string;
};

export type ForwardTradeScenarioRow = {
  movePct: number;
  underlying: number;
  pnl: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
  popAtOrAboveThisPrice?: number | null;
};

export type ForwardTradeAnalyticsResponse = {
  symbol: string;
  asOf: string;
  valuationDate: string;
  spot: number;
  strike: number;
  shortExpiry: string;
  longExpiry: string;
  rates: { r: number; q: number | null; source: string };
  assumptions: {
    pricingModel: "Black-Scholes-European";
    contracts: number;
    multiplier: number;
    popMethod: "lognormal_terminal" | "monte_carlo";
  };
  profile: {
    maxProfit: number | null;
    maxLoss: number | null;
    breakEven: number | null;
    returnRisk: number | null;
    probabilityOfProfit: number | null;
  };
  greeksNow: {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
    rho: number;
  };
  scenarios: ForwardTradeScenarioRow[];
  chart: {
    xUnderlying: number[];
    yPnl: number[];
    yDelta?: number[];
    yGamma?: number[];
    yTheta?: number[];
  };
  warnings: string[];
};

export type PreEarningsVerdict = "recommended" | "consider" | "avoid";

export type PreEarningsRow = {
  symbol: string;
  companyName: string;
  nextEarningsDate: string | null;
  earningsSession: string | null;
  underlyingPrice: number | null;
  expectedMove: string | null;
  avgVolume30: number | null;
  iv30Rv30: number | null;
  tsSlope0To45: number | null;
  avgVolumePass: boolean;
  iv30Rv30Pass: boolean;
  tsSlopePass: boolean;
  verdict: PreEarningsVerdict;
  isViable: boolean;
  notes: string;
  quoteTime: string | null;
  isStale?: boolean;
};

export type PreEarningsRejectedRow = {
  symbol: string;
  companyName: string;
  nextEarningsDate: string | null;
  earningsSession: string | null;
  rejectionCategory: "data" | "criteria";
  rejectionStage: string;
  rejectionReason: string;
  wasComputed: boolean;
  underlyingPrice: number | null;
  expectedMove: string | null;
  avgVolume30: number | null;
  iv30Rv30: number | null;
  tsSlope0To45: number | null;
  avgVolumePass: boolean | null;
  iv30Rv30Pass: boolean | null;
  tsSlopePass: boolean | null;
  verdict: PreEarningsVerdict | null;
  isStale?: boolean;
};

export type TopPreEarningsResponse = {
  asOf: string;
  scannedSymbols: number;
  evaluatedSymbols: number;
  computedSymbols: number;
  viableSymbols: number;
  rejectedSymbols: number;
  isComplete: boolean;
  isWarming: boolean;
  isStale?: boolean;
  warning?: string | null;
  rows: PreEarningsRow[];
  rejectedRows: PreEarningsRejectedRow[];
};

export type UpcomingEarningsRow = {
  symbol: string;
  companyName: string;
  earningsDate: string;
  earningsSession: string | null;
  strategyEntry: string;
  strategyExit: string;
};

export type UpcomingEarningsResponse = {
  asOf: string;
  daysAhead: number;
  totalRows: number;
  rows: UpcomingEarningsRow[];
};
