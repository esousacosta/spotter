/**
 * Trade Journal Service Layer
 *
 * High-level queries and business logic for trade journal operations.
 * Handles creation, updates, closing, and analytics over trades.
 */

import { randomUUID } from "crypto";
import { eq, and, desc, sql } from "drizzle-orm";
import { getDatabase } from "./db/client";
import { tradeJournalEntries, tradeJournalLegs } from "./db/schema";
import {
  computeGrossPnl,
  computeNetPnl,
  computeReturnOnDebit,
  computeMaxRisk,
  type PnlInput,
} from "./trade-pnl";

const db = getDatabase();

export interface CreateTradeInput {
  userId: string;
  symbol: string;
  strategy: string;
  openedAt: Date;
  quantity: number;
  contractMultiplier: number;
  entryNetDebit: number;
  entryCommissions: number;
  edgeAtEntry?: number;
  forwardVolAtEntry?: number;
  ivShortAtEntry?: number;
  ivLongAtEntry?: number;
  shortDteAtEntry?: number;
  longDteAtEntry?: number;
  nextEarningsDateAtEntry?: string; // YYYY-MM-DD
  tradeClassAtEntry?: "standard" | "earnings-exposed";
  quoteTimeAtEntry?: Date;
  notes?: string;
  legs: CreateLegInput[];
}

export interface CreateLegInput {
  side: "buy" | "sell";
  optionType: "call" | "put";
  quantity: number;
  strike: number;
  expirationDate: string; // YYYY-MM-DD
  entryPrice: number;
  entryIv?: number;
  openInterestAtEntry?: number;
}

export interface CloseTradeInput {
  closedAt: Date;
  exitNetCredit: number;
  exitCommissions: number;
  legs: CloseLegInput[];
}

export interface CloseLegInput {
  legId: string;
  exitPrice: number;
  exitIv?: number;
}

export interface TradeWithLegs {
  id: string;
  userId: string;
  symbol: string;
  status: "open" | "closed" | "cancelled";
  strategy: string;
  openedAt: Date;
  closedAt?: Date | null;
  edgeAtEntry?: number | null;
  forwardVolAtEntry?: number | null;
  ivShortAtEntry?: number | null;
  ivLongAtEntry?: number | null;
  shortDteAtEntry?: number | null;
  longDteAtEntry?: number | null;
  nextEarningsDateAtEntry?: string | null;
  tradeClassAtEntry?: "standard" | "earnings-exposed" | null;
  quoteTimeAtEntry?: Date | null;
  notes?: string | null;
  entryNetDebit: number;
  entryCommissions: number;
  exitNetCredit?: number | null;
  exitCommissions?: number | null;
  contractMultiplier: number;
  quantity: number;
  grossPnl?: number | null;
  netPnl?: number | null;
  returnOnDebit?: number | null;
  maxRisk?: number | null;
  createdAt: Date;
  updatedAt: Date;
  legs: TradeJournalLeg[];
}

export interface TradeJournalLeg {
  id: string;
  tradeId: string;
  side: "buy" | "sell";
  optionType: "call" | "put";
  quantity: number;
  strike: number;
  expirationDate: string;
  entryPrice: number;
  exitPrice?: number;
  entryIv?: number;
  exitIv?: number;
  openInterestAtEntry?: number;
}

export interface TradeAnalytics {
  totalNetPnl: number;
  totalGrossPnl: number;
  closedTradeCount: number;
  winCount: number;
  lossCount: number;
  winRate: number; // 0-1
  averageWin: number;
  averageLoss: number;
  profitFactor: number; // total wins / total losses
}

/**
 * Create a new trade entry with legs
 */
