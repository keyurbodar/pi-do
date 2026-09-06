export const STUB_SEED_PATH = "seed.txt";
export const STUB_SEED_FALLBACK = "seed-body-stub";
export const STUB_BASH_MARKER = "harness-bash-ok";

export type StubStep =
  | { kind: "read"; path: string }
  | { kind: "bash"; command: string };

export function planStubTurn(_prompt: string): StubStep[] {
  return [
    { kind: "bash", command: `cat ${STUB_SEED_PATH} 2>/dev/null || echo ${STUB_SEED_FALLBACK}` },
    { kind: "bash", command: `echo ${STUB_BASH_MARKER}` },
  ];
}
