// summarizer.ts — the real compaction summarizer, resolved the same way the
// keyed turn loop resolves its model: provider key from env via
// resolveProviderKey, model from the catalog. No key → undefined, so the
// compaction path stays deterministic byte-for-byte.
//
// Prompt shape follows pi's compaction (read-only reference):
// refs/pi/packages/coding-agent/src/core/compaction/compaction.ts
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { retryAssistantCall, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { SHARED_RETRY } from "pi-cf/agent/budgets";
import { readSingleRow } from "pi-cf/store/sql-util";
import type { EntriesSql } from "pi-cf/store/entries";
import { COMPACTION_RESERVE_TOKENS, type CompactionSummarizer } from "./compaction";
import { resolveCatalogModel, resolveProviderKey, type RuntimeEnv, type RuntimeModel } from "./model-runtime";

const SUMMARIZATION_TIMEOUT_MS = 120_000;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

function summaryText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is Extract<AssistantMessage["content"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function modelSummarizer(env: RuntimeEnv, provider: string, modelId: string, sessionId: string): CompactionSummarizer | undefined {
  const apiKey = resolveProviderKey(env, provider);
  if (apiKey === undefined) return undefined;
  let model: RuntimeModel;
  try {
    model = resolveCatalogModel(provider, modelId);
  } catch {
    return undefined;
  }
  // Same enrichment createAgentSession applies (session.ts piModel): catalog
  // entries omit optional Model fields the pi-ai adapters read directly.
  const piModel = {
    ...model,
    name: model.name ?? model.id,
    input: ["text"],
    reasoning: model.reasoning ?? false,
  } as unknown as Model<Api>;
  const maxTokens = Math.min(Math.floor(0.8 * COMPACTION_RESERVE_TOKENS), model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);
  return async (prefixText, previousSummary) => {
    const hasPrior = previousSummary !== undefined && previousSummary.length > 0;
    let promptText = `<conversation>\n${prefixText}\n</conversation>\n\n`;
    if (hasPrior) promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
    promptText += hasPrior ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
    // The timeout signal rides the request AND the retry loop's backoff
    // sleeps, so the 120s budget still bounds the whole summarization.
    const signal = AbortSignal.timeout(SUMMARIZATION_TIMEOUT_MS);
    const message = await retryAssistantCall(
      () => completeSimple(
        piModel,
        { messages: [{ role: "user", content: promptText, timestamp: Date.now() }] },
        // A stalled summary call must degrade to the deterministic summary
        // instead of hanging the alarm, so the request carries its own timeout.
        // Session-scoped providers (opencode-go) reject keyless-session
        // requests, so the summary rides the same session id.
        { apiKey, maxTokens, signal, sessionId },
      ),
      // Shared retry policy: transient stream drops retry, deterministic
      // errors return immediately, aborts never retry.
      { enabled: true, maxRetries: SHARED_RETRY.maxRetries, baseDelayMs: SHARED_RETRY.baseDelayMs },
      signal,
    );
    return summaryText(message);
  };
}

export function sessionSummarizer(env: RuntimeEnv, sql: EntriesSql, sid: string): CompactionSummarizer | undefined {
  const row = readSingleRow(sql, "SELECT modelProvider, modelId FROM sessions WHERE sid = ? LIMIT 1", sid);
  if (row === null || typeof row !== "object") return undefined;
  const provider = typeof row.modelProvider === "string" && row.modelProvider.length > 0 ? row.modelProvider : null;
  const id = typeof row.modelId === "string" && row.modelId.length > 0 ? row.modelId : null;
  if (provider === null || id === null) return undefined;
  return modelSummarizer(env, provider, id, sid);
}
