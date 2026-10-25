import type { Track } from "../domain.js";

export interface NowPlayingAdapter {
  start(): Promise<void>;
  stop(): void;
}

export interface NowPlayingAdapterError {
  providerLabel: string;
  sourceId: string;
  error: Error;
}

export interface NowPlayingHandlers {
  onTrack: (track: Track) => void | Promise<void>;
  onError: (failure: NowPlayingAdapterError) => void;
}
