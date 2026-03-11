import { createPayRamClient, loadPayRamConfig } from "@wopr-network/platform-core/billing";
import { Payram } from "payram";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("createPayRamClient", () => {
  it("returns a Payram instance", () => {
    const client = createPayRamClient({ apiKey: "test-key", baseUrl: "https://api.payram.test" });
    expect(client).toBeInstanceOf(Payram);
  });

  it("passes config through to the Payram constructor", () => {
    const client = createPayRamClient({ apiKey: "pk_live_123", baseUrl: "https://api.payram.io" });
    expect(client).toBeInstanceOf(Payram);
  });
});

describe("loadPayRamConfig", () => {
  beforeEach(() => {
    delete process.env.PAYRAM_API_KEY;
    delete process.env.PAYRAM_BASE_URL;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when PAYRAM_API_KEY is missing", () => {
    vi.stubEnv("PAYRAM_BASE_URL", "https://api.payram.test");
    expect(loadPayRamConfig()).toBeNull();
  });

  it("returns null when PAYRAM_BASE_URL is missing", () => {
    vi.stubEnv("PAYRAM_API_KEY", "pk_test_123");
    expect(loadPayRamConfig()).toBeNull();
  });

  it("returns null when PAYRAM_API_KEY is an empty string", () => {
    vi.stubEnv("PAYRAM_API_KEY", "");
    vi.stubEnv("PAYRAM_BASE_URL", "https://api.payram.test");
    expect(loadPayRamConfig()).toBeNull();
  });

  it("returns null when PAYRAM_BASE_URL is an empty string", () => {
    vi.stubEnv("PAYRAM_API_KEY", "pk_test_123");
    vi.stubEnv("PAYRAM_BASE_URL", "");
    expect(loadPayRamConfig()).toBeNull();
  });

  it("returns config when both env vars are set", () => {
    vi.stubEnv("PAYRAM_API_KEY", "pk_test_123");
    vi.stubEnv("PAYRAM_BASE_URL", "https://api.payram.test");
    const config = loadPayRamConfig();
    expect(config).toEqual({
      apiKey: "pk_test_123",
      baseUrl: "https://api.payram.test",
    });
  });

  it("returns null when both env vars are missing", () => {
    expect(loadPayRamConfig()).toBeNull();
  });
});
