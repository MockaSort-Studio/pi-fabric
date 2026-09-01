import { describe, expect, it } from "vitest";
import { observeResidentOwner } from "../src/residency/launcher-owner.js";

describe("resident launcher owner observation", () => {
  it("waits while its child has not claimed residency", () => {
    expect(observeResidentOwner(undefined, 20, false)).toEqual({
      claimed: false,
      observedOwner: false,
      closeInput: false,
    });
  });

  it("keeps stdin open while its child owns residency", () => {
    expect(observeResidentOwner(20, 20, false)).toEqual({
      claimed: true,
      observedOwner: true,
      closeInput: false,
    });
  });

  it("closes a duplicate child when another live host owns residency", () => {
    expect(observeResidentOwner(10, 20, false)).toEqual({
      claimed: false,
      observedOwner: true,
      closeInput: true,
    });
  });

  it("closes stdin after its owned host releases residency", () => {
    expect(observeResidentOwner(undefined, 20, true)).toEqual({
      claimed: true,
      observedOwner: false,
      closeInput: true,
    });
  });
});
