import { hasMinimumRole, parseCommand } from "./commands.js";
import type {
  BotEvent,
  OverlayAlert,
  TextMessageEvent,
  UserRole,
} from "./domain.js";
import { EventBus } from "./event-bus.js";
import { BotStore } from "./store.js";

export interface HandleResult {
  handled: boolean;
  reply?: string;
}

export class BotEngine {
  readonly #lastCommandAt = new Map<string, number>();

  constructor(
    private readonly store: BotStore,
    private readonly eventBus: EventBus,
    private readonly voteMinimumRole: UserRole,
    private readonly cooldownMs = 5_000,
  ) {}

  async handle(event: BotEvent): Promise<HandleResult> {
    if (event.kind === "paid-message") {
      if (
        this.store.hasProcessedEvent(event.channelId, event.platform, event.id)
      ) {
        return { handled: false };
      }

      const alert: OverlayAlert = {
        id: event.id,
        channelId: event.channelId,
        platform: event.platform,
        displayName: cleanText(event.user.displayName, 60),
        message: cleanText(event.message, 180),
        amountDisplay: cleanText(event.amountDisplay, 40),
        ...(event.user.profileImageUrl
          ? { profileImageUrl: event.user.profileImageUrl }
          : {}),
        durationMs: event.paidKind === "membership" ? 8_000 : 12_000,
      };

      this.eventBus.publish({ type: "alert", data: alert });
      this.#activity(
        `${alert.displayName}: ${alert.amountDisplay || "membership"} alert queued`,
      );
      this.store.markEventProcessed(event.channelId, event.platform, event.id);
      return { handled: true };
    }

    return this.#handleTextMessage(event);
  }

  #handleTextMessage(event: TextMessageEvent): HandleResult {
    const command = parseCommand(event.message);
    if (!command) return { handled: false };

    if (
      this.store.hasProcessedEvent(event.channelId, event.platform, event.id)
    ) {
      return { handled: false };
    }

    const cooldownKey = `${event.channelId}:${event.platform}:${event.user.id}`;
    const now = Date.now();
    const lastCommandAt = this.#lastCommandAt.get(cooldownKey) ?? 0;
    if (now - lastCommandAt < this.cooldownMs) {
      this.store.markEventProcessed(event.channelId, event.platform, event.id);
      return { handled: true };
    }
    this.#lastCommandAt.set(cooldownKey, now);
    this.#pruneCooldowns(now);

    let reply: string;

    switch (command.kind) {
      case "help":
        reply =
          "Commands: !song, !votes, !help. Channel members can vote with !like or !dislike.";
        break;

      case "song": {
        const track = this.store.getActiveTrack(event.channelId);
        reply = track
          ? `Now playing: ${track.artist} — ${track.title}`
          : "The current song is not available yet.";
        break;
      }

      case "votes": {
        const state = this.store.getOverlayState(event.channelId);
        reply = state.track
          ? `${state.track.artist} — ${state.track.title}: ${state.votes.likes} like${plural(state.votes.likes)}, ${state.votes.dislikes} dislike${plural(state.votes.dislikes)}.`
          : "Voting will open when the next song starts.";
        break;
      }

      case "vote": {
        if (!hasMinimumRole(event.user.role, this.voteMinimumRole)) {
          reply =
            this.voteMinimumRole === "member"
              ? "Song voting is currently available to YouTube channel members."
              : `Song voting requires the ${this.voteMinimumRole} role.`;
          break;
        }

        const result = this.store.recordVote({
          channelId: event.channelId,
          platform: event.platform,
          userId: event.user.id,
          displayName: event.user.displayName,
          vote: command.vote,
        });

        if (!result) {
          reply = "Voting will open when the next song starts.";
          break;
        }

        this.eventBus.publish({ type: "state", data: result.state });
        reply = result.changed
          ? `${command.vote === "like" ? "Like" : "Dislike"} recorded for ${result.state.track?.title ?? "this song"}.`
          : `Your ${command.vote} is already recorded for this song.`;
        break;
      }
    }

    this.#activity(
      `${event.user.displayName} used ${event.message.trim().split(/\s+/, 1)[0] ?? "a command"}`,
    );
    this.store.markEventProcessed(event.channelId, event.platform, event.id);
    return { handled: true, reply };
  }

  #activity(message: string): void {
    this.eventBus.publish({
      type: "activity",
      data: {
        message,
        occurredAt: new Date().toISOString(),
      },
    });
  }

  #pruneCooldowns(now: number): void {
    if (this.#lastCommandAt.size < 10_000) return;

    const cutoff = now - Math.max(this.cooldownMs * 2, 60_000);
    for (const [key, commandAt] of this.#lastCommandAt) {
      if (commandAt < cutoff) this.#lastCommandAt.delete(key);
    }
  }
}

function cleanText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function plural(value: number): string {
  return value === 1 ? "" : "s";
}
