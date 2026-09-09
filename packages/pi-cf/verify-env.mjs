// verify-env.mjs — drives ComputerExecutionEnv against an in-memory fake store.
// Exit nonzero on the first mismatch.
import { ComputerExecutionEnv } from "./src/runtime/env.ts";

function fail(step, want, got) {
  console.error(`FAIL ${step}: want ${want} got ${got}`);
  process.exit(1);
}

function eq(step, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) fail(step, b, a);
}

function throwsEnvError(step, fn, wantError) {
  try {
    fn();
  } catch (e) {
    if (
      e !== null &&
      typeof e === "object" &&
      e.error === wantError &&
      typeof e.hint === "string"
    )
      return;
    fail(step, `{ error: ${wantError}, hint: string }`, JSON.stringify(e));
  }
  fail(step, "throw", "no throw");
}

function createFakeStore() {
  const m = new Map();
  const k = (ws, path) => ws + "\0" + path;
  return {
    put(ws, path, body) {
      const buf = body.slice();
      m.set(k(ws, path), buf);
      return buf.byteLength;
    },
    get(ws, path) {
      return m.get(k(ws, path));
    },
    list(ws, dir) {
      return [...m]
        .filter(([key]) => key.startsWith(ws + "\0" + dir))
        .map(([key, buf]) => ({ path: key.split("\0")[1], bytes: buf.byteLength }))
        .sort((a, b) => (a.path < b.path ? -1 : 1));
    },
    exists(ws, path) {
      return m.has(k(ws, path));
    },
    remove(ws, path) {
      return m.delete(k(ws, path));
    },
  };
}

const env = new ComputerExecutionEnv(createFakeStore(), "ws1");

eq("write", env.writeFile("a.txt", "hello"), { path: "a.txt", bytes: 5 });
eq("read", new TextDecoder().decode(env.readFile("a.txt")), "hello");
eq("stat", env.stat("a.txt"), { path: "a.txt", bytes: 5 });
eq(
  "write-nested",
  env.writeFile("dir/b.txt", new Uint8Array([1, 2, 3])),
  { path: "dir/b.txt", bytes: 3 },
);
eq("readdir-dir", env.readdir("dir/"), [{ path: "dir/b.txt", bytes: 3 }]);
eq("readdir-all", env.readdir(""), [
  { path: "a.txt", bytes: 5 },
  { path: "dir/b.txt", bytes: 3 },
]);
eq("rm", env.rm("a.txt"), { path: "a.txt" });
throwsEnvError("read-missing", () => env.readFile("a.txt"), "no such file: a.txt");
throwsEnvError("stat-missing", () => env.stat("a.txt"), "no such file: a.txt");
throwsEnvError("rm-missing", () => env.rm("a.txt"), "no such file: a.txt");
eq("readdir-after-rm", env.readdir(""), [{ path: "dir/b.txt", bytes: 3 }]);

console.log("PASS verify-env");
