import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildLiveBroadcastsUrl,
  normalizeMessage,
  selectLiveChatId,
  summarizeYouTubeApiError,
} from "../src/youtube.js";

describe("YouTube broadcast discovery requests", () => {
  it("uses one supported filter when discovering the active broadcast", () => {
    const url = buildLiveBroadcastsUrl();

    assert.equal(url.searchParams.get("broadcastStatus"), "active");
    assert.equal(url.searchParams.get("mine"), null);
    assert.equal(url.searchParams.get("id"), null);
  });

  it("uses only the id filter when an exact broadcast is configured", () => {
    const url = buildLiveBroadcastsUrl("broadcast-1");

    assert.equal(url.searchParams.get("id"), "broadcast-1");
    assert.equal(url.searchParams.get("broadcastStatus"), null);
    assert.equal(url.searchParams.get("mine"), null);
  });
});

describe("YouTube API errors", () => {
  it("reduces a structured API failure to one useful line", () => {
    const message = summarizeYouTubeApiError(
      500,
      JSON.stringify({
        error: {
          message: "Internal error encountered.",
          errors: [{ reason: "ERROR_UNSPECIFIED" }],
        },
      }),
    );

    assert.equal(
      message,
      "YouTube API 500: Internal error encountered. (ERROR_UNSPECIFIED)",
    );
  });
});

describe("YouTube broadcast selection", () => {
  it("does not connect to a configured broadcast that has completed", () => {
    const liveChatId = selectLiveChatId(
      {
        items: [
          {
            snippet: { liveChatId: "completed-chat" },
            status: { lifeCycleStatus: "complete" },
          },
        ],
      },
      true,
    );

    assert.equal(liveChatId, null);
  });

  it("connects to a configured broadcast once it is live", () => {
    const liveChatId = selectLiveChatId(
      {
        items: [
          {
            snippet: { liveChatId: "live-chat" },
            status: { lifeCycleStatus: "live" },
          },
        ],
      },
      true,
    );

    assert.equal(liveChatId, "live-chat");
  });
});

describe("YouTube message normalization", () => {
  it("uses the paid-member author flag for command permissions", () => {
    const event = normalizeMessage(
      {
        id: "message-1",
        snippet: {
          type: "textMessageEvent",
          publishedAt: "2026-07-29T12:00:00Z",
          textMessageDetails: {
            messageText: "!like",
          },
        },
        authorDetails: {
          channelId: "channel-1",
          displayName: "Member",
          isChatSponsor: true,
        },
      },
      "secondary",
    );

    assert.equal(event?.kind, "text-message");
    assert.equal(event?.channelId, "secondary");
    assert.equal(event?.user.role, "member");
  });

  it("preserves the display amount and comment from a Super Chat", () => {
    const event = normalizeMessage(
      {
        id: "super-chat-1",
        snippet: {
          type: "superChatEvent",
          publishedAt: "2026-07-29T12:00:00Z",
          superChatDetails: {
            amountMicros: "5000000",
            amountDisplayString: "$5.00",
            currency: "USD",
            userComment: "Love the station",
          },
        },
        authorDetails: {
          channelId: "channel-1",
          displayName: "Supporter",
        },
      },
      "main",
    );

    assert.equal(event?.kind, "paid-message");
    if (event?.kind === "paid-message") {
      assert.equal(event.amountDisplay, "$5.00");
      assert.equal(event.message, "Love the station");
      assert.equal(event.amountMicros, 5_000_000);
    }
  });
});
