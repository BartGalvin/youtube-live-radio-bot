import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "node:path";

import { abortableDelay } from "./abortable-delay.js";
import type {
  BotEvent,
  ChatUser,
  PaidMessageEvent,
  TextMessageEvent,
  UserRole,
} from "./domain.js";

export interface YouTubeClientConfig {
  channelId: string;
  broadcastId?: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

interface AccessToken {
  value: string;
  expiresAt: number;
}

interface LiveBroadcastListResponse {
  items?: Array<{
    snippet?: {
      liveChatId?: string;
    };
    status?: {
      lifeCycleStatus?: string;
    };
  }>;
}

interface YouTubeLiveChatMessage {
  id?: string;
  snippet?: {
    type?: string;
    publishedAt?: string;
    displayMessage?: string;
    textMessageDetails?: {
      messageText?: string;
    };
    superChatDetails?: {
      amountMicros?: string;
      currency?: string;
      amountDisplayString?: string;
      userComment?: string;
    };
    superStickerDetails?: {
      amountMicros?: string;
      currency?: string;
      amountDisplayString?: string;
      superStickerMetadata?: {
        altText?: string;
      };
    };
    newSponsorDetails?: {
      memberLevelName?: string;
    };
    memberMilestoneChatDetails?: {
      userComment?: string;
      memberLevelName?: string;
      memberMonth?: number;
    };
  };
  authorDetails?: {
    channelId?: string;
    displayName?: string;
    profileImageUrl?: string;
    isChatOwner?: boolean;
    isChatModerator?: boolean;
    isChatSponsor?: boolean;
  };
}

type EventHandler = (event: BotEvent) => Promise<void>;

interface GrpcLiveChatListResponse {
  offlineAt?: string;
  nextPageToken?: string;
  items?: YouTubeLiveChatMessage[];
}

interface StreamListClient extends grpc.Client {
  StreamList(
    request: Record<string, unknown>,
    metadata: grpc.Metadata,
  ): grpc.ClientReadableStream<GrpcLiveChatListResponse>;
}

export class YouTubeChatClient {
  readonly #abortController = new AbortController();
  #accessToken: AccessToken | null = null;
  #liveChatId: string | null = null;
  #pageToken: string | null = null;
  #connectedAt = "";
  #activeStream: grpc.ClientReadableStream<GrpcLiveChatListResponse> | null = null;
  #waitingForBroadcast = false;
  #lastPollingError: string | null = null;

  constructor(
    private readonly config: YouTubeClientConfig,
    private readonly onEvent: EventHandler,
  ) {}

  async start(): Promise<void> {
    console.info("YouTube streaming chat client started");

    while (!this.#abortController.signal.aborted) {
      try {
        if (!this.#liveChatId) {
          this.#liveChatId = await this.#discoverLiveChat();
          this.#lastPollingError = null;
          this.#pageToken = null;
          this.#connectedAt = new Date().toISOString();

          if (!this.#liveChatId) {
            if (!this.#waitingForBroadcast) {
              console.info("No active YouTube broadcast; waiting for one");
              this.#waitingForBroadcast = true;
            }
            await abortableDelay(15_000, this.#abortController.signal);
            continue;
          }

          this.#waitingForBroadcast = false;
          console.info("Connected to YouTube live chat");
        }

        await this.#streamOnce();
      } catch (error) {
        if (this.#abortController.signal.aborted) break;
        const message = error instanceof Error ? error.message : "Unknown error";
        if (message !== this.#lastPollingError) {
          console.error(`YouTube polling error: ${message}`);
          this.#lastPollingError = message;
        }
        this.#liveChatId = null;
        this.#pageToken = null;
        await abortableDelay(5_000, this.#abortController.signal);
      }
    }
  }

  stop(): void {
    this.#abortController.abort();
    this.#activeStream?.cancel();
  }

  async sendMessage(message: string): Promise<void> {
    if (!this.#liveChatId) return;

    await this.#apiFetch(
      "https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          snippet: {
            liveChatId: this.#liveChatId,
            type: "textMessageEvent",
            textMessageDetails: {
              messageText: message.slice(0, 200),
            },
          },
        }),
      },
    );
  }

