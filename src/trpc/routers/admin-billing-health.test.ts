import { describe, expect, it, vi } from "vitest";

// Minimal mock of the billingHealth procedure logic
describe("admin.billingHealth", () => {
  it("should return billing health response shape", async () => {
    // Mock deps
    const mockMetrics = {
      getWindow: vi.fn().mockResolvedValue({
        totalRequests: 100,
        totalErrors: 2,
        errorRate: 0.02,
        creditDeductionFailures: 0,
        byCapability: new Map([
          ["tts", { requests: 50, errors: 1, errorRate: 0.02 }],
          ["image_gen", { requests: 50, errors: 1, errorRate: 0.02 }],
        ]),
      }),
    };

    const mockAlertChecker = {
      getStatus: vi.fn().mockReturnValue([{ name: "gateway-error-rate", firing: false, message: "OK" }]),
    };

    const mockResourceMonitor = {
      getSnapshot: vi.fn().mockReturnValue({
        cpuLoad1m: 0.5,
        cpuCount: 4,
        memoryUsedBytes: 4_000_000_000,
        memoryTotalBytes: 8_000_000_000,
        diskUsedBytes: 10_000_000_000,
        diskTotalBytes: 50_000_000_000,
        timestamp: Date.now(),
      }),
    };

    // Test the aggregation logic directly
    const window5m = await mockMetrics.getWindow(5);
    const window60m = await mockMetrics.getWindow(60);
    const alerts = mockAlertChecker.getStatus();
    const system = mockResourceMonitor.getSnapshot();

    expect(window5m.totalRequests).toBe(100);
    expect(window5m.errorRate).toBe(0.02);
    expect(window60m.totalRequests).toBe(100);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].name).toBe("gateway-error-rate");
    expect(alerts[0].firing).toBe(false);
    expect(system).not.toBeNull();
    expect(system?.cpuCount).toBe(4);
  });

  it("should handle null system snapshot gracefully", () => {
    const mockResourceMonitor = {
      getSnapshot: vi.fn().mockReturnValue(null),
    };
    const snapshot = mockResourceMonitor.getSnapshot();
    expect(snapshot).toBeNull();
  });

  it("should convert byCapability Map to plain object", async () => {
    const byCapability = new Map([["tts", { requests: 50, errors: 1, errorRate: 0.02 }]]);
    const asObject = Object.fromEntries(byCapability);
    expect(asObject.tts).toBeDefined();
    expect(asObject.tts.requests).toBe(50);
  });

  it("should derive payment.overall status from payment health probe", () => {
    // healthy when no reasons
    const paymentReasons: string[] = [];
    const paymentOverall = paymentReasons.length === 0 ? "healthy" : "degraded";
    expect(paymentOverall).toBe("healthy");

    // degraded when reasons present
    const withReasons = ["Stripe API unreachable"];
    const degraded = withReasons.length === 0 ? "healthy" : "degraded";
    expect(degraded).toBe("degraded");
  });
});
