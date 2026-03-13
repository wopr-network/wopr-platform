import type { IDeletionExecutorRepository } from "@wopr-network/platform-core/account/deletion-executor-repository";
import { DrizzleDeletionExecutorRepository } from "@wopr-network/platform-core/account/deletion-executor-repository";
import type { PlatformDb } from "@wopr-network/platform-core/db/index";
import { sql } from "drizzle-orm";

export interface ILedgerDeletionRepository extends IDeletionExecutorRepository {
  deleteJournalLines(tenantId: string): Promise<number>;
  deleteJournalEntries(tenantId: string): Promise<number>;
  deleteTenantAccountBalances(tenantId: string): Promise<number>;
  deleteTenantAccounts(tenantId: string): Promise<number>;
}

/**
 * Extends DrizzleDeletionExecutorRepository with deletion of double-entry
 * ledger tables introduced in migration 0072. These tables have no Drizzle
 * schema objects in this repo (they live in platform-core), so raw SQL is used.
 *
 * Deletion order respects FK constraints:
 *   account_balances → accounts  (balances reference accounts)
 *   journal_lines → journal_entries  (lines reference entries)
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

  private async execDelete(query: ReturnType<typeof sql>): Promise<number> {
    const result = (await this._db.execute(query)) as { rowCount?: number | null };
    return result.rowCount ?? 0;
  }

  async deleteJournalLines(tenantId: string): Promise<number> {
    // raw SQL: Drizzle schema objects for journal_lines live in platform-core, not this repo
    return this.execDelete(
      sql`DELETE FROM journal_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE tenant_id = ${tenantId})`,
    );
  }

  async deleteJournalEntries(tenantId: string): Promise<number> {
    // raw SQL: Drizzle schema objects for journal_entries live in platform-core, not this repo
    return this.execDelete(sql`DELETE FROM journal_entries WHERE tenant_id = ${tenantId}`);
  }

  async deleteTenantAccountBalances(tenantId: string): Promise<number> {
    // raw SQL: Drizzle schema objects for account_balances live in platform-core, not this repo
    return this.execDelete(
      sql`DELETE FROM account_balances WHERE account_id IN (SELECT id FROM accounts WHERE tenant_id = ${tenantId})`,
    );
  }

  async deleteTenantAccounts(tenantId: string): Promise<number> {
    // raw SQL: Drizzle schema objects for accounts live in platform-core, not this repo
    return this.execDelete(sql`DELETE FROM accounts WHERE tenant_id = ${tenantId}`);
  }
}
