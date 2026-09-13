// Roster domain: the sidebar's bots, groups, and sections. Fixtures back the
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
}

export interface RosterGroup {
  id: string;
  name: string;
  memberIds: string[];
}

export interface RosterSection {
  id: string;
  name: string;
  /** Ordered ids of bots and groups nested under this section. */
  childIds: string[];
}

export interface Roster {
  bots: RosterBot[];
  groups: RosterGroup[];
  sections: RosterSection[];
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
    },
  ],
  sections: [],
};
