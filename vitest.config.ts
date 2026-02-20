import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["tests/e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "coverage",
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
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
        "src/trpc/routers/*.ts",
      ],
    },
    reporters: ["default", "junit"],
    outputFile: {
      junit: "test-results/junit.xml",
    },
  },
});
