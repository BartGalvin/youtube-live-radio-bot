import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hasMinimumRole, parseCommand } from "../src/commands.js";

describe("command parsing", () => {
  it("recognizes commands without treating arbitrary text as a command", () => {
    assert.deepEqual(parseCommand("  !LIKE  "), {
      kind: "vote",
      vote: "like",
    });
    assert.deepEqual(parseCommand("!song please"), { kind: "song" });
    assert.equal(parseCommand("I really !like this"), null);
    assert.equal(parseCommand("!unknown"), null);
  });

  it("orders YouTube roles by permission", () => {
    assert.equal(hasMinimumRole("viewer", "member"), false);
    assert.equal(hasMinimumRole("member", "member"), true);
    assert.equal(hasMinimumRole("moderator", "member"), true);
    assert.equal(hasMinimumRole("owner", "moderator"), true);
  });
});
