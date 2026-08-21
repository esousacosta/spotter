/**
 * Trade PnL Calculation Module
 *
 * Pure, deterministic functions for computing gross PnL, net PnL, return on debit,
 * and max risk. All formulas are explicit and documented to avoid sign ambiguity.
 */

export interface PnlInput {
  entryNetDebit: number;
  exitNetCredit: number;
  contractMultiplier: number;
  quantity: number;
}

export interface PnlOutput {
  grossPnl: number;
  netPnl: number;
  returnOnDebit: number;
}

/**
 * Compute gross PnL from entry/exit cashflows
 *
 * Formula: gross_pnl = (exit_cashflow - entry_cashflow) * contract_multiplier * contracts
 *
 * Sign convention:
 * - Entry debit is cash outflow (positive number, treated as cost)
 * - Exit credit is cash inflow (positive number, treated as proceeds)
 * - Gross PnL = (proceeds - cost) * multiplier * contracts
 *
 * @param input PnL calculation inputs
 * @returns Gross PnL (positive = profit, negative = loss)
 */
export function computeGrossPnl(input: PnlInput): number {
  const { entryNetDebit, exitNetCredit, contractMultiplier, quantity } = input;
  const grossCashflowPerContract = exitNetCredit - entryNetDebit;
  return grossCashflowPerContract * contractMultiplier * Math.abs(quantity);
}

/**
 * Compute net PnL after commissions
 *
 * Formula: net_pnl = gross_pnl - entry_commissions - exit_commissions
 *
 * @param grossPnl Gross PnL before commissions
 * @param entryCommissions Commission paid at entry (non-negative)
 * @param exitCommissions Commission paid at exit (non-negative)
 * @returns Net PnL after all commissions
 */
export function computeNetPnl(
  grossPnl: number,
  entryCommissions: number,
  exitCommissions: number
): number {
  return grossPnl - entryCommissions - exitCommissions;
}

/**
 * Compute return on debit (ROD) percentage
 *
 * Formula: return_on_debit = net_pnl / (entry_debit * contract_multiplier * contracts)
 *
 * This metric expresses net profit as a percentage of the cash debit at entry.
 * Useful for comparing returns across different position sizes and strategies.
 *
 * @param netPnl Net PnL after all commissions
 * @param input PnL inputs (for entry debit and sizing)
 * @returns Return percentage (0.05 = 5%), or null if entry debit is zero
 */
export function computeReturnOnDebit(netPnl: number, input: PnlInput): number | null {
  const { entryNetDebit, contractMultiplier, quantity } = input;
  const entryDebitTotal = Math.abs(entryNetDebit * contractMultiplier * Math.abs(quantity));

  if (entryDebitTotal === 0) {
    return null;
  }

  return netPnl / entryDebitTotal;
}

/**
 * Compute max risk for a position
 *
 * For a debit spread (call spread, put spread), max risk is the entry debit.
 * For a credit spread, max risk is the width of the spread minus the credit received.
 * For single legs, we don't have enough info here to compute; this is a placeholder.
 *
 * Note: This is a simplified implementation; full max risk requires leg-level
 * strike information and side/type details.
 *
 * @param input PnL inputs
 * @returns Max risk (the maximum amount you can lose on the trade)
 */
export function computeMaxRisk(input: PnlInput): number {
  const { entryNetDebit, contractMultiplier, quantity } = input;
  // For debit spreads, max risk = entry debit
  // For credit spreads, max risk = (spread width - credit) * multiplier * contracts
  // Simplified: assuming debit spread (entry is debit, risk is capped at entry amount)
  return Math.abs(entryNetDebit * contractMultiplier * Math.abs(quantity));
}

/**
 * All-in-one PnL calculation wrapper
 *
 * @param input PnL inputs
 * @param entryCommissions Commission at entry
 * @param exitCommissions Commission at exit
 * @returns Full PnL output with gross, net, and return metrics
 */
export function computeAllPnlMetrics(
  input: PnlInput,
  entryCommissions: number = 0,
  exitCommissions: number = 0
): PnlOutput {
  const grossPnl = computeGrossPnl(input);
  const netPnl = computeNetPnl(grossPnl, entryCommissions, exitCommissions);
  const returnOnDebit = computeReturnOnDebit(netPnl, input);

  return {
    grossPnl,
    netPnl,
    returnOnDebit: returnOnDebit ?? 0,
  };
}
