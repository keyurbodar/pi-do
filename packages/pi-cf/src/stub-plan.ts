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