  async #discoverLiveChat(): Promise<string | null> {
    const url = buildLiveBroadcastsUrl(this.config.broadcastId);
    const response = await this.#apiFetch(url);
    const data = (await response.json()) as LiveBroadcastListResponse;
    return selectLiveChatId(data, Boolean(this.config.broadcastId));
  }

  async #streamOnce(): Promise<void> {
    if (!this.#liveChatId) return;

    const token = await this.#getAccessToken();
    const packageDefinition = protoLoader.loadSync(
      path.resolve("proto/youtube-live-chat.proto"),
      {
        keepCase: false,
        longs: String,
        enums: String,
        defaults: false,
        oneofs: true,
      },
    );
    const loaded = grpc.loadPackageDefinition(packageDefinition) as unknown as {
      youtube: {
        api: {
          v3: {
            V3DataLiveChatMessageService: grpc.ServiceClientConstructor;
          };
        };
      };
    };
    const Client = loaded.youtube.api.v3.V3DataLiveChatMessageService;
    const client = new Client(
      "youtube.googleapis.com:443",
      grpc.credentials.createSsl(),
    ) as unknown as StreamListClient;
    const metadata = new grpc.Metadata();
    metadata.set("authorization", `Bearer ${token}`);
    const isInitialConnection = this.#pageToken === null;

    const request: Record<string, unknown> = {
      liveChatId: this.#liveChatId,
      part: ["id", "snippet", "authorDetails"],
      profileImageSize: 88,
      ...(this.#pageToken ? { pageToken: this.#pageToken } : {}),
    };

    await new Promise<void>((resolve, reject) => {
      let processing = Promise.resolve();
      const stream = client.StreamList(request, metadata);
      this.#activeStream = stream;

      stream.on("data", (data: GrpcLiveChatListResponse) => {
        if (data.nextPageToken) this.#pageToken = data.nextPageToken;

        for (const item of data.items ?? []) {
          const event = normalizeMessage(
            grpcToRestMessage(item),
            this.config.channelId,
          );
          if (!event) continue;

          // The initial server response contains recent chat history.
          if (
            isInitialConnection &&
            Date.parse(event.occurredAt) < Date.parse(this.#connectedAt)
          ) {
            continue;
          }
          processing = processing.then(() => this.onEvent(event));
        }
        if (data.offlineAt) {
          this.#liveChatId = null;
          this.#pageToken = null;
          stream.cancel();
        }
      });

      stream.on("error", (error: grpc.ServiceError) => {
        this.#activeStream = null;
        client.close();
        void processing.then(() => {
          if (
            this.#abortController.signal.aborted ||
            error.code === grpc.status.CANCELLED
          ) {
            resolve();
          } else {
            reject(error);
          }
        });
      });

      stream.on("end", () => {
        this.#activeStream = null;
        client.close();
        void processing.then(resolve, reject);
      });
    });
  }

  async #apiFetch(input: URL | string, init: RequestInit = {}): Promise<Response> {
    let token = await this.#getAccessToken();
    let response = await fetch(input, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${token}`,
      },
      signal: this.#abortController.signal,
    });

    if (response.status === 401) {
      this.#accessToken = null;
      token = await this.#getAccessToken();
      response = await fetch(input, {
        ...init,
        headers: {
          ...init.headers,
          authorization: `Bearer ${token}`,
        },
        signal: this.#abortController.signal,
      });
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(summarizeYouTubeApiError(response.status, body));
    }

    return response;
  }

  async #getAccessToken(): Promise<string> {
    if (this.#accessToken && this.#accessToken.expiresAt > Date.now() + 60_000) {
      return this.#accessToken.value;
    }

    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.config.refreshToken,
      grant_type: "refresh_token",
    });

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal: this.#abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`OAuth token refresh failed: ${await response.text()}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.#accessToken = {
      value: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1_000,
    };
    return this.#accessToken.value;
  }

}

export function summarizeYouTubeApiError(status: number, body: string): string {
  try {
    const data = JSON.parse(body) as {
      error?: {
        message?: string;
        errors?: Array<{ reason?: string }>;
      };
    };
    const message = data.error?.message?.trim();
    const reason = data.error?.errors?.[0]?.reason?.trim();
    if (message) {
      return `YouTube API ${status}: ${message}${reason ? ` (${reason})` : ""}`;
    }
  } catch {
    // Fall through to a compact plain-text response.
  }

  const compactBody = body.replace(/\s+/g, " ").trim().slice(0, 240);
  return `YouTube API ${status}${compactBody ? `: ${compactBody}` : ""}`;
}

export function buildLiveBroadcastsUrl(broadcastId?: string): URL {
  const url = new URL("https://www.googleapis.com/youtube/v3/liveBroadcasts");
  url.searchParams.set("part", "snippet,status");
  if (broadcastId) {
    url.searchParams.set("id", broadcastId);
  } else {
    // YouTube defines broadcastStatus, id, and mine as mutually exclusive filters.
    url.searchParams.set("broadcastStatus", "active");
    url.searchParams.set("broadcastType", "all");
    url.searchParams.set("maxResults", "50");
  }
  return url;
}