export async function createTrade(input: CreateTradeInput): Promise<TradeWithLegs> {
  const tradeId = randomUUID();

  const trade = await db
    .insert(tradeJournalEntries)
    .values({
      id: tradeId,
      userId: input.userId,
      symbol: input.symbol,
      status: "open",
      strategy: input.strategy,
      openedAt: input.openedAt,
      edgeAtEntry: input.edgeAtEntry,
      forwardVolAtEntry: input.forwardVolAtEntry,
      ivShortAtEntry: input.ivShortAtEntry,
      ivLongAtEntry: input.ivLongAtEntry,
      shortDteAtEntry: input.shortDteAtEntry,
      longDteAtEntry: input.longDteAtEntry,
      nextEarningsDateAtEntry: input.nextEarningsDateAtEntry,
      tradeClassAtEntry: input.tradeClassAtEntry,
      quoteTimeAtEntry: input.quoteTimeAtEntry,
      notes: input.notes,
      entryNetDebit: input.entryNetDebit,
      entryCommissions: input.entryCommissions,
      contractMultiplier: input.contractMultiplier,
      quantity: input.quantity,
    })
    .returning();

  // Insert legs
  const legs = await db
    .insert(tradeJournalLegs)
    .values(
      input.legs.map((leg) => ({
        id: randomUUID(),
        tradeId,
        side: leg.side,
        optionType: leg.optionType,
        quantity: leg.quantity,
        strike: leg.strike,
        expirationDate: leg.expirationDate,
        entryPrice: leg.entryPrice,
        entryIv: leg.entryIv,
        openInterestAtEntry: leg.openInterestAtEntry,
      }))
    )
    .returning();

  return {
    ...trade[0],
    legs: legs as TradeJournalLeg[],
  };
}

/**
 * Get trade by ID with ownership check
 */
export async function getTradeById(
  tradeId: string,
  userId: string
): Promise<TradeWithLegs | null> {
  const trade = await db
    .select()
    .from(tradeJournalEntries)
    .where(and(eq(tradeJournalEntries.id, tradeId), eq(tradeJournalEntries.userId, userId)))
    .limit(1);

  if (!trade.length) return null;

  const legs = await db
    .select()
    .from(tradeJournalLegs)
    .where(eq(tradeJournalLegs.tradeId, tradeId));

  return {
    ...trade[0],
    legs: legs as TradeJournalLeg[],
  };
}

/**
 * List user's trades with optional filters
 */
export async function listTrades(
  userId: string,
  filters?: {
    status?: "open" | "closed" | "cancelled";
    symbol?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }
): Promise<TradeWithLegs[]> {
  const conditions: any[] = [eq(tradeJournalEntries.userId, userId)];

  if (filters?.status) {
    conditions.push(eq(tradeJournalEntries.status, filters.status));
  }

  if (filters?.symbol) {
    conditions.push(eq(tradeJournalEntries.symbol, filters.symbol));
  }

  if (filters?.startDate) {
    conditions.push(sql`${tradeJournalEntries.openedAt} >= ${filters.startDate}`);
  }

  if (filters?.endDate) {
    conditions.push(sql`${tradeJournalEntries.openedAt} <= ${filters.endDate}`);
  }

  let query = db
    .select()
    .from(tradeJournalEntries)
    .where(and(...conditions))
    .orderBy(desc(tradeJournalEntries.openedAt)) as any;

  if (filters?.limit) {
    query = query.limit(filters.limit);
  }

  if (filters?.offset) {
    query = query.offset(filters.offset);
  }

  const trades = await query;

  // Fetch legs for each trade
  const tradesWithLegs = await Promise.all(
    trades.map(async (trade: any) => {
      const legs = await db
        .select()
        .from(tradeJournalLegs)
        .where(eq(tradeJournalLegs.tradeId, trade.id));

      return {
        ...trade,
        legs: legs as TradeJournalLeg[],
      };
    })
  );

  return tradesWithLegs;
}

/**
 * Close a trade with exit pricing and compute realized PnL
 */
