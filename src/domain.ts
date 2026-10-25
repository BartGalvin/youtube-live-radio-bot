export type Platform = "youtube" | "simulator";

export type UserRole = "viewer" | "member" | "moderator" | "owner";

export type ChannelId = string;

export interface ChatUser {
  id: string;
  displayName: string;
  role: UserRole;
  profileImageUrl?: string;
}

interface BaseEvent {
  id: string;
  channelId: ChannelId;
  platform: Platform;
  occurredAt: string;
  user: ChatUser;
}

export interface TextMessageEvent extends BaseEvent {
  kind: "text-message";
  message: string;
}

export interface PaidMessageEvent extends BaseEvent {
  kind: "paid-message";
  message: string;
  amountDisplay: string;
  amountMicros: number;
  currency: string;
  paidKind: "super-chat" | "super-sticker" | "membership";
}

export type BotEvent = TextMessageEvent | PaidMessageEvent;

export type VoteValue = "like" | "dislike";

export interface Track {
  id: string;
  channelId: ChannelId;
  artist: string;
  title: string;
  album?: string;
  artworkUrl?: string;
  startedAt: string;
  durationMs?: number;
}

export interface VoteCounts {
  likes: number;
  dislikes: number;
  total: number;
}

export interface OverlayState {
  channelId: ChannelId;
  track: Track | null;
  votes: VoteCounts;
}

export interface OverlayAlert {
  id: string;
  channelId: ChannelId;
  platform: Platform;
  displayName: string;
  message: string;
  amountDisplay: string;
  profileImageUrl?: string;
  durationMs: number;
}

export interface Activity {
  message: string;
  occurredAt: string;
}
