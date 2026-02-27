import { afterEach, describe, expect, it } from "vitest";

describe("loadOnboardingConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it("returns defaults when no env vars set", async () => {
    delete process.env.ONBOARDING_WOPR_PORT;
    delete process.env.ONBOARDING_LLM_PROVIDER;
    delete process.env.ONBOARDING_LLM_MODEL;
    delete process.env.ONBOARDING_ENABLED;
    const { loadOnboardingConfig } = await import("../../src/onboarding/config.js");
    const config = loadOnboardingConfig();
    expect(config.woprPort).toBe(3847);
    expect(config.llmProvider).toBe("anthropic");
    expect(config.llmModel).toBe("claude-sonnet-4-20250514");
    expect(config.enabled).toBe(true);
  });

  it("reads env var overrides", async () => {
    process.env.ONBOARDING_WOPR_PORT = "4000";
    process.env.ONBOARDING_LLM_PROVIDER = "openrouter";
    process.env.ONBOARDING_LLM_MODEL = "gpt-4o";
    process.env.ONBOARDING_ENABLED = "false";
    const { loadOnboardingConfig } = await import("../../src/onboarding/config.js");
    const config = loadOnboardingConfig();
    expect(config.woprPort).toBe(4000);
    expect(config.llmProvider).toBe("openrouter");
    expect(config.llmModel).toBe("gpt-4o");
    expect(config.enabled).toBe(false);
  });
});
