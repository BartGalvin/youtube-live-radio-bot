import type { ChannelId } from "../domain.js";
import type {
  NowPlayingAdapter,
  NowPlayingHandlers,
} from "./adapter.js";
import { RadioCoNowPlaying } from "./radioco/adapter.js";
import {
  loadRadioCoAdapterConfig,
  type RadioCoAdapterConfig,
} from "./radioco/config.js";

export type NowPlayingAdapterConfig = RadioCoAdapterConfig | null;

export function loadNowPlayingAdapterConfig(
  environment: NodeJS.ProcessEnv,
  channelIds: ChannelId[],
): NowPlayingAdapterConfig {
  const adapter = environment.NOW_PLAYING_ADAPTER?.trim();
  if (!adapter) return null;

  if (adapter === "radioco") {
    return loadRadioCoAdapterConfig(environment, channelIds);
  }

  throw new Error("NOW_PLAYING_ADAPTER must be empty or radioco");
}

export function createNowPlayingAdapter(
  config: NowPlayingAdapterConfig,
  handlers: NowPlayingHandlers,
): NowPlayingAdapter | null {
  if (!config) return null;
  return new RadioCoNowPlaying(config, handlers);
}
