// stub-model.ts — fixed deterministic script standing in for the model.
//
// @todo PR14 replaces this with ModelRuntime (pi-ai Model interface in
// refs/pi/packages/ai src/types.ts: Model needs id/name/api/provider/baseUrl
// plus a stream function; the stub carries only an id because no provider
// call happens). Scaffold before feature, deleted on arrival.

export const STUB_MODEL_ID = "stub";
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
