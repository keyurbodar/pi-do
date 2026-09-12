// overflow-recovery-session-hook.mjs — resolve hook for
// overflow-recovery.test.mjs: intercepts the pi-cf/agent/session specifier
// with the scripted fake module; everything else falls through.
export async function resolve(specifier, context, next) {
  if (specifier === "pi-cf/agent/session") {
    return { url: new URL("./overflow-recovery-session-fake.mjs", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
