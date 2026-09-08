// TurnView — one agent turn: user row, streaming thinking (collapses on
// done), tool chips, streaming text, then the terminal state. Steer notes
// render inline; error/interrupted turns offer Retry of the same prompt.
//
// Shell follows the blocks Message + MessageContent pattern
// (refs/blocks/components/ai-elements/message.tsx): Message is the
// from=user|assistant row wrapper, MessageContent is the inner column.
// Composition only — same children, same order, zero behavior change.
import { ThinkingReasoning, ThinkingState } from "../aicss";
import { ToolChips } from "../bui";
import { StreamText } from "./StreamText";
import { TurnError } from "./TurnError";
import { UserRow } from "./UserRow";
import type { TurnViewState } from "./types";
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import styles from "./TurnView.module.css";

// WorkingTimer — port of t3-web MessagesTimeline WorkingTimer: a self-ticking
// elapsed label that mutates its own text node each second, so streaming
// updates don't re-render the component tree every second.
function WorkingTimer({ createdAt }: { createdAt: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const update = () => {
      if (ref.current) {
        ref.current.textContent = `${Math.max(0, Math.floor((Date.now() - createdAt) / 1000))}s`;
      }
    };
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [createdAt]);
  return (
    <span ref={ref} className={styles.tabular}>
      0s
    </span>
  );
}

type MessageFrom = "user" | "assistant";

function Message({ from, children }: { from: MessageFrom; children: ReactNode }) {
  return (
    <div
      data-slot="message"
      data-role={from}
      className={from === "user" ? styles.messageUser : styles.messageAssistant}
    >
      {children}
    </div>
  );
}

function MessageContent({ children }: { children: ReactNode }) {
  return (
    <div data-slot="message-content" className={styles.messageContent}>
      {children}
    </div>
  );
}

function AgentContent({ turn }: { turn: TurnViewState }) {
  const streaming = turn.status === "streaming";
  // T3 turn-fold: a settled turn folds everything before its terminal text
  // (thinking + tool calls) behind the fold row; the final text stays
  // visible. Streaming turns never fold; error turns stay open so the
  // failure context is visible. Mount-folded, so a live turn collapses
  // itself the moment it settles with no remount.
  const foldable = turn.status === "done" || turn.status === "interrupted";
  const [unfolded, setUnfolded] = useState(false);
  const folded = foldable && !unfolded;
  let lastTextIndex = -1;
  turn.parts.forEach((part, i) => {
    if (part.type === "text") lastTextIndex = i;
  });
  const hasFoldContent = turn.parts.some((part) => part.type !== "text");
  const elapsed =
    turn.startedAt !== null && turn.endedAt !== null
      ? Math.max(1, Math.round((turn.endedAt - turn.startedAt) / 1000))
      : null;
  const foldLabel =
    turn.status === "interrupted"
      ? elapsed !== null
        ? `You stopped after ${elapsed}s`
        : "You stopped this response"
      : elapsed !== null
        ? `Worked for ${elapsed}s`
        : "Worked";
  return (
    <>
      {/* t3-web WorkingTimelineRow: live status on top, hairline under. */}
      {streaming && (
        <p className={styles.workingRow}>
          {turn.startedAt !== null ? (
            <>
              Working for <WorkingTimer createdAt={turn.startedAt} />
            </>
          ) : (
            <ThinkingState label="Working" />
          )}
        </p>
      )}
      {!streaming && foldable && hasFoldContent && (
        <button
          type="button"
          className={styles.foldRow}
          aria-expanded={unfolded}
          aria-label="Toggle turn details"
          onClick={() => setUnfolded((v) => !v)}
        >
          <span>{foldLabel}</span>
          <ChevronDown
            size={12}
            aria-hidden="true"
            className={unfolded ? styles.foldChevronOpen : styles.foldChevron}
          />
        </button>
      )}
      {!streaming && !hasFoldContent && elapsed !== null && turn.status === "done" && (
        <p className={styles.workingRow}>Worked for {elapsed}s</p>
      )}
      {turn.parts.map((part, i) => {
        // Folded: only the terminal text part stays visible.
        if (folded && (part.type !== "text" || i !== lastTextIndex)) return null;
        const live = streaming && i === turn.parts.length - 1;
        if (part.type === "thinking") {
          return <ThinkingReasoning key={i} text={part.text} streaming={live} thinkingMs={part.ms} />;
        }
        if (part.type === "tools") {
          const calls = part.ids
            .map((id) => turn.calls.find((c) => c.id === id))
            .filter((c) => c !== undefined);
          return calls.length > 0 ? <ToolChips key={i} calls={calls} streaming={streaming && live} /> : null;
        }
        return <StreamText key={i} text={part.text} streaming={live} />;
      })}
      {turn.steers.map((steer, i) => (
        <p key={i} className={styles.steer}>
          {steer}
        </p>
      ))}
    </>
  );
}

export function TurnView({ turn, onRetry }: { turn: TurnViewState; onRetry: (prompt: string) => void }) {
  // Keyless turns ran without a provider key: never render their agent
  // content (harness output, not model output). Block with the key-required
  // error instead; Retry re-queues the prompt for a real keyed run.
  if (turn.keyless) {
    return (
      <article className={styles.turn}>
        {turn.prompt.length > 0 && (
          <Message from="user">
            <MessageContent>
              <UserRow text={turn.prompt} />
            </MessageContent>
          </Message>
        )}
        <Message from="assistant">
          <MessageContent>
            <TurnError
              title="Provider key required"
              message="This turn ran without a model provider key, so its output is not shown."
              hint="Set a provider key as a Worker secret (for example ANTHROPIC_API_KEY), redeploy, then reload — or Retry once a key is set."
              onRetry={() => onRetry(turn.prompt)}
            />
          </MessageContent>
        </Message>
      </article>
    );
  }
  return (
    <article className={styles.turn}>
      {turn.prompt.length > 0 && (
        <Message from="user">
          <MessageContent>
            <UserRow text={turn.prompt} />
          </MessageContent>
        </Message>
      )}
      <Message from="assistant">
        <MessageContent>
          <AgentContent turn={turn} />
          {turn.status === "error" && (
            <TurnError
              title="Turn failed"
              message={turn.error ?? "Turn failed"}
              hint={turn.hint}
              onRetry={() => onRetry(turn.prompt)}
            />
          )}
          {turn.status === "interrupted" && (
            <TurnError
              title="Turn interrupted"
              message="The run ended before producing a result."
              hint={turn.hint}
              onRetry={() => onRetry(turn.prompt)}
            />
          )}
        </MessageContent>
      </Message>
    </article>
  );
}
