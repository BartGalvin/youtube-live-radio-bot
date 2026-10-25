import type { UserRole, VoteValue } from "./domain.js";

export type ParsedCommand =
  | { kind: "help" }
  | { kind: "song" }
  | { kind: "votes" }
  | { kind: "vote"; vote: VoteValue };

const roleRank: Record<UserRole, number> = {
  viewer: 0,
  member: 1,
  moderator: 2,
  owner: 3,
};

export function parseCommand(message: string): ParsedCommand | null {
  const [firstToken] = message.trim().toLowerCase().split(/\s+/, 1);

  switch (firstToken) {
    case "!help":
      return { kind: "help" };
    case "!song":
      return { kind: "song" };
    case "!votes":
      return { kind: "votes" };
    case "!like":
      return { kind: "vote", vote: "like" };
    case "!dislike":
      return { kind: "vote", vote: "dislike" };
    default:
      return null;
  }
}

export function hasMinimumRole(actual: UserRole, minimum: UserRole): boolean {
  return roleRank[actual] >= roleRank[minimum];
}
