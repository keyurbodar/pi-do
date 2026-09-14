// components/chat/GroupPane.tsx — crew chat over the groups routes. The
// thread log is GET /workspaces/:id/groups/messages polled while the pane is
// open (no WS exists for group threads); the composer POSTs {from:"user"}.
// Fan-out writes one inbox row per member, so adjacent rows sharing a
// requestId base collapse into one bubble whose deliveredAt set is the
// per-member ack state.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ensureWorkspace } from "../../lib/session";
import { groupMessages, sendGroupMessage, type GroupMessage } from "../../lib/groups";
import type { RosterBot, RosterGroup } from "../../lib/roster";
import { PromptInput } from "../prompt-input";
import { BotAvatar } from "../roster";
import { Shimmer } from "../aicss";
import { MessageBubble } from "./MessageBubble";

const POLL_MS = 3000;

/** One rendered row: a logical message plus its per-member ack counts. */
interface GroupLogEntry {
  key: string;
  id: string;
  from: string;
  body: string;
  createdAt: string;
  delivered: number;
  total: number;
}

/** Fan-out rows carry requestId "<base>:<member sid>"; rows without a
 * requestId (bot tool sends) collapse on adjacent identical from+to+body. */
function clusterMessages(rows: GroupMessage[]): GroupLogEntry[] {
  const entries: GroupLogEntry[] = [];
  for (const row of rows) {
    const base =
      row.requestId !== null && row.requestId.endsWith(`:${row.to}`)
        ? row.requestId.slice(0, -(row.to.length + 1))
        : row.requestId;
    const key = base !== null ? `req:${base}` : `msg:${row.from}::${row.to}::${row.body}`;
    const last = entries[entries.length - 1];
    if (last !== undefined && last.key === key) {
      last.total += 1;
      if (row.deliveredAt !== null) last.delivered += 1;
      continue;
    }
    entries.push({
      key,
      id: row.id,
      from: row.from,
      body: row.body,
      createdAt: row.createdAt,
      delivered: row.deliveredAt === null ? 0 : 1,
      total: 1,
    });
  }
  return entries;
}

const openImageNoop = () => {};

export function GroupPane({ group, bots }: { group: RosterGroup; bots: RosterBot[] }) {
  const [messages, setMessages] = useState<GroupMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const mounted = useRef(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    inFlight.current = true;
    ensureWorkspace()
      .then((ws) => groupMessages(ws, group.id))
      .then(
        (rows) => {
          if (!mounted.current) return;
          setMessages(rows);
          setError(null);
        },
        (e: unknown) => {
          if (!mounted.current) return;
          setError(e instanceof Error ? e.message : String(e));
        },
      )
      .finally(() => {
        inFlight.current = false;
      });
  }, [group.id]);

  useEffect(() => {
    refresh();
    // Poll ticks skip while a fetch is in flight or the tab is hidden;
    // send-triggered refreshes always run so the new row lands at once.
    const timer = window.setInterval(() => {
      if (inFlight.current || document.visibilityState !== "visible") return;
      refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const entries = useMemo(() => clusterMessages(messages ?? []), [messages]);
  const botBySid = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const send = useCallback(
    (text: string) => {
      const body = text.trim();
      if (body.length === 0 || sending) return;
      setSending(true);
      ensureWorkspace()
        .then((ws) =>
          sendGroupMessage(ws, group.id, { from: "user", body, requestId: crypto.randomUUID() }),
        )
        .then(() => refresh())
        .catch((e: unknown) => {
          if (mounted.current) setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (mounted.current) setSending(false);
        });
    },
    [group.id, refresh, sending],
  );

  return (
    <main className="main">
      <div className="thread">
        {messages === null && error === null ? (
          <p style={{ color: "var(--muted-foreground)" }}>
            <Shimmer>Loading…</Shimmer>
          </p>
        ) : messages === null ? (
          <p role="alert" style={{ color: "var(--destructive)" }}>
            {error}
          </p>
        ) : entries.length === 0 ? (
          <p style={{ color: "var(--muted-foreground)" }}>
            No messages yet — say hello to the crew.
          </p>
        ) : (
          <div
            ref={scrollRef}
            data-testid="group-thread"
            className="min-h-0 flex-1 overflow-y-auto px-6 py-4"
            onScroll={(event) => {
              const el = event.currentTarget;
              atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
          >
            <div className="mx-auto flex max-w-3xl flex-col gap-3">
              {entries.map((entry) => {
                const ts = Date.parse(entry.createdAt);
                const vm = {
                  id: entry.id,
                  role: entry.from === "user" ? ("user" as const) : ("bot" as const),
                  text: entry.body,
                  attachments: [],
                  ts: Number.isNaN(ts) ? null : ts,
                };
                if (entry.from === "user") {
                  return (
                    <div key={entry.id} className="flex flex-col items-end">
                      <MessageBubble vm={vm} bots={bots} onOpenImage={openImageNoop} />
                      <span
                        data-testid={`group-ack-${entry.id}`}
                        className="px-1 pt-0.5 text-[11px] text-muted-foreground"
                      >
                        {entry.delivered === entry.total
                          ? `Delivered to ${entry.total}`
                          : `Delivered to ${entry.delivered} of ${entry.total}`}
                      </span>
                    </div>
                  );
                }
                const bot = botBySid.get(entry.from);
                return (
                  <div key={entry.id} className="flex items-start gap-2.5">
                    <span className="mt-4 flex size-7 shrink-0 items-center justify-center">
                      {bot !== undefined ? (
                        <BotAvatar identity={bot.bloub} size={28} />
                      ) : (
                        <span className="flex size-7 items-center justify-center rounded-full bg-accent text-[10px] font-medium text-muted-foreground">
                          {entry.from.slice(0, 1).toUpperCase()}
                        </span>
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <MessageBubble
                        vm={vm}
                        senderLabel={bot?.name ?? entry.from}
                        bots={bots}
                        onOpenImage={openImageNoop}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      <footer className="composer-footer" style={{ padding: "12px 24px 16px" }}>
        <div className="composer" style={{ maxWidth: "none", margin: "0", width: "100%" }}>
          <PromptInput
            onSubmit={send}
            running={sending}
            botName={group.name}
            draftKey={`group-${group.id}`}
          />
        </div>
      </footer>
    </main>
  );
}
