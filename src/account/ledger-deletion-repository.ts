import type { IDeletionExecutorRepository } from "@wopr-network/platform-core/account/deletion-executor-repository";
import { DrizzleDeletionExecutorRepository } from "@wopr-network/platform-core/account/deletion-executor-repository";
import type { PlatformDb } from "@wopr-network/platform-core/db/index";
import { sql } from "drizzle-orm";

export interface ILedgerDeletionRepository extends IDeletionExecutorRepository {
  /**
   * Strip tenant_id and PII fields from journal_entries (description,
   * reference_id, metadata, created_by) so the financial record survives
   * for tax/audit purposes but no longer links to a natural person.
   * journal_lines are untouched — they contain amounts only, no PII.
   */
  anonymizeJournalEntries(tenantId: string): Promise<number>;

  /**
   * Null the tenant_id on tenant-scoped accounts and randomize the code so
   * the account row survives (preserving journal_line FK integrity) but
   * cannot be traced back to the deleted tenant.
   */
  anonymizeTenantAccounts(tenantId: string): Promise<number>;

  /**
   * Delete account_balances for tenant-scoped accounts — this is derived
   * state (the running balance), not a primary financial record, so
   * deletion is correct. Must run before anonymizeTenantAccounts.
   */
  deleteTenantAccountBalances(tenantId: string): Promise<number>;
}

/**
 * Extends DrizzleDeletionExecutorRepository with GDPR-compliant handling of
 * double-entry ledger tables (migration 0072).
 *
 * journal_entries are ANONYMIZED, not deleted. Deleting them would remove
 * financial records (revenue recognition, cash receipts) that tax law
 * typically requires retaining for 5–7 years. GDPR only requires removing
 * the personal data link — anonymizing tenant_id satisfies that obligation
 * without destroying the accounting record.
 *
 * account_balances are deleted (derived state, no audit value).
 * journal_lines are untouched (amounts + account refs — no PII).
 * tenant accounts are anonymized so FK integrity from journal_lines holds.
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

  async anonymizeJournalEntries(tenantId: string): Promise<number> {
    // raw SQL: Drizzle cannot express — schema objects for journal_entries live in platform-core, not this repo
    return this.execSql(sql`
      UPDATE journal_entries
      SET tenant_id   = 'gdpr-anonymized',
          description = NULL,
          reference_id = NULL,
          metadata    = NULL,
          created_by  = NULL
      WHERE tenant_id = ${tenantId}
    `);
  }

  async deleteTenantAccountBalances(tenantId: string): Promise<number> {
    // raw SQL: Drizzle cannot express — schema objects for account_balances live in platform-core, not this repo
    return this.execSql(
      sql`DELETE FROM account_balances WHERE account_id IN (SELECT id FROM accounts WHERE tenant_id = ${tenantId})`,
    );
  }

  async anonymizeTenantAccounts(tenantId: string): Promise<number> {
    // raw SQL: Drizzle cannot express — schema objects for accounts live in platform-core, not this repo
    // Set code to 'ANON-<id>' (unique per row) to avoid unique-index conflicts
    // and null tenant_id so the account no longer appears in tenant queries.
    return this.execSql(sql`
      UPDATE accounts
      SET name      = 'Deleted Account',
          code      = 'ANON-' || id,
          tenant_id = NULL
      WHERE tenant_id = ${tenantId}
    `);
  }
}
