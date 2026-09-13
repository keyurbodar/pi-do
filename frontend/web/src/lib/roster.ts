// Roster domain: the sidebar's bots and groups. Fixtures back the
// UI until real sessions replace them; the swap point is loadRoster() only.
// Identity vocab (shapes, colors, expressions) mirrors the bloub engine
// catalogue in lib/bloub so a bot id deterministically yields its avatar.

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

export function loadRoster(): Roster {
  return SEED_ROSTER;
}

const minutesAgo = (m: number) => Date.now() - m * 60_000;

const SEED_ROSTER: Roster = {
  bots: [
    {
      id: "chief",
      name: "Chief",
      bloub: { shape: "cercle", color: "vert", expression: "fier" },
      preview: "booked the venue and sent the calendar hold",
      updatedAt: minutesAgo(60 * 26),
      presence: "idle",
      unread: 0,
      pinned: false,
      persona: "Decisive chief of staff who keeps the team unblocked.",
      instructions: "Confirm venue holds before sending calendar invites.",
      modelId: "default",
      avatarVariant: "bloub",
      identiconStyle: 0,
      voiceEnabled: false,
      memory: ["Prefers morning standups", "Q3 offsite in Lisbon"],
      sandbox: "readonly",
      toolOverrides: { slack: true, gcal: true },
      usageCap: 1000,
      channels: { slack: true, gmail: false, discord: false },
    },
    {
      id: "sales-outbound",
      name: "Sales Outbound",
      bloub: { shape: "galet", color: "orange", expression: "attentif" },
      preview: "Typing…",
      updatedAt: minutesAgo(0),
      presence: "typing",
      unread: 2,
      pinned: false,
    },
    {
      id: "inbox-manager",
      name: "Inbox Manager",
      bloub: { shape: "nuage", color: "violet", expression: "neutre" },
      preview: "sent. inbox at zero, 5 drafts parked",
      updatedAt: minutesAgo(180),
      presence: "idle",
      unread: 1,
      pinned: false,
    },
    {
      id: "account-manager",
      name: "Account Manager",
      bloub: { shape: "squircle", color: "bleu", expression: "curieux" },
      preview: "invite's out to vicky. globex note drafted",
      updatedAt: minutesAgo(300),
      presence: "idle",
      unread: 0,
      pinned: false,
    },
    {
      id: "talent-scout",
      name: "Talent Scout",
      bloub: { shape: "goutte", color: "turquoise", expression: "heureux" },
      preview: "3 intros drafted in your voice, ready to send",
      updatedAt: minutesAgo(360),
      presence: "idle",
      unread: 0,
      pinned: false,
    },
    {
      id: "expense-manager",
      name: "Expense Manager",
      bloub: { shape: "capsule", color: "rouge", expression: "blase" },
      preview: "report filed. 9 receipts, nothing outstanding",
      updatedAt: minutesAgo(420),
      presence: "sleeping",
      unread: 0,
      pinned: false,
    },
  ],
  groups: [
    {
      id: "offsite-crew",
      name: "Offsite crew",
      memberIds: ["chief", "account-manager", "talent-scout"],
      updatedAt: minutesAgo(355),
    },
  ],
};
