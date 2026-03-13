// biome-ignore lint/style/useImportType: Database namespace needed for Database.Database type reference
import Database from "better-sqlite3";

/**
 * Apply standard platform pragmas to a SQLite database handle.
 *
 * - journal_mode = WAL: enables concurrent readers with a single writer
 * - busy_timeout = 5000: wait up to 5 seconds for write locks instead of
 *   failing immediately with SQLITE_BUSY
 */
export function applyPlatformPragmas(sqlite: Database.Database): void {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
}
