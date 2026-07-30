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
  successfulSymbols: number;
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

export type TopPreEarningsResponse = {
  asOf: string;
  scannedSymbols: number;
  evaluatedSymbols: number;
  viableSymbols: number;
  rows: PreEarningsRow[];
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
