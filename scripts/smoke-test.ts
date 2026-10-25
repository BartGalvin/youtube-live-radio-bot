import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8080";
const runId = randomUUID();

const health = await getJson<{
  ok: boolean;
  channels: string[];
  defaultChannelId: string;
}>("/healthz");
assert.equal(health.ok, true);
const primaryChannel = health.defaultChannelId;
const secondaryChannel = health.channels.find(
  (channelId) => channelId !== primaryChannel,
);

const invalidBody = await fetch(`${baseUrl}/api/now-playing`, {
  method: "POST",
  headers: requestHeaders(),
  body: "null",
});
assert.equal(invalidBody.status, 400);
assert.deepEqual(await invalidBody.json(), {
  error: "Request body must be a JSON object",
});

const removedTrackEndpoint = await fetch(`${baseUrl}/api/simulator/track`, {
  method: "POST",
  headers: requestHeaders(),
  body: JSON.stringify({
    channelId: primaryChannel,
    artist: "Unused",
    title: "Removed endpoint",
  }),
});
assert.equal(removedTrackEndpoint.status, 404);

const track = await postJson<{ track: { title: string } }>("/api/now-playing", {
  channelId: primaryChannel,
  id: `smoke-track:${runId}`,
  artist: "Talking Heads",
  title: "This Must Be the Place",
  startedAt: new Date().toISOString(),
});
assert.equal(track.track.title, "This Must Be the Place");

if (secondaryChannel) {
  await postJson("/api/now-playing", {
    channelId: secondaryChannel,
    id: `smoke-track-secondary:${runId}`,
    artist: "Aaliyah",
    title: "Rock the Boat",
    startedAt: new Date().toISOString(),
  });
}

const vote = await postJson<{ reply: string }>("/api/simulator/chat", {
  channelId: primaryChannel,
  id: `smoke-vote:${runId}`,
  userId: `smoke-member:${runId}`,
  displayName: "Smoke Test",
  role: "member",
  message: "!like",
});
assert.match(vote.reply, /Like recorded/);

const state = await getJson<{
  votes: { likes: number; dislikes: number; total: number };
}>(`/api/state?channel=${encodeURIComponent(primaryChannel)}`);
assert.deepEqual(state.votes, { likes: 1, dislikes: 0, total: 1 });

if (secondaryChannel) {
  const otherState = await getJson<{
    track: { title: string };
    votes: { likes: number; dislikes: number; total: number };
  }>(`/api/state?channel=${encodeURIComponent(secondaryChannel)}`);
  assert.equal(otherState.track.title, "Rock the Boat");
  assert.deepEqual(otherState.votes, { likes: 0, dislikes: 0, total: 0 });
}

const alert = await postJson<{ handled: boolean }>("/api/simulator/super-chat", {
  channelId: primaryChannel,
  id: `smoke-alert:${runId}`,
  displayName: "Test Supporter",
  message: "Great station!",
  amountDisplay: "$5.00",
});
assert.equal(alert.handled, true);

const overlay = await fetch(
  `${baseUrl}/overlay?channel=${encodeURIComponent(primaryChannel)}`,
);
assert.equal(overlay.status, 200);
assert.match(overlay.headers.get("content-type") ?? "", /^text\/html/);

console.info(
  secondaryChannel
    ? "Smoke test passed: health, channel-isolated tracks/votes, alert, and overlay"
    : "Smoke test passed: health, track/vote, alert, and overlay",
);

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  return readResponse<T>(response);
}

async function postJson<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify(body),
  });
  return readResponse<T>(response);
}

function requestHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(process.env.ADMIN_TOKEN
      ? { "x-admin-token": process.env.ADMIN_TOKEN }
      : {}),
  };
}

async function readResponse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T;
  if (!response.ok) {
    throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}
