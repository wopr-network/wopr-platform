import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOApiError, DOClient } from "./do-client.js";

const BASE_URL = "https://api.digitalocean.com/v2";
const TOKEN = "test-token";

function mockFetch(response: { ok: boolean; status: number; json?: () => Promise<unknown> }) {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    statusText: `HTTP ${response.status}`,
    json: response.json ?? (() => Promise.resolve({})),
  });
}

describe("DOClient", () => {
  let client: DOClient;

  beforeEach(() => {
    client = new DOClient(TOKEN);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("createDroplet", () => {
    it("calls correct URL with auth header and returns droplet", async () => {
      const droplet = {
        id: 1234,
        name: "wopr-node-abc",
        status: "new",
        region: { slug: "nyc1", name: "New York 1" },
        size: { slug: "s-4vcpu-8gb", memory: 8192, vcpus: 4, disk: 160, price_monthly: 48 },
        networks: { v4: [{ ip_address: "1.2.3.4", type: "public" }] },
        created_at: "2026-01-01T00:00:00Z",
      };

      const fetchMock = mockFetch({ ok: true, status: 201, json: () => Promise.resolve({ droplet }) });
      vi.stubGlobal("fetch", fetchMock);

      const result = await client.createDroplet({
        name: "wopr-node-abc",
        region: "nyc1",
        size: "s-4vcpu-8gb",
        image: "ubuntu-24-04-x64",
        ssh_keys: [123],
        tags: ["wopr-node"],
        user_data: "#cloud-config\n",
      });

      expect(fetchMock).toHaveBeenCalledWith(`${BASE_URL}/droplets`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body: expect.stringContaining("wopr-node-abc"),
      });
      expect(result.id).toBe(1234);
      expect(result.name).toBe("wopr-node-abc");
    });

    it("throws DOApiError on non-2xx response", async () => {
      const fetchMock = mockFetch({
        ok: false,
        status: 422,
        json: () => Promise.resolve({ message: "Validation failed" }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        client.createDroplet({
          name: "bad",
          region: "nyc1",
          size: "s-1vcpu-1gb",
          image: "ubuntu-24-04-x64",
          ssh_keys: [],
          tags: [],
        }),
      ).rejects.toThrow(DOApiError);
    });
  });

  describe("getDroplet", () => {
    it("fetches droplet by ID", async () => {
      const droplet = {
        id: 9999,
        name: "wopr-test",
        status: "active",
        region: { slug: "sfo3", name: "San Francisco 3" },
        size: { slug: "s-2vcpu-4gb", memory: 4096, vcpus: 2, disk: 80, price_monthly: 24 },
        networks: { v4: [{ ip_address: "5.6.7.8", type: "public" }] },
        created_at: "2026-02-01T00:00:00Z",
      };

      const fetchMock = mockFetch({ ok: true, status: 200, json: () => Promise.resolve({ droplet }) });
      vi.stubGlobal("fetch", fetchMock);

      const result = await client.getDroplet(9999);

      expect(fetchMock).toHaveBeenCalledWith(`${BASE_URL}/droplets/9999`, expect.objectContaining({ method: "GET" }));
      expect(result.id).toBe(9999);
      expect(result.status).toBe("active");
    });
  });

  describe("deleteDroplet", () => {
    it("calls DELETE and resolves on 204", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, json: () => Promise.resolve({}) });
      vi.stubGlobal("fetch", fetchMock);

      await expect(client.deleteDroplet(1234)).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/droplets/1234`,
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    it("throws DOApiError when delete fails", async () => {
      const fetchMock = mockFetch({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ message: "Not found" }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(client.deleteDroplet(999)).rejects.toThrow(DOApiError);
    });
  });

  describe("listRegions", () => {
    it("returns only available regions", async () => {
      const regions = [
        { slug: "nyc1", name: "New York 1", available: true, sizes: ["s-1vcpu-1gb"] },
        { slug: "ams2", name: "Amsterdam 2", available: false, sizes: [] },
        { slug: "sfo3", name: "San Francisco 3", available: true, sizes: ["s-2vcpu-4gb"] },
      ];

      const fetchMock = mockFetch({ ok: true, status: 200, json: () => Promise.resolve({ regions }) });
      vi.stubGlobal("fetch", fetchMock);

      const result = await client.listRegions();

      expect(result).toHaveLength(2);
      expect(result.map((r) => r.slug)).toEqual(["nyc1", "sfo3"]);
    });
  });

  describe("listSizes", () => {
    it("returns only available sizes", async () => {
      const sizes = [
        {
          slug: "s-1vcpu-1gb",
          memory: 1024,
          vcpus: 1,
          disk: 25,
          price_monthly: 6,
          available: true,
          regions: ["nyc1"],
          description: "Basic",
        },
        {
          slug: "s-2vcpu-4gb",
          memory: 4096,
          vcpus: 2,
          disk: 80,
          price_monthly: 24,
          available: false,
          regions: [],
          description: "Basic",
        },
        {
          slug: "s-4vcpu-8gb",
          memory: 8192,
          vcpus: 4,
          disk: 160,
          price_monthly: 48,
          available: true,
          regions: ["nyc1"],
          description: "Basic",
        },
      ];

      const fetchMock = mockFetch({ ok: true, status: 200, json: () => Promise.resolve({ sizes }) });
      vi.stubGlobal("fetch", fetchMock);

      const result = await client.listSizes();

      expect(result).toHaveLength(2);
      expect(result.map((s) => s.slug)).toEqual(["s-1vcpu-1gb", "s-4vcpu-8gb"]);
    });
  });

  describe("error handling", () => {
    it("DOApiError includes status code and message", async () => {
      const err = new DOApiError(422, "resource already exists");
      expect(err.statusCode).toBe(422);
      expect(err.doMessage).toBe("resource already exists");
      expect(err.message).toContain("422");
      expect(err.message).toContain("resource already exists");
      expect(err.name).toBe("DOApiError");
    });

    it("uses statusText when response body has no message", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: () => Promise.reject(new Error("no body")),
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(client.getDroplet(1)).rejects.toThrow("500");
    });
  });
});
