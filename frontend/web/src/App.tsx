import { useEffect, useMemo, useState } from 'react';
import { PromptInput } from './components/prompt-input';
import { ThreadPane, useFixturePlayback } from './components/chat';
import { useThread, type SessionRef } from './components/thread';
import { BotAvatar } from './components/roster';
import type { RosterBot } from './lib/roster';
import { Shimmer } from './components/aicss';
import { BotRosterSidebar, useRosterState } from './components/roster';
import { fetchKeyedProviders, sessionForOwner, type SessionHandle } from './lib/session';

type BootState =
  | { status: 'loading' }
  | { status: 'unkeyed' }
  | { status: 'error'; message: string }
  | { status: 'ready' };

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
        setBoot({ status: "ready" });
      } catch (e) {
        if (cancelled) return;
        setBoot({ status: "error", message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeBot = useMemo(() => {
    if (roster.activeId === null) return null;
    return roster.bots.find((candidate) => candidate.id === roster.activeId) ?? null;
  }, [roster.activeId, roster.bots]);
  const activeName = useMemo(() => {
    if (activeBot !== null) return activeBot.name;
    return roster.groups.find((group) => group.id === roster.activeId)?.name ?? null;
  }, [activeBot, roster.activeId, roster.groups]);

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <BotRosterSidebar api={roster} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
          {activeBot !== null ? (
            <span data-testid="header-avatar" className="flex shrink-0 items-center">
              <BotAvatar identity={activeBot.bloub} presence={activeBot.presence} size={22} />
            </span>
          ) : null}
          <span className="truncate text-sm font-semibold text-foreground">
            {activeName ?? 'pi-do'}
          </span>
        </header>
        <ChatPane boot={boot} activeBot={activeBot} activeId={roster.activeId} />
      </div>
    </div>
  );
}

function ChatPane({
  boot,
  activeBot,
  activeId,
}: {
  boot: BootState;
  activeBot: RosterBot | null;
  activeId: string | null;
}) {
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

  if (activeId === null) {
    return (
      <main className="main">
        <div
          data-testid="empty-state-no-bot"
          className="flex flex-1 flex-col items-center justify-center gap-4"
        >
          <BotAvatar
            identity={{ shape: 'cercle', color: 'encre', expression: 'neutre' }}
            size={96}
          />
          <p className="text-sm text-muted-foreground">Pick a bot to start chatting</p>
        </div>
      </main>
    );
  }

  return <ReadyThread key={activeId} ownerId={activeId} activeBot={activeBot} />;
}

function ReadyThread({ ownerId, activeBot }: { ownerId: string; activeBot: RosterBot | null }) {
  const [session, setSession] = useState<SessionHandle | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSession(null);
    setError(null);
    sessionForOwner(ownerId).then(
      (s) => { if (!cancelled) setSession(s); },
      (e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { cancelled = true; };
  }, [ownerId]);
  if (error !== null) {
    return (
      <main className="main">
        <div className="thread" role="alert">
          <p style={{ color: 'var(--destructive)' }}>{error}</p>
        </div>
      </main>
    );
  }
  if (session === null) {
    return (
      <main className="main">
        <div className="thread">
          <p style={{ color: 'var(--muted-foreground)' }}><Shimmer>Connecting…</Shimmer></p>
        </div>
      </main>
    );
  }
  return <ReadyThreadInner key={session.sessionId} session={session} activeBot={activeBot} />;
}
function ReadyThreadInner({ session, activeBot }: { session: SessionRef; activeBot: RosterBot | null }) {
  const thread = useThread(session);
  const playback = useFixturePlayback(activeBot?.id ?? null);
  return (
    <main className="main">
      <div className="thread">
        <ThreadPane
          turns={[...playback.turns, ...thread.turns]}
          pending={thread.pending}
          conn={thread.conn}
          playing={playback.playing}
          onRetry={thread.send}
          avatarSlot={activeBot
            ? <BotAvatar identity={activeBot.bloub} presence={activeBot.presence} size={36} />
            : null}
        />
      </div>
      <footer className="composer-footer">
        <div className="composer">
          <PromptInput onSubmit={thread.send} running={thread.running} onAbort={thread.abort} botName={activeBot?.name ?? 'the group'} />
        </div>
      </footer>
    </main>
  );
}
