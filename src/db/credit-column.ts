import { Credit } from "@wopr-network/platform-core/credits";
import { customType } from "drizzle-orm/pg-core";

export const creditColumn = customType<{
  data: Credit;
  driverData: string;
}>({
  dataType() {
    return "bigint"; // nanodollar values exceed int4 range
  },
  toDriver(value: Credit): string {
    return String(value.toRaw());
  },
  fromDriver(value: number | string): Credit {
    return Credit.fromRaw(Number(value));
  },
});
