import { setTimeout as delay } from "node:timers/promises";

export async function abortableDelay(
  durationMs: number,
  signal: AbortSignal,
): Promise<void> {
  try {
    await delay(durationMs, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}
