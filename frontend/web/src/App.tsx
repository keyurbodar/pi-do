import { useEffect, useState } from 'react';
import { PromptInput } from './components/prompt-input';
import { Thread, useThread, type SessionRef } from './components/thread';
import { Shimmer } from './components/aicss';
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

  if (boot.status === 'loading') {
    return (
      <div className="shell">
        <div className="gutter" aria-hidden="true" />
        <main className="main stage">
          <div className="thread">
            <p style={{ color: 'var(--muted-foreground)' }}><Shimmer>Connecting…</Shimmer></p>
          </div>
        </main>
        <div className="gutter" aria-hidden="true" />
      </div>
    );
  }

  if (boot.status === 'unkeyed' || boot.status === 'error') {
    return (
      <div className="shell">
        <div className="gutter" aria-hidden="true" />
        <main className="main stage">
          <div className="thread" role="alert">
            <p style={{ color: 'var(--destructive)' }}>
              {boot.status === 'unkeyed' ? UNKEYED_MESSAGE : boot.message}
            </p>
          </div>
        </main>
        <div className="gutter" aria-hidden="true" />
      </div>
    );
  }

  return <ReadyThread key={boot.session.sessionId} session={boot.session} />;
}

function ReadyThread({ session }: { session: SessionRef }) {
  const thread = useThread(session);
  return (
    <div className="shell">
      <div className="gutter" aria-hidden="true" />
      <main className="main stage">
        <div className="thread">
          <Thread turns={thread.turns} pending={thread.pending} conn={thread.conn} onRetry={thread.send} />
        </div>
        <footer className="composer-footer">
          <div className="composer">
            <PromptInput onSubmit={thread.send} running={thread.running} onAbort={thread.abort} />
          </div>
        </footer>
      </main>
      <div className="gutter" aria-hidden="true" />
    </div>
  );
}
