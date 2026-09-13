// components/chat/transcript.ts — pure TurnViewState[] → plain-text
// transcript for the header copy action. Mirrors mapper.turnToItems order
// (system, prompt, delegation, thinking, tools, text, approval, userinput,
// error/halt) without React.
import type { TurnViewState } from "../thread/types";
import { toolRowOf } from "../thread/viewModel";

export function buildTranscript(turns: TurnViewState[]): string {
  const lines: string[] = [];
  for (const turn of turns) {
    if (turn.systemEvent !== undefined && turn.systemEvent.length > 0) {
      lines.push(`[system] ${turn.systemEvent}`);
    }
    if (turn.prompt.length > 0) lines.push(`User: ${turn.prompt}`);
    if (turn.delegation !== undefined) {
      lines.push(`[delegation] ${turn.delegation.childBot}: ${turn.delegation.task} (${turn.delegation.state})`);
    }
    for (const part of turn.parts) {
      if (part.type === "thinking") {
        lines.push(`[thinking${part.ms !== null ? ` ${part.ms}ms` : ""}] ${part.text}`);
      } else if (part.type === "text") {
        if (part.text.trim().length > 0) lines.push(`Bot: ${part.text}`);
      } else {
        for (const id of part.ids) {
          const call = turn.calls.find((c) => c.id === id);
          if (call !== undefined) {
            const row = toolRowOf(call);
            lines.push(`[tool] ${row.label} → ${row.detail ?? "running"}`);
          }
        }
      }
    }
    if (turn.approval !== undefined) {
      lines.push(`[approval] ${turn.approval.title}: ${turn.approval.description} (pending)`);
    }
    if (turn.userInput !== undefined) {
      lines.push(`[question] ${turn.userInput.question} (${turn.userInput.options.join(" / ")})`);
    }
    if (turn.error !== null && turn.error.length > 0) lines.push(`[error] ${turn.error}`);
    else if (turn.halt !== null) lines.push(`[halted] ${turn.halt}`);
  }
  return lines.join("\n");
}
