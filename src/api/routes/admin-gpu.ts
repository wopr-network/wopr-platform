import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "../../auth/index.js";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "../../auth/index.js";
import { logger } from "../../config/logger.js";
import { getAdminAuditLog, getDOClient, getGpuNodeProvisioner, getGpuNodeRepository } from "../../fleet/services.js";

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

/**
 * Admin API routes for GPU node management.
 *
 * IMPORTANT: Static routes (/regions, /sizes) are registered BEFORE
 * parameterized routes (/:nodeId) so Hono does not match "regions" as a nodeId.
 */
export const adminGpuRoutes = new Hono<AuthEnv>();

/**
 * GET /api/admin/gpu
 * List all GPU nodes
 */
adminGpuRoutes.get("/", adminAuth, (c) => {
  const nodes = getGpuNodeRepository().list();
  return c.json({
    success: true,
    nodes,
    count: nodes.length,
  });
});

/**
 * POST /api/admin/gpu
 * Provision a new GPU node
 */
adminGpuRoutes.post("/", adminAuth, async (c) => {
  try {
    const body = await c.req.json();
    const parsed = z
      .object({
        region: z.string().min(1).max(20).optional(),
        size: z.string().min(1).max(50).optional(),
        name: z
          .string()
          .min(1)
          .max(63)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/)
          .optional(),
      })
      .parse(body);

    const provisioner = getGpuNodeProvisioner();
    const result = await provisioner.provision(parsed);

    getAdminAuditLog().log({
      adminUser: (c.get("user") as { id?: string } | undefined)?.id ?? "unknown",
      action: "gpu.provision",
      category: "config",
      details: {
        nodeId: result.nodeId,
        dropletId: result.dropletId,
        region: result.region,
        size: result.size,
        monthlyCostCents: result.monthlyCostCents,
      },
    });

    return c.json({ success: true, node: result }, 201);
  } catch (err) {
    if (err instanceof Error && err.message.includes("DO_API_TOKEN")) {
      return c.json(
        {
          success: false,
          error: "GPU provisioning not configured. Set DO_API_TOKEN environment variable.",
        },
        503,
      );
    }
    logger.error("GPU node provisioning failed", { err });
    return c.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      },
      500,
    );
  }
});

/**
 * GET /api/admin/gpu/regions
 * List available DO regions
 * MUST be before /:nodeId to avoid route collision
 */
adminGpuRoutes.get("/regions", adminAuth, async (c) => {
  try {
    const doClient = getDOClient();
    const regions = await doClient.listRegions();
    return c.json({ success: true, regions });
  } catch (err) {
    if (err instanceof Error && err.message.includes("DO_API_TOKEN")) {
      return c.json(
        {
          success: false,
          error: "GPU provisioning not configured. Set DO_API_TOKEN environment variable.",
        },
        503,
      );
    }
    return c.json({ success: false, error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

/**
 * GET /api/admin/gpu/sizes
 * List available DO droplet sizes
 * MUST be before /:nodeId to avoid route collision
 */
adminGpuRoutes.get("/sizes", adminAuth, async (c) => {
  try {
    const doClient = getDOClient();
    const sizes = await doClient.listSizes();
    return c.json({ success: true, sizes });
  } catch (err) {
    if (err instanceof Error && err.message.includes("DO_API_TOKEN")) {
      return c.json(
        {
          success: false,
          error: "GPU provisioning not configured. Set DO_API_TOKEN environment variable.",
        },
        503,
      );
    }
    return c.json({ success: false, error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

/**
 * GET /api/admin/gpu/:nodeId
 * Get single GPU node details
 */
adminGpuRoutes.get("/:nodeId", adminAuth, (c) => {
  const nodeId = c.req.param("nodeId");
  const node = getGpuNodeRepository().getById(nodeId);

  if (!node) {
    return c.json({ success: false, error: "GPU node not found" }, 404);
  }

  return c.json({ success: true, node });
});

/**
 * DELETE /api/admin/gpu/:nodeId
 * Destroy a GPU node. Returns 409 if provisioning or bootstrapping.
 */
adminGpuRoutes.delete("/:nodeId", adminAuth, async (c) => {
  const nodeId = c.req.param("nodeId");

  try {
    const provisioner = getGpuNodeProvisioner();
    await provisioner.destroy(nodeId);

    getAdminAuditLog().log({
      adminUser: (c.get("user") as { id?: string } | undefined)?.id ?? "unknown",
      action: "gpu.destroy",
      category: "config",
      details: { nodeId },
    });

    return c.json({ success: true });
  } catch (err) {
    logger.error("GPU node destruction failed", { nodeId, err });
    const msg = err instanceof Error ? err.message : "Unknown error";
    const status = msg.includes("provisioning") || msg.includes("bootstrapping") ? 409 : 500;
    return c.json({ success: false, error: msg }, status);
  }
});

/**
 * POST /api/admin/gpu/:nodeId/reboot
 * Reboot a GPU node via DO API
 */
adminGpuRoutes.post("/:nodeId/reboot", adminAuth, async (c) => {
  const nodeId = c.req.param("nodeId");

  try {
    const node = getGpuNodeRepository().getById(nodeId);
    if (!node) {
      return c.json({ success: false, error: "GPU node not found" }, 404);
    }
    if (!node.dropletId) {
      return c.json({ success: false, error: "GPU node has no droplet assigned" }, 400);
    }

    const doClient = getDOClient();
    await doClient.rebootDroplet(Number(node.dropletId));

    getAdminAuditLog().log({
      adminUser: (c.get("user") as { id?: string } | undefined)?.id ?? "unknown",
      action: "gpu.reboot",
      category: "config",
      details: { nodeId, dropletId: node.dropletId },
    });

    return c.json({ success: true, message: `Reboot initiated for GPU node ${nodeId}` });
  } catch (err) {
    logger.error("GPU node reboot failed", { nodeId, err });
    return c.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      },
      500,
    );
  }
});
