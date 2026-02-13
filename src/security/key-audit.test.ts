import { describe, expect, it } from "vitest";
import { scanForKeyLeaks } from "./key-audit.js";

describe("key-audit", () => {
  describe("scanForKeyLeaks", () => {
    it("detects Anthropic key patterns", () => {
      const content = "info: processing request with key sk-ant-abcdefghijklmnopqrstuvwxyz123456";
      const leaks = scanForKeyLeaks(content);
      expect(leaks.length).toBe(1);
      expect(leaks[0].provider).toBe("anthropic");
      expect(leaks[0].line).toBe(1);
    });

    it("detects OpenAI key patterns", () => {
      const content = "debug: using API key sk-abcdefghijklmnopqrstuvwxyz";
      const leaks = scanForKeyLeaks(content);
      expect(leaks.some((l) => l.provider === "openai")).toBe(true);
    });

    it("detects Google key patterns", () => {
      const content = "config: api_key=AIzaSyA1234567890abcdefghijklmnopqrstuvwx";
      const leaks = scanForKeyLeaks(content);
      expect(leaks.some((l) => l.provider === "google")).toBe(true);
    });

    it("returns empty array for clean logs", () => {
      const content = [
        "info: server started on port 3000",
        "info: health check passed",
        "debug: processing request id=abc-123",
      ].join("\n");
      const leaks = scanForKeyLeaks(content);
      expect(leaks).toEqual([]);
    });

    it("detects multiple leaks across lines", () => {
      const content = [
        "line 1: safe content",
        "line 2: key=sk-ant-abcdefghijklmnopqrstuvwxyz",
        "line 3: also sk-abcdefghijklmnopqrstuvwxyz",
      ].join("\n");
      const leaks = scanForKeyLeaks(content);
      expect(leaks.length).toBeGreaterThanOrEqual(2);
    });

    it("truncates matched key in output for safety", () => {
      const content = "key: sk-ant-abcdefghijklmnopqrstuvwxyz123456";
      const leaks = scanForKeyLeaks(content);
      expect(leaks[0].match).toContain("...");
      expect(leaks[0].match.length).toBeLessThan(40);
    });

    it("handles empty input", () => {
      expect(scanForKeyLeaks("")).toEqual([]);
    });
  });
});
