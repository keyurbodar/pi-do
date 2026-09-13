// Routines section of the bot details sheet: lists this bot's scheduled
// durable turns (GET is workspace-wide, filtered by sid here), creates new
// ones, and deletes per row. Server rejections carry {error, hint} — the hint
// is shown inline so a bad spec or the active cap is self-explanatory.
import { useCallback, useEffect, useState } from "react";
import {
  createRoutine,
  deleteRoutine,
  listRoutines,
  RoutineRequestError,
  type Routine,
  type RoutineKind,
} from "../../lib/routines";
import type { RosterBot } from "../../lib/roster";
import { ensureWorkspace } from "../../lib/session";
import { cn } from "./roster.logic";

const KINDS: readonly RoutineKind[] = ["once", "interval", "weekly"];

const SPEC_PLACEHOLDER: Record<RoutineKind, string> = {
  once: "2026-12-31T09:00:00Z",
  interval: "seconds, e.g. 300",
  weekly: "mon:09:30",
};

function describeSchedule(routine: Routine): string {
  const { kind, spec } = routine.schedule;
  if (kind === "once") return `once ${spec}`;
  if (kind === "interval") return `every ${spec}s`;
  if (kind === "weekly") return `weekly ${spec.replace(":", " ")}`;
  return `${kind} ${spec}`;
}

function describeError(error: unknown): string {
  if (error instanceof RoutineRequestError) {
    return error.hint !== null ? `${error.message} — ${error.hint}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function BotRoutinesSection({ bot }: { bot: RosterBot }) {
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<RoutineKind>("interval");
  const [spec, setSpec] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const ws = await ensureWorkspace();
      const all = await listRoutines(ws, bot.id);
      setRoutines(all.filter((routine) => routine.sid === bot.id));
      setError(null);
    } catch (cause) {
      setError(describeError(cause));
    }
  }, [bot.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const ws = await ensureWorkspace();
      await createRoutine(ws, bot.id, { kind, spec: spec.trim(), prompt: prompt.trim() });
      setSpec("");
      setPrompt("");
      await refresh();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      const ws = await ensureWorkspace();
      await deleteRoutine(ws, bot.id, id);
      await refresh();
    } catch (cause) {
      setError(describeError(cause));
    }
  };

  return (
    <section className="space-y-3 border-t pt-5" data-testid="routines-section">
      <div>
        <h3 className="text-sm font-medium">Routines</h3>
        <p className="text-xs text-muted-foreground">Scheduled turns this bot runs on its own.</p>
      </div>
      {routines === null ? (
        error === null ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : null
      ) : routines.length === 0 ? (
        <p className="text-xs text-muted-foreground">No routines yet.</p>
      ) : (
        <ul className="space-y-2">
          {routines.map((routine) => (
            <li
              key={routine.id}
              data-testid={`routine-row-${routine.id}`}
              className={cn(
                "rounded-md border border-border px-3 py-2 text-sm",
                !routine.active && "opacity-60",
              )}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{routine.prompt}</span>
                <button
                  type="button"
                  data-testid={`routine-delete-${routine.id}`}
                  onClick={() => void remove(routine.id)}
                  className="cursor-pointer rounded px-1.5 py-0.5 text-xs text-destructive outline-none hover:bg-destructive/15 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Delete
                </button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {describeSchedule(routine)}
                {routine.nextRunAt !== null ? ` · next ${routine.nextRunAt}` : " · inactive"}
                {` · ran ${routine.runCount}×`}
              </p>
            </li>
          ))}
        </ul>
      )}
      <div className="space-y-2">
        <div className="flex gap-2">
          <select
            data-testid="routine-kind-select"
            value={kind}
            onChange={(event) => setKind(event.target.value as RoutineKind)}
            className="h-9 shrink-0 cursor-pointer rounded-md border border-input bg-input px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {KINDS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <input
            data-testid="routine-spec-input"
            value={spec}
            onChange={(event) => setSpec(event.target.value)}
            placeholder={SPEC_PLACEHOLDER[kind]}
            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-input px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div className="flex gap-2">
          <input
            data-testid="routine-prompt-input"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder="What should the bot do?"
            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-input px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="button"
            data-testid="routine-create"
            disabled={busy}
            onClick={() => void submit()}
            className="h-9 shrink-0 cursor-pointer rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>
      {error !== null && (
        <p data-testid="routine-error" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
