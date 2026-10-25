import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";

import { abortableDelay } from "../src/abortable-delay.js";

describe("abortableDelay", () => {
  it("removes its abort listener after the delay completes", async () => {
    const controller = new AbortController();

    await abortableDelay(1, controller.signal);

    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  it("ends promptly and cleans up when aborted", async () => {
    const controller = new AbortController();
    const pending = abortableDelay(60_000, controller.signal);

    controller.abort();
    await pending;

    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
});
