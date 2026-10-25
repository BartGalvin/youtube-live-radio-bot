import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RadioCoNowPlaying,
} from "../src/now-playing/radioco/adapter.js";
import { normalizeRadioCoTrack } from "../src/now-playing/radioco/normalize.js";

const currentTrack = {
  title: "Vampire Weekend - This Life",
  start_time: "2026-07-29T17:15:18+00:00",
  artwork_urls: {
    standard: "https://example.test/100.jpg",
    large: "https://example.test/600.jpg",
  },
  track_artist: "Vampire Weekend",
  track_title: "This Life",
  track_album: "Father of the Bride",
  track_playout_duration: 265_000,
  track_duration: 270_000,
};

describe("Radio.co now-playing adapter", () => {
  it("normalizes current-track metadata into a stable playback identity", () => {
    const track = normalizeRadioCoTrack(
      "main",
      "s123456789",
      currentTrack,
    );

    assert.deepEqual(track, {
      id: "radioco:s123456789:2026-07-29T17:15:18.000Z",
      channelId: "main",
      artist: "Vampire Weekend",
      title: "This Life",
      album: "Father of the Bride",
      artworkUrl: "https://example.test/600.jpg",
      startedAt: "2026-07-29T17:15:18.000Z",
      durationMs: 265_000,
    });
  });

  it("falls back to the combined title when split metadata is absent", () => {
    const track = normalizeRadioCoTrack("secondary", "sabcdef012", {
      title: "Aaliyah - Rock the Boat",
      start_time: "2026-07-29T17:19:05Z",
      artwork_urls: null,
    });

    assert.equal(track?.artist, "Aaliyah");
    assert.equal(track?.title, "Rock the Boat");
  });

  it("fetches a shared station once and emits channel-specific tracks once", async () => {
    let requestCount = 0;
    const received: string[] = [];
    const fetchFunction: typeof fetch = async () => {
      requestCount += 1;
      return new Response(JSON.stringify({ data: currentTrack }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const adapter = new RadioCoNowPlaying(
      {
        adapter: "radioco",
        pollIntervalMs: 10_000,
        stations: [
          { channelId: "main", stationId: "s123456789" },
          { channelId: "video", stationId: "s123456789" },
        ],
      },
      {
        onTrack: (track) => {
          received.push(track.channelId);
        },
        onError: () => {},
      },
      fetchFunction,
    );

    await adapter.pollNow();
    await adapter.pollNow();

    assert.equal(requestCount, 2);
    assert.deepEqual(received, ["main", "video"]);
    adapter.stop();
  });
});
