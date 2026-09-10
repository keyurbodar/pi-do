export const STUB_SEED_PATH = "seed.txt";
export const STUB_BASH_MARKER = "harness-bash-ok";

export type StubStep =
  | { kind: "read"; path: string }
  | { kind: "bash"; command: string };

export function planStubTurn(_prompt: string): StubStep[] {
  return [
    { kind: "read", path: STUB_SEED_PATH },
    { kind: "bash", command: `echo ${STUB_BASH_MARKER}` },
  ];
}
// Plan mode is pure read-only with no approval gate: every write-capable
// tool throws, so both the stub and model turns fail closed on writes.
const PLAN_BLOCKED: Record<string, true> = { write: true, edit: true, remove: true, bash: true, test: true, pm: true, bg: true };
export function planTools<T extends Record<string, any>>(tools: T): T {
  const out: Record<string, any> = { ...tools };
  for (const name of Object.keys(PLAN_BLOCKED)) {
    const tool = out[name];
    if (tool === undefined) continue;
    out[name] = { ...tool, execute: async (): Promise<never> => { throw { error: `plan mode blocks the ${name} tool`, hint: "retry without plan mode to allow writes" }; } };
  }
  return out as T;
}