export async function closeTrade(
  tradeId: string,
  userId: string,
  input: CloseTradeInput
): Promise<TradeWithLegs> {
  // Fetch current trade
  const trade = await getTradeById(tradeId, userId);
  if (!trade) {
    throw new Error("Trade not found");
  }

  if (trade.status !== "open") {
    throw new Error(`Cannot close trade with status ${trade.status}`);
  }

  // Update leg exit prices
  for (const legInput of input.legs) {
    await db
      .update(tradeJournalLegs)
      .set({
        exitPrice: legInput.exitPrice,
        exitIv: legInput.exitIv,
      })
      .where(eq(tradeJournalLegs.id, legInput.legId));
  }

  // Compute PnL metrics
  const pnlInput: PnlInput = {
    entryNetDebit: trade.entryNetDebit,
    exitNetCredit: input.exitNetCredit,
    contractMultiplier: trade.contractMultiplier,
    quantity: trade.quantity,
  };

  const grossPnl = computeGrossPnl(pnlInput);
  const netPnl = computeNetPnl(grossPnl, trade.entryCommissions, input.exitCommissions);
  const returnOnDebit = computeReturnOnDebit(netPnl, pnlInput) ?? 0;
  const maxRisk = computeMaxRisk(pnlInput);

  // Update trade with close data
  const updated = await db
    .update(tradeJournalEntries)
    .set({
      status: "closed",
      closedAt: input.closedAt,
      exitNetCredit: input.exitNetCredit,
      exitCommissions: input.exitCommissions,
      grossPnl,
      netPnl,
      returnOnDebit,
      maxRisk,
      updatedAt: new Date(),
    })
    .where(eq(tradeJournalEntries.id, tradeId))
    .returning();

  // Fetch updated legs
  const legs = await db
    .select()
    .from(tradeJournalLegs)
    .where(eq(tradeJournalLegs.tradeId, tradeId));

  return {
    ...updated[0],
    legs: legs as TradeJournalLeg[],
  };
}

export interface UpdateLegInput {
  /** Existing leg id to update in place; omit to insert a new leg. */
  id?: string;
  side: "buy" | "sell";
  optionType: "call" | "put";
  quantity: number;
  strike: number;
  expirationDate: string;
  entryPrice: number;
  entryIv?: number;
  openInterestAtEntry?: number;
}

/**
 * Update mutable fields (and, optionally, the full leg set) on an open trade
 */
export async function updateTrade(
  tradeId: string,
  userId: string,
  updates: {
    symbol?: string;
    strategy?: string;
    quantity?: number;
    contractMultiplier?: number;
    entryNetDebit?: number;
    entryCommissions?: number;
    edgeAtEntry?: number;
    notes?: string;
    legs?: UpdateLegInput[];
  }
): Promise<TradeWithLegs> {
  const trade = await getTradeById(tradeId, userId);
  if (!trade) {
    throw new Error("Trade not found");
  }

  if (trade.status !== "open") {
    throw new Error(`Cannot update trade with status ${trade.status}`);
  }

  const { legs, ...tradeFieldUpdates } = updates;

  const updated = await db
    .update(tradeJournalEntries)
    .set({
      ...tradeFieldUpdates,
      updatedAt: new Date(),
    })
    .where(eq(tradeJournalEntries.id, tradeId))
    .returning();

  if (legs) {
    const keepIds = new Set(legs.filter((leg) => leg.id).map((leg) => leg.id!));

    // Remove legs that are no longer present in the submitted set.
    for (const existingLeg of trade.legs) {
      if (!keepIds.has(existingLeg.id)) {
        await db.delete(tradeJournalLegs).where(eq(tradeJournalLegs.id, existingLeg.id));
      }
    }

    // Update existing legs in place, insert any new ones.
    for (const leg of legs) {
      if (leg.id && trade.legs.some((existingLeg) => existingLeg.id === leg.id)) {
        await db
          .update(tradeJournalLegs)
          .set({
            side: leg.side,
            optionType: leg.optionType,
            quantity: leg.quantity,
            strike: leg.strike,
            expirationDate: leg.expirationDate,
            entryPrice: leg.entryPrice,
            entryIv: leg.entryIv,
            openInterestAtEntry: leg.openInterestAtEntry,
          })
          .where(eq(tradeJournalLegs.id, leg.id));
      } else {
        await db.insert(tradeJournalLegs).values({
          id: randomUUID(),
          tradeId,
          side: leg.side,
          optionType: leg.optionType,
          quantity: leg.quantity,
          strike: leg.strike,
          expirationDate: leg.expirationDate,
          entryPrice: leg.entryPrice,
          entryIv: leg.entryIv,
          openInterestAtEntry: leg.openInterestAtEntry,
        });
      }
    }
  }

  const finalLegs = await db
    .select()
    .from(tradeJournalLegs)
    .where(eq(tradeJournalLegs.tradeId, tradeId));

  return {
    ...updated[0],
    legs: finalLegs as TradeJournalLeg[],
  };
}

