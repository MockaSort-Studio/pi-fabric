import { describe, expect, it } from "vitest";
import { prepareFabricExecArguments } from "../src/fabric-exec-arguments.js";
import { repairFabricGuestCode } from "../src/runtime/guest-code-repair.js";
import { GUEST_TYPE_DECLARATIONS } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";

describe("repairFabricGuestCode", () => {
  it("returns the same string when nothing needs quoting", () => {
    const code = 'return await pi.read("/tmp/x");';
    expect(repairFabricGuestCode(code)).toBe(code);
  });

  it("quotes an unquoted absolute path on pi.read", () => {
    expect(repairFabricGuestCode("return await pi.read(/tmp/x);")).toBe(
      'return await pi.read("/tmp/x");',
    );
  });

  it("keeps a following options argument", () => {
    expect(repairFabricGuestCode("return await pi.read(/tmp/x, { limit: 1 });")).toBe(
      'return await pi.read("/tmp/x", { limit: 1 });',
    );
  });

  it("quotes object path values", () => {
    expect(repairFabricGuestCode("return await pi.read({ path: /Users/foo/bar.ts });")).toBe(
      'return await pi.read({ path: "/Users/foo/bar.ts" });',
    );
  });

  it("quotes URLs including query strings that look like extra paths", () => {
    expect(
      repairFabricGuestCode("return await pi.read(https://example.com/foo.md5?q=/a/b/c/d);"),
    ).toBe('return await pi.read("https://example.com/foo.md5?q=/a/b/c/d");');
  });

  it("quotes macOS cache paths with md5 query fragments", () => {
    const input =
      "return await pi.read(/var/folders/xx/T/cache.md5?q=/a/b/c/d/e/f/g);";
    expect(repairFabricGuestCode(input)).toBe(
      'return await pi.read("/var/folders/xx/T/cache.md5?q=/a/b/c/d/e/f/g");',
    );
  });

  it("does not quote grep regex literals", () => {
    const code = "return await pi.grep(/TODO/g, 'src');";
    expect(repairFabricGuestCode(code)).toBe(code);
  });

  it("quotes grep object path values", () => {
    expect(repairFabricGuestCode('return await pi.grep({ pattern: "TODO", path: /src });')).toBe(
      'return await pi.grep({ pattern: "TODO", path: "/src" });',
    );
  });

  it("does not rewrite pi.read inside an already-quoted payload", () => {
    const code = "return await pi.write('/a.ts', 'pi.read(/tmp/x)');";
    expect(repairFabricGuestCode(code)).toBe(code);
  });

  it("repairs pi.read inside template expressions", () => {
    expect(repairFabricGuestCode("return `x ${await pi.read(/tmp/x)}`;")).toBe(
      'return `x ${await pi.read("/tmp/x")}`;',
    );
  });

  it("normalizes unicode quotes around a path", () => {
    expect(repairFabricGuestCode("return await pi.read(\u201c/tmp/x\u201d);")).toBe(
      'return await pi.read("/tmp/x");',
    );
  });

  it("quotes relative and home paths", () => {
    expect(repairFabricGuestCode("return await pi.read(./src/index.ts);")).toBe(
      'return await pi.read("./src/index.ts");',
    );
    expect(repairFabricGuestCode("return await pi.ls(../lib);")).toBe(
      'return await pi.ls("../lib");',
    );
    expect(repairFabricGuestCode("return await pi.read(~/.bashrc);")).toBe(
      'return await pi.read("~/.bashrc");',
    );
  });

  it("quotes Windows drive paths", () => {
    expect(repairFabricGuestCode("return await pi.read(C:/Users/foo/bar.ts);")).toBe(
      'return await pi.read("C:/Users/foo/bar.ts");',
    );
  });

  it("is idempotent", () => {
    const once = repairFabricGuestCode("return await pi.read(/tmp/x);");
    expect(repairFabricGuestCode(once)).toBe(once);
  });

  it("makes previously unparseable pi.read typecheck", () => {
    const original = "return await pi.read(/tmp/x);";
    expect(typeCheckFabricCode(original, GUEST_TYPE_DECLARATIONS).errors.length).toBeGreaterThan(0);
    expect(typeCheckFabricCode(repairFabricGuestCode(original), GUEST_TYPE_DECLARATIONS).errors).toEqual([]);
  });
});

describe("prepareFabricExecArguments path repair", () => {
  it("quotes unquoted pi.read paths on the envelope code field", () => {
    expect(prepareFabricExecArguments({ code: "return await pi.read(/tmp/x);" })).toEqual({
      code: 'return await pi.read("/tmp/x");',
    });
  });
});
