// Roster domain: the sidebar's bots and groups. Server sessions are the
// truth for a bot's existence, name, and backstory; everything else lives in
// the client overlay (useRosterState). Identity vocab (shapes, colors,
// expressions) mirrors the bloub engine catalogue in lib/bloub so a bot id
// deterministically yields its avatar.

export type BloubShape =
  | "cercle"
  | "galet"
  | "squircle"
  | "capsule"
  | "triangle"
  | "hexagone"
  | "nuage"
  | "goutte";

export type BloubColor =
  | "encre"
  | "brun"
  | "rouge"
  | "orange"
  | "ambre"
  | "vert"
  | "turquoise"
  | "bleu"
  | "violet"
  | "rose"
  | "gris"
  | "creme";

export type BloubExpression =
  | "neutre"
  | "attentif"
  | "surpris"
  | "excite"
  | "heureux"
  | "hilare"
  | "colere"
  | "triste"
  | "effraye"
  | "mefiant"
  | "confus"
  | "curieux"
  | "fier"
  | "timide"
  | "blase"
  | "somnolent";

export type BotPresence = "idle" | "typing" | "working" | "sleeping";

export interface BloubIdentity {
  shape: BloubShape;
  color: BloubColor;
  expression: BloubExpression;
}

export type BotAvatarVariant = "bloub" | "upload" | "identicon";

export type BotModelId = "default" | "claude-opus" | "gpt-5" | "grok-4";

export type BotSandbox = "none" | "readonly" | "full";

export type BotToolId = "salesforce" | "gmail" | "slack" | "hex" | "notion" | "gcal";

export type ChannelProviderId = "slack" | "gmail" | "discord";

export const BOT_MODELS: readonly BotModelId[] = ["default", "claude-opus", "gpt-5", "grok-4"];

export const BOT_TOOLS: readonly BotToolId[] = ["salesforce", "gmail", "slack", "hex", "notion", "gcal"];

export const CHANNEL_PROVIDERS: readonly ChannelProviderId[] = ["slack", "gmail", "discord"];

export const BOT_SANDBOXES: readonly BotSandbox[] = ["none", "readonly", "full"];

export interface RosterBot {
  id: string;
  name: string;
  bloub: BloubIdentity;
  /** Last message preview shown under the name in the sidebar. */
  preview: string;
  /** Epoch ms of the last activity; the sidebar renders relative ("10:17 AM", "Yesterday"). */
  updatedAt: number;
  presence: BotPresence;
  unread: number;
  pinned: boolean;
  /** Free-form persona blurb authored in the new-bot dialog. */
  persona?: string;
  /** System instructions authored in the new-bot dialog. */
  instructions?: string;
  /** Model backing the bot; plain string ids until a real model picker lands. */
  modelId?: BotModelId;
  /** Which avatar source the row renders. Defaults to "bloub". */
  avatarVariant?: BotAvatarVariant;
  /** Uploaded avatar stored as a data URL (rejected above 200KB at author time). */
  avatarImage?: string;
  /** Identicon style variant (0-2) when avatarVariant is "identicon". */
  identiconStyle?: number;
  voiceEnabled?: boolean;
  /** Fixture-local memory entries. */
  memory?: string[];
  sandbox?: BotSandbox;
  /** Per-tool enable overrides; absent means enabled. */
  toolOverrides?: Partial<Record<BotToolId, boolean>>;
  /** Monthly token/step cap; 0 or absent means uncapped. */
  usageCap?: number;
  /** Per-provider channel connection state; true means connected. */
  channels?: Partial<Record<ChannelProviderId, boolean>>;
}

export interface RosterGroup {
  id: string;
  name: string;
  memberIds: string[];
  /** Epoch ms of the last activity; keeps group rows aligned with bot rows. */
  updatedAt: number;
}

export interface Roster {
  bots: RosterBot[];
  groups: RosterGroup[];
}

