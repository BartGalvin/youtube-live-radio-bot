import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createNowPlayingAdapter } from "../src/now-playing/factory.js";

const handlers = {
  onTrack: () => {},
  onError: () => {},
};

describe("now-playing adapter factory", () => {
  it("uses no background adapter by default", () => {
    assert.equal(createNowPlayingAdapter(null, handlers), null);
  });

  it("creates a lifecycle adapter for Radio.co input", () => {
    const adapter = createNowPlayingAdapter(
      {
        adapter: "radioco",
        pollIntervalMs: 10_000,
        stations: [{ channelId: "main", stationId: "s123456789" }],
      },
      handlers,
    );

    assert.notEqual(adapter, null);
    adapter?.stop();
  });
});
