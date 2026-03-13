import type { IDeletionExecutorRepository } from "@wopr-network/platform-core/account/deletion-executor-repository";
import { DrizzleDeletionExecutorRepository } from "@wopr-network/platform-core/account/deletion-executor-repository";
import type { PlatformDb } from "@wopr-network/platform-core/db/index";
import { sql } from "drizzle-orm";

export interface ILedgerDeletionRepository extends IDeletionExecutorRepository {
  /**
   * Copy tenant journal entries into archived_journal_entries (lines flattened
   * to JSONB, no tenant_id, no FKs), then delete the originals.
   * Returns the number of entries archived.
   */
  archiveJournalEntries(tenantId: string): Promise<number>;

  /** Delete account_balances for tenant-scoped accounts (derived state). */
  deleteTenantAccountBalances(tenantId: string): Promise<number>;

  /** Delete tenant-scoped accounts (safe after archiveJournalEntries removes lines). */
  deleteTenantAccounts(tenantId: string): Promise<number>;
}

/**
 * Extends DrizzleDeletionExecutorRepository with GDPR-compliant handling of
 * double-entry ledger tables (migration 0072).
 *
 * Financial records must be retained 5-7 years (tax law). GDPR only requires
 * removing the personal data link. The solution: archive entries into a
 * separate table (archived_journal_entries) with lines flattened to JSONB —
 * no tenant_id, no FK dependencies — then delete from the live tables.
 *
 * Archived rows are a point-in-time snapshot. They are not live accounting
 * records and carry no FK constraints.
 */
export class DrizzleLedgerDeletionRepository
  extends DrizzleDeletionExecutorRepository
  implements ILedgerDeletionRepository
{
  private readonly _db: PlatformDb;

  constructor(...args: ConstructorParameters<typeof DrizzleDeletionExecutorRepository>) {
    super(...args);
    this._db = args[0];
  }

  private async execSql(query: ReturnType<typeof sql>): Promise<number> {
    const result = (await this._db.execute(query)) as { rowCount?: number | null };
    return result.rowCount ?? 0;
  }

  async archiveJournalEntries(tenantId: string): Promise<number> {
    // raw SQL: Drizzle cannot express — schema objects for journal_entries/journal_lines/archived_journal_entries live in platform-core, not this repo
    // Step 1: copy to archive table with lines flattened to JSONB
    const archived = await this.execSql(sql`
      INSERT INTO archived_journal_entries (id, posted_at, entry_type, lines)
      SELECT
        je.id,
        je.posted_at,
        je.entry_type,
        COALESCE(
          (SELECT jsonb_agg(jsonb_build_object(
            'account_code', a.code,
            'account_name', a.name,
            'account_type', a.type,
            'amount',       jl.amount,
            'side',         jl.side
          ))
          FROM journal_lines jl
          JOIN accounts a ON a.id = jl.account_id
          WHERE jl.journal_entry_id = je.id),
          '[]'::jsonb
        )
      FROM journal_entries je
      WHERE je.tenant_id = ${tenantId}
    `);
    // Step 2: remove lines (FK → journal_entries, must precede entry delete)
    await this.execSql(
      sql`DELETE FROM journal_lines
          WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE tenant_id = ${tenantId})`,
    );
    // Step 3: remove entries
    await this.execSql(sql`DELETE FROM journal_entries WHERE tenant_id = ${tenantId}`);
    return archived;
  }

  async deleteTenantAccountBalances(tenantId: string): Promise<number> {
    // raw SQL: Drizzle cannot express — schema objects for account_balances live in platform-core, not this repo
    return this.execSql(
      sql`DELETE FROM account_balances WHERE account_id IN (SELECT id FROM accounts WHERE tenant_id = ${tenantId})`,
    );
  }

  async deleteTenantAccounts(tenantId: string): Promise<number> {
    // raw SQL: Drizzle cannot express — schema objects for accounts live in platform-core, not this repo
    return this.execSql(sql`DELETE FROM accounts WHERE tenant_id = ${tenantId}`);
  }
}
