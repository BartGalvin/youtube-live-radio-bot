import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BotEvent } from "../src/domain.js";
import { BotEngine } from "../src/engine.js";
import { EventBus, type BotStreamEvent } from "../src/event-bus.js";
import { BotStore } from "../src/store.js";

function textEvent(overrides: Partial<BotEvent> = {}): BotEvent {
  return {
    id: "message-1",
    channelId: "main",
    platform: "youtube",
    kind: "text-message",
    occurredAt: "2026-07-29T12:00:05.000Z",
    user: {
      id: "listener-1",
      displayName: "Listener",
      role: "member",
    },
    message: "!like",
    ...overrides,
  } as BotEvent;
}

describe("BotEngine", () => {
  it("enforces the member vote policy", async () => {
    const store = new BotStore(":memory:");
    store.setTrack({
      id: "track-1",
      channelId: "main",
      artist: "Artist",
      title: "Song",
      startedAt: "2026-07-29T12:00:00.000Z",
    });
    const engine = new BotEngine(store, new EventBus(), "member", 0);

    const result = await engine.handle(
      textEvent({
        user: {
          id: "viewer-1",
          displayName: "Viewer",
          role: "viewer",
        },
      }),
    );

    assert.match(result.reply ?? "", /YouTube channel members/);
    assert.deepEqual(store.getOverlayState("main").votes, {
      likes: 0,
      dislikes: 0,
      total: 0,
    });
    store.close();
  });

  it("publishes vote state and ignores a duplicate event", async () => {
    const store = new BotStore(":memory:");
    const bus = new EventBus();
    const published: BotStreamEvent[] = [];
    bus.subscribe((event) => published.push(event));
    store.setTrack({
      id: "track-1",
      channelId: "main",
      artist: "Artist",
      title: "Song",
      startedAt: "2026-07-29T12:00:00.000Z",
    });
    const engine = new BotEngine(store, bus, "member", 0);

    const first = await engine.handle(textEvent());
    const duplicate = await engine.handle(textEvent());

    assert.match(first.reply ?? "", /Like recorded/);
    assert.equal(duplicate.handled, false);
    assert.equal(published.filter((event) => event.type === "state").length, 1);
    assert.deepEqual(store.getOverlayState("main").votes, {
      likes: 1,
      dislikes: 0,
      total: 1,
    });
    store.close();
  });

  it("sanitizes paid messages before publishing an overlay alert", async () => {
    const store = new BotStore(":memory:");
    const bus = new EventBus();
    const published: BotStreamEvent[] = [];
    bus.subscribe((event) => published.push(event));
    const engine = new BotEngine(store, bus, "member", 0);

    await engine.handle({
      id: "super-chat-1",
      channelId: "main",
      platform: "youtube",
      kind: "paid-message",
      occurredAt: "2026-07-29T12:00:00.000Z",
      user: {
        id: "donor-1",
        displayName: "Donor\nName",
        role: "viewer",
      },
      message: "Great\u0000 station!",
      amountDisplay: "$5.00",
      amountMicros: 5_000_000,
      currency: "USD",
      paidKind: "super-chat",
    });

    const alertEvent = published.find((event) => event.type === "alert");
    assert.equal(alertEvent?.type, "alert");
    if (alertEvent?.type === "alert") {
      assert.equal(alertEvent.data.displayName, "Donor Name");
      assert.equal(alertEvent.data.message, "Great station!");
    }
    store.close();
  });
});
