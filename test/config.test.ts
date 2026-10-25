import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { loadConfig } from "../src/config.js";

const managedVariables = [
  "APP_NAME",
  "BRAND_NAME",
  "CHANNELS",
  "CHANNEL_LABELS",
  "DATABASE_PATH",
  "DEFAULT_CHANNEL_ID",
  "NOW_PLAYING_ADAPTER",
  "NOW_PLAYING_POLL_INTERVAL_MS",
  "RADIOCO_STATIONS",
  "YOUTUBE_CLIENT_ID",
  "YOUTUBE_CLIENT_SECRET",
  "YOUTUBE_BROADCAST_ID",
  "YOUTUBE_ENABLE_REPLIES",
  "YOUTUBE_ENABLED",
  "YOUTUBE_REFRESH_TOKEN",
  "YOUTUBE_CHANNEL_ID",
] as const;

const originalValues = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of managedVariables) {
    originalValues.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of managedVariables) {
    const value = originalValues.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originalValues.clear();
});

describe("configuration", () => {
  it("keeps SQLite's in-memory path literal and parses station mappings", () => {
    process.env.DATABASE_PATH = ":memory:";
    process.env.CHANNELS = "main,secondary,video";
    process.env.CHANNEL_LABELS =
      "main=Main Stream,secondary=Second Stream,video=Video Stream";
    process.env.NOW_PLAYING_ADAPTER = "radioco";
    process.env.RADIOCO_STATIONS =
      "main=s123456789,secondary=sabcdef012,video=s123456789";

    const config = loadConfig();

    assert.equal(config.databasePath, ":memory:");
    assert.equal(config.defaultChannelId, "main");
    assert.deepEqual(config.channelLabels, {
      main: "Main Stream",
      secondary: "Second Stream",
      video: "Video Stream",
    });
    assert.deepEqual(config.nowPlayingAdapter, {
      adapter: "radioco",
      pollIntervalMs: 10_000,
      stations: [
        { channelId: "main", stationId: "s123456789" },
        { channelId: "secondary", stationId: "sabcdef012" },
        { channelId: "video", stationId: "s123456789" },
      ],
    });
  });

  it("defaults to no background metadata adapter", () => {
    process.env.RADIOCO_STATIONS = "unused-adapter-data";
    const config = loadConfig();

    assert.equal(config.nowPlayingAdapter, null);
    assert.equal(config.youtube, null);
  });

  it("rejects a YouTube binding outside the configured channels", () => {
    process.env.CHANNELS = "main,secondary";
    process.env.YOUTUBE_ENABLED = "true";
    process.env.YOUTUBE_CHANNEL_ID = "video";
    process.env.YOUTUBE_CLIENT_ID = "client";
    process.env.YOUTUBE_CLIENT_SECRET = "secret";
    process.env.YOUTUBE_REFRESH_TOKEN = "refresh";

    assert.throws(
      () => loadConfig(),
      /YOUTUBE_CHANNEL_ID must be listed/,
    );
  });

  it("returns a complete YouTube config when enabled", () => {
    process.env.YOUTUBE_ENABLED = "true";
    process.env.YOUTUBE_CLIENT_ID = "client";
    process.env.YOUTUBE_CLIENT_SECRET = "secret";
    process.env.YOUTUBE_REFRESH_TOKEN = "refresh";
    process.env.YOUTUBE_ENABLE_REPLIES = "true";

    assert.deepEqual(loadConfig().youtube, {
      channelId: "main",
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh",
      enableReplies: true,
    });
  });

  it("rejects enabled YouTube without complete credentials", () => {
    process.env.YOUTUBE_ENABLED = "true";

    assert.throws(
      () => loadConfig(),
      /YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and YOUTUBE_REFRESH_TOKEN/,
    );
  });
});
