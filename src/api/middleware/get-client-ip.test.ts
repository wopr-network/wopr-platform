import { describe, expect, it } from "vitest";
import { getClientIp, parseTrustedProxies } from "./get-client-ip.js";

describe("parseTrustedProxies", () => {
  it("returns empty set for undefined", () => {
    expect(parseTrustedProxies(undefined).size).toBe(0);
  });

  it("returns empty set for empty string", () => {
    expect(parseTrustedProxies("").size).toBe(0);
  });

  it("parses comma-separated IPs", () => {
    const result = parseTrustedProxies("10.0.0.1, 10.0.0.2");
    expect(result.has("10.0.0.1")).toBe(true);
    expect(result.has("10.0.0.2")).toBe(true);
    expect(result.size).toBe(2);
  });
});

describe("getClientIp", () => {
  it("returns socket address when no trusted proxies configured", () => {
    expect(getClientIp("attacker-spoofed", "1.2.3.4", new Set())).toBe("1.2.3.4");
  });

  it("ignores XFF when socket is not in trusted proxy set", () => {
    const trusted = new Set(["10.0.0.1"]);
    expect(getClientIp("spoofed-ip", "9.9.9.9", trusted)).toBe("9.9.9.9");
  });

  it("trusts XFF rightmost value when socket is a trusted proxy", () => {
    const trusted = new Set(["10.0.0.1"]);
    expect(getClientIp("client-ip, 10.0.0.1", "10.0.0.1", trusted)).toBe("10.0.0.1");
  });

  it("uses rightmost XFF entry (closest to trusted proxy)", () => {
    const trusted = new Set(["10.0.0.1"]);
    expect(getClientIp("spoofed, real-client", "10.0.0.1", trusted)).toBe("real-client");
  });

  it("handles IPv6-mapped IPv4 socket addresses", () => {
    const trusted = new Set(["10.0.0.1"]);
    expect(getClientIp("client-ip", "::ffff:10.0.0.1", trusted)).toBe("client-ip");
  });

  it("returns 'unknown' when no socket and no XFF", () => {
    expect(getClientIp(undefined, undefined, new Set())).toBe("unknown");
  });
});
