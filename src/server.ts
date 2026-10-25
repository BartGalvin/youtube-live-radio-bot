import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import type { Config } from "./config.js";
import type { BotEvent, UserRole } from "./domain.js";
import { BotEngine } from "./engine.js";
import { EventBus } from "./event-bus.js";
import { BotStore } from "./store.js";

const validRoles = new Set<UserRole>(["viewer", "member", "moderator", "owner"]);

export function startServer(
  config: Config,
  store: BotStore,
  engine: BotEngine,
  eventBus: EventBus,
) {
  const publicDirectory = path.resolve("public");
  const overlay = readFileSync(path.join(publicDirectory, "overlay.html"));
  const control = readFileSync(path.join(publicDirectory, "control.html"));
  const staticFiles = {
    "/overlay": overlay,
    "/overlay.html": overlay,
    "/control": control,
    "/control.html": control,
  };

  const server = createServer(async (request, response) => {
    try {
      await routeRequest(request, response, {
        config,
        store,
        engine,
        eventBus,
        staticFiles,
      });
    } catch (error) {
      const isRequestError = error instanceof RequestError;
      if (!isRequestError) console.error("HTTP request failed", error);
      if (!response.headersSent) {
        sendJson(response, isRequestError ? 400 : 500, {
          error: isRequestError ? error.message : "Internal server error",
        });
      } else {
        response.end();
      }
    }
  });

  server.listen(config.port, config.host, () => {
    console.info(`${config.appName} control: http://${config.host}:${config.port}/control`);
    console.info(`OBS overlay: http://${config.host}:${config.port}/overlay`);
  });

  return server;
}

interface RouteContext {
  config: Config;
  store: BotStore;
  engine: BotEngine;
  eventBus: EventBus;
  staticFiles: Record<string, Buffer>;
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");

  if (method === "GET" && url.pathname === "/") {
    response.writeHead(302, { location: "/control" });
    response.end();
    return;
  }

  if (method === "GET" && context.staticFiles[url.pathname]) {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(context.staticFiles[url.pathname]);
    return;
  }

  if (method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, {
      ok: true,
      appName: context.config.appName,
      brandName: context.config.brandName,
      channels: context.config.channelIds,
      channelLabels: context.config.channelLabels,
      defaultChannelId: context.config.defaultChannelId,
      nowPlayingAdapter: context.config.nowPlayingAdapter?.adapter ?? null,
      youtubeEnabled: context.config.youtube !== null,
      simulatorEnabled: context.config.simulatorEnabled,
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/state") {
    const channelId = resolveChannelId(
      url.searchParams.get("channel"),
      context.config,
    );
    sendJson(response, 200, context.store.getOverlayState(channelId));
    return;
  }

  if (method === "GET" && url.pathname === "/events") {
    const channelId = resolveChannelId(
      url.searchParams.get("channel"),
      context.config,
    );
    openEventStream(request, response, context, channelId);
    return;
  }

  if (method === "POST" && url.pathname === "/api/now-playing") {
    if (!isAuthorized(request, context.config.adminToken)) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }

    const body = await readJsonBody(request);
    const channelId = resolveChannelId(body.channelId, context.config);
    const artist = requiredString(body.artist, "artist", 100);
    const title = requiredString(body.title, "title", 160);
    const startedAt =
      parseIsoDate(body.startedAt) ?? new Date().toISOString();
    const album = optionalString(body.album, 160);
    const artworkUrl = optionalHttpUrl(body.artworkUrl);
    const durationMs = optionalPositiveInteger(body.durationMs);
    const state = context.store.setTrack({
      id:
        optionalString(body.id, 200) ??
        `${slug(artist)}:${slug(title)}:${startedAt}`,
      channelId,
      artist,
      title,
      ...(album ? { album } : {}),
      ...(artworkUrl ? { artworkUrl } : {}),
      startedAt,
      ...(durationMs ? { durationMs } : {}),
    });
    context.eventBus.publish({ type: "state", data: state });
    sendJson(response, 200, state);
    return;
  }

