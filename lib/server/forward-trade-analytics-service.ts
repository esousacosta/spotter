import { getCached } from "@/lib/server/cache";
import { marketDataProvider, type OptionContract } from "@/lib/server/market-data-provider";
import type { ForwardTradeAnalyticsRequest, ForwardTradeAnalyticsResponse } from "@/lib/types";

const CONTRACT_MULTIPLIER = 100;
const CONTRACT_COUNT = 1;
const DEFAULT_MAX_MOVE_PCT = 0.3;
const DEFAULT_SCENARIO_STEPS = 31;
const DEFAULT_RISK_FREE_RATE = 0.045;
const DEFAULT_DIVIDEND_YIELD = 0;
const ANALYTICS_CACHE_TTL_MS = 5 * 60 * 1000;

type Greeks = {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
};

type OptionMetrics = Greeks & {
  price: number;
};

export class ForwardTradeAnalyticsError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "ForwardTradeAnalyticsError";
    this.status = status;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function parseIsoToNoonUnix(isoDate: string): number {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    throw new ForwardTradeAnalyticsError(`Invalid expiry date: ${isoDate}`, 400);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return Math.floor(Date.UTC(year, month - 1, day, 12, 0, 0) / 1000);
}

function yearsBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.max(ms / (365 * 24 * 60 * 60 * 1000), 0);
}

function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * absX);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) *
      Math.exp(-absX * absX);
  return sign * y;
}

function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.sqrt(2)));
}

