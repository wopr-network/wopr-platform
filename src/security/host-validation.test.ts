import { validateNodeHost } from "@wopr-network/platform-core/security";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("validateNodeHost", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // --- VALID hosts ---
  it("accepts a public IPv4 address", () => {
    expect(() => validateNodeHost("203.0.113.10")).not.toThrow();
  });

  it("accepts a valid hostname", () => {
    expect(() => validateNodeHost("node-1.fleet.wopr.network")).not.toThrow();
  });

  it("accepts a public IPv6 address", () => {
    expect(() => validateNodeHost("2001:db8::1")).not.toThrow();
  });

  // --- ALWAYS blocked ---
  it("rejects empty string", () => {
    expect(() => validateNodeHost("")).toThrow("Invalid node host");
  });

  it("rejects whitespace-only string", () => {
    expect(() => validateNodeHost("   ")).toThrow("Invalid node host");
  });

  it("rejects loopback 127.0.0.1", () => {
    expect(() => validateNodeHost("127.0.0.1")).toThrow("Invalid node host");
  });

  it("rejects loopback 127.0.0.2", () => {
    expect(() => validateNodeHost("127.0.0.2")).toThrow("Invalid node host");
  });

  it("rejects link-local 169.254.169.254", () => {
    expect(() => validateNodeHost("169.254.169.254")).toThrow("Invalid node host");
  });

  it("rejects IPv6 loopback ::1", () => {
    expect(() => validateNodeHost("::1")).toThrow("Invalid node host");
  });

  it("rejects IPv6-mapped loopback ::ffff:127.0.0.1", () => {
    expect(() => validateNodeHost("::ffff:127.0.0.1")).toThrow("Invalid node host");
  });

  it("rejects multicast 224.0.0.1", () => {
    expect(() => validateNodeHost("224.0.0.1")).toThrow("Invalid node host");
  });

  it("rejects broadcast 255.255.255.255", () => {
    expect(() => validateNodeHost("255.255.255.255")).toThrow("Invalid node host");
  });

  it("rejects 0.0.0.0", () => {
    expect(() => validateNodeHost("0.0.0.0")).toThrow("Invalid node host");
  });

  it("rejects localhost hostname", () => {
    expect(() => validateNodeHost("localhost")).toThrow("Invalid node host");
  });

  // --- Private ranges (blocked by default) ---
  it("rejects 10.x.x.x by default", () => {
    expect(() => validateNodeHost("10.0.0.1")).toThrow("Invalid node host");
  });

  it("rejects 172.16.x.x by default", () => {
    expect(() => validateNodeHost("172.16.0.1")).toThrow("Invalid node host");
  });

  it("rejects 192.168.x.x by default", () => {
    expect(() => validateNodeHost("192.168.1.1")).toThrow("Invalid node host");
  });

  it("rejects IPv6 unique local fc00::", () => {
    expect(() => validateNodeHost("fc00::1")).toThrow("Invalid node host");
  });

  // --- Private ranges (allowed with env var) ---
  it("allows 10.x.x.x when ALLOW_PRIVATE_NODE_HOSTS=true", () => {
    vi.stubEnv("ALLOW_PRIVATE_NODE_HOSTS", "true");
    expect(() => validateNodeHost("10.0.0.1")).not.toThrow();
  });

  it("allows 172.16.x.x when ALLOW_PRIVATE_NODE_HOSTS=true", () => {
    vi.stubEnv("ALLOW_PRIVATE_NODE_HOSTS", "true");
    expect(() => validateNodeHost("172.16.0.1")).not.toThrow();
  });

  it("allows 192.168.x.x when ALLOW_PRIVATE_NODE_HOSTS=true", () => {
    vi.stubEnv("ALLOW_PRIVATE_NODE_HOSTS", "true");
    expect(() => validateNodeHost("192.168.1.1")).not.toThrow();
  });

  it("still blocks loopback even with ALLOW_PRIVATE_NODE_HOSTS=true", () => {
    vi.stubEnv("ALLOW_PRIVATE_NODE_HOSTS", "true");
    expect(() => validateNodeHost("127.0.0.1")).toThrow("Invalid node host");
  });

  it("still blocks link-local even with ALLOW_PRIVATE_NODE_HOSTS=true", () => {
    vi.stubEnv("ALLOW_PRIVATE_NODE_HOSTS", "true");
    expect(() => validateNodeHost("169.254.169.254")).toThrow("Invalid node host");
  });

  // --- Malformed IPv4-looking strings ---
  it("rejects malformed dotted-quad 999.999.999.999", () => {
    expect(() => validateNodeHost("999.999.999.999")).toThrow("Invalid node host: malformed IPv4 address");
  });

  it("rejects malformed dotted-quad 256.0.0.1", () => {
    expect(() => validateNodeHost("256.0.0.1")).toThrow("Invalid node host: malformed IPv4 address");
  });

  it("rejects malformed dotted-quad 1.2.3.999", () => {
    expect(() => validateNodeHost("1.2.3.999")).toThrow("Invalid node host: malformed IPv4 address");
  });

  // --- Hostname validation ---
  it("rejects hostnames with spaces", () => {
    expect(() => validateNodeHost("host name")).toThrow("Invalid node host");
  });

  it("rejects hostnames starting with a dot", () => {
    expect(() => validateNodeHost(".example.com")).toThrow("Invalid node host");
  });

  it("rejects hostnames longer than 253 characters", () => {
    const long = "a".repeat(254);
    expect(() => validateNodeHost(long)).toThrow("Invalid node host");
  });
});
