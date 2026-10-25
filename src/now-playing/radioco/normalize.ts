import type { Track } from "../../domain.js";

export interface RadioCoTrackData {
  title?: unknown;
  start_time?: unknown;
  artwork_urls?: unknown;
  track_artist?: unknown;
  track_title?: unknown;
  track_album?: unknown;
  track_playout_duration?: unknown;
  track_duration?: unknown;
}

interface ArtworkUrls {
  standard?: unknown;
  large?: unknown;
}

export function normalizeRadioCoTrack(
  channelId: string,
  stationId: string,
  data: RadioCoTrackData,
): Track | null {
  const startedAt = isoDate(data.start_time);
  if (!startedAt) return null;

  const combinedTitle = stringValue(data.title);
  const parsedCombined = combinedTitle ? splitCombinedTitle(combinedTitle) : null;
  const artist =
    stringValue(data.track_artist) ?? parsedCombined?.artist ?? "Unknown artist";
  const title =
    stringValue(data.track_title) ?? parsedCombined?.title ?? combinedTitle;
  if (!title) return null;

  const artwork = isRecord(data.artwork_urls)
    ? (data.artwork_urls as ArtworkUrls)
    : null;
  const artworkUrl =
    httpUrl(artwork?.large) ?? httpUrl(artwork?.standard);
  const album = stringValue(data.track_album);
  const durationMs =
    positiveInteger(data.track_playout_duration) ??
    positiveInteger(data.track_duration);

  return {
    id: `radioco:${stationId}:${startedAt}`,
    channelId,
    artist,
    title,
    ...(album ? { album } : {}),
    ...(artworkUrl ? { artworkUrl } : {}),
    startedAt,
    ...(durationMs ? { durationMs } : {}),
  };
}

function splitCombinedTitle(value: string): {
  artist: string;
  title: string;
} | null {
  const separator = value.indexOf(" - ");
  if (separator < 1 || separator >= value.length - 3) return null;
  return {
    artist: value.slice(0, separator).trim(),
    title: value.slice(separator + 3).trim(),
  };
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 300) : null;
}

function isoDate(value: unknown): string | null {
  const text = stringValue(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : null;
}

function httpUrl(value: unknown): string | null {
  const text = stringValue(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
