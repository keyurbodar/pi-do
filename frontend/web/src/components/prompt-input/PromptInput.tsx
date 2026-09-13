// Ported from refs/akeru-bot/apps/web/src/components/roster/BotPromptComposer.tsx
// and BotPromptAttachments.tsx (MIT — https://github.com/t3tools/akeru-bot),
// with patterns from apps/web/src/components/chat/ComposerCommandMenu.tsx,
// ComposerBannerStack.tsx, ComposerStashBadge.tsx, ComposerTasksBadge.tsx,
// ComposerPromptLengthValidation.tsx, and ContextWindowMeter.tsx.
// Akeru's state layer (Effect/atom stores, WS send path, lightbox, form retry)
// is stripped: everything here is fixture-local or localStorage-backed
// (keys namespaced `pi-do.*`) and wired to the pi-do session contract
// (onSubmit / running / onAbort). All new props are optional; the v1
// onSubmit(text)/running/onAbort/botName/draftKey contract is unchanged.

import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ArrowUp, Bookmark, FileText, Mic, Plus, Square, X } from "lucide-react";

import { StashMenu, type StashEntry } from "./StashMenu";

import { clearReplyTarget, stageReplyFor, useReplyTarget } from "../chat/replyStore";

export type SubmitOpts = {
  model?: string;
  reply?: { label: string; text: string };
};

export type MentionBot = {
  id: string;
  name: string;
};

export type ReplyPreview = {
  id: string;
  text: string;
};

export type PendingQuestion = {
  text: string;
  options: string[];
};

export type ComposerBannerKind = "info" | "warning" | "error";

export type ComposerBanner = {
  id: string;
  kind: ComposerBannerKind;
  text: string;
};

export type PromptInputProps = {
  // v1 wires to the session WS send path; keep send() clearing behavior.
  // Second arg carries the per-draft model pick; old callers ignore it.
  onSubmit?: (text: string, opts?: SubmitOpts) => void;
  // While a turn streams the send button stays Send (disabled); Escape is
  // the only abort path and fires onAbort.
  running?: boolean;
  onAbort?: () => void;
  // Placeholder reads "Message {botName}".
  botName?: string;
  // Per-bot draft bucket; localStorage key is `pi-do-draft-{draftKey}`.
  draftKey?: string;
  // Bots offered by the @ mention menu. Optional; default [].
  bots?: readonly MentionBot[];
  // Quoted strip above the input; X reports via onCancelReply.
  replyTo?: ReplyPreview | null;
  onCancelReply?: () => void;
  // Question banner above the input; chips report via onAnswer.
  pendingQuestion?: PendingQuestion | null;
  onAnswer?: (option: string) => void;
  // Dismissible banner stack above the composer.
  banners?: readonly ComposerBanner[];
  onDismissBanner?: (id: string) => void;
  // Accepted-but-ignored (meter UI removed). Kept optional so old callers
  // keep compiling.
  contextPercent?: number;
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

/**
 * Downscales an image to max 1200px on its long edge as JPEG 0.82, keeping
 * the original file name so staged chips stay recognizable. Non-images,
 * tiny images, and any failure fall back to the original file untouched.
 */
async function downscaleImage(file: File): Promise<File> {
  try {
    if (!file.type.startsWith("image/")) return file;
    if (typeof document === "undefined" || typeof Image === "undefined") return file;
    const sourceUrl = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("decode failed"));
        el.src = sourceUrl;
      });
      const longest = Math.max(img.naturalWidth, img.naturalHeight);
      if (longest <= MAX_IMAGE_DIM || img.naturalWidth === 0) return file;
      const scale = MAX_IMAGE_DIM / longest;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext("2d");
      if (ctx === null) return file;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), "image/jpeg", 0.82),
      );
      if (blob === null) return file;
      return new File([blob], file.name, { type: "image/jpeg" });
    } finally {
      URL.revokeObjectURL(sourceUrl);
    }
  } catch {
    return file;
  }
}

