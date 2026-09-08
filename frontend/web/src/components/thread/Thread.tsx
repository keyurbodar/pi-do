// Thread — scroll container for the turn list, following the vendored
// blocks Conversation / StickToBottom pattern
// (refs/blocks/components/ai-elements/conversation.tsx): a sticky scroll
// container that stays pinned to the bottom while new deltas land, a
// content column, and an isAtBottom-gated jump pill. Renders committed
// turns plus optimistic pending user rows.
//
// Same component API in/out as before (turns/pending/conn/onRetry); only
// the markup/classes follow the Conversation / ConversationContent /
// ConversationScrollButton split, preset-styled.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode, RefObject } from "react";
import { ArrowDown } from "lucide-react";
import { TurnView } from "./TurnView";
import { UserRow } from "./UserRow";
import type { ConnState, PendingPrompt, TurnViewState } from "./types";
import styles from "./Thread.module.css";

type StickState = {
  /** True while the viewport sits within the pin threshold of the bottom. */
  isAtBottom: boolean;
  /** Re-pin and scroll to the bottom (instant for streaming follow). */
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  /** Shared by Conversation (ResizeObserver) and ConversationContent. */
  contentRef: RefObject<HTMLDivElement | null>;
};

const StickContext = createContext<StickState | null>(null);

function useStick(): StickState {
  const ctx = useContext(StickContext);
  if (!ctx) throw new Error("Conversation subcomponent must render inside Conversation");
  return ctx;
}

/** Distance in px from the bottom that still counts as pinned. */
const PIN_THRESHOLD = 64;

// Conversation — StickToBottom viewport. Owns the scroll element, the
// pinned state, and the stick/follow behavior.
function Conversation({ children }: { children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stuckRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    stuckRef.current = true;
    setIsAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD;
      stuckRef.current = nearBottom;
      setIsAtBottom(nearBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // StickToBottom "resize" follow: any content growth (streaming text,
  // images, fonts) re-pins while stuck, not just new turns/rows.
  useEffect(() => {
    const node = contentRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stuckRef.current) {
        const el = scrollRef.current;
        if (el) el.scrollTo({ top: el.scrollHeight });
      }
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const state: StickState = { isAtBottom, scrollToBottom, contentRef };

  return (
    <StickContext.Provider value={state}>
      <div className={styles.scroll} ref={scrollRef} role="log">
        {children}
      </div>
    </StickContext.Provider>
  );
}

// ConversationContent — the centered 880px column.
function ConversationContent({ children }: { children: ReactNode }) {
  const { contentRef } = useStick();
  return (
    <div className={styles.inner} ref={contentRef}>
      {children}
    </div>
  );
}

// ConversationScrollButton — isAtBottom-gated jump pill. Null while
// pinned; smooth-scrolls home and re-pins on click.
function ConversationScrollButton() {
  const { isAtBottom, scrollToBottom } = useStick();
  if (isAtBottom) return null;
  return (
    <button
      type="button"
      className={styles.jump}
      onClick={() => scrollToBottom("smooth")}
      aria-label="Jump to latest"
    >
      <ArrowDown size={16} />
      <span>Latest</span>
    </button>
  );
}

function ThreadBody({
  turns,
  pending,
  conn,
  onRetry,
}: {
  turns: TurnViewState[];
  pending: PendingPrompt[];
  conn: ConnState;
  onRetry: (prompt: string) => void;
}) {
  const { isAtBottom, scrollToBottom } = useStick();

  // Pinned follow: new turns/rows pull the viewport down while stuck.
  // Runs on mount too, so late-joining content starts at the bottom.
  useEffect(() => {
    if (isAtBottom) scrollToBottom("auto");
  }, [turns, pending, isAtBottom, scrollToBottom]);

  const empty = turns.length === 0 && pending.length === 0;

  return (
    <>
      {empty && (
        <div className={styles.empty}>
          <p className={styles.status}>
            {conn === "connecting" ? "Connecting…" : "New session ready — send a prompt to start."}
          </p>
        </div>
      )}
      {turns.map((turn) => (
        <TurnView key={turn.runId} turn={turn} onRetry={onRetry} />
      ))}
      {pending.map((p) => (
        <UserRow key={p.id} text={p.text} />
      ))}
      {conn === "closed" && !empty && (
        <p className={styles.status}>Live stream closed — Retry re-queues the prompt over a fresh socket.</p>
      )}
    </>
  );
}

export function Thread({
  turns,
  pending,
  conn,
  onRetry,
}: {
  turns: TurnViewState[];
  pending: PendingPrompt[];
  conn: ConnState;
  onRetry: (prompt: string) => void;
}) {
  return (
    <div className={styles.wrap}>
      <Conversation>
        <ConversationContent>
          <ThreadBody turns={turns} pending={pending} conn={conn} onRetry={onRetry} />
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
    </div>
  );
}
