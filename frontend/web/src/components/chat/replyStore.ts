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
 * Akeru BotPromptComposer buildReplyPrompt equivalent: quotes the replied-to
 * message above the fresh text so the send path stays plain text.
 */
export function buildReplyPrompt(text: string, reply: ReplyTarget | null): string {
  if (reply === null) return text;
  return `> ${reply.label}: ${reply.text}\n\n${text}`;
}
