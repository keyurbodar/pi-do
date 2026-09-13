import { useEffect, useMemo, useState } from 'react';
import { PromptInput } from './components/prompt-input';
import { Thread, useThread, type SessionRef } from './components/thread';
import { Shimmer } from './components/aicss';
import { BotRosterSidebar, useRosterState } from './components/roster';
import { bootstrapSession, fetchKeyedProviders, type SessionHandle } from './lib/session';

type BootState =
  | { status: 'loading' }
  | { status: 'unkeyed' }
  | { status: 'error'; message: string }
  | { status: 'ready'; session: SessionHandle };

const UNKEYED_MESSAGE =
  'No model provider key is set on the backend, so turns cannot run. ' +
  'Set a provider key as a Worker secret (for example ANTHROPIC_API_KEY), redeploy, then reload.';

export default function App() {
  const roster = useRosterState();
  const [boot, setBoot] = useState<BootState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const keyed = await fetchKeyedProviders();
        if (cancelled) return;
        if (keyed.length === 0) {
          setBoot({ status: "unkeyed" });
          return;
        }
        // Fresh session every load: no stored handle, no stale history.
        const session = await bootstrapSession();
        setBoot({ status: "ready", session });
      } catch (e) {
        if (cancelled) return;
        setBoot({ status: "error", message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeName = useMemo(() => {
    if (roster.activeId === null) return null;
    const bot = roster.bots.find((candidate) => candidate.id === roster.activeId);
    if (bot !== undefined) return bot.name;
    return roster.groups.find((group) => group.id === roster.activeId)?.name ?? null;
  }, [roster.activeId, roster.bots, roster.groups]);

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <BotRosterSidebar api={roster} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
          <span className="truncate text-sm font-semibold text-foreground">
            {activeName ?? 'pi-do'}
          </span>
        </header>
        <ChatPane boot={boot} />
      </div>
    </div>
  );
}

function ChatPane({ boot }: { boot: BootState }) {
  if (boot.status === 'loading') {
    return (
      <main className="main">
        <div className="thread">
          <p style={{ color: 'var(--muted-foreground)' }}><Shimmer>Connecting…</Shimmer></p>
        </div>
      </main>
    );
  }

  if (boot.status === 'unkeyed' || boot.status === 'error') {
    return (
      <main className="main">
        <div className="thread" role="alert">
          <p style={{ color: 'var(--destructive)' }}>
            {boot.status === 'unkeyed' ? UNKEYED_MESSAGE : boot.message}
          </p>
        </div>
      </main>
    );
  }

  return <ReadyThread key={boot.session.sessionId} session={boot.session} />;
}

function ReadyThread({ session }: { session: SessionRef }) {
  const thread = useThread(session);
  return (
    <main className="main">
      <div className="thread">
        <Thread turns={thread.turns} pending={thread.pending} conn={thread.conn} onRetry={thread.send} />
      </div>
      <footer className="composer-footer">
        <div className="composer">
          <PromptInput onSubmit={thread.send} running={thread.running} onAbort={thread.abort} />
        </div>
      </footer>
    </main>
  );
}
