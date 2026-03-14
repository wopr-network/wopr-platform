import { defineConfig } from "vitest/config";

// Separate vitest config for the NodeAgent heartbeat tests.
// platform-core must be inlined here so that vi.mock("ws") can intercept
// the ws import inside NodeAgent (which lives inside the platform-core package).
// Scoping this to a dedicated config prevents the inline from affecting all other tests.
export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 60000,
    server: {
      deps: {
        inline: ["@wopr-network/platform-core"],
      },
    },
    include: ["src/node-agent/heartbeat.test.ts"],
  },
});
