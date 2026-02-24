import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PagerDutyNotifier } from "./pagerduty.js";

describe("PagerDutyNotifier", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no-ops when disabled", async () => {
    const notifier = new PagerDutyNotifier({
      enabled: false,
      routingKey: "fake-key",
      businessHoursStart: 14,
      businessHoursEnd: 23,
    });

    await notifier.trigger("test-alert", "Test alert fired", "critical");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("no-ops when routingKey is empty", async () => {
    const notifier = new PagerDutyNotifier({
      enabled: true,
      routingKey: "",
      businessHoursStart: 14,
      businessHoursEnd: 23,
    });

    await notifier.trigger("test-alert", "Test alert fired", "critical");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends trigger event to PagerDuty Events API v2", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 202, ok: true });

    const notifier = new PagerDutyNotifier({
      enabled: true,
      routingKey: "R123",
      businessHoursStart: 14,
      businessHoursEnd: 23,
    });

    await notifier.trigger("gateway-error-rate", "Gateway error rate 8% exceeds 5%", "critical", {
      errorRate: 0.08,
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, opts] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://events.pagerduty.com/v2/enqueue");
    expect(opts.method).toBe("POST");

    const body = JSON.parse(opts.body);
    expect(body.event_action).toBe("trigger");
    expect(body.dedup_key).toBe("wopr-platform:gateway-error-rate");
    expect(body.routing_key).toBe("R123");
    expect(body.payload.severity).toBe("critical");
    expect(body.payload.summary).toBe("Gateway error rate 8% exceeds 5%");
    expect(body.payload.source).toBe("wopr-platform");
    expect(body.payload.custom_details).toEqual({ errorRate: 0.08 });
  });

  it("sends resolve event with matching dedup_key", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 202, ok: true });

    const notifier = new PagerDutyNotifier({
      enabled: true,
      routingKey: "R123",
      businessHoursStart: 14,
      businessHoursEnd: 23,
    });

    await notifier.resolve("gateway-error-rate");

    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.event_action).toBe("resolve");
    expect(body.dedup_key).toBe("wopr-platform:gateway-error-rate");
  });

  it("uses afterHoursRoutingKey outside business hours", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 202, ok: true });
    vi.useFakeTimers();
    // Set time to 3am UTC (outside 14-23 business hours)
    vi.setSystemTime(new Date("2026-02-24T03:00:00Z"));

    const notifier = new PagerDutyNotifier({
      enabled: true,
      routingKey: "R-biz",
      afterHoursRoutingKey: "R-after",
      businessHoursStart: 14,
      businessHoursEnd: 23,
    });

    await notifier.trigger("test-alert", "Alert", "critical");

    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.routing_key).toBe("R-after");

    vi.useRealTimers();
  });

  it("falls back to routingKey when afterHoursRoutingKey not set", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 202, ok: true });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-24T03:00:00Z"));

    const notifier = new PagerDutyNotifier({
      enabled: true,
      routingKey: "R-biz",
      businessHoursStart: 14,
      businessHoursEnd: 23,
    });

    await notifier.trigger("test-alert", "Alert", "critical");

    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.routing_key).toBe("R-biz");

    vi.useRealTimers();
  });

  it("logs error and does not throw on fetch failure", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network down"));

    const notifier = new PagerDutyNotifier({
      enabled: true,
      routingKey: "R123",
      businessHoursStart: 14,
      businessHoursEnd: 23,
    });

    // Should not throw
    await notifier.trigger("test-alert", "Alert", "critical");
  });

  it("logs warning on non-202 response", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 400, ok: false, statusText: "Bad Request" });

    const notifier = new PagerDutyNotifier({
      enabled: true,
      routingKey: "R123",
      businessHoursStart: 14,
      businessHoursEnd: 23,
    });

    // Should not throw
    await notifier.trigger("test-alert", "Alert", "critical");
  });
});
