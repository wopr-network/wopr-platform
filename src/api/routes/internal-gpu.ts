import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { logger } from "../../config/logger.js";
import { getGpuNodeRepo } from "../../fleet/services.js";

const VALID_STAGES = [
  "installing_drivers",
  "installing_docker",
  "downloading_models",
  "starting_services",
  "registering",
  "done",
] as const;

type ProvisionStage = (typeof VALID_STAGES)[number];

export const internalGpuRoutes = new Hono();

internalGpuRoutes.post("/register", async (c) => {
  // --- Auth: Bearer GPU_NODE_SECRET ---
  const gpuSecret = process.env.GPU_NODE_SECRET;
  if (!gpuSecret) {
    logger.warn("GPU_NODE_SECRET not configured");
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  const authHeader = c.req.header("Authorization");
  const bearer = authHeader?.replace(/^Bearer\s+/i, "");
  if (!bearer) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  const a = Buffer.from(bearer);
  const b = Buffer.from(gpuSecret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  // --- Validate stage query param ---
  const stage = c.req.query("stage") as ProvisionStage | undefined;
  if (!stage || !VALID_STAGES.includes(stage)) {
    return c.json({ success: false, error: `Invalid or missing stage. Valid: ${VALID_STAGES.join(", ")}` }, 400);
  }

  // --- Validate body ---
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  if (
    typeof rawBody !== "object" ||
    rawBody === null ||
    typeof (rawBody as Record<string, unknown>).nodeId !== "string"
  ) {
    return c.json({ success: false, error: "Missing required field: nodeId" }, 400);
  }

  const { nodeId } = rawBody as { nodeId: string };

  // --- Update DB ---
  const repo = getGpuNodeRepo();
  try {
    repo.updateStage(nodeId, stage);
    if (stage === "done") {
      repo.updateStatus(nodeId, "active");
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) {
      return c.json({ success: false, error: `GPU node not found: ${nodeId}` }, 404);
    }
    throw err;
  }

  logger.info(`GPU node ${nodeId} stage updated to ${stage}`);
  return c.json({ success: true });
});
