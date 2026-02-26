/**
 * Spending cap store interface and domain type.
 *
 * Gateway business logic depends only on ISpendingCapStore.
 * The Drizzle implementation lives in src/fleet/spending-cap-repository.ts.
 */

// ---------------------------------------------------------------------------
// Domain type
// ---------------------------------------------------------------------------

/** Accumulated daily and monthly spend for a tenant. */
export interface SpendingCapRecord {
  dailySpend: number;
  monthlySpend: number;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Repository interface for spending cap queries. */
export interface ISpendingCapStore {
  /** Query accumulated daily and monthly spend for a tenant at a given point in time. */
  querySpend(tenant: string, now: number): Promise<SpendingCapRecord>;
}
