import type { Activity, OverlayAlert, OverlayState } from "./domain.js";

export type BotStreamEvent =
  | { type: "state"; data: OverlayState }
  | { type: "alert"; data: OverlayAlert }
  | { type: "activity"; data: Activity };

type Listener = (event: BotStreamEvent) => void;

export class EventBus {
  readonly #listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  publish(event: BotStreamEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}
