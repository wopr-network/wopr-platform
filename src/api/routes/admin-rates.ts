import { Hono } from "hono";
import type { ProviderCostInput, SellRateInput } from "../../admin/rates/rate-store.js";
import { RateStore } from "../../admin/rates/rate-store.js";
import type { AuthEnv } from "../../auth/index.js";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "../../auth/index.js";
import type { DrizzleDb } from "../../db/index.js";
import { getAdminAuditLog, getDb } from "../../fleet/services.js";

let _store: RateStore | null = null;
function getStore(): RateStore {
  if (!_store) {
    _store = new RateStore(getDb());
  }
  return _store;
}

function parseBooleanParam(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/**
 * Create admin rate API routes with an explicit database.
 * Used in tests to inject an in-memory database.
 */
export function createAdminRateApiRoutes(db: DrizzleDb): Hono<AuthEnv> {
  const store = new RateStore(db);
  return buildRoutes(() => store);
}

function buildRoutes(storeFactory: () => RateStore): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>();

  // ── Combined List ──

  /** GET / - List all sell rates and provider costs (combined admin view) */
  routes.get("/", async (c) => {
    const store = storeFactory();
    const capability = c.req.query("capability");
    const active = parseBooleanParam(c.req.query("active"));

    try {
      const [sellRates, providerCosts] = await Promise.all([
        store.listSellRates({ capability, isActive: active }),
        store.listProviderCosts({ capability, isActive: active }),
      ]);

      return c.json({
        sell_rates: sellRates.entries,
        provider_costs: providerCosts.entries,
        total_sell_rates: sellRates.total,
        total_provider_costs: providerCosts.total,
      });
    } catch {
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // ── Sell Rates ──

  /** POST /sell - Create a sell rate */
  routes.post("/sell", async (c) => {
    const store = storeFactory();

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { capability, displayName, unit, priceUsd, model, isActive, sortOrder } = body;

    if (typeof capability !== "string" || !capability.trim()) {
      return c.json({ error: "capability is required and must be non-empty" }, 400);
    }

    if (typeof displayName !== "string" || !displayName.trim()) {
      return c.json({ error: "displayName is required and must be non-empty" }, 400);
    }

    if (typeof unit !== "string" || !unit.trim()) {
      return c.json({ error: "unit is required and must be non-empty" }, 400);
    }

    if (typeof priceUsd !== "number" || priceUsd <= 0) {
      return c.json({ error: "priceUsd must be a positive number" }, 400);
    }

    if (model !== undefined && typeof model !== "string") {
      return c.json({ error: "model must be a string if provided" }, 400);
    }

    if (isActive !== undefined && typeof isActive !== "boolean") {
      return c.json({ error: "isActive must be a boolean if provided" }, 400);
    }

    if (sortOrder !== undefined && (typeof sortOrder !== "number" || !Number.isInteger(sortOrder))) {
      return c.json({ error: "sortOrder must be an integer if provided" }, 400);
    }

    try {
      const adminUser = (c.get("user") as { id?: string } | undefined)?.id ?? "unknown";
      const input: SellRateInput = {
        capability,
        displayName,
        unit,
        priceUsd,
        model: model as string | undefined,
        isActive: isActive as boolean | undefined,
        sortOrder: sortOrder as number | undefined,
      };
      let result: Awaited<ReturnType<typeof store.createSellRate>>;
      try {
        result = await store.createSellRate(input);
      } catch (err) {
        try {
          getAdminAuditLog().log({
            adminUser,
            action: "rates.sell.create",
            category: "config",
            details: { ...input, error: String(err) },
            outcome: "failure",
          });
        } catch {
          /* audit must not break request */
        }
        throw err;
      }
      try {
        getAdminAuditLog().log({
          adminUser,
          action: "rates.sell.create",
          category: "config",
          details: { ...input },
          outcome: "success",
        });
      } catch {
        /* audit must not break request */
      }
      return c.json(result, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Internal server error" }, 500);
    }
  });

  /** PUT /sell/:id - Update a sell rate */
  routes.put("/sell/:id", async (c) => {
    const store = storeFactory();
    const id = c.req.param("id");

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { capability, displayName, unit, priceUsd, model, isActive, sortOrder } = body;

    if (capability !== undefined && (typeof capability !== "string" || !capability.trim())) {
      return c.json({ error: "capability must be non-empty if provided" }, 400);
    }

    if (displayName !== undefined && (typeof displayName !== "string" || !displayName.trim())) {
      return c.json({ error: "displayName must be non-empty if provided" }, 400);
    }

    if (unit !== undefined && (typeof unit !== "string" || !unit.trim())) {
      return c.json({ error: "unit must be non-empty if provided" }, 400);
    }

    if (priceUsd !== undefined && (typeof priceUsd !== "number" || priceUsd <= 0)) {
      return c.json({ error: "priceUsd must be a positive number if provided" }, 400);
    }

    if (model !== undefined && model !== null && typeof model !== "string") {
      return c.json({ error: "model must be a string or null if provided" }, 400);
    }

    if (isActive !== undefined && typeof isActive !== "boolean") {
      return c.json({ error: "isActive must be a boolean if provided" }, 400);
    }

    if (sortOrder !== undefined && (typeof sortOrder !== "number" || !Number.isInteger(sortOrder))) {
      return c.json({ error: "sortOrder must be an integer if provided" }, 400);
    }

    try {
      const adminUser = (c.get("user") as { id?: string } | undefined)?.id ?? "unknown";
      const input: Partial<SellRateInput> = {};
      if (capability !== undefined) input.capability = capability as string;
      if (displayName !== undefined) input.displayName = displayName as string;
      if (unit !== undefined) input.unit = unit as string;
      if (priceUsd !== undefined) input.priceUsd = priceUsd as number;
      if ("model" in body) input.model = model as string | undefined;
      if (isActive !== undefined) input.isActive = isActive as boolean;
      if (sortOrder !== undefined) input.sortOrder = sortOrder as number;

      let result: Awaited<ReturnType<typeof store.updateSellRate>>;
      try {
        result = await store.updateSellRate(id, input);
      } catch (err) {
        try {
          getAdminAuditLog().log({
            adminUser,
            action: "rates.sell.update",
            category: "config",
            details: { id, ...input, error: String(err) },
            outcome: "failure",
          });
        } catch {
          /* audit must not break request */
        }
        throw err;
      }
      try {
        getAdminAuditLog().log({
          adminUser,
          action: "rates.sell.update",
          category: "config",
          details: { id, ...input },
          outcome: "success",
        });
      } catch {
        /* audit must not break request */
      }
      return c.json(result, 200);
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found")) {
        return c.json({ error: err.message }, 404);
      }
      return c.json({ error: err instanceof Error ? err.message : "Internal server error" }, 500);
    }
  });

  /** DELETE /sell/:id - Delete a sell rate */
  routes.delete("/sell/:id", async (c) => {
    const store = storeFactory();
    const id = c.req.param("id");

    try {
      const adminUser = (c.get("user") as { id?: string } | undefined)?.id ?? "unknown";
      let deleted: boolean;
      try {
        deleted = await store.deleteSellRate(id);
      } catch (err) {
        try {
          getAdminAuditLog().log({
            adminUser,
            action: "rates.sell.delete",
            category: "config",
            details: { id, error: String(err) },
            outcome: "failure",
          });
        } catch {
          /* audit must not break request */
        }
        throw err;
      }
      if (deleted) {
        try {
          getAdminAuditLog().log({
            adminUser,
            action: "rates.sell.delete",
            category: "config",
            details: { id },
            outcome: "success",
          });
        } catch {
          /* audit must not break request */
        }
        return c.json({ success: true }, 200);
      }
      return c.json({ error: "Sell rate not found" }, 404);
    } catch {
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // ── Provider Costs ──

  /** POST /provider - Create a provider cost */
  routes.post("/provider", async (c) => {
    const store = storeFactory();

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { capability, adapter, model, unit, costUsd, priority, latencyClass, isActive } = body;

    if (typeof capability !== "string" || !capability.trim()) {
      return c.json({ error: "capability is required and must be non-empty" }, 400);
    }

    if (typeof adapter !== "string" || !adapter.trim()) {
      return c.json({ error: "adapter is required and must be non-empty" }, 400);
    }

    if (typeof unit !== "string" || !unit.trim()) {
      return c.json({ error: "unit is required and must be non-empty" }, 400);
    }

    if (typeof costUsd !== "number" || costUsd <= 0) {
      return c.json({ error: "costUsd must be a positive number" }, 400);
    }

    if (model !== undefined && typeof model !== "string") {
      return c.json({ error: "model must be a string if provided" }, 400);
    }

    if (priority !== undefined && (typeof priority !== "number" || !Number.isInteger(priority))) {
      return c.json({ error: "priority must be an integer if provided" }, 400);
    }

    if (latencyClass !== undefined && typeof latencyClass !== "string") {
      return c.json({ error: "latencyClass must be a string if provided" }, 400);
    }

    if (isActive !== undefined && typeof isActive !== "boolean") {
      return c.json({ error: "isActive must be a boolean if provided" }, 400);
    }

    try {
      const adminUser = (c.get("user") as { id?: string } | undefined)?.id ?? "unknown";
      const input: ProviderCostInput = {
        capability,
        adapter,
        unit,
        costUsd,
        model: model as string | undefined,
        priority: priority as number | undefined,
        latencyClass: latencyClass as string | undefined,
        isActive: isActive as boolean | undefined,
      };
      let result: Awaited<ReturnType<typeof store.createProviderCost>>;
      try {
        result = await store.createProviderCost(input);
      } catch (err) {
        try {
          getAdminAuditLog().log({
            adminUser,
            action: "rates.provider.create",
            category: "config",
            details: { ...input, error: String(err) },
            outcome: "failure",
          });
        } catch {
          /* audit must not break request */
        }
        throw err;
      }
      try {
        getAdminAuditLog().log({
          adminUser,
          action: "rates.provider.create",
          category: "config",
          details: { ...input },
          outcome: "success",
        });
      } catch {
        /* audit must not break request */
      }
      return c.json(result, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Internal server error" }, 500);
    }
  });

  /** PUT /provider/:id - Update a provider cost */
  routes.put("/provider/:id", async (c) => {
    const store = storeFactory();
    const id = c.req.param("id");

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { capability, adapter, model, unit, costUsd, priority, latencyClass, isActive } = body;

    if (capability !== undefined && (typeof capability !== "string" || !capability.trim())) {
      return c.json({ error: "capability must be non-empty if provided" }, 400);
    }

    if (adapter !== undefined && (typeof adapter !== "string" || !adapter.trim())) {
      return c.json({ error: "adapter must be non-empty if provided" }, 400);
    }

    if (unit !== undefined && (typeof unit !== "string" || !unit.trim())) {
      return c.json({ error: "unit must be non-empty if provided" }, 400);
    }

    if (costUsd !== undefined && (typeof costUsd !== "number" || costUsd <= 0)) {
      return c.json({ error: "costUsd must be a positive number if provided" }, 400);
    }

    if (model !== undefined && model !== null && typeof model !== "string") {
      return c.json({ error: "model must be a string or null if provided" }, 400);
    }

    if (priority !== undefined && (typeof priority !== "number" || !Number.isInteger(priority))) {
      return c.json({ error: "priority must be an integer if provided" }, 400);
    }

    if (latencyClass !== undefined && typeof latencyClass !== "string") {
      return c.json({ error: "latencyClass must be a string if provided" }, 400);
    }

    if (isActive !== undefined && typeof isActive !== "boolean") {
      return c.json({ error: "isActive must be a boolean if provided" }, 400);
    }

    try {
      const adminUser = (c.get("user") as { id?: string } | undefined)?.id ?? "unknown";
      const input: Partial<ProviderCostInput> = {};
      if (capability !== undefined) input.capability = capability as string;
      if (adapter !== undefined) input.adapter = adapter as string;
      if (unit !== undefined) input.unit = unit as string;
      if (costUsd !== undefined) input.costUsd = costUsd as number;
      if ("model" in body) input.model = model as string | undefined;
      if (priority !== undefined) input.priority = priority as number;
      if (latencyClass !== undefined) input.latencyClass = latencyClass as string;
      if (isActive !== undefined) input.isActive = isActive as boolean;

      let result: Awaited<ReturnType<typeof store.updateProviderCost>>;
      try {
        result = await store.updateProviderCost(id, input);
      } catch (err) {
        try {
          getAdminAuditLog().log({
            adminUser,
            action: "rates.provider.update",
            category: "config",
            details: { id, ...input, error: String(err) },
            outcome: "failure",
          });
        } catch {
          /* audit must not break request */
        }
        throw err;
      }
      try {
        getAdminAuditLog().log({
          adminUser,
          action: "rates.provider.update",
          category: "config",
          details: { id, ...input },
          outcome: "success",
        });
      } catch {
        /* audit must not break request */
      }
      return c.json(result, 200);
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found")) {
        return c.json({ error: err.message }, 404);
      }
      return c.json({ error: err instanceof Error ? err.message : "Internal server error" }, 500);
    }
  });

  /** DELETE /provider/:id - Delete a provider cost */
  routes.delete("/provider/:id", async (c) => {
    const store = storeFactory();
    const id = c.req.param("id");

    try {
      const adminUser = (c.get("user") as { id?: string } | undefined)?.id ?? "unknown";
      let deleted: boolean;
      try {
        deleted = await store.deleteProviderCost(id);
      } catch (err) {
        try {
          getAdminAuditLog().log({
            adminUser,
            action: "rates.provider.delete",
            category: "config",
            details: { id, error: String(err) },
            outcome: "failure",
          });
        } catch {
          /* audit must not break request */
        }
        throw err;
      }
      if (deleted) {
        try {
          getAdminAuditLog().log({
            adminUser,
            action: "rates.provider.delete",
            category: "config",
            details: { id },
            outcome: "success",
          });
        } catch {
          /* audit must not break request */
        }
        return c.json({ success: true }, 200);
      }
      return c.json({ error: "Provider cost not found" }, 404);
    } catch {
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // ── Margin Report ──

  /** GET /margins - Get margin report */
  routes.get("/margins", async (c) => {
    const store = storeFactory();
    const capability = c.req.query("capability");

    try {
      const report = await store.getMarginReport(capability);
      return c.json({ margins: report });
    } catch {
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  return routes;
}

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

/** Pre-built admin rate routes with auth and lazy DB initialization. */
export const adminRateRoutes = new Hono<AuthEnv>();
adminRateRoutes.use("*", adminAuth);
adminRateRoutes.route("/", buildRoutes(getStore));
