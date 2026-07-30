import { describe, expect, it } from "vitest";

import {
  EARNINGS_ACCEPTED_REASON,
  EARNINGS_ALIGNMENT_REASON,
  EARNINGS_ANCHOR_DISTANCE_REASON,
  EARNINGS_ANCHOR_LIQUIDITY_REASON,
  EARNINGS_ANCHOR_MISSING_REASON,
  EARNINGS_BASELINE_CONFLICT_REASON,
  EARNINGS_MISSING_REASON,
  EARNINGS_MULTI_EVENT_REASON,
  EARNINGS_REJECTED_REASON,
  EARNINGS_SAME_DAY_REJECTED_REASON,
  EARNINGS_STANDARD_REASON,
  EARNINGS_TENOR_STRETCH_REASON,
  classifyEarningsContext,
  validateExEarningsSafeguards,
  evaluateEarningsExposedAdjustedEdge,
} from "./earnings-filter";

describe("classifyEarningsContext", () => {
  it("routes pre-earnings expiry to standard", () => {
    const result = classifyEarningsContext({
      nextEarningsDate: "2026-08-30",
      shortExpiryDate: "2026-08-15",
      isReliable: true,
    });
    expect(result).toEqual({
      state: "standard",
      tradeClass: "standard",
      reason: EARNINGS_STANDARD_REASON,
    });
  });

  it("rejects same-day earnings expiry conservatively", () => {
    const result = classifyEarningsContext({
      nextEarningsDate: "2026-08-15",
      shortExpiryDate: "2026-08-15",
      isReliable: true,
    });
    expect(result).toEqual({
      state: "ineligible",
      tradeClass: "earnings-exposed",
      reason: EARNINGS_SAME_DAY_REJECTED_REASON,
    });
  });

  it("rejects missing earnings data", () => {
    const result = classifyEarningsContext({
      nextEarningsDate: null,
      shortExpiryDate: "2026-08-15",
      isReliable: false,
    });
    expect(result).toEqual({
      state: "ineligible",
      tradeClass: null,
      reason: EARNINGS_MISSING_REASON,
    });
  });
});

describe("evaluateEarningsExposedAdjustedEdge", () => {
  it("accepts earnings-exposed trade when adjusted edge is strong", () => {
    const result = evaluateEarningsExposedAdjustedEdge({
      ivShort: 0.45,
      ivLong: 0.35,
      shortDteDays: 30,
      longDteDays: 60,
      preEarningsAnchorIv: 0.32,
    });
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.adjustedEdge).toBeGreaterThanOrEqual(0.05);
      expect(result.reason).toBe(EARNINGS_ACCEPTED_REASON);
    }
  });

  it("rejects earnings-exposed trade when adjusted edge is weak", () => {
    const result = evaluateEarningsExposedAdjustedEdge({
      ivShort: 0.35,
      ivLong: 0.33,
      shortDteDays: 30,
      longDteDays: 60,
      preEarningsAnchorIv: 0.32,
    });
    expect(result).toMatchObject({
      eligible: false,
      reason: EARNINGS_REJECTED_REASON,
    });
  });

  it("rejects when anchor IV is unavailable", () => {
    const result = evaluateEarningsExposedAdjustedEdge({
      ivShort: 0.35,
      ivLong: 0.3,
      shortDteDays: 30,
      longDteDays: 60,
      preEarningsAnchorIv: null,
    });
    expect(result).toEqual({
      eligible: false,
      adjustedEdge: null,
      adjustedForwardVol: null,
      adjustedShortIv: null,
      reason: EARNINGS_MISSING_REASON,
    });
  });

  it("rejects when short baseline exceeds short total variance", () => {
    const result = evaluateEarningsExposedAdjustedEdge({
      ivShort: 0.25,
      ivLong: 0.3,
      shortDteDays: 30,
      longDteDays: 60,
      preEarningsAnchorIv: 0.35,
    });
    expect(result).toEqual({
      eligible: false,
      adjustedEdge: null,
      adjustedForwardVol: null,
      adjustedShortIv: null,
      reason: EARNINGS_BASELINE_CONFLICT_REASON,
    });
  });
});

describe("validateExEarningsSafeguards", () => {
  it("rejects when no anchor expiry is available", () => {
    const result = validateExEarningsSafeguards({
      hasAnchorExpiry: false,
      anchorOpenInterest: null,
      daysNowToEarnings: 10,
      anchorDaysBeforeEarnings: null,
      anchorTenorGapDays: null,
      bothLegsSpanEarnings: true,
      daysEarningsToLong: 20,
    });
    expect(result).toEqual({ ok: false, reason: EARNINGS_ANCHOR_MISSING_REASON });
  });

  it("rejects when anchor open interest is zero", () => {
    const result = validateExEarningsSafeguards({
      hasAnchorExpiry: true,
      anchorOpenInterest: 0,
      daysNowToEarnings: 12,
      anchorDaysBeforeEarnings: 3,
      anchorTenorGapDays: 5,
      bothLegsSpanEarnings: true,
      daysEarningsToLong: 20,
    });
    expect(result).toEqual({ ok: false, reason: EARNINGS_ANCHOR_LIQUIDITY_REASON });
  });

  it("rejects when anchor is too far before earnings", () => {
    const result = validateExEarningsSafeguards({
      hasAnchorExpiry: true,
      anchorOpenInterest: 100,
      daysNowToEarnings: 40,
      anchorDaysBeforeEarnings: 31,
      anchorTenorGapDays: 10,
      bothLegsSpanEarnings: true,
      daysEarningsToLong: 20,
    });
    expect(result).toEqual({ ok: false, reason: EARNINGS_ANCHOR_DISTANCE_REASON });
  });

  it("rejects when legs are not aligned to same earnings span", () => {
    const result = validateExEarningsSafeguards({
      hasAnchorExpiry: true,
      anchorOpenInterest: 100,
      daysNowToEarnings: 12,
      anchorDaysBeforeEarnings: 4,
      anchorTenorGapDays: 5,
      bothLegsSpanEarnings: false,
      daysEarningsToLong: 20,
    });
    expect(result).toEqual({ ok: false, reason: EARNINGS_ALIGNMENT_REASON });
  });

  it("rejects possible multi-event windows", () => {
    const result = validateExEarningsSafeguards({
      hasAnchorExpiry: true,
      anchorOpenInterest: 100,
      daysNowToEarnings: 15,
      anchorDaysBeforeEarnings: 5,
      anchorTenorGapDays: 8,
      bothLegsSpanEarnings: true,
      daysEarningsToLong: 95,
    });
    expect(result).toEqual({ ok: false, reason: EARNINGS_MULTI_EVENT_REASON });
  });

  it("rejects when anchor tenor is too far from short tenor", () => {
    const result = validateExEarningsSafeguards({
      hasAnchorExpiry: true,
      anchorOpenInterest: 100,
      daysNowToEarnings: 20,
      anchorDaysBeforeEarnings: 6,
      anchorTenorGapDays: 24,
      bothLegsSpanEarnings: true,
      daysEarningsToLong: 25,
    });
    expect(result).toEqual({ ok: false, reason: EARNINGS_TENOR_STRETCH_REASON });
  });
});
