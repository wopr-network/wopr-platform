import { customType } from "drizzle-orm/sqlite-core";
import { Credit } from "../monetization/credit.js";

/**
 * Custom Drizzle column type that stores Credit as INTEGER (raw units)
 * and deserializes to Credit on read.
 *
 * Usage in schema:
 * ```ts
 * import { creditColumn } from "../db/credit-column.js";
 * const myTable = sqliteTable("my_table", {
 *   balance: creditColumn("balance").notNull(),
 * });
 * ```
 */
export const creditColumn = customType<{
  data: Credit;
  driverData: number;
}>({
  dataType() {
    return "integer";
  },
  toDriver(value: Credit): number {
    return value.toRaw();
  },
  fromDriver(value: number): Credit {
    return Credit.fromRaw(value);
  },
});
