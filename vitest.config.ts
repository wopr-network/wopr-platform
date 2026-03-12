import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 60000,
    maxWorkers: 4,
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["tests/e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "coverage",
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 65,
        statements: 70,
      },
      exclude: [
        "**/*.test.ts",
        "**/*.d.ts",
        // Pure type-only files (interfaces/types, no runtime logic)
        "src/audit/types.ts",
        "src/monetization/metering/types.ts",
        "src/monetization/stripe/types.ts",
        "src/proxy/types.ts",
        // Barrel re-export files (no logic, just re-exports)
        "src/audit/index.ts",
        "src/monetization/index.ts",
        "src/monetization/arbitrage/index.ts",
        "src/monetization/metering/index.ts",
        "src/monetization/stripe/index.ts",
        "src/observability/index.ts",
        "src/auth/index.ts",
        "src/instance/index.ts",
        "src/email/index.ts",
        // tRPC router files — thin wiring layer that delegates to tested stores/services.
        // Branch coverage here reflects optional dep initialization paths, not business logic.
        // marketplace.ts and promotions.ts are excluded from this list — they have non-trivial logic and dedicated tests.
        "src/trpc/routers/account.ts",
        "src/trpc/routers/addons.ts",
        "src/trpc/routers/admin.ts",
        "src/trpc/routers/billing.ts",
        "src/trpc/routers/fleet.ts",
        "src/trpc/routers/inference-admin.ts",
        "src/trpc/routers/model-selection.ts",
        "src/trpc/routers/nodes.ts",
        "src/trpc/routers/org-keys.ts",
        "src/trpc/routers/org.ts",
        "src/trpc/routers/page-context.ts",
        "src/trpc/routers/profile.ts",
        "src/trpc/routers/settings.ts",
        "src/trpc/routers/two-factor.ts",
      ],
    },
    reporters: ["default", "junit"],
    outputFile: {
      junit: "test-results/junit.xml",
    },
  },
});