export function blackScholesCallMetrics(
  spot: number,
  strike: number,
  timeYears: number,
  sigma: number,
  rate: number,
  dividendYield: number,
): OptionMetrics {
  if (timeYears <= 0 || sigma <= 0) {
    const intrinsic = Math.max(spot - strike, 0);
    const delta = spot > strike ? 1 : spot < strike ? 0 : 0.5;
    return {
      price: intrinsic,
      delta,
      gamma: 0,
      theta: 0,
      vega: 0,
      rho: 0,
    };
  }

  const sqrtT = Math.sqrt(timeYears);
  const discountedQ = Math.exp(-dividendYield * timeYears);
  const discountedR = Math.exp(-rate * timeYears);
  const d1 =
    (Math.log(spot / strike) + (rate - dividendYield + 0.5 * sigma * sigma) * timeYears) /
    (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const nd1 = normalCdf(d1);
  const nd2 = normalCdf(d2);
  const pdfD1 = normalPdf(d1);

  const price = spot * discountedQ * nd1 - strike * discountedR * nd2;
  const delta = discountedQ * nd1;
  const gamma = (discountedQ * pdfD1) / (spot * sigma * sqrtT);
  const thetaAnnual =
    (-spot * discountedQ * pdfD1 * sigma) / (2 * sqrtT) -
    rate * strike * discountedR * nd2 +
    dividendYield * spot * discountedQ * nd1;
  const theta = thetaAnnual / 365;
  const vega = spot * discountedQ * pdfD1 * sqrtT;
  const rho = strike * timeYears * discountedR * nd2;

  return { price, delta, gamma, theta, vega, rho };
}

function findContractByStrike(contracts: OptionContract[], strike: number): OptionContract | null {
  return contracts.find((contract) => Math.abs(contract.strike - strike) < 0.001) ?? null;
}

function isFinitePrice(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

function midpointOrModel(
  contract: OptionContract,
  modelPrice: number,
  warnings: string[],
  legName: string,
): number {
  if (isFinitePrice(contract.bid) && isFinitePrice(contract.ask) && contract.ask >= contract.bid) {
    return (contract.bid + contract.ask) / 2;
  }
  warnings.push(`Missing bid/ask on ${legName} leg; using model theoretical price for entry valuation.`);
  return modelPrice;
}

function interpolateRootX(x0: number, y0: number, x1: number, y1: number): number {
  if (y1 === y0) {
    return (x0 + x1) / 2;
  }
  return x0 + ((0 - y0) * (x1 - x0)) / (y1 - y0);
}

export function gatherBreakEvenPoints(xs: number[], ys: number[]): number[] {
  const roots: number[] = [];
  for (let i = 0; i < xs.length - 1; i += 1) {
    const x0 = xs[i];
    const x1 = xs[i + 1];
    const y0 = ys[i];
    const y1 = ys[i + 1];
    if (y0 === 0) {
      roots.push(x0);
      continue;
    }
    if (y0 * y1 < 0) {
      roots.push(interpolateRootX(x0, y0, x1, y1));
    }
  }
  if (ys[ys.length - 1] === 0) {
    roots.push(xs[xs.length - 1]);
  }
  return roots;
}

function interpolateY(xs: number[], ys: number[], x: number): number {
  if (x <= xs[0]) {
    return ys[0];
  }
  if (x >= xs[xs.length - 1]) {
    return ys[ys.length - 1];
  }
  for (let i = 0; i < xs.length - 1; i += 1) {
    const x0 = xs[i];
    const x1 = xs[i + 1];
    if (x >= x0 && x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return ys[i] + t * (ys[i + 1] - ys[i]);
    }
  }
  return ys[ys.length - 1];
}

function lognormalCdf(x: number, mu: number, sigmaTerm: number): number {
  if (x <= 0) {
    return 0;
  }
  const z = (Math.log(x) - mu) / sigmaTerm;
  return normalCdf(z);
}

export function popFromScenarioCurve(
  underlyings: number[],
  pnls: number[],
  spot: number,
  valuationYears: number,
  rate: number,
  dividendYield: number,
  sigmaRef: number,
): number | null {
  if (valuationYears <= 0 || sigmaRef <= 0) {
    return interpolateY(underlyings, pnls, spot) > 0 ? 1 : 0;
  }

  const sigmaTerm = sigmaRef * Math.sqrt(valuationYears);
  if (!Number.isFinite(sigmaTerm) || sigmaTerm <= 0) {
    return null;
  }
  const mu = Math.log(spot) + (rate - dividendYield - 0.5 * sigmaRef * sigmaRef) * valuationYears;
  const roots = gatherBreakEvenPoints(underlyings, pnls).sort((a, b) => a - b);
  const bounds = [0, ...roots, Number.POSITIVE_INFINITY];
  let probability = 0;

  for (let i = 0; i < bounds.length - 1; i += 1) {
    const lower = bounds[i];
    const upper = bounds[i + 1];
    const probe =
      !Number.isFinite(lower) || lower === 0
        ? Number.isFinite(upper)
          ? upper * 0.5
          : spot
        : Number.isFinite(upper)
          ? (lower + upper) / 2
          : lower * 1.2;

    const pnlAtProbe = interpolateY(underlyings, pnls, probe);
    if (pnlAtProbe <= 0) {
      continue;
    }

    const lowerCdf = lower <= 0 ? 0 : lognormalCdf(lower, mu, sigmaTerm);
    const upperCdf = Number.isFinite(upper) ? lognormalCdf(upper, mu, sigmaTerm) : 1;
    probability += upperCdf - lowerCdf;
  }

  return clamp(probability, 0, 1);
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function buildCacheKey(request: ForwardTradeAnalyticsRequest): string {
  const maxMovePct = request.maxMovePct ?? DEFAULT_MAX_MOVE_PCT;
  const steps = request.steps ?? DEFAULT_SCENARIO_STEPS;
  const valuationDateMode = request.valuationDateMode ?? "shortExpiry";
  const valuationDate = valuationDateMode === "custom" ? request.valuationDate ?? "" : "";
  return [
    request.symbol.toUpperCase(),
    request.shortExpiry,
    request.longExpiry,
    request.strike.toString(),
    maxMovePct.toString(),
    steps.toString(),
    valuationDateMode,
    valuationDate,
  ].join("|");
}

function parseValuationDate(request: ForwardTradeAnalyticsRequest, shortExpiry: string): Date {
  const mode = request.valuationDateMode ?? "shortExpiry";
  if (mode === "shortExpiry") {
    return new Date(`${shortExpiry}T16:00:00.000Z`);
  }
  if (!request.valuationDate) {
    throw new ForwardTradeAnalyticsError("valuationDate is required when valuationDateMode=custom.", 400);
  }
  const valuation = new Date(request.valuationDate);
  if (Number.isNaN(valuation.getTime())) {
    throw new ForwardTradeAnalyticsError("valuationDate must be a valid ISO date.", 400);
  }
  return valuation;
}

export async function computeForwardTradeAnalytics(
  request: ForwardTradeAnalyticsRequest,
): Promise<ForwardTradeAnalyticsResponse> {
  const symbol = request.symbol.trim().toUpperCase();
  const strike = request.strike;
  const maxMovePct = clamp(request.maxMovePct ?? DEFAULT_MAX_MOVE_PCT, 0.05, 0.8);
  const requestedSteps = Math.round(request.steps ?? DEFAULT_SCENARIO_STEPS);
  const stepsBase = clamp(requestedSteps, 11, 101);
  const steps = stepsBase % 2 === 0 ? stepsBase + 1 : stepsBase;
  const warnings: string[] = [];
  const asOf = request.asOf ? new Date(request.asOf) : new Date();
  if (Number.isNaN(asOf.getTime())) {
    throw new ForwardTradeAnalyticsError("asOf must be a valid ISO date when provided.", 400);
  }

  const valuationDate = parseValuationDate(request, request.shortExpiry);
  const longExpiryDate = new Date(`${request.longExpiry}T16:00:00.000Z`);
  if (valuationDate.getTime() > longExpiryDate.getTime()) {
    throw new ForwardTradeAnalyticsError("valuationDate cannot be after longExpiry.", 400);
  }

  const shortExpiryUnix = parseIsoToNoonUnix(request.shortExpiry);
  const longExpiryUnix = parseIsoToNoonUnix(request.longExpiry);
  const [snapshot, shortCalls, longCalls] = await Promise.all([
    marketDataProvider.getOptionSnapshot(symbol),
    marketDataProvider.getOptionChainCalls(symbol, shortExpiryUnix),
    marketDataProvider.getOptionChainCalls(symbol, longExpiryUnix),
  ]);

  const shortContract = findContractByStrike(shortCalls, strike);
  if (!shortContract) {
    throw new ForwardTradeAnalyticsError(
      `Short-expiry contract not found at strike ${strike} for ${symbol} ${request.shortExpiry}.`,
      422,
    );
  }
  const longContract = findContractByStrike(longCalls, strike);
  if (!longContract) {
    throw new ForwardTradeAnalyticsError(
      `Long-expiry contract not found at strike ${strike} for ${symbol} ${request.longExpiry}.`,
      422,
    );
  }

  const spot = snapshot.spotPrice;
  const rate = DEFAULT_RISK_FREE_RATE;
  const dividendYield = DEFAULT_DIVIDEND_YIELD;
  warnings.push("Dividend yield data unavailable; assuming q=0.00 for phase-1 analytics.");

  const shortTimeNow = yearsBetween(asOf, new Date(`${request.shortExpiry}T16:00:00.000Z`));
  const longTimeNow = yearsBetween(asOf, longExpiryDate);
  const shortNow = blackScholesCallMetrics(
    spot,
    strike,
    shortTimeNow,
    shortContract.impliedVolatility,
    rate,
    dividendYield,
  );
  const longNow = blackScholesCallMetrics(
    spot,
    strike,
    longTimeNow,
    longContract.impliedVolatility,
    rate,
    dividendYield,
  );

  const shortEntry = midpointOrModel(shortContract, shortNow.price, warnings, "short");
  const longEntry = midpointOrModel(longContract, longNow.price, warnings, "long");
  const entryCost = (longEntry - shortEntry) * CONTRACT_MULTIPLIER * CONTRACT_COUNT;

  const scenarios = [];
  const xUnderlying: number[] = [];
  const yPnl: number[] = [];
  const yDelta: number[] = [];
  const yGamma: number[] = [];
  const yTheta: number[] = [];
  const scenarioStep = (2 * maxMovePct) / (steps - 1);
  const shortTimeAtVal = yearsBetween(valuationDate, new Date(`${request.shortExpiry}T16:00:00.000Z`));
  const longTimeAtVal = yearsBetween(valuationDate, longExpiryDate);

  for (let i = 0; i < steps; i += 1) {
    const movePct = -maxMovePct + scenarioStep * i;
    const underlying = spot * (1 + movePct);
    const shortMetrics = blackScholesCallMetrics(
      underlying,
      strike,
      shortTimeAtVal,
      shortContract.impliedVolatility,
      rate,
      dividendYield,
    );
    const longMetrics = blackScholesCallMetrics(
      underlying,
      strike,
      longTimeAtVal,
      longContract.impliedVolatility,
      rate,
      dividendYield,
    );

    const positionValue = (longMetrics.price - shortMetrics.price) * CONTRACT_MULTIPLIER * CONTRACT_COUNT;
    const pnl = positionValue - entryCost;
    const delta = (longMetrics.delta - shortMetrics.delta) * CONTRACT_MULTIPLIER * CONTRACT_COUNT;
    const gamma = (longMetrics.gamma - shortMetrics.gamma) * CONTRACT_MULTIPLIER * CONTRACT_COUNT;
    const theta = (longMetrics.theta - shortMetrics.theta) * CONTRACT_MULTIPLIER * CONTRACT_COUNT;
    const vega = (longMetrics.vega - shortMetrics.vega) * CONTRACT_MULTIPLIER * CONTRACT_COUNT;
    const rho = (longMetrics.rho - shortMetrics.rho) * CONTRACT_MULTIPLIER * CONTRACT_COUNT;

    scenarios.push({
      movePct: round(movePct),
      underlying: round(underlying),
      pnl: round(pnl),
      delta: round(delta),
      gamma: round(gamma),
      theta: round(theta),
      vega: round(vega),
      rho: round(rho),
    });
    xUnderlying.push(underlying);
    yPnl.push(pnl);
    yDelta.push(delta);
    yGamma.push(gamma);
    yTheta.push(theta);
  }

  const breakEvenPoints = gatherBreakEvenPoints(xUnderlying, yPnl);
  const breakEven =
    breakEvenPoints.length > 0
      ? breakEvenPoints.sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot))[0]
      : null;

  let maxProfit = Number.NEGATIVE_INFINITY;
  let maxProfitIndex = -1;
  let maxLoss = Number.POSITIVE_INFINITY;
  let maxLossIndex = -1;
  yPnl.forEach((value, index) => {
    if (value > maxProfit) {
      maxProfit = value;
      maxProfitIndex = index;
    }
    if (value < maxLoss) {
      maxLoss = value;
      maxLossIndex = index;
    }
  });

  const maxProfitValue =
    maxProfitIndex === 0 || maxProfitIndex === yPnl.length - 1 ? null : round(maxProfit);
  const maxLossValue = maxLossIndex === 0 || maxLossIndex === yPnl.length - 1 ? null : round(maxLoss);
  if (maxProfitValue === null) {
    warnings.push("Max profit falls at scenario boundary; reported as null under current move range.");
  }
  if (maxLossValue === null) {
    warnings.push("Max loss falls at scenario boundary; reported as null under current move range.");
  }
  const returnRisk =
    maxProfitValue !== null && maxLossValue !== null && maxLossValue < 0
      ? round(maxProfitValue / Math.abs(maxLossValue))
      : null;

  const valuationYears = yearsBetween(asOf, valuationDate);
  const sigmaRef = longContract.impliedVolatility;
  const probabilityOfProfit = popFromScenarioCurve(
    xUnderlying,
    yPnl,
    spot,
    valuationYears,
    rate,
    dividendYield,
    sigmaRef,
  );
  const sigmaTerm = sigmaRef * Math.sqrt(Math.max(valuationYears, 0));
  const mu =
    valuationYears > 0 ? Math.log(spot) + (rate - dividendYield - 0.5 * sigmaRef * sigmaRef) * valuationYears : null;
  const scenariosWithPop = scenarios.map((scenario) => {
    let popAtOrAboveThisPrice: number | null = null;
    if (valuationYears <= 0) {
      popAtOrAboveThisPrice = scenario.underlying <= spot ? 1 : 0;
    } else if (mu !== null && sigmaTerm > 0) {
      popAtOrAboveThisPrice = round(1 - lognormalCdf(scenario.underlying, mu, sigmaTerm));
    }
    return {
      ...scenario,
      popAtOrAboveThisPrice,
    };
  });

  return {
    symbol,
    asOf: asOf.toISOString(),
    valuationDate: valuationDate.toISOString(),
    spot: round(spot),
    strike: round(strike),
    shortExpiry: request.shortExpiry,
    longExpiry: request.longExpiry,
    rates: { r: rate, q: null, source: "constant-rate-phase-1" },
    assumptions: {
      pricingModel: "Black-Scholes-European",
      contracts: CONTRACT_COUNT,
      multiplier: CONTRACT_MULTIPLIER,
      popMethod: "lognormal_terminal",
    },
    profile: {
      maxProfit: maxProfitValue,
      maxLoss: maxLossValue,
      breakEven: breakEven === null ? null : round(breakEven),
      returnRisk,
      probabilityOfProfit: probabilityOfProfit === null ? null : round(probabilityOfProfit),
    },
    greeksNow: {
      delta: round((longNow.delta - shortNow.delta) * CONTRACT_MULTIPLIER * CONTRACT_COUNT),
      gamma: round((longNow.gamma - shortNow.gamma) * CONTRACT_MULTIPLIER * CONTRACT_COUNT),
      theta: round((longNow.theta - shortNow.theta) * CONTRACT_MULTIPLIER * CONTRACT_COUNT),
      vega: round((longNow.vega - shortNow.vega) * CONTRACT_MULTIPLIER * CONTRACT_COUNT),
      rho: round((longNow.rho - shortNow.rho) * CONTRACT_MULTIPLIER * CONTRACT_COUNT),
    },
    scenarios: scenariosWithPop,
    chart: {
      xUnderlying: xUnderlying.map(round),
      yPnl: yPnl.map(round),
      yDelta: yDelta.map(round),
      yGamma: yGamma.map(round),
      yTheta: yTheta.map(round),
    },
    warnings,
  };
}

export async function getForwardTradeAnalytics(
  request: ForwardTradeAnalyticsRequest,
): Promise<ForwardTradeAnalyticsResponse> {
  const cacheKey = `forward-trade-analytics:${buildCacheKey(request)}`;
  return getCached(cacheKey, ANALYTICS_CACHE_TTL_MS, () => computeForwardTradeAnalytics(request));
}
