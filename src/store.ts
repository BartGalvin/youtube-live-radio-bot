import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { OverlayState, Platform, Track, VoteCounts, VoteValue } from "./domain.js";

export interface VoteResult {
  changed: boolean;
  state: OverlayState;
}

export class BotStore {
  readonly #db: DatabaseSync;

  constructor(
    databasePath: string,
    private readonly legacyChannelId = "main",
  ) {
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(databasePath), { recursive: true });
    }

    this.#db = new DatabaseSync(databasePath);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#migrate();
  }

  close(): void {
    this.#db.close();
  }

  #migrate(): void {
    if (!this.#tableExists("tracks")) {
      this.#createSchema();
      return;
    }

    if (!this.#tableHasColumn("tracks", "channel_id")) {
      this.#migrateSingleChannelSchema();
      return;
    }

    this.#createSchema();
    this.#ensureTrackMetadataColumns();
  }

  #createSchema(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS tracks (
        channel_id TEXT NOT NULL,
        id TEXT NOT NULL,
        artist TEXT NOT NULL,
        title TEXT NOT NULL,
        album TEXT,
        artwork_url TEXT,
        started_at TEXT NOT NULL,
        duration_ms INTEGER,
        is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
        PRIMARY KEY (channel_id, id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS one_active_track_per_channel
        ON tracks(channel_id)
        WHERE is_active = 1;

      CREATE TABLE IF NOT EXISTS votes (
        channel_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        user_id TEXT NOT NULL,
        vote TEXT NOT NULL CHECK (vote IN ('like', 'dislike')),
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, track_id, platform, user_id),
        FOREIGN KEY (channel_id, track_id)
          REFERENCES tracks(channel_id, id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS processed_events (
        channel_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, event_id, platform)
      );
    `);
  }

  #migrateSingleChannelSchema(): void {
    this.#db.exec("PRAGMA foreign_keys = OFF");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.exec(`
        ALTER TABLE tracks RENAME TO tracks_single_channel;
        ALTER TABLE votes RENAME TO votes_single_channel;
        ALTER TABLE processed_events RENAME TO processed_events_single_channel;
      `);
      this.#createSchema();
      this.#db
        .prepare(
          `INSERT INTO tracks (
             channel_id, id, artist, title, started_at, is_active
           )
           SELECT ?, id, artist, title, started_at, is_active
           FROM tracks_single_channel`,
        )
        .run(this.legacyChannelId);
      this.#db
        .prepare(
          `INSERT INTO votes (
             channel_id, track_id, platform, user_id, vote, display_name, created_at
           )
           SELECT ?, track_id, platform, user_id, vote, display_name, created_at
           FROM votes_single_channel`,
        )
        .run(this.legacyChannelId);
      this.#db
        .prepare(
          `INSERT INTO processed_events (
             channel_id, event_id, platform, processed_at
           )
           SELECT ?, event_id, platform, processed_at
           FROM processed_events_single_channel`,
        )
        .run(this.legacyChannelId);
      const violations = this.#db
        .prepare("PRAGMA foreign_key_check")
        .all();
      if (violations.length > 0) {
        throw new Error("Channel migration failed its foreign-key check");
      }
      this.#db.exec(`
        DROP TABLE votes_single_channel;
        DROP TABLE processed_events_single_channel;
        DROP TABLE tracks_single_channel;
        COMMIT;
      `);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    } finally {
      this.#db.exec("PRAGMA foreign_keys = ON");
    }
  }

  #ensureTrackMetadataColumns(): void {
    const columns: Array<[string, string]> = [
      ["album", "TEXT"],
      ["artwork_url", "TEXT"],
      ["duration_ms", "INTEGER"],
    ];
    for (const [name, type] of columns) {
      if (!this.#tableHasColumn("tracks", name)) {
        this.#db.exec(`ALTER TABLE tracks ADD COLUMN ${name} ${type}`);
      }
    }
  }

  #tableExists(name: string): boolean {
    return (
      this.#db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(name) !== undefined
    );
  }

  #tableHasColumn(table: string, column: string): boolean {
    const rows = this.#db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    return rows.some((row) => row.name === column);
  }

  setTrack(track: Track): OverlayState {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          "UPDATE tracks SET is_active = 0 WHERE channel_id = ? AND is_active = 1",
        )
        .run(track.channelId);
      this.#db
        .prepare(
          `INSERT INTO tracks (
             channel_id, id, artist, title, album, artwork_url,
             started_at, duration_ms, is_active
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
           ON CONFLICT(channel_id, id) DO UPDATE SET
             artist = excluded.artist,
             title = excluded.title,
             album = excluded.album,
             artwork_url = excluded.artwork_url,
             started_at = excluded.started_at,
             duration_ms = excluded.duration_ms,
             is_active = 1`,
        )
        .run(
          track.channelId,
          track.id,
          track.artist,
          track.title,
          track.album ?? null,
          track.artworkUrl ?? null,
          track.startedAt,
          track.durationMs ?? null,
        );
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }

    return this.getOverlayState(track.channelId);
  }

  pruneHistory(retentionDays = 30): void {
    const cutoff = new Date(
      Date.now() - retentionDays * 24 * 60 * 60 * 1_000,
    ).toISOString();
    this.#db
      .prepare("DELETE FROM processed_events WHERE processed_at < ?")
      .run(cutoff);
    this.#db
      .prepare("DELETE FROM tracks WHERE is_active = 0 AND started_at < ?")
      .run(cutoff);
  }

  getActiveTrack(channelId: string): Track | null {
    const row = this.#db
      .prepare(
        `SELECT
           channel_id, id, artist, title, album, artwork_url,
           started_at, duration_ms
         FROM tracks
         WHERE channel_id = ? AND is_active = 1
         LIMIT 1`,
      )
      .get(channelId) as
      | {
          channel_id: string;
          id: string;
          artist: string;
          title: string;
          album: string | null;
          artwork_url: string | null;
          started_at: string;
          duration_ms: number | null;
        }
      | undefined;

    if (!row) return null;

    return {
      id: row.id,
      channelId: row.channel_id,
      artist: row.artist,
      title: row.title,
      ...(row.album ? { album: row.album } : {}),
      ...(row.artwork_url ? { artworkUrl: row.artwork_url } : {}),
      startedAt: row.started_at,
      ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    };
  }

  getVoteCounts(channelId: string, trackId: string): VoteCounts {
    const row = this.#db
      .prepare(
        `SELECT
           SUM(CASE WHEN vote = 'like' THEN 1 ELSE 0 END) AS likes,
           SUM(CASE WHEN vote = 'dislike' THEN 1 ELSE 0 END) AS dislikes,
           COUNT(*) AS total
         FROM votes
         WHERE channel_id = ? AND track_id = ?`,
      )
      .get(channelId, trackId) as {
      likes: number | null;
      dislikes: number | null;
      total: number;
    };

    return {
      likes: row.likes ?? 0,
      dislikes: row.dislikes ?? 0,
      total: row.total,
    };
  }

  getOverlayState(channelId: string): OverlayState {
    const track = this.getActiveTrack(channelId);
    return {
      channelId,
      track,
      votes: track
        ? this.getVoteCounts(channelId, track.id)
        : {
            likes: 0,
            dislikes: 0,
            total: 0,
          },
    };
  }

  recordVote(input: {
    channelId: string;
    platform: Platform;
    userId: string;
    displayName: string;
    vote: VoteValue;
  }): VoteResult | null {
    const track = this.getActiveTrack(input.channelId);
    if (!track) return null;

    const result = this.#db
      .prepare(
        `INSERT INTO votes (
           channel_id, track_id, platform, user_id,
           vote, display_name, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, track_id, platform, user_id) DO UPDATE SET
           vote = excluded.vote,
           display_name = excluded.display_name,
           created_at = excluded.created_at
         WHERE votes.vote <> excluded.vote`,
      )
      .run(
        input.channelId,
        track.id,
        input.platform,
        input.userId,
        input.vote,
        input.displayName,
        new Date().toISOString(),
      );

    return {
      changed: Number(result.changes) > 0,
      state: this.getOverlayState(input.channelId),
    };
  }

  hasProcessedEvent(
    channelId: string,
    platform: Platform,
    eventId: string,
  ): boolean {
    const row = this.#db
      .prepare(
        `SELECT 1
         FROM processed_events
         WHERE channel_id = ? AND platform = ? AND event_id = ?`,
      )
      .get(channelId, platform, eventId);
    return row !== undefined;
  }

  markEventProcessed(
    channelId: string,
    platform: Platform,
    eventId: string,
  ): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO processed_events (
           channel_id, platform, event_id, processed_at
         )
         VALUES (?, ?, ?, ?)`,
      )
      .run(channelId, platform, eventId, new Date().toISOString());
  }
}
