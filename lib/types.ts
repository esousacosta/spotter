export type Ticker = {
  symbol: string;
  name: string;
};

export type TargetPair = {
  shortDte: number;
  longDte: number;
};

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
};

export type ForwardVolResponse = {
  symbol: string;
  asOf: string;
  rows: ForwardVolRow[];
};

export type RankedForwardVolRow = ForwardVolRow & {
  symbol: string;
  companyName: string;
};

export type TopForwardVolResponse = {
  asOf: string;
  scannedSymbols: number;
  processedSymbols: number;
  successfulSymbols: number;
  isComplete: boolean;
  isWarming: boolean;
  rows: RankedForwardVolRow[];
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
