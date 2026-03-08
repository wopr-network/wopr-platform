import { Hono } from "hono";
import type { AuditEnv } from "../../audit/types.js";
import type { ISecretAuditRepository } from "../../security/credential-vault/audit-repository.js";
import type { CredentialSummaryRow } from "../../security/credential-vault/credential-repository.js";

type GetCredentialOwner = (id: string) => Promise<CredentialSummaryRow | null>;

/**
 * Create secret audit routes.
 *
 * @param getRepo - factory for the secret audit repository (lazy init)
 * @param getCredentialOwner - lookup function to find credential and check ownership
 */
export function createSecretAuditRoutes(
  getRepo: () => ISecretAuditRepository,
  getCredentialOwner: GetCredentialOwner,
): Hono<AuditEnv> {
  const routes = new Hono<AuditEnv>();

  routes.get("/:id/audit", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const credentialId = c.req.param("id");

    // Verify credential exists and is owned by this user
    const credential = await getCredentialOwner(credentialId);
    if (!credential || credential.createdBy !== user.id) {
      return c.json({ error: "Not found" }, 404);
    }

    const limitRaw = c.req.query("limit") ? Number(c.req.query("limit")) : 50;
    const offsetRaw = c.req.query("offset") ? Number(c.req.query("offset")) : 0;
    const limit = Number.isFinite(limitRaw) ? limitRaw : 50;
    const offset = Number.isFinite(offsetRaw) ? offsetRaw : 0;

    const repo = getRepo();
    const [events, total] = await Promise.all([
      repo.listByCredentialId(credentialId, { limit, offset }),
      repo.countByCredentialId(credentialId),
    ]);

    return c.json({
      events: events.map((e) => ({
        id: e.id,
        accessedAt: new Date(e.accessedAt).toISOString(),
        accessedBy: e.accessedBy,
        action: e.action,
        ...(e.ip !== null ? { ip: e.ip } : {}),
      })),
      total,
    });
  });

  return routes;
}
