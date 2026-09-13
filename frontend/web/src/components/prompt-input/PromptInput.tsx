// Ported from refs/akeru-bot/apps/web/src/components/roster/BotPromptComposer.tsx
// and BotPromptAttachments.tsx (MIT — https://github.com/t3tools/akeru-bot).
// Akeru's state layer (stash, mentions, reply preview, failed-preview
// tracking, lightbox, form retry) is stripped: what remains is the pill
// shell, the attachment strip, a mic placeholder, and the send/stop morph
// wired to the pi-do session contract (onSubmit / running / onAbort).

import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ArrowUp, Bookmark, Mic, Plus, Square, X } from "lucide-react";

import { StashMenu, type StashEntry } from "./StashMenu";

export type PromptInputProps = {
  // v1 wires to the session WS send path; keep send() clearing behavior.
  onSubmit?: (text: string) => void;
  // While a turn streams, the send button morphs into Stop (Square) and
  // fires onAbort instead — the only brake on a stuck turn.
  running?: boolean;
  onAbort?: () => void;
  // Placeholder reads "Message {botName}".
  botName?: string;
  // Per-bot draft bucket; localStorage key is `pidof-draft-{draftKey}`.
  draftKey?: string;
};

/** A staged composer file plus the object URL that backs its live thumbnail. */
type Attachment = {
  id: string;
  file: File;
  previewUrl: string | null;
};

let attachmentSequence = 0;

/** Images get an object URL so the thumbnail renders before any upload starts. */
function createAttachments(files: readonly File[]): Attachment[] {
  return files.map((file) => {
    attachmentSequence += 1;
    return {
      id: `composer-attachment-${attachmentSequence}`,
      file,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    };
  });
}

/** Revokes every object URL held by the given attachments. */
function releaseAttachments(attachments: readonly Attachment[]): void {
  for (const attachment of attachments) {
    if (attachment.previewUrl !== null) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  }
}

const MAX_DRAFT_CHARS = 20_000;
const MAX_STASH_ENTRIES = 10;

function readDraft(draftKey: string): string {
  try {
    return globalThis.localStorage.getItem(`pidof-draft-${draftKey}`) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(draftKey: string, text: string): void {
  try {
    globalThis.localStorage.setItem(`pidof-draft-${draftKey}`, text.slice(0, MAX_DRAFT_CHARS));
  } catch {
    // Quota or private mode. Draft recovery is best-effort.
  }
}

function clearDraft(draftKey: string): void {
  try {
    globalThis.localStorage.removeItem(`pidof-draft-${draftKey}`);
  } catch {
    // Ignore.
  }
}

let stashSequence = 0;

function readStash(draftKey: string): StashEntry[] {
  try {
    const raw = globalThis.localStorage.getItem(`pi-do-stash-${draftKey}`);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is StashEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as StashEntry).id === "string" &&
        typeof (entry as StashEntry).text === "string" &&
        typeof (entry as StashEntry).createdAt === "string",
    );
  } catch {
    return [];
  }
}

function writeStash(draftKey: string, entries: readonly StashEntry[]): void {
  try {
    globalThis.localStorage.setItem(
      `pi-do-stash-${draftKey}`,
      JSON.stringify(entries.slice(0, MAX_STASH_ENTRIES)),
    );
  } catch {
    // Quota or private mode. Stash persistence is best-effort.
  }
}

