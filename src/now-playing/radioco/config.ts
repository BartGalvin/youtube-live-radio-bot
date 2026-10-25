import type { ChannelId } from "../../domain.js";

export interface RadioCoStation {
  channelId: string;
  stationId: string;
}

export interface RadioCoAdapterConfig {
  adapter: "radioco";
  pollIntervalMs: number;
  stations: RadioCoStation[];
}

const radioCoStationPattern = /^s[0-9a-f]{9}$/;

export function loadRadioCoAdapterConfig(
  environment: NodeJS.ProcessEnv,
  channelIds: ChannelId[],
): RadioCoAdapterConfig {
  const stations = parseRadioCoStations(
    environment.RADIOCO_STATIONS,
    channelIds,
  );
  if (stations.length === 0) {
    throw new Error(
      "RADIOCO_STATIONS is required when NOW_PLAYING_ADAPTER=radioco",
    );
  }

  const pollIntervalMs = Number(
    environment.NOW_PLAYING_POLL_INTERVAL_MS ?? 10_000,
  );
  if (
    !Number.isInteger(pollIntervalMs) ||
    pollIntervalMs < 5_000 ||
    pollIntervalMs > 300_000
  ) {
    throw new Error(
      "NOW_PLAYING_POLL_INTERVAL_MS must be between 5000 and 300000",
    );
  }

  return { adapter: "radioco", pollIntervalMs, stations };
}

function parseRadioCoStations(
  value: string | undefined,
  channelIds: ChannelId[],
): RadioCoStation[] {
  if (!value) return [];

  const stations = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separator = item.indexOf("=");
      if (separator < 1) {
        throw new Error(
          "RADIOCO_STATIONS entries must use channel=station format",
        );
      }
      const channelId = item.slice(0, separator).trim();
      const stationId = item.slice(separator + 1).trim();
      if (!channelIds.includes(channelId)) {
        throw new Error(`Unknown channel in RADIOCO_STATIONS: ${channelId}`);
      }
      if (!radioCoStationPattern.test(stationId)) {
        throw new Error(`Invalid Radio.co station ID: ${stationId}`);
      }
      return { channelId, stationId };
    });

  const mappedChannels = new Set<string>();
  for (const station of stations) {
    if (mappedChannels.has(station.channelId)) {
      throw new Error(`Duplicate Radio.co mapping for ${station.channelId}`);
    }
    mappedChannels.add(station.channelId);
  }
  return stations;
}
