import { describe, expect, it } from "vitest";
import { parseS3CmdLsOutput, SpacesClient } from "./spaces-client.js";

describe("parseS3CmdLsOutput", () => {
  it("parses standard s3cmd ls output", () => {
    const output = [
      "2026-02-13 03:00    104857600   s3://wopr-backups/nightly/node-1/tenant_abc/tenant_abc_20260213.tar.gz",
      "2026-02-14 03:00    209715200   s3://wopr-backups/nightly/node-1/tenant_abc/tenant_abc_20260214.tar.gz",
    ].join("\n");

    const result = parseS3CmdLsOutput(output);
    expect(result).toHaveLength(2);

    expect(result[0]).toEqual({
      date: "2026-02-13T03:00:00Z",
      size: 104857600,
      path: "nightly/node-1/tenant_abc/tenant_abc_20260213.tar.gz",
    });

    expect(result[1]).toEqual({
      date: "2026-02-14T03:00:00Z",
      size: 209715200,
      path: "nightly/node-1/tenant_abc/tenant_abc_20260214.tar.gz",
    });
  });

  it("handles empty output", () => {
    expect(parseS3CmdLsOutput("")).toEqual([]);
    expect(parseS3CmdLsOutput("\n\n")).toEqual([]);
  });

  it("skips malformed lines", () => {
    const output = [
      "2026-02-13 03:00    104857600   s3://wopr-backups/nightly/file.tar.gz",
      "some random text",
      "DIR  s3://wopr-backups/nightly/node-1/",
    ].join("\n");

    const result = parseS3CmdLsOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("nightly/file.tar.gz");
  });
});

describe("SpacesClient.removeMany", () => {
  it("returns immediately when given an empty array (no s3cmd call)", async () => {
    // This tests the early-return branch without needing to mock s3cmd
    const client = new SpacesClient("test-bucket");
    // Should resolve without error and without calling any external process
    await expect(client.removeMany([])).resolves.toBeUndefined();
  });
});

describe("SpacesClient.list", () => {
  it("returns empty array when s3cmd is unavailable (error path)", async () => {
    // s3cmd is not installed in the test environment, so execFileAsync throws.
    // The catch block in list() handles this gracefully by returning [].
    const client = new SpacesClient("test-bucket");
    const result = await client.list("nightly/does-not-exist/");
    expect(result).toEqual([]);
  });
});
