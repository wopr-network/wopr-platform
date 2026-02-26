import { customType } from "drizzle-orm/pg-core";
import { Credit } from "../monetization/credit.js";

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
