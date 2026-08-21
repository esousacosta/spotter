import { describe, it, expect } from "vitest";
import {
  computeGrossPnl,
  computeNetPnl,
  computeReturnOnDebit,
  computeMaxRisk,
  computeAllPnlMetrics,
  type PnlInput,
} from "./trade-pnl";

describe("trade-pnl", () => {
  describe("computeGrossPnl", () => {
    it("should compute positive gross PnL on a winning debit trade", () => {
      const input: PnlInput = {
        entryNetDebit: 1.0, // paid $1 per contract
        exitNetCredit: 1.5, // received $1.50 per contract
        contractMultiplier: 100,
        quantity: 5, // 5 contracts
      };
      const result = computeGrossPnl(input);
      // (1.5 - 1.0) * 100 * 5 = 0.5 * 100 * 5 = 250
      expect(result).toBe(250);
    });

    it("should compute negative gross PnL on a losing debit trade", () => {
      const input: PnlInput = {
        entryNetDebit: 2.0,
        exitNetCredit: 1.0,
        contractMultiplier: 100,
        quantity: 10,
      };
      const result = computeGrossPnl(input);
      // (1.0 - 2.0) * 100 * 10 = -1.0 * 100 * 10 = -1000
      expect(result).toBe(-1000);
    });

    it("should handle zero gross PnL (breakeven)", () => {
      const input: PnlInput = {
        entryNetDebit: 2.5,
        exitNetCredit: 2.5,
        contractMultiplier: 100,
        quantity: 1,
      };
      const result = computeGrossPnl(input);
      expect(result).toBe(0);
    });

    it("should handle single contract", () => {
      const input: PnlInput = {
        entryNetDebit: 0.5,
        exitNetCredit: 0.75,
        contractMultiplier: 100,
        quantity: 1,
      };
      const result = computeGrossPnl(input);
      // (0.75 - 0.5) * 100 * 1 = 0.25 * 100 = 25
      expect(result).toBe(25);
    });

    it("should handle large position size", () => {
      const input: PnlInput = {
        entryNetDebit: 1.0,
        exitNetCredit: 1.1,
        contractMultiplier: 100,
        quantity: 100,
      };
      const result = computeGrossPnl(input);
      // (1.1 - 1.0) * 100 * 100 = 0.1 * 100 * 100 = 1000
      expect(result).toBeCloseTo(1000, 2);
    });

    it("should handle fractional per-contract amounts", () => {
      const input: PnlInput = {
        entryNetDebit: 0.15,
        exitNetCredit: 0.25,
        contractMultiplier: 100,
        quantity: 2,
      };
      const result = computeGrossPnl(input);
      // (0.25 - 0.15) * 100 * 2 = 0.1 * 100 * 2 = 20
      expect(result).toBe(20);
    });
  });

  describe("computeNetPnl", () => {
    it("should subtract entry and exit commissions from gross", () => {
      const result = computeNetPnl(1000, 10, 5);
      expect(result).toBe(985);
    });

    it("should handle zero commissions", () => {
      const result = computeNetPnl(500, 0, 0);
      expect(result).toBe(500);
    });

    it("should handle high commission scenario", () => {
      const result = computeNetPnl(100, 30, 20);
      expect(result).toBe(50);
    });

    it("should handle negative gross with commissions", () => {
      const result = computeNetPnl(-500, 10, 10);
      expect(result).toBe(-520);
    });
  });

  describe("computeReturnOnDebit", () => {
    it("should compute positive return percentage", () => {
      const input: PnlInput = {
        entryNetDebit: 1.0,
        exitNetCredit: 1.5,
        contractMultiplier: 100,
        quantity: 10,
      };
      const netPnl = 500; // $500 profit
      const result = computeReturnOnDebit(netPnl, input);
      // entry debit total = 1.0 * 100 * 10 = 1000
      // return = 500 / 1000 = 0.5 (50%)
      expect(result).toBe(0.5);
    });

    it("should compute negative return percentage (loss)", () => {
      const input: PnlInput = {
        entryNetDebit: 2.0,
        exitNetCredit: 1.0,
        contractMultiplier: 100,
        quantity: 5,
      };
      const netPnl = -250; // $250 loss
      const result = computeReturnOnDebit(netPnl, input);
      // entry debit total = 2.0 * 100 * 5 = 1000
      // return = -250 / 1000 = -0.25 (-25%)
      expect(result).toBe(-0.25);
    });

    it("should return null when entry debit is zero", () => {
      const input: PnlInput = {
        entryNetDebit: 0,
        exitNetCredit: 1.0,
        contractMultiplier: 100,
        quantity: 5,
      };
      const netPnl = 100;
      const result = computeReturnOnDebit(netPnl, input);
      expect(result).toBeNull();
    });

    it("should compute small return correctly", () => {
      const input: PnlInput = {
        entryNetDebit: 10.0,
        exitNetCredit: 10.1,
        contractMultiplier: 100,
        quantity: 1,
      };
      const netPnl = 10; // $10 profit (before commissions)
      const result = computeReturnOnDebit(netPnl, input);
      // entry debit total = 10.0 * 100 * 1 = 1000
      // return = 10 / 1000 = 0.01 (1%)
      expect(result).toBe(0.01);
    });
  });

  describe("computeMaxRisk", () => {
    it("should compute max risk as entry debit for simple case", () => {
      const input: PnlInput = {
        entryNetDebit: 1.0,
        exitNetCredit: 0,
        contractMultiplier: 100,
        quantity: 5,
      };
      const result = computeMaxRisk(input);
      // max risk = 1.0 * 100 * 5 = 500
      expect(result).toBe(500);
    });

    it("should handle single contract max risk", () => {
      const input: PnlInput = {
        entryNetDebit: 0.5,
        exitNetCredit: 0,
        contractMultiplier: 100,
        quantity: 1,
      };
      const result = computeMaxRisk(input);
      // max risk = 0.5 * 100 * 1 = 50
      expect(result).toBe(50);
    });

    it("should compute max risk for large position", () => {
      const input: PnlInput = {
        entryNetDebit: 2.0,
        exitNetCredit: 0,
        contractMultiplier: 100,
        quantity: 50,
      };
      const result = computeMaxRisk(input);
      // max risk = 2.0 * 100 * 50 = 10000
      expect(result).toBe(10000);
    });
  });

  describe("computeAllPnlMetrics", () => {
    it("should compute all metrics for a winning trade", () => {
      const input: PnlInput = {
        entryNetDebit: 1.0,
        exitNetCredit: 1.5,
        contractMultiplier: 100,
        quantity: 10,
      };
      const result = computeAllPnlMetrics(input, 10, 5);
      expect(result.grossPnl).toBe(500); // (1.5 - 1.0) * 100 * 10
      expect(result.netPnl).toBe(485); // 500 - 10 - 5
      expect(result.returnOnDebit).toBeCloseTo(0.485, 3); // 485 / 1000
    });

    it("should compute all metrics for a losing trade", () => {
      const input: PnlInput = {
        entryNetDebit: 2.0,
        exitNetCredit: 1.5,
        contractMultiplier: 100,
        quantity: 5,
      };
      const result = computeAllPnlMetrics(input, 15, 10);
      expect(result.grossPnl).toBe(-250); // (1.5 - 2.0) * 100 * 5
      expect(result.netPnl).toBe(-275); // -250 - 15 - 10
      expect(result.returnOnDebit).toBeCloseTo(-0.275, 2); // -275 / 1000
    });

    it("should default commissions to 0", () => {
      const input: PnlInput = {
        entryNetDebit: 1.0,
        exitNetCredit: 1.2,
        contractMultiplier: 100,
        quantity: 3,
      };
      const result = computeAllPnlMetrics(input);
      expect(result.grossPnl).toBeCloseTo(60, 0); // (1.2 - 1.0) * 100 * 3 = 60
      expect(result.netPnl).toBeCloseTo(60, 0); // no commissions
      expect(result.returnOnDebit).toBeCloseTo(0.2, 1); // 60 / 300 = 0.2
    });

    it("should handle breakeven scenario", () => {
      const input: PnlInput = {
        entryNetDebit: 1.5,
        exitNetCredit: 1.5,
        contractMultiplier: 100,
        quantity: 2,
      };
      const result = computeAllPnlMetrics(input, 5, 5);
      expect(result.grossPnl).toBe(0);
      expect(result.netPnl).toBe(-10); // 0 - 5 - 5 (commissions turn it to loss)
      expect(result.returnOnDebit).toBeCloseTo(-0.00333, 1); // -10 / 3000
    });
  });

  describe("edge cases and boundary conditions", () => {
    it("should handle very small per-contract prices", () => {
      const input: PnlInput = {
        entryNetDebit: 0.01,
        exitNetCredit: 0.02,
        contractMultiplier: 100,
        quantity: 1,
      };
      const result = computeGrossPnl(input);
      // (0.02 - 0.01) * 100 * 1 = 1
      expect(result).toBe(1);
    });

    it("should handle high per-contract prices", () => {
      const input: PnlInput = {
        entryNetDebit: 100.0,
        exitNetCredit: 150.0,
        contractMultiplier: 100,
        quantity: 1,
      };
      const result = computeGrossPnl(input);
      // (150 - 100) * 100 * 1 = 5000
      expect(result).toBe(5000);
    });

    it("should handle extremely large position sizes", () => {
      const input: PnlInput = {
        entryNetDebit: 1.0,
        exitNetCredit: 1.01,
        contractMultiplier: 100,
        quantity: 1000,
      };
      const result = computeGrossPnl(input);
      // (1.01 - 1.0) * 100 * 1000 = 1000
      expect(result).toBeCloseTo(1000, 2);
    });

    it("should preserve precision in commission calculations", () => {
      const result = computeNetPnl(1000.5, 10.25, 5.75);
      expect(result).toBe(984.5);
    });
  });
});