export function PromptInput({
  onSubmit,
  running = false,
  onAbort,
  botName = "agent",
  draftKey = "default",
}: PromptInputProps = {}) {
  // Draft persists per bot: restored on mount (and on draftKey change),
  // saved on every change, cleared on send.
  const [value, setValue] = useState(() => readDraft(draftKey));
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Stash persists per bot alongside the draft; newest entry first.
  const [stashEntries, setStashEntries] = useState<StashEntry[]>(() => readStash(draftKey));
  const [isStashMenuOpen, setIsStashMenuOpen] = useState(false);

  const attachmentsRef = useRef<Attachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setValue(readDraft(draftKey));
    setStashEntries(readStash(draftKey));
    setIsStashMenuOpen(false);
  }, [draftKey]);

  useEffect(
    () => () => {
      releaseAttachments(attachmentsRef.current);
      attachmentsRef.current = [];
    },
    [],
  );

  const hasText = value.trim().length > 0;

  const addFiles = (files: FileList | readonly File[]) => {
    const added = createAttachments(Array.from(files));
    const updated = [...attachmentsRef.current, ...added];
    attachmentsRef.current = updated;
    setAttachments(updated);
  };

  const removeAttachment = (attachmentId: string) => {
    const removed = attachmentsRef.current.find(
      (attachment) => attachment.id === attachmentId,
    );
    if (!removed) return;
    const updated = attachmentsRef.current.filter(
      (attachment) => attachment.id !== attachmentId,
    );
    attachmentsRef.current = updated;
    setAttachments(updated);
    releaseAttachments([removed]);
  };

  const send = () => {
    const text = value.trim();
    if (!text) return;
    const staged = attachmentsRef.current;
    clearDraft(draftKey);
    setValue("");
    attachmentsRef.current = [];
    setAttachments([]);
    releaseAttachments(staged);
    onSubmit?.(text);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const onTextareaKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      const native = e.nativeEvent;
      if (native.isComposing || native.keyCode === 229) return;
      e.preventDefault();
      send();
    }
  };

  const onTextareaPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    if (e.clipboardData.files.length > 0) {
      e.preventDefault();
      addFiles(e.clipboardData.files);
    }
  };

  const stashCurrentDraft = () => {
    const text = value.trim();
    if (text.length === 0) {
      // Nothing to stash: the button doubles as the menu toggle.
      setIsStashMenuOpen((open) => !open);
      return;
    }
    stashSequence += 1;
    const entry: StashEntry = {
      id: `stash-${Date.now()}-${stashSequence}`,
      text,
      createdAt: new Date().toISOString(),
    };
    const updated = [entry, ...stashEntries].slice(0, MAX_STASH_ENTRIES);
    writeStash(draftKey, updated);
    setStashEntries(updated);
    clearDraft(draftKey);
    setValue("");
    setIsStashMenuOpen(true);
  };

  const restoreStashEntry = (entry: StashEntry) => {
    const updated = stashEntries.filter((candidate) => candidate.id !== entry.id);
    writeStash(draftKey, updated);
    setStashEntries(updated);
    setValue(entry.text);
    writeDraft(draftKey, entry.text);
    setIsStashMenuOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const deleteStashEntry = (entry: StashEntry) => {
    const updated = stashEntries.filter((candidate) => candidate.id !== entry.id);
    writeStash(draftKey, updated);
    setStashEntries(updated);
  };

  return (
    <div className="relative w-full">
      <div
        data-testid="composer"
        className="relative flex min-h-13 flex-col overflow-hidden rounded-[1.65rem] border border-input bg-foreground/[0.08] shadow-[0_12px_36px_-24px_rgb(0_0_0/80%)] transition-[border-color,background-color,box-shadow] duration-200 ease-out"
      >
        {attachments.length > 0 ? (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {attachments.map((attachment) => (
              <div
                key={attachment.id}
                data-testid="composer-attachment"
                className="relative size-16 shrink-0 overflow-hidden rounded-[var(--control-radius)] border border-input bg-background/65"
              >
                {attachment.previewUrl !== null ? (
                  <img
                    src={attachment.previewUrl}
                    alt={attachment.file.name}
                    className="size-full object-cover"
                    draggable={false}
                  />
                ) : (
                  <span className="flex size-full items-center justify-center break-all px-1 text-center text-[10px] leading-tight text-muted-foreground">
                    {attachment.file.name}
                  </span>
                )}
                <button
                  type="button"
                  data-testid={`attachment-remove-${attachment.id}`}
                  aria-label={`Remove ${attachment.file.name}`}
                  onClick={() => removeAttachment(attachment.id)}
                  className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-background/80 text-muted-foreground hover:bg-background hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          data-testid="composer-input"
          aria-label={`Message ${botName}`}
          placeholder={`Message ${botName}`}
          rows={1}
          value={value}
          className="field-sizing-content max-h-56 w-full resize-none bg-transparent px-[5.5rem] py-[0.9rem] text-[15px] leading-6 outline-none placeholder:text-muted-foreground/70"
          onChange={(event) => {
            const next = event.currentTarget.value;
            setValue(next);
            writeDraft(draftKey, next);
          }}
          onKeyDown={onTextareaKeyDown}
          onPaste={onTextareaPaste}
        />

        <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-center justify-between">
          <div className="pointer-events-auto flex items-center gap-1">
            <button
              type="button"
              data-testid="composer-stash"
              aria-label="Stash prompt"
              aria-expanded={isStashMenuOpen}
              title={hasText ? "Stash this draft" : "Stashed prompts"}
              onClick={stashCurrentDraft}
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground transition-colors hover:text-foreground"
            >
              <Bookmark className="size-5" />
            </button>
            <button
              type="button"
              data-testid="composer-attach"
              aria-label="Add attachment"
              title="Attach files"
              onClick={() => fileInputRef.current?.click()}
              className="pointer-events-auto flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground transition-colors hover:text-foreground"
            >
              <Plus className="size-5" />
            </button>
          </div>

          <div className="pointer-events-auto flex items-center gap-1">
            <button
              type="button"
              data-testid="composer-mic"
              aria-label="Voice input"
              title="Voice coming soon"
              disabled
              className="flex size-9 shrink-0 cursor-default items-center justify-center rounded-full bg-secondary text-muted-foreground opacity-60"
            >
              <Mic className="size-5" />
            </button>
            <button
              type="button"
              data-testid="composer-send"
              data-status={running ? "streaming" : "ready"}
              aria-label={running ? "Stop" : "Send"}
              disabled={!hasText && !running}
              onClick={running ? onAbort : send}
              className={[
                "flex size-9 shrink-0 items-center justify-center rounded-full transition-transform",
                running
                  ? "bg-[var(--error-surface)] text-destructive hover:scale-105"
                  : "bg-primary text-primary-foreground disabled:opacity-25",
              ].join(" ")}
            >
              {running ? <Square size={12} fill="currentColor" /> : <ArrowUp className="size-5" />}
            </button>
          </div>
        </div>
      </div>

      {isStashMenuOpen ? (
        <StashMenu
          entries={stashEntries}
          onRestore={restoreStashEntry}
          onDelete={deleteStashEntry}
          onClose={() => setIsStashMenuOpen(false)}
        />
      ) : null}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="sr-only"
        onChange={(event) => {
          if (event.currentTarget.files) addFiles(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
    </div>
  );
}
