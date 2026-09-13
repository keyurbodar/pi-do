// components/chat/replyStore.ts — module-level reply target both the
// timeline and the composer import (no App.tsx changes). MessageBubble's
// default onReply sets the target from the bubble text; PromptInput reads it
// via useReplyTarget(), renders the reply strip, and folds it into the
// onSubmit opts as { reply: { label, text } }.
import { useSyncExternalStore } from "react";

export interface ReplyTarget {
  label: string;
  text: string;
}

let target: ReplyTarget | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of Array.from(listeners)) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ReplyTarget | null {
  return target;
}

export function getReplyTarget(): ReplyTarget | null {
  return target;
}

export function setReplyTarget(next: ReplyTarget | null): void {
  if (target?.label === next?.label && target?.text === next?.text) return;
  target = next;
  emit();
}

export function clearReplyTarget(): void {
  setReplyTarget(null);
}
/** Reactive read of the module reply target; re-renders on set/clear. */
export function useReplyTarget(): ReplyTarget | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Staged replies keyed by exact outgoing prompt text. The worker never
 * returns replyTo, so the send path stages the armed target here and the
 * mapper reattaches it to the sent user bubble on render.
 */
const stagedByPrompt = new Map<string, ReplyTarget>();

/**
 * Captures the currently armed target into the staged map under the exact
 * prompt text, then clears the armed target. No-ops when no reply is armed
 * or the prompt is empty (leaves the armed target untouched).
 */
export function stageReplyFor(prompt: string): void {
  if (prompt.length === 0) return;
  const current = target;
  if (current === null) return;
  stagedByPrompt.set(prompt, { label: current.label, text: current.text });
  setReplyTarget(null);
}

/**
 * Returns the staged reply for the exact prompt text WITHOUT deleting it.
 * Idempotent: every render attaches the same replyTo, so React StrictMode
 * double render (first pass discarded, second pass committed) keeps the
 * quote. Entries persist in the module Map for the page lifetime — bounded,
 * one per replied send — which is acceptable.
 */
export function peekReplyFor(prompt: string): ReplyTarget | null {
  if (prompt.length === 0) return null;
  const staged = stagedByPrompt.get(prompt);
  if (staged === undefined) return null;
  return staged;
}

/**
 * Akeru BotPromptComposer buildReplyPrompt equivalent: quotes the replied-to
 * message above the fresh text so the send path stays plain text.
 */
export function buildReplyPrompt(text: string, reply: ReplyTarget | null): string {
  if (reply === null) return text;
  return `> ${reply.label}: ${reply.text}\n\n${text}`;
}
