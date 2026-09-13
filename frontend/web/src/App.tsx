import { useEffect, useMemo, useState } from 'react';
import { PromptInput } from './components/prompt-input';
import { ChatHeader, ThreadPane, buildTranscript, useFixturePlayback } from './components/chat';
import { useThread, type SessionRef, type TurnViewState } from './components/thread';
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

  const activeGroup = useMemo(() => {
    if (activeBot !== null || roster.activeId === null) return null;
    return roster.groups.find((group) => group.id === roster.activeId) ?? null;
  }, [activeBot, roster.activeId, roster.groups]);
  const presenceText = useMemo(() => {
    if (activeBot !== null) return PRESENCE_TEXT[activeBot.presence];
    if (activeGroup !== null) return `Group · ${activeGroup.memberIds.length} members`;
    return 'pi-do';
  }, [activeBot, activeGroup]);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const onDone = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    };
    window.addEventListener('pi-do:copy-transcript-done', onDone);
    return () => window.removeEventListener('pi-do:copy-transcript-done', onDone);
  }, []);

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <BotRosterSidebar api={roster} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
          <ChatHeader
            name={activeName ?? 'pi-do'}
            presenceText={presenceText}
            avatar={activeBot !== null
              ? <BotAvatar identity={activeBot.bloub} presence={activeBot.presence} size={22} />
              : null}
            copied={copied}
            onScrollBottom={() => window.dispatchEvent(new CustomEvent('pi-do:scroll-bottom'))}
            onCopyTranscript={() => window.dispatchEvent(new CustomEvent('pi-do:copy-transcript'))}
            onNewTurn={() => window.dispatchEvent(new CustomEvent('pi-do:new-turn'))}
          />
        </header>
        <ChatPane boot={boot} activeBot={activeBot} activeId={roster.activeId} bots={roster.bots} onActivity={roster.setActivity} />
      </div>
    </div>
  );
}

const PRESENCE_TEXT: Record<RosterBot['presence'], string> = {
  idle: 'Idle',
  typing: 'Typing…',
  working: 'Working…',
  sleeping: 'Away',
};

function ChatPane({
  boot,
  activeBot,
  activeId,
  bots,
  onActivity,
}: {
  boot: BootState;
  activeBot: RosterBot | null;
  activeId: string | null;
  bots: RosterBot[];
  onActivity: (id: string, preview: string, presence: RosterBot["presence"]) => void;
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

  return <ReadyThread key={activeId} ownerId={activeId} activeBot={activeBot} bots={bots} onActivity={onActivity} />;
}

function ReadyThread({ ownerId, activeBot, bots, onActivity }: {
  ownerId: string;
  activeBot: RosterBot | null;
  bots: RosterBot[];
  onActivity: (id: string, preview: string, presence: RosterBot["presence"]) => void;
}) {
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
  return <ReadyThreadInner key={session.sessionId} session={session} ownerId={ownerId} activeBot={activeBot} bots={bots} onActivity={onActivity} />;
}
function ReadyThreadInner({ session, ownerId, activeBot, bots, onActivity }: {
  session: SessionRef;
  ownerId: string;
  activeBot: RosterBot | null;
  bots: RosterBot[];
  onActivity: (id: string, preview: string, presence: RosterBot["presence"]) => void;
}) {
  const thread = useThread(session);
  const playback = useFixturePlayback(activeBot?.id ?? ownerId);
  const lastTurn = thread.turns[thread.turns.length - 1] ?? null;
  const preview = lastTurn === null ? null : lastTurnPreview(lastTurn);
  useEffect(() => {
    if (activeBot === null || preview === null) return;
    onActivity(activeBot.id, preview, thread.running ? "typing" : "idle");
  }, [activeBot, preview, thread.running, onActivity]);
  // Header "new turn" clears the live turns view locally (fixtures stay);
  // the next send brings the live view back.
  const [hideLive, setHideLive] = useState(false);
  // Composer remount key: edit actions write the draft then bump this so
  // PromptInput re-reads it (its draft store lives in localStorage).
  const [composerKey, setComposerKey] = useState(0);
  const liveTurns = hideLive ? [] : thread.turns;
  useEffect(() => {
    const onNewTurn = () => setHideLive(true);
    const onCopy = () => {
      const text = buildTranscript([...playback.turns, ...thread.turns]);
      const done = () => window.dispatchEvent(new CustomEvent('pi-do:copy-transcript-done'));
      if (text.length === 0) {
        done();
        return;
      }
      const clipboard = navigator.clipboard;
      if (clipboard !== undefined) {
        clipboard.writeText(text).then(done, done);
      } else {
        done();
      }
    };
    window.addEventListener('pi-do:new-turn', onNewTurn);
    window.addEventListener('pi-do:copy-transcript', onCopy);
    return () => {
      window.removeEventListener('pi-do:new-turn', onNewTurn);
      window.removeEventListener('pi-do:copy-transcript', onCopy);
    };
  }, [playback.turns, thread.turns]);
  const send = (prompt: string) => {
    setHideLive(false);
    thread.send(prompt);
  };
  const editInComposer = (text: string) => {
    try {
      globalThis.localStorage.setItem('pidof-draft-default', text.slice(0, 20_000));
    } catch {
      // Quota or private mode: remount still focuses the composer.
    }
    setComposerKey((key) => key + 1);
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-testid="composer-input"]')?.focus();
    });
  };
  return (
    <main className="main">
      <div className="thread">
        <ThreadPane
          turns={[...playback.turns, ...liveTurns]}
          pending={thread.pending}
          conn={thread.conn}
          playing={playback.playing}
          onRetry={send}
          onEdit={editInComposer}
          bots={bots}
          /* Resting face only: ThreadPane shows this slot beside the working dots,
             and a typing/live presence would collapse the engine into dot-state. */
          avatarSlot={activeBot
            ? <BotAvatar identity={activeBot.bloub} presence="idle" size={36} />
            : null}
        />
      </div>
      <footer className="composer-footer" style={{ padding: "12px 24px 16px" }}>
        {/* Full-width bar matching the thread column gutters above. */}
        <div className="composer" style={{ maxWidth: "none", margin: "0" }}>
          <PromptInput key={composerKey} onSubmit={send} running={thread.running} onAbort={thread.abort} botName={activeBot?.name ?? 'the group'} />
        </div>
      </footer>
    </main>
  );
}

function lastTurnPreview(turn: TurnViewState): string | null {
  const botPart = [...turn.parts].reverse().find((part) => part.type === "text");
  const text = (botPart !== undefined && "text" in botPart ? botPart.text : turn.prompt).trim();
  return text.length > 0 ? text.slice(0, 140) : null;
}
