import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { FleetEventEmitter } from "../../fleet/fleet-event-emitter.js";
import { createFleetEventsRoute } from "./fleet-events.js";

function makeApp(userId: string, emitter: FleetEventEmitter): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as unknown as { set(k: string, v: unknown): void }).set("user", { id: userId });
    await next();
  });
  app.route("/", createFleetEventsRoute(emitter));
  return app;
}

function decodeChunk(value: string | Uint8Array | undefined): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return new TextDecoder().decode(value);
}

describe("fleet-events SSE", () => {
  it("forwards NodeFleetEvents to all authenticated subscribers regardless of tenantId", async () => {
    const emitter = new FleetEventEmitter();
    const app = makeApp("tenant-abc", emitter);

    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No body reader");

    const readPromise = reader.read();
    emitter.emit({ type: "node.provisioned", nodeId: "node-1", timestamp: "2026-01-01T00:00:00Z" });

    const { value } = await readPromise;
    reader.cancel();

    const chunk = decodeChunk(value as string | Uint8Array | undefined);
    expect(chunk).toContain("node.provisioned");
    expect(chunk).toContain("node-1");
  });

  it("forwards BotFleetEvents only to the matching tenant subscriber", async () => {
    const emitter = new FleetEventEmitter();
    const appAbc = makeApp("tenant-abc", emitter);
    const appXyz = makeApp("tenant-xyz", emitter);

    const resAbc = await appAbc.request("/");
    const resXyz = await appXyz.request("/");

    const readerAbc = resAbc.body?.getReader();
    const readerXyz = resXyz.body?.getReader();
    if (!readerAbc || !readerXyz) throw new Error("No body readers");

    const readAbc = readerAbc.read();
    const readXyz = readerXyz.read();

    emitter.emit({ type: "bot.started", botId: "bot-abc", tenantId: "tenant-abc", timestamp: "2026-01-01T00:00:00Z" });

    const { value: abcVal } = await readAbc;
    const chunkAbc = decodeChunk(abcVal as string | Uint8Array | undefined);
    expect(chunkAbc).toContain("bot-abc");

    readerAbc.cancel();

    // xyz reader should still be pending (tenant-abc event filtered). Cancel it.
    readerXyz.cancel();
    const { value: xyzVal } = await readXyz.catch(() => ({ value: undefined }));
    const chunkXyz = decodeChunk(xyzVal as string | Uint8Array | undefined);
    expect(chunkXyz).not.toContain("bot-abc");
  });
});
