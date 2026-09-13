// AICSS-frame composer: full-thread-width column frame (field row on top,
// controls row below) that grows vertically when multiline, wired to the
// pi-do session contract (onSubmit / running / onAbort). Draft + stash
// persist per bot in localStorage (keys namespaced `pi-do.*`). The `$`
// skill menu accepts an optional `skills` prop so hosts can extend it;
// committed `$skill` tokens render as inline pills (presentation only —
// send submits plain text). The Enter/Escape, reply-strip,
// question-banner, and banner-stack behaviors are unchanged.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  ArrowUp,
  Bookmark,
  FileText,
  Image as ImageIcon,
  Paperclip,
  Plus,
  X,
} from "lucide-react";

import { StashMenu, type StashEntry } from "./StashMenu";

import { clearReplyTarget, stageReplyFor, useReplyTarget } from "../chat/replyStore";

export type SubmitOpts = {
  reply?: { label: string; text: string };
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

export type Skill = {
  id: string;
  name: string;
  description?: string;
};

export type PromptInputProps = {
  // v1 wires to the session WS send path; keep send() clearing behavior.
  onSubmit?: (text: string, opts?: SubmitOpts) => void;
  // While a turn streams the send button stays Send (disabled); Escape is
  // the only abort path and fires onAbort.
  running?: boolean;
  onAbort?: () => void;
  // Placeholder reads "Message {botName}".
  botName?: string;
  // Per-bot draft bucket; localStorage key is `pi-do-draft-{draftKey}`.
  draftKey?: string;
  // Skill menu entries. Defaults to the built-in set below; pass more to
  // extend the menu without touching this component.
  skills?: readonly Skill[];
  // Quoted strip above the input; X reports via onCancelReply.
  replyTo?: ReplyPreview | null;
  onCancelReply?: () => void;
  // Question banner above the input; chips report via onAnswer.
  pendingQuestion?: PendingQuestion | null;
  onAnswer?: (option: string) => void;
  // Dismissible banner stack above the composer.
  banners?: readonly ComposerBanner[];
  onDismissBanner?: (id: string) => void;
  // Context meter: usedTokens/contextWindow as a percent, rendered as a
  // compact bar beside the send button. Omitted → no meter.
  contextPercent?: number;
  // Compaction is queued server-side; the meter shows a pending hint.
  compactionPending?: boolean;
};

const MAX_DRAFT_CHARS = 20_000;
const MAX_STASH_ENTRIES = 10;

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

const MAX_IMAGE_DIM = 1200;

/** Built-in skills; extend via the `skills` prop. */
const BUILTIN_SKILLS: ReadonlyArray<Skill> = [
  { id: "search", name: "Search", description: "Search the workspace" },
  { id: "summarize", name: "Summarize", description: "Summarize the thread" },
  { id: "plan", name: "Plan", description: "Draft a plan" },
];

/**
 * Committed `$skill` tokens, ported from t3-web's SKILL_TOKEN_REGEX
 * (packages/shared/src/composerInlineTokens.ts): a token that starts with a
 * digit must still contain a letter and must not be a compact monetary
 * amount like `$20`, `$20k`, `$100M`, or `$1e6`. The trailing lookahead also
 * accepts end-of-input so a token at the very end of the draft highlights.
 * The skill menu trigger below shares this definition.
 */
const SKILL_TOKEN_REGEX =
  /(^|\s)(\$(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])[a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/g;

/**
 * Digit-led queries the money guard above would reject once committed
 * (`$20`, `$20k`, `$1_000`, `$100M`, `$1e6`): typing them never opens the
 * skill menu. Queries with a letter (`$2spec`) still trigger.
 */
const SKILL_MONEY_QUERY_REGEX = /^[0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?$/;

function skillTokenAtCaret(
  beforeCaret: string,
): { start: number; query: string } | null {
  const match = beforeCaret.match(/(^|\s)\$([A-Za-z0-9:_-]*)$/);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  const query = match[2];
  if (query !== "" && SKILL_MONEY_QUERY_REGEX.test(query)) return null;
  const tokenLength = match[0].length - match[1].length;
  return { start: beforeCaret.length - tokenLength, query };
}

/**
 * Splits draft text so committed `$skill` tokens (per SKILL_TOKEN_REGEX)
 * render as colored pills. Derived from `value` on every keystroke — the
 * sent text stays plain, pills are presentation only.
 */
function renderSkillHighlight(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  SKILL_TOKEN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SKILL_TOKEN_REGEX.exec(text)) !== null) {
    const token = match[2] ?? "";
    const tokenStart = match.index + (match[1] ?? "").length;
    if (tokenStart > lastIndex) nodes.push(text.slice(lastIndex, tokenStart));
    // -mx-[3px] compensates px-0.5 + 1px border so the pill occupies exactly
    // its text width: surrounding text wraps at the same offsets as the
    // (unstyled) textarea text underneath.
    nodes.push(
      <span
        key={tokenStart}
        data-testid="composer-skill-token"
        className="-mx-[3px] rounded border border-fuchsia-500/25 bg-fuchsia-500/15 px-0.5 font-medium text-fuchsia-700 dark:text-fuchsia-300"
      >
        {token}
      </span>,
    );
    lastIndex = tokenStart + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  if (text.endsWith("\n")) nodes.push(" ");
  return nodes;
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
  skills = BUILTIN_SKILLS,
  replyTo = null,
  onCancelReply,
  pendingQuestion = null,
  onAnswer,
  banners = [],
  onDismissBanner,
  contextPercent,
  compactionPending = false,
}: PromptInputProps = {}) {
  // Draft persists per bot: restored on mount (and on draftKey change),
  // saved on every change, cleared on send.
  const [value, setValue] = useState(() => readDraft(draftKey));
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isAttachMenuOpen, setIsAttachMenuOpen] = useState(false);
  // File drag-drop overlay state; the depth counter absorbs child enter/leave noise.
  const [isDragOver, setIsDragOver] = useState(false);
  const [stashEntries, setStashEntries] = useState<StashEntry[]>(() => readStash(draftKey));
  const [isStashMenuOpen, setIsStashMenuOpen] = useState(false);
  // Caret-tracked skill trigger + menu highlight/dismiss state.
  // Discipline (ported from t3-web's ComposerPromptEditor without Lexical):
  // (value, caret) is always updated atomically — onChange carries both
  // from the same event — and programmatic inserts read the live DOM
  // snapshot synchronously instead of the render-time `caret` state, which
  // can lag one commit behind. Caret restoration runs in a layout effect
  // (before paint), never in rAF: rAF lets an intervening keystroke land
  // against a stale offset and then yanks the caret back behind it, which
  // is exactly how text became undeletable / duplicated / phantom.
  const [caret, setCaret] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [skillMenuDismissed, setSkillMenuDismissed] = useState(false);

  const pendingCaretRef = useRef<number | null>(null);
  const pendingCaretValueRef = useRef<string | null>(null);

  // Controlled-from-above extras with local dismiss fallbacks.
  const [dismissedBanners, setDismissedBanners] = useState<ReadonlySet<string>>(new Set());

  const attachmentsRef = useRef<Attachment[]>([]);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dragDepthRef = useRef(0);
  useEffect(() => {
    setValue(readDraft(draftKey));
    setStashEntries(readStash(draftKey));
    setIsStashMenuOpen(false);
    setDismissedBanners(new Set());
    setCaret(0);
    pendingCaretRef.current = null;
    pendingCaretValueRef.current = null;
  }, [draftKey]);

  useEffect(
    () => () => {
      releaseAttachments(attachmentsRef.current);
      attachmentsRef.current = [];
    },
    [],
  );

  // Dismiss the "+" menu on outside click / Escape.
  useEffect(() => {
    if (!isAttachMenuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!attachMenuRef.current?.contains(e.target as Node)) setIsAttachMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsAttachMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [isAttachMenuOpen]);
  // Pending programmatic caret: applied synchronously after the commit
  // (layout effect, before paint) so no keystroke can interleave, and
  // dropped when the draft moved on (t3's promptRef guard) so a stale
  // restore can never drag the caret back behind newer typing.
  useLayoutEffect(() => {
    if (pendingCaretRef.current === null) return;
    const el = textareaRef.current;
    const expected = pendingCaretValueRef.current;
    pendingCaretRef.current = null;
    pendingCaretValueRef.current = null;
    if (el === null || (expected !== null && expected !== value)) return;
    const pos = Math.max(0, Math.min(caret, el.value.length));
    el.focus({ preventScroll: true });
    el.setSelectionRange(pos, pos);
  }, [value, caret]);

  // JS auto-resize: the field rests at one ~20px row and grows to 160px
  // max; past that it scrolls internally. Width never changes. Height
  // writes only — selection is never touched here.
  useEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = "";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    el.style.overflowY = el.scrollHeight > 160 ? "auto" : "hidden";
    syncBackdropScroll();
  }, [value]);

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

  const openPicker = (kind: "image" | "file") => {
    const input = fileInputRef.current;
    if (!input) return;
    input.accept = kind === "image" ? "image/*" : "";
    input.value = "";
    input.click();
    setIsAttachMenuOpen(false);
  };

  const send = () => {
    const text = value.trim();
    if (!text) return;
    const staged = attachmentsRef.current;
    clearDraft(draftKey);
    setValue("");
    setCaret(0);
    pendingCaretRef.current = null;
    pendingCaretValueRef.current = null;
    attachmentsRef.current = [];
    setAttachments([]);
    releaseAttachments(staged);
    if (hasActiveReply) stageReplyFor(text);
    onSubmit?.(text, {
      ...(hasActiveReply && activeReplyLabel !== undefined && activeReplyText !== undefined
        ? { reply: { label: activeReplyLabel, text: activeReplyText } }
        : {}),
    });
    if (hasActiveReply) cancelReply();
    textareaRef.current?.focus({ preventScroll: true });
  };

  const syncBackdropScroll = () => {
    const backdrop = backdropRef.current;
    const el = textareaRef.current;
    if (backdrop !== null && el !== null) backdrop.scrollTop = el.scrollTop;
  };

  const composerDropHasFiles = (e: ReactDragEvent<HTMLDivElement>) =>
    Array.from(e.dataTransfer.types).includes("Files");

  const onComposerDragEnter = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!composerDropHasFiles(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  };

  const onComposerDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!composerDropHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  const onComposerDragLeave = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!composerDropHasFiles(e)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragOver(false);
  };

  const onComposerDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!composerDropHasFiles(e)) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  };

  // Programmatic insert (t3's readSnapshot + focusAt, minus Lexical): the
  // slice coordinates come from the live DOM, never from render-time state.
  const insertAtToken = (tokenStart: number, caretEnd: number, insert: string) => {
    const el = textareaRef.current;
    const liveValue = el?.value ?? value;
    const liveCaret = el ? (el.selectionStart ?? liveValue.length) : caretEnd;
    const start = Math.max(0, Math.min(tokenStart, liveValue.length));
    const end = Math.max(start, Math.min(caretEnd, liveCaret, liveValue.length));
    const next = liveValue.slice(0, start) + insert + liveValue.slice(end);
    const pos = start + insert.length;
    // Caret restore is staged for the layout effect (applied synchronously
    // after the commit, before paint). Focus moves now: the mouse path
    // already preventDefaulted mousedown so focus never left, and the
    // keyboard path never lost it.
    pendingCaretRef.current = pos;
    pendingCaretValueRef.current = next;
    setValue(next);
    setCaret(pos);
    writeDraft(draftKey, next);
    setMenuIndex(0);
    el?.focus({ preventScroll: true });
  };

  // Trigger detection runs against text before the caret so "$skill hello"
  // keeps working with the caret at the end, not just a lone "$".
  const beforeCaret = value.slice(0, Math.max(0, Math.min(caret, value.length)));
  const skillToken = skillTokenAtCaret(beforeCaret);

  const filteredSkills =
    skillToken !== null
      ? skills.filter(
          (skill) =>
            skill.id.toLowerCase().startsWith(skillToken.query.toLowerCase()) ||
            skill.name.toLowerCase().startsWith(skillToken.query.toLowerCase()),
        )
      : [];
  const isSkillOpen = skillToken !== null && !skillMenuDismissed;

  useEffect(() => {
    setMenuIndex(0);
    setSkillMenuDismissed(false);
  }, [skillToken?.query, skills]);
  const pickSkill = (skill: Skill) => {
    // Recompute the trigger from the live editor snapshot (t3's
    // readSnapshot): the render-time skillToken can lag one commit behind
    // after fast typing, and inserting at its stale offset duplicates text.
    const el = textareaRef.current;
    const liveValue = el?.value ?? value;
    const liveCaret = el ? (el.selectionStart ?? liveValue.length) : caret;
    const liveToken = skillTokenAtCaret(
      liveValue.slice(0, Math.max(0, Math.min(liveCaret, liveValue.length))),
    );
    if (liveToken === null) return;
    setSkillMenuDismissed(false);
    insertAtToken(liveToken.start, liveCaret, `$${skill.id} `);
  };

  const onTextareaKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      setIsAttachMenuOpen(false);
      setIsStashMenuOpen(false);
      setSkillMenuDismissed(true);
      // The send button never morphs into Stop; Escape is the only abort path.
      if (running) onAbort?.();
      return;
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && skillToken !== null) {
      if (filteredSkills.length > 0) {
        e.preventDefault();
        setMenuIndex((i) =>
          e.key === "ArrowDown"
            ? (i + 1) % filteredSkills.length
            : (i - 1 + filteredSkills.length) % filteredSkills.length,
        );
        return;
      }
    }
    if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
      // Tab only hijacks focus when it would pick a skill; otherwise the
      // focus ring moves on as usual.
      if (e.key === "Tab" && (!isSkillOpen || filteredSkills.length === 0)) return;
      const native = e.nativeEvent;
      if (native.isComposing || native.keyCode === 229) return;
      e.preventDefault();
      // Enter/Tab confirms the highlighted skill item; plain Enter sends.
      if (isSkillOpen && filteredSkills.length > 0) {
        const pick = filteredSkills[menuIndex % filteredSkills.length];
        if (pick) pickSkill(pick);
        return;
      }
      if (e.key === "Enter") send();
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
    setCaret(0);
    pendingCaretRef.current = null;
    pendingCaretValueRef.current = null;
    setIsStashMenuOpen(true);
  };

  const restoreStashEntry = (entry: StashEntry) => {
    const updated = stashEntries.filter((candidate) => candidate.id !== entry.id);
    writeStash(draftKey, updated);
    setStashEntries(updated);
    pendingCaretRef.current = entry.text.length;
    pendingCaretValueRef.current = entry.text;
    setValue(entry.text);
    setCaret(entry.text.length);
    writeDraft(draftKey, entry.text);
    setIsStashMenuOpen(false);
    textareaRef.current?.focus({ preventScroll: true });
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

  return (
    <div className="relative w-full min-w-0">
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
          className="flex w-full flex-col gap-2 rounded-xl border border-input bg-foreground/[0.08] p-2.5 pb-2 shadow-[0_12px_36px_-24px_rgb(0_0_0/80%)] focus-within:border-ring/60"
          onDragEnter={onComposerDragEnter}
          onDragOver={onComposerDragOver}
          onDragLeave={onComposerDragLeave}
          onDrop={onComposerDrop}
        >
          {attachments.length > 0 ? (
            <div className="flex flex-wrap gap-2">
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
          {/*
            Highlight backdrop + invisible-chrome textarea. Both share identical
            box metrics (w-full, px-1/py-1, text-sm/leading-5, font, pre-wrap)
            so pills sit exactly over their text. The backdrop is absolute
            inset-0 over the textarea's padding box (same padding on both) and
            stretches with the wrapper, whose height is defined by the textarea
            alone — sizes match by construction, including JS auto-resize.
            Focus ring lives on the frame (focus-within:) above, never here.
          */}
          <div className="relative">
            <div
              aria-hidden="true"
              data-testid="composer-highlight"
              ref={backdropRef}
              className="pointer-events-none absolute inset-0 box-border w-full overflow-hidden whitespace-pre-wrap break-words px-1 py-1 font-[inherit] text-sm leading-5 text-foreground"
            >
              {renderSkillHighlight(value)}
            </div>
          <textarea
            ref={textareaRef}
            data-testid="composer-input"
            aria-label={`Message ${botName}`}
            placeholder={`Message ${botName}`}
            rows={1}
            value={value}
            className="block max-h-40 w-full box-border resize-none whitespace-pre-wrap break-words bg-transparent px-1 py-1 font-[inherit] text-sm leading-5 text-transparent caret-foreground outline-none selection:bg-primary/30 selection:text-foreground placeholder:text-muted-foreground/70"
            onChange={(event) => {
              const next = event.currentTarget.value;
              // Atomic (value, caret) update from the same event (t3's
              // onChange carries both together): the trigger below always
              // derives from a matched pair. A user edit also cancels any
              // staged programmatic restore — the edit wins.
              const nextCaret = event.currentTarget.selectionStart ?? next.length;
              pendingCaretRef.current = null;
              pendingCaretValueRef.current = null;
              setValue(next);
              setCaret(nextCaret);
              writeDraft(draftKey, next);
            }}
            onKeyDown={onTextareaKeyDown}
            onSelect={(event) => {
              // Cursor-only moves (arrows, mouse, select-all): the single
              // cursor source besides onChange. onKeyUp/onClick mirrors are
              // gone — they re-committed stale offsets one render late.
              setCaret(event.currentTarget.selectionStart ?? value.length);
            }}
            onScroll={syncBackdropScroll}
            onPaste={onTextareaPaste}
          />
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center">
              <div ref={attachMenuRef} className="relative shrink-0">
                <button
                  type="button"
                  data-testid="composer-attach"
                  aria-label="Add attachments"
                  aria-expanded={isAttachMenuOpen}
                  title="Add attachments"
                  onClick={() => setIsAttachMenuOpen((open) => !open)}
                  className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
                >
                  <span
                    aria-hidden="true"
                    className={["flex transition-transform", isAttachMenuOpen ? "rotate-45" : ""].join(" ")}
                  >
                    <Plus className="size-4" />
                  </span>
                </button>
                <CountBadge
                  testid="composer-tasks-badge"
                  count={attachments.length}
                  label={`${attachments.length} staged attachments`}
                />
                {isAttachMenuOpen ? (
                  <div
                    role="menu"
                    className="absolute bottom-[calc(100%+8px)] left-2 z-20 w-56 overflow-hidden rounded-[var(--control-radius)] border border-border bg-card p-1"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="attach-photos"
                      onClick={() => openPicker("image")}
                      className="flex w-full items-center gap-2 rounded-[calc(var(--control-radius)-4px)] px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                    >
                      <ImageIcon className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">Add photos</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="attach-files"
                      onClick={() => openPicker("file")}
                      className="flex w-full items-center gap-2 rounded-[calc(var(--control-radius)-4px)] px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                    >
                      <Paperclip className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">Attach files</span>
                    </button>
                  </div>
                ) : null}
              </div>
              <span className="relative shrink-0">
              <button
                type="button"
                data-testid="composer-stash"
                aria-label="Stash prompt"
                aria-expanded={isStashMenuOpen}
                title={hasText ? "Stash this draft" : "Stashed prompts"}
                onClick={stashCurrentDraft}
                className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
              >
                <Bookmark className="size-4" />
              </button>
              <CountBadge
                testid="composer-stash-badge"
                count={stashEntries.length}
                label={`${stashEntries.length} stashed prompts`}
              />
            </span>
            </div>
            <div className="flex items-center gap-2.5">
              {contextPercent !== undefined ? (
                <span
                  data-testid="context-meter"
                  role="meter"
                  aria-label={`Context ${Math.round(contextPercent)}% used`}
                  aria-valuenow={Math.round(contextPercent)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  title={compactionPending ? "Compaction pending" : "Context used"}
                  className="flex items-center gap-1.5"
                >
                  <span className="h-1 w-14 overflow-hidden rounded-full bg-foreground/15">
                    <span
                      className="block h-full rounded-full bg-muted-foreground transition-[width] duration-300"
                      style={{ width: `${Math.max(0, Math.min(100, contextPercent))}%` }}
                    />
                  </span>
                  <span className="text-[10px] tabular-nums text-muted-foreground">
                    {compactionPending ? "compacting" : `${Math.round(contextPercent)}%`}
                  </span>
                </span>
              ) : null}
              <button
                type="button"
                data-testid="composer-send"
                data-status="ready"
                aria-label="Send"
                disabled={!hasText}
                onClick={send}
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-transform disabled:opacity-25"
              >
                <ArrowUp className="size-4" />
              </button>
            </div>
          </div>
        </div>
        {isDragOver ? (
          <div
            data-testid="composer-drop-overlay"
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border border-dashed border-ring/60 bg-background/70 text-sm text-muted-foreground"
          >
            Drop files to attach
          </div>
        ) : null}

        {isSkillOpen ? (
          <div
            data-testid="composer-skill-menu"
            role="listbox"
            aria-label="Skills"
            className="absolute bottom-[calc(100%+8px)] left-2 z-20 w-72 overflow-hidden rounded-[var(--control-radius)] border border-border bg-card p-1"
          >
            <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Skills
            </p>
            {filteredSkills.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">No skills found.</p>
            ) : (
              filteredSkills.map((skill, index) => (
                <button
                  key={skill.id}
                  type="button"
                  role="option"
                  aria-selected={index === menuIndex % filteredSkills.length}
                  data-testid={`skill-option-${skill.id}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickSkill(skill)}
                  onMouseMove={() => setMenuIndex(index)}
                  className={[
                    "flex w-full items-center gap-2 rounded-[calc(var(--control-radius)-4px)] px-2.5 py-1.5 text-left text-sm transition-colors",
                    index === menuIndex % filteredSkills.length
                      ? "bg-foreground/[0.06] text-foreground"
                      : "text-muted-foreground",
                  ].join(" ")}
                >
                  <span className="shrink-0 font-medium text-foreground">${skill.id}</span>
                  <span className="min-w-0 flex-1 truncate text-xs">{skill.description ?? skill.name}</span>
                </button>
              ))
            )}
          </div>
        ) : null}
      </div>

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
      {isStashMenuOpen ? (
        <StashMenu
          entries={stashEntries}
          onRestore={restoreStashEntry}
          onDelete={deleteStashEntry}
          onClose={() => setIsStashMenuOpen(false)}
        />
      ) : null}
    </div>
  );
}
