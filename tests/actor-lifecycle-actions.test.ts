import { describe, expect, it } from "vitest";
import { AGENTS_ACTION_DESCRIPTORS } from "../src/providers/agents-actions.js";

const action = (name: string) => AGENTS_ACTION_DESCRIPTORS.find(item => item.name === name);

describe("actor lifecycle action contracts", () => {
  it("distinguishes retained stop from permanent remove", () => {
    expect(action("stop")?.description).toMatch(/retains.*registry.*mailbox.*session/i);
    expect(action("remove")?.description).toMatch(/permanently delete.*registry.*bindings.*mailbox.*session/i);
  });
});