/** Human-readable file size for context chips (B / KB / MB, one decimal). */
function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb >= 100 ? Math.round(kb).toString() : kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb >= 100 ? Math.round(mb).toString() : mb.toFixed(1)} MB`;
}

const MAX_DRAFT_CHARS = 20_000;
const MAX_STASH_ENTRIES = 10;
const MAX_IMAGE_DIM = 1200;

type ModelId = "default" | "claude-opus" | "gpt-5" | "grok-4";
type SlashCommand = {
  id: "search" | "summarize" | "plan" | "mention";
  description: string;
};

const SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
  { id: "search", description: "Search the workspace" },
  { id: "summarize", description: "Summarize the thread" },
  { id: "plan", description: "Draft a plan" },
  { id: "mention", description: "Mention a bot (@bot-name)" },
];

function tokenAtCaret(
  beforeCaret: string,
  trigger: "/" | "@",
): { start: number; query: string } | null {
  const pattern = trigger === "/" ? /(^|\s)\/([A-Za-z-]*)$/ : /(^|\s)@([\w-]*)$/;
  const match = beforeCaret.match(pattern);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  const tokenLength = match[0].length - match[1].length;
  return { start: beforeCaret.length - tokenLength, query: match[2] };
}

function readDraft(draftKey: string): string {
  try {
    return globalThis.localStorage.getItem(`pi-do-draft-${draftKey}`) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(draftKey: string, text: string): void {
  try {
    globalThis.localStorage.setItem(`pi-do-draft-${draftKey}`, text.slice(0, MAX_DRAFT_CHARS));
  } catch {
    // Quota or private mode. Draft recovery is best-effort.
  }
}

function clearDraft(draftKey: string): void {
  try {
    globalThis.localStorage.removeItem(`pi-do-draft-${draftKey}`);
  } catch {
    // Ignore.
  }
}

function readModel(draftKey: string): ModelId {
  try {
    const raw = globalThis.localStorage.getItem(`pi-do-model-${draftKey}`);
    return raw === "claude-opus" || raw === "gpt-5" || raw === "grok-4" ? raw : "default";
  } catch {
    return "default";
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

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Count badge that pops (scale bump) whenever its count changes. */
function CountBadge({
  testid,
  count,
  label,
}: {
  testid: string;
  count: number;
  label: string;
}) {
  const [pulse, setPulse] = useState(false);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (count === 0) return;
    setPulse(true);
    const timer = setTimeout(() => setPulse(false), 350);
    return () => clearTimeout(timer);
  }, [count]);
  if (count === 0) return null;
  return (
    <span
      data-testid={testid}
      aria-label={label}
      className={[
        "pointer-events-none absolute -right-1 -top-1 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground transition-transform duration-200",
        pulse ? "scale-125" : "scale-100",
      ].join(" ")}
    >
      {count}
    </span>
  );
}

export function PromptInput({
  onSubmit,
  running = false,
  onAbort,
  botName = "agent",
  draftKey = "default",
  bots = [],
  replyTo = null,
  onCancelReply,
  pendingQuestion = null,
  onAnswer,
  banners = [],
  onDismissBanner,
  contextPercent,
}: PromptInputProps = {}) {
  // contextPercent no longer renders a meter; accepted-but-ignored.
  void contextPercent;
  // Draft persists per bot: restored on mount (and on draftKey change),
  // saved on every change, cleared on send.
  const [value, setValue] = useState(() => readDraft(draftKey));
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Stash persists per bot alongside the draft; newest entry first.
  const [stashEntries, setStashEntries] = useState<StashEntry[]>(() => readStash(draftKey));
  const [isStashMenuOpen, setIsStashMenuOpen] = useState(false);
  // Last stored model pick (picker UI removed — nothing changes it here);
  // still sent so a stored preference keeps applying.
  const [model, setModel] = useState<ModelId>(() => readModel(draftKey));
  // Caret-tracked trigger menus (slash + @ mention).
  const [caret, setCaret] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  // Controlled-from-above extras with local dismiss fallbacks.
  const [dismissedBanners, setDismissedBanners] = useState<ReadonlySet<string>>(new Set());
  // Voice recording is UI-only: a pulsing state + timer, no audio anywhere.
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [micNotice, setMicNotice] = useState(false);

  const attachmentsRef = useRef<Attachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const micSupported =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function";

  useEffect(() => {
    setValue(readDraft(draftKey));
    setStashEntries(readStash(draftKey));
    setModel(readModel(draftKey));
    setIsStashMenuOpen(false);
    setDismissedBanners(new Set());
  }, [draftKey]);

  useEffect(
    () => () => {
      releaseAttachments(attachmentsRef.current);
      attachmentsRef.current = [];
    },
    [],
  );

  useEffect(() => {
    if (!recording) return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);

  const hasText = value.trim().length > 0;

  // Reply target: the controlled replyTo prop wins; otherwise the module
  // store armed by MessageBubble reply actions.
  const storeReply = useReplyTarget();
  const activeReplyLabel = replyTo === null || replyTo === undefined ? storeReply?.label : replyTo.id;
  const activeReplyText = replyTo === null || replyTo === undefined ? storeReply?.text : replyTo.text;
  const hasActiveReply = activeReplyLabel !== undefined && activeReplyText !== undefined;
  const cancelReply = () => {
    onCancelReply?.();
    clearReplyTarget();
  };

  const appendAttachments = (added: readonly Attachment[]) => {
    if (added.length === 0) return;
    const updated = [...attachmentsRef.current, ...added];
    attachmentsRef.current = updated;
    setAttachments(updated);
  };

  const addFiles = (files: FileList | readonly File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    // Non-images stage synchronously; images compress off-thread first.
    appendAttachments(createAttachments(list.filter((f) => !f.type.startsWith("image/"))));
    for (const image of list.filter((f) => f.type.startsWith("image/"))) {
      void downscaleImage(image).then((finalFile) => {
        appendAttachments(createAttachments([finalFile]));
      });
    }
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
    if (hasActiveReply) stageReplyFor(text);
    onSubmit?.(text, {
      ...(model === "default" ? {} : { model }),
      ...(hasActiveReply && activeReplyLabel !== undefined && activeReplyText !== undefined
        ? { reply: { label: activeReplyLabel, text: activeReplyText } }
        : {}),
    });
    if (hasActiveReply) cancelReply();
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const syncCaret = () => {
    const el = textareaRef.current;
    if (el !== null) setCaret(el.selectionStart ?? value.length);
  };

  const insertAtToken = (tokenStart: number, caretEnd: number, insert: string) => {
    const next = value.slice(0, tokenStart) + insert + value.slice(caretEnd);
    setValue(next);
    writeDraft(draftKey, next);
    setMenuIndex(0);
    const pos = tokenStart + insert.length;
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  // Trigger detection runs against text before the caret so "/cmd hello"
  // keeps working with the caret at the end, not just a lone "/".
  const beforeCaret = value.slice(0, Math.max(0, Math.min(caret, value.length)));
  const slashToken = tokenAtCaret(beforeCaret, "/");
  const mentionToken = tokenAtCaret(beforeCaret, "@");
  const activeToken = mentionToken ?? slashToken;

  const filteredSlash =
    slashToken !== null && mentionToken === null
      ? SLASH_COMMANDS.filter((cmd) =>
          cmd.id.startsWith(slashToken.query.toLowerCase()),
        )
      : [];
  const isSlashOpen = slashToken !== null && mentionToken === null;

  const mentionQuery = mentionToken?.query.toLowerCase() ?? "";
  const filteredBots =
    mentionToken !== null
      ? bots.filter((bot) => bot.name.toLowerCase().includes(mentionQuery))
      : [];
  const isMentionOpen = mentionToken !== null;

  useEffect(() => {
    setMenuIndex(0);
  }, [slashToken?.query, mentionToken?.query]);

  const pickSlash = (cmd: SlashCommand) => {
    if (slashToken === null) return;
    if (cmd.id === "mention") {
      const name = bots[0]?.name ?? "bot-name";
      insertAtToken(slashToken.start, caret, `@${name} `);
      return;
    }
    insertAtToken(slashToken.start, caret, `/${cmd.id} `);
  };

  const pickBot = (name: string) => {
    if (mentionToken === null) return;
    insertAtToken(mentionToken.start, caret, `@${name} `);
  };

  const onTextareaKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      setIsStashMenuOpen(false);
      // The send button never morphs into Stop; Escape is the only abort path.
      if (running) onAbort?.();
      return;
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && activeToken !== null) {
      const count = isMentionOpen ? Math.max(filteredBots.length, 1) : filteredSlash.length;
      if (count > 0) {
        e.preventDefault();
        setMenuIndex((i) => (e.key === "ArrowDown" ? (i + 1) % count : (i - 1 + count) % count));
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      const native = e.nativeEvent;
      if (native.isComposing || native.keyCode === 229) return;
      e.preventDefault();
      // Enter confirms the highlighted trigger item; plain Enter sends.
      if (isSlashOpen && filteredSlash.length > 0) {
        const pick = filteredSlash[menuIndex % filteredSlash.length];
        if (pick) pickSlash(pick);
        return;
      }
      if (isMentionOpen && filteredBots.length > 0) {
        const pick = filteredBots[menuIndex % filteredBots.length];
        if (pick) pickBot(pick.name);
        return;
      }
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

  const dismissBanner = (id: string) => {
    setDismissedBanners((prev) => new Set(prev).add(id));
    onDismissBanner?.(id);
  };

  const visibleBanners = banners.filter((b) => !dismissedBanners.has(b.id));

  const bannerTone: Record<ComposerBannerKind, string> = {
    info: "border-input bg-secondary text-foreground",
    warning: "border-warning/40 bg-warning/10 text-foreground",
    error: "border-destructive/40 bg-destructive/10 text-foreground",
  };

  const onMicClick = () => {
    if (!micSupported) {
      setMicNotice(true);
      return;
    }
    setRecording((r) => !r);
  };

  return (
    <div className="relative w-full">
      {visibleBanners.length > 0 ? (
        <div data-testid="composer-banners" className="mb-2 space-y-1.5">
          {visibleBanners.map((banner) => (
            <div
              key={banner.id}
              data-testid={`banner-${banner.id}`}
              data-kind={banner.kind}
              role={banner.kind === "error" ? "alert" : "status"}
              className={[
                "flex items-center gap-2 rounded-[var(--control-radius)] border px-3 py-1.5 text-xs",
                bannerTone[banner.kind],
              ].join(" ")}
            >
              <span
                aria-hidden="true"
                className={[
                  "size-1.5 shrink-0 rounded-full",
                  banner.kind === "error"
                    ? "bg-destructive"
                    : banner.kind === "warning"
                      ? "bg-warning"
                      : "bg-primary",
                ].join(" ")}
              />
              <p className="min-w-0 flex-1 truncate">{banner.text}</p>
              <button
                type="button"
                data-testid={`banner-dismiss-${banner.id}`}
                aria-label="Dismiss banner"
                onClick={() => dismissBanner(banner.id)}
                className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {pendingQuestion !== null ? (
        <div
          data-testid="composer-question-banner"
          className="mb-2 rounded-[var(--control-radius)] border border-input bg-secondary px-3 py-2"
        >
          <p className="text-xs font-medium text-foreground">{pendingQuestion.text}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {pendingQuestion.options.map((option, index) => (
              <button
                key={`${option}-${index}`}
                type="button"
                data-testid={`question-option-${index}`}
                onClick={() => onAnswer?.(option)}
                className="rounded-full border border-input bg-background/60 px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-white/10"
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {hasActiveReply ? (
        <div
          data-testid="composer-reply-preview"
          className="mb-2 flex items-center gap-2 rounded-[var(--control-radius)] border border-input bg-secondary px-3 py-1.5"
        >
          <span
            aria-hidden="true"
            className="w-0.5 shrink-0 self-stretch rounded-full bg-primary"
          />
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            Replying to {activeReplyLabel}: {activeReplyText}
          </p>
          <button
            type="button"
            data-testid="reply-dismiss"
            aria-label="Dismiss reply"
            onClick={cancelReply}
            className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}

      <div className="relative">
        <div
          data-testid="composer"
          className="relative flex min-h-13 flex-col overflow-hidden rounded-[1.65rem] border border-input bg-foreground/[0.08] shadow-[0_12px_36px_-24px_rgb(0_0_0/80%)] transition-[border-color,background-color,box-shadow] duration-200 ease-out"
        >
          {attachments.length > 0 ? (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {attachments.map((attachment) => {
                const isImage = attachment.previewUrl !== null;
                return (
                  <div
                    key={attachment.id}
                    data-testid="composer-attachment"
                    title={`${attachment.file.name} · ${formatFileSize(attachment.file.size)}`}
                    className="flex max-w-56 shrink-0 items-center gap-2 rounded-[var(--control-radius)] border border-input bg-background/65 py-1 pl-1 pr-2"
                  >
                    {isImage && attachment.previewUrl !== null ? (
                      <img
                        src={attachment.previewUrl}
                        alt={attachment.file.name}
                        className="size-9 shrink-0 rounded-[calc(var(--control-radius)-4px)] object-cover"
                        draggable={false}
                      />
                    ) : (
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-[calc(var(--control-radius)-4px)] bg-secondary text-muted-foreground">
                        <FileText className="size-4" />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs leading-4 text-foreground">
                        {attachment.file.name}
                      </span>
                      <span className="block text-[10px] leading-4 text-muted-foreground">
                        {isImage ? "Image" : "File"} ·{" "}
                        {formatFileSize(attachment.file.size)}
                      </span>
                    </span>
                    <button
                      type="button"
                      data-testid={`attachment-remove-${attachment.id}`}
                      aria-label={`Remove ${attachment.file.name}`}
                      onClick={() => removeAttachment(attachment.id)}
                      className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}

          {recording ? (
            <div
              data-testid="mic-recording"
              className="flex items-center gap-2 px-4 pt-2.5 text-xs text-muted-foreground"
            >
              <span
                aria-hidden="true"
                className="size-2 shrink-0 animate-pulse rounded-full bg-destructive"
              />
              <span>Recording</span>
              <span data-testid="mic-timer" className="font-mono tabular-nums">
                {formatElapsed(elapsed)}
              </span>
              <button
                type="button"
                data-testid="mic-stop"
                aria-label="Stop recording"
                onClick={() => setRecording(false)}
                className="flex h-6 items-center gap-1 rounded-full border border-input px-2 text-[11px] text-foreground transition-colors hover:bg-white/10"
              >
                <Square size={10} fill="currentColor" />
                Stop
              </button>
            </div>
          ) : null}

          <div className="flex min-h-[52px] items-center gap-2 px-4">
            <span className="relative shrink-0">
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
              <CountBadge
                testid="composer-stash-badge"
                count={stashEntries.length}
                label={`${stashEntries.length} stashed prompts`}
              />
            </span>
            <span className="relative shrink-0">
              <button
                type="button"
                data-testid="composer-attach"
                aria-label="Add attachment"
                title="Attach files"
                onClick={() => fileInputRef.current?.click()}
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground transition-colors hover:text-foreground"
              >
                <Plus className="size-5" />
              </button>
              <CountBadge
                testid="composer-tasks-badge"
                count={attachments.length}
                label={`${attachments.length} staged attachments`}
              />
            </span>
            <textarea
              ref={textareaRef}
              data-testid="composer-input"
              aria-label={`Message ${botName}`}
              placeholder={`Message ${botName}`}
              rows={1}
              value={value}
              className="field-sizing-content max-h-56 min-w-0 flex-1 resize-none bg-transparent py-0 text-[15px] leading-6 outline-none placeholder:text-muted-foreground/70"
              onChange={(event) => {
                const next = event.currentTarget.value;
                setValue(next);
                writeDraft(draftKey, next);
                syncCaret();
              }}
              onKeyDown={onTextareaKeyDown}
              onKeyUp={syncCaret}
              onClick={syncCaret}
              onSelect={syncCaret}
              onPaste={onTextareaPaste}
            />
            <span className="relative shrink-0">
              <button
                type="button"
                data-testid="composer-mic"
                aria-label={recording ? "Stop voice input" : "Voice input"}
                title={
                  !micSupported
                    ? "Mic unavailable"
                    : recording
                      ? "Stop recording"
                      : "Voice input"
                }
                aria-pressed={recording}
                onClick={onMicClick}
                className={[
                  "flex size-9 shrink-0 items-center justify-center rounded-full transition-colors",
                  recording
                    ? "bg-destructive/15 text-destructive hover:text-destructive"
                    : "bg-secondary text-muted-foreground hover:text-foreground",
                ].join(" ")}
              >
                <Mic className="size-5" />
              </button>
              {!micSupported && micNotice ? (
                <span
                  data-testid="mic-unavailable"
                  role="status"
                  className="absolute bottom-[calc(100%+6px)] right-0 z-20 whitespace-nowrap rounded-[var(--control-radius)] border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground shadow-[0_16px_40px_-20px_rgb(0_0_0/60%)]"
                >
                  Mic unavailable
                </span>
              ) : null}
            </span>
            <button
              type="button"
              data-testid="composer-send"
              data-status="ready"
              aria-label="Send"
              disabled={!hasText}
              onClick={send}
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-transform disabled:opacity-25"
            >
              <ArrowUp className="size-5" />
            </button>
          </div>
        </div>

        {isSlashOpen ? (
          <div
            data-testid="composer-slash-menu"
            role="listbox"
            aria-label="Slash commands"
            className="absolute bottom-[calc(100%+8px)] left-2 z-20 w-72 overflow-hidden rounded-[var(--control-radius)] border border-border bg-card p-1 shadow-[0_16px_40px_-20px_rgb(0_0_0/60%)]"
          >
            {filteredSlash.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">No matching command.</p>
            ) : (
              filteredSlash.map((cmd, index) => (
                <button
                  key={cmd.id}
                  type="button"
                  role="option"
                  aria-selected={index === menuIndex % filteredSlash.length}
                  data-testid={`slash-option-${cmd.id}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickSlash(cmd)}
                  onMouseMove={() => setMenuIndex(index)}
                  className={[
                    "flex w-full items-center gap-2 rounded-[calc(var(--control-radius)-4px)] px-2.5 py-1.5 text-left text-sm transition-colors",
                    index === menuIndex % filteredSlash.length
                      ? "bg-foreground/[0.06] text-foreground"
                      : "text-muted-foreground",
                  ].join(" ")}
                >
                  <span className="shrink-0 font-medium text-foreground">/{cmd.id}</span>
                  <span className="min-w-0 flex-1 truncate text-xs">{cmd.description}</span>
                </button>
              ))
            )}
          </div>
        ) : null}

        {isMentionOpen ? (
          <div
            data-testid="composer-mention-menu"
            role="listbox"
            aria-label="Mention a bot"
            className="absolute bottom-[calc(100%+8px)] left-2 z-20 w-72 overflow-hidden rounded-[var(--control-radius)] border border-border bg-card p-1 shadow-[0_16px_40px_-20px_rgb(0_0_0/60%)]"
          >
            {filteredBots.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">No bots found.</p>
            ) : (
              filteredBots.map((bot, index) => (
                <button
                  key={bot.id}
                  type="button"
                  role="option"
                  aria-selected={index === menuIndex % filteredBots.length}
                  data-testid={`mention-option-${bot.name}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickBot(bot.name)}
                  onMouseMove={() => setMenuIndex(index)}
                  className={[
                    "flex w-full items-center gap-2 rounded-[calc(var(--control-radius)-4px)] px-2.5 py-1.5 text-left text-sm transition-colors",
                    index === menuIndex % filteredBots.length
                      ? "bg-foreground/[0.06] text-foreground"
                      : "text-muted-foreground",
                  ].join(" ")}
                >
                  <span className="shrink-0 font-medium text-foreground">@{bot.name}</span>
                </button>
              ))
            )}
          </div>
        ) : null}
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
