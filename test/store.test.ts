import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { BotStore } from "../src/store.js";

describe("BotStore", () => {
  it("stores one vote per listener per playback instance", () => {
    const store = new BotStore(":memory:");
    store.setTrack({
      id: "playback-1",
      channelId: "main",
      artist: "Talking Heads",
      title: "This Must Be the Place",
      startedAt: "2026-07-29T12:00:00.000Z",
    });

    const first = store.recordVote({
      channelId: "main",
      platform: "youtube",
      userId: "listener-1",
      displayName: "Listener",
      vote: "like",
    });
    assert.equal(first?.changed, true);
    assert.deepEqual(first?.state.votes, { likes: 1, dislikes: 0, total: 1 });

    const changed = store.recordVote({
      channelId: "main",
      platform: "youtube",
      userId: "listener-1",
      displayName: "Listener",
      vote: "dislike",
    });
    assert.equal(changed?.changed, true);
    assert.deepEqual(changed?.state.votes, { likes: 0, dislikes: 1, total: 1 });

    const unchanged = store.recordVote({
      channelId: "main",
      platform: "youtube",
      userId: "listener-1",
      displayName: "Listener",
      vote: "dislike",
    });
    assert.equal(unchanged?.changed, false);
    assert.deepEqual(unchanged?.state.votes, {
      likes: 0,
      dislikes: 1,
      total: 1,
    });

    store.close();
  });

  it("starts with fresh counts when a new playback instance begins", () => {
    const store = new BotStore(":memory:");
    store.setTrack({
      id: "playback-1",
      channelId: "main",
      artist: "Artist",
      title: "First song",
      startedAt: "2026-07-29T12:00:00.000Z",
    });
    store.recordVote({
      channelId: "main",
      platform: "youtube",
      userId: "listener-1",
      displayName: "Listener",
      vote: "like",
    });

    const state = store.setTrack({
      id: "playback-2",
      channelId: "main",
      artist: "Artist",
      title: "Second song",
      startedAt: "2026-07-29T12:04:00.000Z",
    });
    assert.equal(state.track?.id, "playback-2");
    assert.deepEqual(state.votes, { likes: 0, dislikes: 0, total: 0 });

    store.close();
  });

  it("keeps active tracks and votes isolated by channel", () => {
    const store = new BotStore(":memory:");
    store.setTrack({
      id: "shared-playback-id",
      channelId: "main",
      artist: "Vampire Weekend",
      title: "This Life",
      startedAt: "2026-07-29T17:15:18.000Z",
    });
    store.setTrack({
      id: "shared-playback-id",
      channelId: "secondary",
      artist: "Aaliyah",
      title: "Rock the Boat",
      startedAt: "2026-07-29T17:19:05.000Z",
    });
    store.recordVote({
      channelId: "main",
      platform: "youtube",
      userId: "listener-1",
      displayName: "Listener",
      vote: "like",
    });

    assert.equal(store.getActiveTrack("main")?.title, "This Life");
    assert.equal(store.getActiveTrack("secondary")?.title, "Rock the Boat");
    assert.deepEqual(store.getOverlayState("main").votes, {
      likes: 1,
      dislikes: 0,
      total: 1,
    });
    assert.deepEqual(store.getOverlayState("secondary").votes, {
      likes: 0,
      dislikes: 0,
      total: 0,
    });
    store.close();
  });

  it("migrates the original single-channel database without losing data", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "live-radio-bot-migration-"));
    const databasePath = path.join(directory, "bot.sqlite");

    try {
      const old = new DatabaseSync(databasePath);
      old.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE tracks (
          id TEXT PRIMARY KEY,
          artist TEXT NOT NULL,
          title TEXT NOT NULL,
          started_at TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 0
        );
        CREATE UNIQUE INDEX one_active_track
          ON tracks(is_active) WHERE is_active = 1;
        CREATE TABLE votes (
          track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
          platform TEXT NOT NULL,
          user_id TEXT NOT NULL,
          vote TEXT NOT NULL,
          display_name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (track_id, platform, user_id)
        );
        CREATE TABLE processed_events (
          event_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          processed_at TEXT NOT NULL,
          PRIMARY KEY (event_id, platform)
        );
        INSERT INTO tracks
          (id, artist, title, started_at, is_active)
        VALUES
          ('old-track', 'Artist', 'Song', '2026-07-29T12:00:00Z', 1);
        INSERT INTO votes
          (track_id, platform, user_id, vote, display_name, created_at)
        VALUES
          ('old-track', 'youtube', 'listener', 'like', 'Listener',
           '2026-07-29T12:00:10Z');
        INSERT INTO processed_events
          (event_id, platform, processed_at)
        VALUES
          ('old-event', 'youtube', '2026-07-29T12:00:10Z');
      `);
      old.close();

      const migrated = new BotStore(databasePath, "main");
      assert.equal(migrated.getActiveTrack("main")?.id, "old-track");
      assert.deepEqual(migrated.getOverlayState("main").votes, {
        likes: 1,
        dislikes: 0,
        total: 1,
      });
      assert.equal(
        migrated.hasProcessedEvent("main", "youtube", "old-event"),
        true,
      );
      migrated.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
