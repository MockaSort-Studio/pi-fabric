import { describe, expect, it, vi } from "vitest";
import { boundModelOutput } from "../src/output-budget.js";

describe("boundModelOutput", () => {
  it("leaves output under budget untouched", async () => {
    const writer = vi.fn(async () => "/tmp/full.txt");
    await expect(boundModelOutput("small", 1_000, "small", writer)).resolves.toEqual({
      text: "small",
      originalChars: 5,
      omittedChars: 0,
    });
    expect(writer).not.toHaveBeenCalled();
  });

  it("bounds visible text and links the complete artifact", async () => {
    const full = `start-${"x".repeat(4_000)}-end`;
    const writer = vi.fn(async () => "/tmp/pi-fabric-output/output.txt");
    const result = await boundModelOutput(full, 1_000, full, writer);

    expect(result.text.length).toBeLessThanOrEqual(1_000);
    expect(result.text).toContain("start-");
    expect(result.text).toContain("-end");
    expect(result.text).toContain("Full output (4010 chars) saved to:");
    expect(result.artifactPath).toBe("/tmp/pi-fabric-output/output.txt");
    expect(result.omittedChars).toBeGreaterThan(0);
    expect(writer).toHaveBeenCalledWith(full);
  });

  it("stays bounded if artifact persistence fails", async () => {
    const writer = vi.fn(async () => { throw new Error("disk full"); });
    const result = await boundModelOutput("x".repeat(4_000), 1_000, undefined, writer);

    expect(result.text.length).toBeLessThanOrEqual(1_000);
    expect(result.artifactPath).toBeUndefined();
    expect(result.text).toContain("characters omitted by Pi Fabric");
  });
});