export function selectLiveChatId(
  data: LiveBroadcastListResponse,
  requireLiveStatus: boolean,
): string | null {
  const broadcast = data.items?.find((item) => {
    if (!item.snippet?.liveChatId) return false;
    return !requireLiveStatus || item.status?.lifeCycleStatus === "live";
  });
  return broadcast?.snippet?.liveChatId ?? null;
}

export function normalizeMessage(
  message: YouTubeLiveChatMessage,
  channelId: string,
): BotEvent | null {
  const id = message.id;
  const occurredAt = message.snippet?.publishedAt;
  if (!id || !occurredAt) return null;

  const user = normalizeUser(message);
  const type = message.snippet?.type;

  if (type === "textMessageEvent") {
    const event: TextMessageEvent = {
      id,
      channelId,
      platform: "youtube",
      kind: "text-message",
      occurredAt,
      user,
      message:
        message.snippet?.textMessageDetails?.messageText ??
        message.snippet?.displayMessage ??
        "",
    };
    return event;
  }

  if (type === "superChatEvent") {
    const details = message.snippet?.superChatDetails;
    return paidEvent(message, user, channelId, {
      id,
      occurredAt,
      message: details?.userComment ?? "",
      amountDisplay: details?.amountDisplayString ?? "Super Chat",
      amountMicros: Number(details?.amountMicros ?? 0),
      currency: details?.currency ?? "",
      paidKind: "super-chat",
    });
  }

  if (type === "superStickerEvent") {
    const details = message.snippet?.superStickerDetails;
    return paidEvent(message, user, channelId, {
      id,
      occurredAt,
      message: details?.superStickerMetadata?.altText ?? "Super Sticker",
      amountDisplay: details?.amountDisplayString ?? "Super Sticker",
      amountMicros: Number(details?.amountMicros ?? 0),
      currency: details?.currency ?? "",
      paidKind: "super-sticker",
    });
  }

  if (type === "newSponsorEvent" || type === "memberMilestoneChatEvent") {
    const milestone = message.snippet?.memberMilestoneChatDetails;
    const level =
      message.snippet?.newSponsorDetails?.memberLevelName ?? milestone?.memberLevelName;
    const monthText = milestone?.memberMonth
      ? `${milestone.memberMonth}-month member`
      : "New channel member";

    return paidEvent(message, user, channelId, {
      id,
      occurredAt,
      message: milestone?.userComment ?? level ?? monthText,
      amountDisplay: monthText,
      amountMicros: 0,
      currency: "",
      paidKind: "membership",
    });
  }

  return null;
}

function normalizeUser(message: YouTubeLiveChatMessage): ChatUser {
  const author = message.authorDetails;
  return {
    id: author?.channelId ?? `unknown:${message.id ?? "message"}`,
    displayName: author?.displayName ?? "YouTube viewer",
    role: youtubeRole(author),
    ...(author?.profileImageUrl ? { profileImageUrl: author.profileImageUrl } : {}),
  };
}

function youtubeRole(
  author: YouTubeLiveChatMessage["authorDetails"],
): UserRole {
  if (author?.isChatOwner) return "owner";
  if (author?.isChatModerator) return "moderator";
  if (author?.isChatSponsor) return "member";
  return "viewer";
}

function paidEvent(
  message: YouTubeLiveChatMessage,
  user: ChatUser,
  channelId: string,
  input: Omit<
    PaidMessageEvent,
    "kind" | "channelId" | "platform" | "user"
  >,
): PaidMessageEvent {
  return {
    ...input,
    kind: "paid-message",
    channelId,
    platform: "youtube",
    user,
    message: input.message || message.snippet?.displayMessage || "",
  };
}

function grpcToRestMessage(
  message: YouTubeLiveChatMessage,
): YouTubeLiveChatMessage {
  const snippet = message.snippet;
  if (!snippet?.type) return message;

  return {
    ...message,
    snippet: {
      ...snippet,
      type: grpcTypeToRestType(snippet.type),
    },
  };
}

function grpcTypeToRestType(type: string): string {
  const types: Record<string, string> = {
    TEXT_MESSAGE_EVENT: "textMessageEvent",
    SUPER_CHAT_EVENT: "superChatEvent",
    SUPER_STICKER_EVENT: "superStickerEvent",
    NEW_SPONSOR_EVENT: "newSponsorEvent",
    MEMBER_MILESTONE_CHAT_EVENT: "memberMilestoneChatEvent",
  };
  return types[type] ?? type;
}
