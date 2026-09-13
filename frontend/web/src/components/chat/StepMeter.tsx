// components/chat/StepMeter.tsx — compact progress meter rendered above
// the activity row while a turn streams (akeru BotStepMeter pattern,
// refs/akeru-bot, MIT). No new data: step count derives from the turn's
// parts, tool-call count from its calls.
import type { TurnViewState } from "../thread/types";

export function stepLabel(turn: TurnViewState): string {
  const steps = Math.max(1, turn.parts.length);
  const calls = turn.calls.length;
  return `Step ${steps} · ${calls} tool call${calls === 1 ? "" : "s"}`;
}

export function StepMeter({ turn }: { turn: TurnViewState }) {
  return (
    <div
      data-testid={`step-meter-${turn.runId}`}
      aria-live="polite"
      className="px-2 text-xs font-medium text-[var(--muted-foreground)]"
    >
      {stepLabel(turn)}
    </div>
  );
}
