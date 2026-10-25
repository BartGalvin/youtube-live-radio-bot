import path from "node:path";

import type { ChannelId, UserRole } from "./domain.js";
import {
  loadNowPlayingAdapterConfig,
  type NowPlayingAdapterConfig,
} from "./now-playing/factory.js";
import type { YouTubeClientConfig } from "./youtube.js";

export interface YouTubeBotConfig extends YouTubeClientConfig {
  enableReplies: boolean;
}

export interface Config {
  appName: string;
  brandName: string;
  host: string;
  port: number;
  databasePath: string;
  simulatorEnabled: boolean;
  adminToken?: string;
  channelIds: ChannelId[];
  channelLabels: Record<ChannelId, string>;
  defaultChannelId: ChannelId;
  voteMinimumRole: UserRole;
  nowPlayingAdapter: NowPlayingAdapterConfig;
  youtube: YouTubeBotConfig | null;
}

const roles: UserRole[] = ["viewer", "member", "moderator", "owner"];
const channelPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function parseChannelIds(value: string): ChannelId[] {
  const channelIds = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (channelIds.length === 0) {
    throw new Error("CHANNELS must contain at least one channel");
  }
  for (const channelId of channelIds) {
    if (!channelPattern.test(channelId)) {
      throw new Error(`Invalid channel ID: ${channelId}`);
    }
  }
  return channelIds;
}

function parseChannelLabels(
  value: string | undefined,
  channelIds: ChannelId[],
): Record<ChannelId, string> {
  const labels = Object.fromEntries(
    channelIds.map((channelId) => [channelId, humanizeChannelId(channelId)]),
  );
  if (!value) return labels;

  for (const item of value.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    const separator = item.indexOf("=");
    if (separator < 1) {
      throw new Error("CHANNEL_LABELS entries must use channel=label format");
    }
    const channelId = item.slice(0, separator).trim();
    const label = item.slice(separator + 1).trim();
    if (!channelIds.includes(channelId)) {
      throw new Error(`Unknown channel in CHANNEL_LABELS: ${channelId}`);
    }
    if (!label) {
      throw new Error(`CHANNEL_LABELS must provide a label for ${channelId}`);
    }
    labels[channelId] = label.slice(0, 80);
  }
  return labels;
}

function humanizeChannelId(channelId: string): string {
  return channelId
    .split("-")
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}

export function loadConfig(): Config {
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const voteMinimumRole = (process.env.VOTE_MINIMUM_ROLE ?? "member") as UserRole;
  if (!roles.includes(voteMinimumRole)) {
    throw new Error(`VOTE_MINIMUM_ROLE must be one of: ${roles.join(", ")}`);
  }

  const channelIds = parseChannelIds(process.env.CHANNELS ?? "main");
  const channelLabels = parseChannelLabels(
    optionalEnv("CHANNEL_LABELS"),
    channelIds,
  );
  const defaultChannelId = process.env.DEFAULT_CHANNEL_ID?.trim() ?? channelIds[0]!;
  if (!channelIds.includes(defaultChannelId)) {
    throw new Error("DEFAULT_CHANNEL_ID must be listed in CHANNELS");
  }

  const nowPlayingAdapter = loadNowPlayingAdapterConfig(
    process.env,
    channelIds,
  );

  const youtubeEnabled = booleanEnv("YOUTUBE_ENABLED", false);
  let youtube: YouTubeBotConfig | null = null;
  if (youtubeEnabled) {
    const channelId =
      process.env.YOUTUBE_CHANNEL_ID?.trim() ?? defaultChannelId;
    if (!channelIds.includes(channelId)) {
      throw new Error("YOUTUBE_CHANNEL_ID must be listed in CHANNELS");
    }

    const clientId = optionalEnv("YOUTUBE_CLIENT_ID");
    const clientSecret = optionalEnv("YOUTUBE_CLIENT_SECRET");
    const refreshToken = optionalEnv("YOUTUBE_REFRESH_TOKEN");
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(
        "YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and YOUTUBE_REFRESH_TOKEN are required when YOUTUBE_ENABLED=true",
      );
    }

    const broadcastId = optionalEnv("YOUTUBE_BROADCAST_ID");
    youtube = {
      channelId,
      ...(broadcastId ? { broadcastId } : {}),
      clientId,
      clientSecret,
      refreshToken,
      enableReplies: booleanEnv("YOUTUBE_ENABLE_REPLIES", false),
    };
  }

  const host = process.env.HOST ?? "127.0.0.1";
  const adminToken = optionalEnv("ADMIN_TOKEN");
  if (host !== "127.0.0.1" && host !== "localhost" && !adminToken) {
    throw new Error("ADMIN_TOKEN is required when HOST is not localhost");
  }

  const databasePathValue =
    process.env.DATABASE_PATH ?? "./data/live-radio-bot.sqlite";

  return {
    appName: optionalEnv("APP_NAME") ?? "Live Radio Bot",
    brandName: optionalEnv("BRAND_NAME") ?? "Live Radio",
    host,
    port,
    databasePath:
      databasePathValue === ":memory:"
        ? databasePathValue
        : path.resolve(databasePathValue),
    simulatorEnabled: booleanEnv("SIMULATOR_ENABLED", true),
    ...(adminToken ? { adminToken } : {}),
    channelIds,
    channelLabels,
    defaultChannelId,
    voteMinimumRole,
    nowPlayingAdapter,
    youtube,
  };
}
