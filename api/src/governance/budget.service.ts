// G3 — the spend circuit-breaker: a SendPolicy-style gate in front of every
// PAID vendor call (enrichment · analysis · expansion · classification).
// When the calendar month's ledger reaches MUNINN_MONTHLY_BUDGET_USD, the
// next call is refused with an alert — not a surprise invoice. Sends are NOT
// gated here: Smartlead/Resend are flat-rate and SendPolicy owns them.
import { gte, sum } from 'drizzle-orm';
import type { Db } from '../db/db';
import * as t from '../db/schema';

export const FLAG_BUDGET_BREAKER = 'budget_breaker'; // { tripped, month, spendUsd, at }

export type BudgetVerdict = { allowed: true } | { allowed: false; reason: string };

type FlagStore = {
  getFlag<T>(key: string, fallback: T): Promise<T>;
  setFlag(key: string, value: unknown): Promise<void>;
};

export class BudgetService {
  constructor(
    private readonly db: Db,
    private readonly flags: FlagStore,
    private readonly ceilingUsd: number, // 0 = no ceiling
    private readonly notify: (html: string) => Promise<void>,
  ) {}

  private monthKey(now = new Date()): string {
    return now.toISOString().slice(0, 7); // YYYY-MM, UTC
  }

  async spentThisMonthUsd(): Promise<number> {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [row] = await this.db
      .select({ total: sum(t.vendorCalls.costUsd) })
      .from(t.vendorCalls)
      .where(gte(t.vendorCalls.at, monthStart));
    return Number(row?.total ?? 0);
  }

  async tripped(): Promise<boolean> {
    if (this.ceilingUsd <= 0) return false;
    const flag = await this.flags.getFlag<{ tripped?: boolean; month?: string }>(FLAG_BUDGET_BREAKER, {});
    return flag?.tripped === true && flag?.month === this.monthKey();
  }

  // The gate. Trips loudly ONCE per month-state transition; resets itself
  // when the month rolls or the ceiling is raised above the spend.
  async gate(provider: string): Promise<BudgetVerdict> {
    if (this.ceilingUsd <= 0) return { allowed: true };
    const spend = await this.spentThisMonthUsd();
    const month = this.monthKey();
    const flag = await this.flags.getFlag<{ tripped?: boolean; month?: string }>(FLAG_BUDGET_BREAKER, {});
    const wasTripped = flag?.tripped === true && flag?.month === month;

    if (spend >= this.ceilingUsd) {
      if (!wasTripped) {
        await this.flags.setFlag(FLAG_BUDGET_BREAKER, { tripped: true, month, spendUsd: spend, at: new Date().toISOString() });
        await this.db.insert(t.events).values({
          kind: 'budget_breaker_tripped',
          payload: { month, spend_usd: spend, ceiling_usd: this.ceilingUsd, provider },
        });
        await this.notify(
          `⛔ <b>budget breaker tripped</b> — $${spend.toFixed(2)} of $${this.ceilingUsd.toFixed(2)} this month. ` +
            `Enrichment/AI calls halt until the month rolls or you raise MUNINN_MONTHLY_BUDGET_USD in Settings.`,
        );
      }
      return {
        allowed: false,
        reason: `budget ceiling reached — $${spend.toFixed(2)}/$${this.ceilingUsd.toFixed(2)} this month; raise MUNINN_MONTHLY_BUDGET_USD or wait for the month to roll`,
      };
    }

    if (wasTripped) {
      await this.flags.setFlag(FLAG_BUDGET_BREAKER, { tripped: false, month, spendUsd: spend, at: new Date().toISOString() });
      await this.notify(`▶ budget breaker reset — $${spend.toFixed(2)}/$${this.ceilingUsd.toFixed(2)} this month; paid calls resume.`);
    }
    return { allowed: true };
  }
}
