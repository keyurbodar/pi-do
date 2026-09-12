// overflow-recovery-session-fake.mjs — module-double for pi-cf/agent/session
// in overflow-recovery.test.mjs: createAgentSession counts constructions and
// run() throws the next scripted error (or returns a done turn) from
// globalThis.__overflowTest.script, set per test.
export function createAgentSession() {
  const state = globalThis.__overflowTest;
  state.calls.createAgentSession += 1;
  const next = state.script.length > 0 ? state.script.shift() : { error: "script exhausted", hint: "test bug" };
  return {
    async run() {
      if (next.ok) {
        return { result: "recovered", toolCalls: [], via: "createAgentSession", model: "stub", usage: { inTokens: 1, outTokens: 1, cacheRead: 0, costTotal: 0, elapsedMs: 1, tokensPerSec: null } };
      }
      throw { ...next };
    },
  };
}
