import { loadConfig } from "./config.js";
import { BotEngine } from "./engine.js";
import { EventBus } from "./event-bus.js";
import type { NowPlayingAdapter } from "./now-playing/adapter.js";
import { createNowPlayingAdapter } from "./now-playing/factory.js";
import { startServer } from "./server.js";
import { BotStore } from "./store.js";
import { YouTubeChatClient } from "./youtube.js";

const config = loadConfig();
const store = new BotStore(config.databasePath, config.defaultChannelId);
store.pruneHistory();
const eventBus = new EventBus();
const engine = new BotEngine(store, eventBus, config.voteMinimumRole);
const server = startServer(config, store, engine, eventBus);
const historyPruner = setInterval(
  () => store.pruneHistory(),
  6 * 60 * 60 * 1_000,
);
historyPruner.unref();

let youtube: YouTubeChatClient | null = null;
let youtubeTask: Promise<void> | null = null;

const lastNowPlayingErrorAt = new Map<string, number>();
const nowPlayingSource: NowPlayingAdapter | null = createNowPlayingAdapter(
  config.nowPlayingAdapter,
  {
    onTrack: (track) => {
      const state = store.setTrack(track);
      eventBus.publish({ type: "state", data: state });
      eventBus.publish({
        type: "activity",
        data: {
          message: `${track.channelId}: now playing ${track.artist} - ${track.title}`,
          occurredAt: new Date().toISOString(),
        },
      });
    },
    onError: ({ providerLabel, sourceId, error }) => {
      const errorKey = `${providerLabel}:${sourceId}`;
      const now = Date.now();
      if (now - (lastNowPlayingErrorAt.get(errorKey) ?? 0) < 60_000) return;
      lastNowPlayingErrorAt.set(errorKey, now);
      console.error(`${providerLabel} ${sourceId} error`, error);
      eventBus.publish({
        type: "activity",
        data: {
          message: `${providerLabel} ${sourceId} metadata is temporarily unavailable`,
          occurredAt: new Date().toISOString(),
        },
      });
    },
  },
);
const nowPlayingTask = nowPlayingSource?.start() ?? null;

if (config.youtube) {
  const youtubeConfig = config.youtube;
  youtube = new YouTubeChatClient(
    youtubeConfig,
    async (event) => {
      const result = await engine.handle(event);
      if (result.reply && youtubeConfig.enableReplies) {
        try {
          await youtube?.sendMessage(result.reply);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          console.error(
            `YouTube chat reply failed; command was processed: ${message}`,
          );
        }
      }
    },
  );

  youtubeTask = youtube.start();
}

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) {
    console.warn(`Received ${signal} again; forcing shutdown`);
    process.exit(0);
  }
  shuttingDown = true;
  console.info(`Received ${signal}; shutting down`);

  const forceExitTimer = setTimeout(() => {
    console.warn("Graceful shutdown timed out after 5 seconds; forcing shutdown");
    process.exit(0);
  }, 5_000);
  forceExitTimer.unref();

  clearInterval(historyPruner);
  nowPlayingSource?.stop();
  youtube?.stop();
  server.close(async () => {
    await Promise.allSettled(
      [nowPlayingTask, youtubeTask].filter(
        (task): task is Promise<void> => task !== null,
      ),
    );
    store.close();
    clearTimeout(forceExitTimer);
    console.info("Shutdown complete");
    process.exitCode = 0;
  });

  // Browser overlays and the control room keep long-lived SSE requests open.
  // End them after stopping new requests so server.close() can complete.
  server.closeAllConnections();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