/**
 * Delete a trade (and its legs, via cascade) with ownership check
 */
export async function deleteTrade(tradeId: string, userId: string): Promise<void> {
  const trade = await getTradeById(tradeId, userId);
  if (!trade) {
    throw new Error("Trade not found");
  }

  await db
    .delete(tradeJournalEntries)
    .where(and(eq(tradeJournalEntries.id, tradeId), eq(tradeJournalEntries.userId, userId)));
}

/**
 * Compute analytics over closed trades for a user
 */
export async function getTradeAnalytics(userId: string): Promise<TradeAnalytics> {
  const closedTrades = await db
    .select()
    .from(tradeJournalEntries)
    .where(
      and(
        eq(tradeJournalEntries.userId, userId),
        eq(tradeJournalEntries.status, "closed")
      )
    );

  const totalNetPnl = closedTrades.reduce((sum, t) => sum + (t.netPnl ?? 0), 0);
  const totalGrossPnl = closedTrades.reduce((sum, t) => sum + (t.grossPnl ?? 0), 0);
  const closedTradeCount = closedTrades.length;

  const winTrades = closedTrades.filter((t) => (t.netPnl ?? 0) > 0);
  const lossTrades = closedTrades.filter((t) => (t.netPnl ?? 0) < 0);

  const winCount = winTrades.length;
  const lossCount = lossTrades.length;
  const winRate = closedTradeCount > 0 ? winCount / closedTradeCount : 0;

  const winSum = winTrades.reduce((sum, t) => sum + (t.netPnl ?? 0), 0);
  const averageWin = winCount > 0 ? winSum / winCount : 0;

  const lossSum = lossTrades.reduce((sum, t) => sum + Math.abs(t.netPnl ?? 0), 0);
  const averageLoss = lossCount > 0 ? lossSum / lossCount : 0;

  const profitFactor = averageLoss > 0 ? averageWin / averageLoss : 0;

  return {
    totalNetPnl,
    totalGrossPnl,
    closedTradeCount,
    winCount,
    lossCount,
    winRate,
    averageWin,
    averageLoss,
    profitFactor,
  };
}

/**
 * Get analytics by trade class
 */
export async function getAnalyticsByTradeClass(
  userId: string
): Promise<Record<string, TradeAnalytics>> {
  const result: Record<string, TradeAnalytics> = {};

  const tradeClasses = ["standard", "earnings-exposed"] as const;

  for (const tradeClass of tradeClasses) {
    const closedTrades = await db
      .select()
      .from(tradeJournalEntries)
      .where(
        and(
          eq(tradeJournalEntries.userId, userId),
          eq(tradeJournalEntries.status, "closed"),
          eq(tradeJournalEntries.tradeClassAtEntry, tradeClass)
        )
      );

    const totalNetPnl = closedTrades.reduce((sum, t) => sum + (t.netPnl ?? 0), 0);
    const totalGrossPnl = closedTrades.reduce((sum, t) => sum + (t.grossPnl ?? 0), 0);
    const closedTradeCount = closedTrades.length;

    const winTrades = closedTrades.filter((t) => (t.netPnl ?? 0) > 0);
    const lossTrades = closedTrades.filter((t) => (t.netPnl ?? 0) < 0);

    const winCount = winTrades.length;
    const lossCount = lossTrades.length;
    const winRate = closedTradeCount > 0 ? winCount / closedTradeCount : 0;

    const winSum = winTrades.reduce((sum, t) => sum + (t.netPnl ?? 0), 0);
    const averageWin = winCount > 0 ? winSum / winCount : 0;

    const lossSum = lossTrades.reduce((sum, t) => sum + Math.abs(t.netPnl ?? 0), 0);
    const averageLoss = lossCount > 0 ? lossSum / lossCount : 0;

    const profitFactor = averageLoss > 0 ? averageWin / averageLoss : 0;

    result[tradeClass] = {
      totalNetPnl,
      totalGrossPnl,
      closedTradeCount,
      winCount,
      lossCount,
      winRate,
      averageWin,
      averageLoss,
      profitFactor,
    };
  }

  return result;
}
