import { describe, expect, it } from "vitest";
import { app } from "../app.js";

describe("fleet routes", () => {
  it("GET /api/fleet returns empty bots list", async () => {
    const res = await app.request("/api/fleet");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ bots: [] });
  });
});
