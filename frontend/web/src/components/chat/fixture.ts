// components/chat/fixture.ts — temporary fixture turns so ThreadPane can be
// rendered (and verify-driven) without a live worker session. The mapper
// stays pure; this file is demo-only and deleted when the shell wires the
// real useThread data through.
import type { TurnViewState } from "../thread/types";

const now = Date.now();

export const FIXTURE_TURNS: TurnViewState[] = [
  {
    runId: "fixture-1",
    prompt: "Pull the account list from Salesforce and draft a follow-up for the stale ones.",
    parts: [
      { type: "thinking", text: "The user wants a stale-account sweep. I should list accounts first, then filter by last activity.", ms: 4200 },
      { type: "tools", ids: ["f1c1", "f1c2"] },
      { type: "text", text: "Pulled **52 accounts** from Salesforce — 7 went stale past 30 days. Drafts are queued for review in the outreach queue." },
    ],
    startedAt: now - 90_000,
    endedAt: now - 61_000,
    steers: [],
    calls: [
      { id: "f1c1", tool: "salesforce", args: { object: "Account" }, output: "list pulled · 52 accounts", done: true },
      { id: "f1c2", tool: "outreach", args: { queue: "stale" }, output: "7 drafts queued for review", done: true },
    ],
    status: "done",
    error: null,
    halt: null,
    hint: null,
    keyless: false,
    live: false,
  },
  {
    runId: "fixture-2",
    prompt: "Now summarize the top three by revenue.",
    parts: [
      { type: "tools", ids: ["f2c1"] },
    ],
    startedAt: now - 12_000,
    endedAt: null,
    steers: [],
    calls: [
      { id: "f2c1", tool: "salesforce", args: { object: "Account", sort: "arr" }, output: null, done: false },
    ],
    status: "streaming",
    error: null,
    halt: null,
    hint: null,
    keyless: false,
    live: true,
  },
  {
    runId: "fixture-3",
    prompt: "Export the stale list as CSV.",
    parts: [{ type: "text", text: "Starting the export…" }],
    startedAt: now - 200_000,
    endedAt: now - 190_000,
    steers: [],
    calls: [],
    status: "error",
    error: "Provider request failed: 429 rate limited",
    halt: null,
    hint: null,
    keyless: false,
    live: true,
  },
];
