import { abortableDelay } from "../../abortable-delay.js";
import type {
  NowPlayingAdapter,
  NowPlayingHandlers,
} from "../adapter.js";
import type {
  RadioCoAdapterConfig,
  RadioCoStation,
} from "./config.js";
import {
  normalizeRadioCoTrack,
  type RadioCoTrackData,
} from "./normalize.js";

type FetchFunction = typeof fetch;

export class RadioCoNowPlaying implements NowPlayingAdapter {
  readonly #abortController = new AbortController();
  readonly #lastTrackSignatures = new Map<string, string>();
  readonly #channelsByStation = new Map<string, RadioCoStation[]>();

  constructor(
    private readonly config: RadioCoAdapterConfig,
    private readonly handlers: NowPlayingHandlers,
    private readonly fetchFunction: FetchFunction = fetch,
  ) {
    for (const station of config.stations) {
      const mappings = this.#channelsByStation.get(station.stationId) ?? [];
      mappings.push(station);
      this.#channelsByStation.set(station.stationId, mappings);
    }
  }

  async start(): Promise<void> {
    console.info(
      `Radio.co now-playing adapter started for ${this.config.stations.length} channel mapping(s)`,
    );

    while (!this.#abortController.signal.aborted) {
      await this.pollNow();
      await abortableDelay(
        this.config.pollIntervalMs,
        this.#abortController.signal,
      );
    }
  }

  stop(): void {
    this.#abortController.abort();
  }

  async pollNow(): Promise<void> {
    await Promise.all(
      [...this.#channelsByStation].map(async ([stationId, stations]) => {
        try {
          const data = await this.#fetchCurrentTrack(stationId);
          for (const station of stations) {
            const track = normalizeRadioCoTrack(
              station.channelId,
              stationId,
              data,
            );
            if (!track) continue;
            const signature = JSON.stringify(track);
            if (
              this.#lastTrackSignatures.get(station.channelId) === signature
            ) {
              continue;
            }

            await this.handlers.onTrack(track);
            this.#lastTrackSignatures.set(station.channelId, signature);
          }
        } catch (error) {
          if (this.#abortController.signal.aborted) return;
          this.handlers.onError({
            providerLabel: "Radio.co",
            sourceId: stationId,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }),
    );
  }

  async #fetchCurrentTrack(stationId: string): Promise<RadioCoTrackData> {
    const signal = AbortSignal.any([
      this.#abortController.signal,
      AbortSignal.timeout(8_000),
    ]);
    const response = await this.fetchFunction(
      `https://public.radio.co/api/v2/${encodeURIComponent(stationId)}/track/current`,
      {
        headers: {
          accept: "application/json",
          "user-agent": "Live-Radio-Bot/0.1",
        },
        signal,
      },
    );
    if (!response.ok) {
      throw new Error(`Radio.co ${stationId} returned HTTP ${response.status}`);
    }

    const body = (await response.json()) as { data?: unknown };
    if (!body.data || typeof body.data !== "object") {
      throw new Error(`Radio.co ${stationId} returned no current track`);
    }
    return body.data as RadioCoTrackData;
  }
}
