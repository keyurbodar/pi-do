// components/chat/fixtureScripts.ts — scripted demo conversations, one per
// seed bot in lib/roster.ts. Each exchange plays as two real-shaped turns:
// the prompt lands as its own done turn, then the bot turn streams
// thinking → tools → text exactly like a live run, so ThreadPane renders
// fixtures identically to real turns (streaming caret, activity row, tool
// rows flipping running→done). Tone per bot mirrors the seed previews.

export interface FixtureTool {
  tool: string;
  args: unknown;
  /** First line becomes the row detail once the call flips to done. */
  output: string;
}

export interface FixtureResponse {
  thinking?: { text: string; ms: number };
  tools?: FixtureTool[];
  text: string;
}

export interface FixtureExchange {
  prompt: string;
  response: FixtureResponse;
}

export type FixtureScript = FixtureExchange[];

export const FIXTURE_SCRIPTS: Record<string, FixtureScript> = {
  chief: [
    {
      prompt: "Where are we on the offsite?",
      response: {
        thinking: {
          text: "Pulling the offsite thread — venue, calendar holds, and who still hasn't confirmed travel.",
          ms: 2400,
        },
        tools: [
          { tool: "gcal.search", args: { query: "offsite", range: "30d" }, output: "3 events · offsite week" },
          { tool: "slack.search", args: { channel: "#offsite-crew" }, output: "14 messages · 2 open questions" },
        ],
        text: "Venue is booked — the loft on 9th, October 14–16. Calendar hold is out to the offsite crew. Two people haven't confirmed travel yet; I'll nudge them this afternoon.",
      },
    },
    {
      prompt: "Book the team dinner for the second night.",
      response: {
        tools: [
          { tool: "opentable.reserve", args: { party: 8, evening: "2026-10-15" }, output: "table for 8 · 7:30pm · Casa Luca" },
          { tool: "gcal.event.create", args: { title: "Team dinner", guests: 8 }, output: "sent · team dinner · oct 15" },
        ],
        text: "Done — table for 8 at Casa Luca, 7:30pm on the 15th. The invite is on the calendar with the loft address in the notes.",
      },
    },
    {
      prompt: "What's still unresolved before Friday?",
      response: {
        thinking: {
          text: "Cross-checking the action list against what's actually closed.",
          ms: 1600,
        },
        tools: [{ tool: "notion.query", args: { database: "offsite-actions" }, output: "9 items · 3 open" }],
        text: "Three things: travel confirmations from Ana and Cole, the AV setup at the loft, and printing the agenda. Everything else is closed. I can take the AV call if you want.",
      },
    },
  ],

  "sales-outbound": [
    {
      prompt: "Draft a follow-up for the Meridian thread.",
      response: {
        thinking: {
          text: "Meridian went quiet after the demo — pull the thread and the last-touch notes before drafting.",
          ms: 2100,
        },
        tools: [
          { tool: "salesforce.search", args: { account: "Meridian" }, output: "list pulled · 52 accounts" },
          { tool: "gmail.search", args: { from: "meridian.com" }, output: "last reply · 6 days ago" },
        ],
        text: "Drafted and parked in your outbox: a three-line nudge referencing their Q3 pipeline call, with the pricing one-pager attached. Want me to send it as-is?",
      },
    },
    {
      prompt: "Which accounts went cold this week?",
      response: {
        tools: [
          { tool: "salesforce.search", args: { stage: "engaged" }, output: "list pulled · 52 accounts" },
          { tool: "hex.query", args: { metric: "touch_recency", window: "14d" }, output: "11 accounts · no touch in 14d" },
        ],
        text: "Eleven accounts have had no touch in two weeks — Meridian is the biggest. I've queued a re-engagement sequence for the top four; the rest go into Friday's digest.",
      },
    },
  ],

  "inbox-manager": [
    {
      prompt: "Anything urgent in the inbox?",
      response: {
        thinking: {
          text: "scan flagged and unread, sort by sender priority",
          ms: 1400,
        },
        tools: [
          { tool: "gmail.search", args: { filter: "flagged" }, output: "4 threads · flagged" },
          { tool: "slack.search", args: { channel: "#exec" }, output: "2 pings · unread" },
        ],
        text: "two urgent threads: the vendor contract (legal is waiting) and a board reply. drafted both, parked for your ok. the rest is triaged.",
      },
    },
    {
      prompt: "Clear what you can.",
      response: {
        tools: [
          { tool: "gmail.send", args: { drafts: "approved" }, output: "5 sent · drafts cleared" },
          { tool: "notion.query", args: { database: "follow-ups" }, output: "3 follow-ups logged" },
        ],
        text: "sent. inbox at zero, 5 drafts parked. 3 follow-ups logged for next week.",
      },
    },
  ],

  "account-manager": [
    {
      prompt: "What's the latest with Globex?",
      response: {
        tools: [
          { tool: "salesforce.search", args: { account: "Globex" }, output: "1 account · renewal oct 1" },
          { tool: "hex.query", args: { metric: "usage_trend", window: "90d" }, output: "+12% · quarter over quarter" },
        ],
        text: "renewal lands oct 1 and usage is up 12% quarter over quarter. invite's out to vicky for the qbr. globex note drafted — want to review before it goes?",
      },
    },
    {
      prompt: "Send the note.",
      response: {
        tools: [
          { tool: "gmail.send", args: { to: "vicky@globex.com" }, output: "sent · globex note" },
          { tool: "salesforce.task.create", args: { subject: "qbr prep" }, output: "due fri · owner: you" },
        ],
        text: "sent. also set a friday reminder for qbr prep so the deck isn't last-minute.",
      },
    },
  ],

  "talent-scout": [
    {
      prompt: "Find backend engineers in Lisbon.",
      response: {
        thinking: {
          text: "Cross-referencing the hiring bar with people who've replied before — warm intros convert.",
          ms: 1900,
        },
        tools: [
          { tool: "linkedin.search", args: { role: "backend", location: "Lisbon" }, output: "38 profiles · lisbon" },
          { tool: "hex.query", args: { metric: "warm_contacts" }, output: "9 warm contacts" },
        ],
        text: "38 profiles match — 9 are warm from past threads. 3 intros drafted in your voice, ready to send. The strongest is a staff engineer leaving a fintech next month.",
      },
    },
    {
      prompt: "Send the top intro.",
      response: {
        tools: [
          { tool: "gmail.send", args: { template: "intro" }, output: "1 sent · intro email" },
          { tool: "notion.query", args: { database: "pipeline" }, output: "pipeline updated · 4 candidates" },
        ],
        text: "Sent, with a note about the Lisbon hub. Pipeline updated — 4 candidates now at the top of the funnel.",
      },
    },
  ],

  "expense-manager": [
    {
      prompt: "How's the expense report looking?",
      response: {
        tools: [
          { tool: "ramp.query", args: { month: "september" }, output: "9 receipts · unmatched: 0" },
          { tool: "hex.query", args: { metric: "spend", window: "30d" }, output: "$1,842 · september" },
        ],
        text: "report filed. 9 receipts, nothing outstanding. $1,842 for september, under budget by $210. remarkably little to complain about.",
      },
    },
    {
      prompt: "Flag anything weird.",
      response: {
        tools: [{ tool: "ramp.query", args: { anomaly: "duplicates" }, output: "1 flag · duplicate taxi" }],
        text: "one duplicate taxi charge on the 4th — flagged and disputed. that's the only surprise. everything else is exactly as boring as it should be.",
      },
    },
  ],
};