  if (method === "POST" && url.pathname.startsWith("/api/simulator/")) {
    if (!context.config.simulatorEnabled) {
      sendJson(response, 404, { error: "Simulator is disabled" });
      return;
    }
    if (!isAuthorized(request, context.config.adminToken)) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }

    const body = await readJsonBody(request);
    const channelId = resolveChannelId(body.channelId, context.config);

    if (url.pathname === "/api/simulator/chat") {
      const role = optionalString(body.role, 20) ?? "viewer";
      if (!validRoles.has(role as UserRole)) {
        throw new RequestError("role must be viewer, member, moderator, or owner");
      }

      const event: BotEvent = {
        id: optionalString(body.id, 200) ?? randomUUID(),
        channelId,
        platform: "simulator",
        kind: "text-message",
        occurredAt: new Date().toISOString(),
        user: {
          id: optionalString(body.userId, 200) ?? `sim-user:${role}`,
          displayName: optionalString(body.displayName, 60) ?? "Test listener",
          role: role as UserRole,
        },
        message: requiredString(body.message, "message", 200),
      };
      const result = await context.engine.handle(event);
      sendJson(response, 200, result);
      return;
    }

    if (url.pathname === "/api/simulator/super-chat") {
      const event: BotEvent = {
        id: optionalString(body.id, 200) ?? randomUUID(),
        channelId,
        platform: "simulator",
        kind: "paid-message",
        occurredAt: new Date().toISOString(),
        user: {
          id: optionalString(body.userId, 200) ?? "sim-donor",
          displayName: optionalString(body.displayName, 60) ?? "Generous listener",
          role: "viewer",
        },
        message: optionalString(body.message, 180) ?? "Love this station!",
        amountDisplay: optionalString(body.amountDisplay, 40) ?? "$5.00",
        amountMicros: 5_000_000,
        currency: "USD",
        paidKind: "super-chat",
      };
      const result = await context.engine.handle(event);
      sendJson(response, 200, result);
      return;
    }
  }

  sendJson(response, 404, { error: "Not found" });
}

function openEventStream(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
  channelId: string,
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.write(": connected\n\n");
  writeSse(response, "state", context.store.getOverlayState(channelId));

  const unsubscribe = context.eventBus.subscribe((event) => {
    if (
      (event.type === "state" || event.type === "alert") &&
      event.data.channelId !== channelId
    ) {
      return;
    }
    writeSse(response, event.type, event.data);
  });
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);

  request.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function writeSse(response: ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function isAuthorized(request: IncomingMessage, configuredToken?: string): boolean {
  if (!configuredToken) return true;

  const suppliedToken =
    request.headers["x-admin-token"] ??
    request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (typeof suppliedToken !== "string") return false;

  const expected = Buffer.from(configuredToken);
  const supplied = Buffer.from(suppliedToken);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 64 * 1024) {
      throw new RequestError("Request body is too large");
    }
    chunks.push(buffer);
  }

  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError("Request body must be valid JSON");
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestError("Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, maxLength: number): string {
  const parsed = optionalString(value, maxLength);
  if (!parsed) throw new RequestError(`${name} is required`);
  return parsed;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = value.trim();
  if (!parsed) return undefined;
  if (parsed.length > maxLength) {
    throw new RequestError(`Value must be at most ${maxLength} characters`);
  }
  return parsed;
}

function resolveChannelId(value: unknown, config: Config): string {
  const channelId =
    optionalString(value, 64) ?? config.defaultChannelId;
  if (!config.channelIds.includes(channelId)) {
    throw new RequestError(
      `channelId must be one of: ${config.channelIds.join(", ")}`,
    );
  }
  return channelId;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RequestError("durationMs must be a positive integer");
  }
  return parsed;
}

function optionalHttpUrl(value: unknown): string | undefined {
  const text = optionalString(value, 2_000);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
    return url.toString();
  } catch {
    throw new RequestError("artworkUrl must be an HTTP or HTTPS URL");
  }
}

function parseIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new RequestError("startedAt must be an ISO 8601 date");
  }
  return parsed.toISOString();
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

class RequestError extends Error {}
