/**
 * Scan statistics tracking for measuring where rows are rejected
 * to identify the most restrictive filters.
 */

export type RejectionReason =
  | "no_valid_expiry_pair"
  | "earnings_ineligible"
  | "missing_shared_atm_strike"
  | "invalid_forward_variance"
  | "below_viability_threshold"
  | "stale_or_missing_quote"
  | "failed_earnings_safeguards"
  | "failed_earnings_evaluation";

export type ScanStats = {
  totalScanned: number;
  rejectionCounts: Record<RejectionReason, number>;
  topRejectionReasons: Array<{ reason: RejectionReason; count: number }>;
};

export class ScanStatsCollector {
  private rejectionCounts: Record<RejectionReason, number>;

  constructor() {
    this.rejectionCounts = {
      no_valid_expiry_pair: 0,
      earnings_ineligible: 0,
      missing_shared_atm_strike: 0,
      invalid_forward_variance: 0,
      below_viability_threshold: 0,
      stale_or_missing_quote: 0,
      failed_earnings_safeguards: 0,
      failed_earnings_evaluation: 0,
    };
  }

  recordRejection(reason: RejectionReason): void {
    this.rejectionCounts[reason] += 1;
  }

  getStats(totalScanned: number): ScanStats {
    const reasons: Array<{ reason: RejectionReason; count: number }> = Object.entries(
      this.rejectionCounts,
    )
      .map(([reason, count]) => ({ reason: reason as RejectionReason, count }))
      .filter((item) => item.count > 0)
      .sort((a, b) => b.count - a.count);

    return {
      totalScanned,
      rejectionCounts: this.rejectionCounts,
      topRejectionReasons: reasons.slice(0, 3),
    };
  }
}
