// verify-tools.mjs — drives the pi-cf tool shells against an in-memory fake
// store. Proves write-then-read round-trip, edit patch plus diff output,
// list recursive plus cap, remove plus traversal rejection, read ranges plus
// bound, and serialized overlapping writes. Exit nonzero on the first gap.
import { ComputerExecutionEnv } from "./src/env.ts";
import {
  editTool,
  listTool,
  readTool,
  removeTool,
  writeTool,
} from "./src/tools.ts";
import { sessionTools } from "./src/session.ts";

function fail(step, want, got) {
  console.error(`FAIL ${step}: want ${want} got ${got}`);
  process.exit(1);
}

function eq(step, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) fail(step, b, a);
}

function includes(step, got, want) {
  if (typeof got !== "string" || !got.includes(want)) fail(step, `includes ${want}`, got);
}

async function throwsToolError(step, fn, wantError) {
  try {
    await fn();
  } catch (e) {
    if (e !== null && typeof e === "object" && typeof e.error === "string" && typeof e.hint === "string") {
      if (`${e.error} ${e.hint}`.includes(wantError)) return;
      fail(step, `error/hint includes ${wantError}`, JSON.stringify(e));
    }
    fail(step, `{ error, hint }`, JSON.stringify(e));
  }
  fail(step, "throw", "no throw");
}

function createFakeStore(putOrder) {
  const m = new Map();
  const k = (ws, path) => ws + "\0" + path;
  return {
    put(ws, path, body) {
      const buf = body instanceof Uint8Array ? body.slice() : new TextEncoder().encode(body);
      m.set(k(ws, path), buf);
      if (putOrder) putOrder.push(path);
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

const ctx = { env: new ComputerExecutionEnv(createFakeStore(), "ws1") };
const textOf = (r) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("");

eq("session-tools", Object.keys(sessionTools).sort(), ["bash", "bg", "definition", "diagnostics", "edit", "find", "grep", "list", "pm", "read", "references", "remove", "test", "write"]);

eq("write", textOf(await writeTool.execute("t1", { path: "a.txt", content: "hello" }, undefined, undefined, ctx)), "Successfully wrote to a.txt");
eq("read-back", textOf(await readTool.execute("t2", { path: "a.txt" }, undefined, undefined, ctx)), "hello");

// Overwrite is create-through-same-path.
await writeTool.execute("t3", { path: "a.txt", content: "hello again" }, undefined, undefined, ctx);
eq("read-overwrite", textOf(await readTool.execute("t4", { path: "a.txt" }, undefined, undefined, ctx)), "hello again");

await writeTool.execute("t5", { path: "poem.txt", content: "line one\nline two\nline three" }, undefined, undefined, ctx);
const edited = await editTool.execute("t6", { path: "poem.txt", edits: [{ oldText: "line two", newText: "LINE TWO" }] }, undefined, undefined, ctx);
includes("edit-text", textOf(edited), "Successfully replaced 1 block(s) in poem.txt.");
includes("edit-diff", edited.details.diff, "+2 LINE TWO");
includes("edit-diff-old", edited.details.diff, "-2 line two");
includes("edit-patch", edited.details.patch, "@@");
eq("edit-first-line", edited.details.firstChangedLine, 2);
eq("edit-read", textOf(await readTool.execute("t7", { path: "poem.txt" }, undefined, undefined, ctx)), "line one\nLINE TWO\nline three");

// Legacy single-edit compat form.
const edited2 = await editTool.execute("t8", { path: "poem.txt", oldText: "LINE TWO", newText: "line 2" }, undefined, undefined, ctx);
includes("edit-compat", textOf(edited2), "Successfully replaced 1 block(s) in poem.txt.");

await throwsToolError("edit-missing", () => editTool.execute("t9", { path: "nope.txt", edits: [{ oldText: "x", newText: "y" }] }, undefined, undefined, ctx), "no such file");
await throwsToolError("edit-notfound", () => editTool.execute("t10", { path: "poem.txt", edits: [{ oldText: "absent", newText: "y" }] }, undefined, undefined, ctx), "Could not find");
await writeTool.execute("t11", { path: "dup.txt", content: "same\nsame" }, undefined, undefined, ctx);
await throwsToolError("edit-duplicate", () => editTool.execute("t12", { path: "dup.txt", edits: [{ oldText: "same", newText: "y" }] }, undefined, undefined, ctx), "occurrences");

await writeTool.execute("t13", { path: "d/a.txt", content: "a" }, undefined, undefined, ctx);
await writeTool.execute("t14", { path: "d/b.txt", content: "b" }, undefined, undefined, ctx);
await writeTool.execute("t15", { path: "d/sub/c.txt", content: "c" }, undefined, undefined, ctx);
eq("list-flat", textOf(await listTool.execute("t16", { path: "d/" }, undefined, undefined, ctx)), "d/a.txt\nd/b.txt\nd/sub/");
eq("list-recursive", textOf(await listTool.execute("t17", { path: "d/", recursive: true }, undefined, undefined, ctx)), "d/a.txt\nd/b.txt\nd/sub/c.txt");
const capped = await listTool.execute("t18", { path: "d/", recursive: true, maxEntries: 2 }, undefined, undefined, ctx);
eq("list-cap", textOf(capped), "d/a.txt\nd/b.txt\n\n[2 entries limit reached. Use maxEntries=4 for more]");
eq("list-empty", textOf(await listTool.execute("t19", { path: "empty/" }, undefined, undefined, ctx)), "(empty directory)");
await throwsToolError("list-bad-cap", () => listTool.execute("t20", { path: "d/", maxEntries: 0 }, undefined, undefined, ctx), "bad maxEntries");

eq("remove-file", textOf(await removeTool.execute("t21", { path: "d/a.txt" }, undefined, undefined, ctx)), "Removed d/a.txt");
await throwsToolError("remove-gone", () => readTool.execute("t22", { path: "d/a.txt" }, undefined, undefined, ctx), "no such file");
await throwsToolError("remove-dir-guarded", () => removeTool.execute("t23", { path: "d" }, undefined, undefined, ctx), "is a directory");
const removedTree = await removeTool.execute("t24", { path: "d", recursive: true }, undefined, undefined, ctx);
includes("remove-tree", textOf(removedTree), "Removed 2 files under d/");
await throwsToolError("remove-missing", () => removeTool.execute("t25", { path: "d" }, undefined, undefined, ctx), "no such file");
await throwsToolError("remove-traversal", () => removeTool.execute("t26", { path: "../escape.txt" }, undefined, undefined, ctx), "escapes workspace");
await throwsToolError("remove-backslash", () => removeTool.execute("t27", { path: "a\\b.txt" }, undefined, undefined, ctx), "backslashes");
await throwsToolError("remove-nul", () => removeTool.execute("t28", { path: "a\0b.txt" }, undefined, undefined, ctx), "NUL");
await throwsToolError("remove-root", () => removeTool.execute("t29", { path: "./" }, undefined, undefined, ctx), "workspace root");
await throwsToolError("write-traversal", () => writeTool.execute("t30", { path: "sub/../../escape.txt", content: "x" }, undefined, undefined, ctx), "escapes workspace");

const ten = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n");
await writeTool.execute("t31", { path: "ten.txt", content: ten }, undefined, undefined, ctx);
eq("read-whole-unchanged", textOf(await readTool.execute("t32", { path: "ten.txt" }, undefined, undefined, ctx)), ten);
eq("read-range", textOf(await readTool.execute("t33", { path: "ten.txt", offset: 3, limit: 4 }, undefined, undefined, ctx)), "l3\nl4\nl5\nl6\n\n[Showing lines 3-6 of 10. Use offset=7 to continue.]");
await throwsToolError("read-offset-past-end", () => readTool.execute("t34", { path: "ten.txt", offset: 11 }, undefined, undefined, ctx), "beyond end of file");
await throwsToolError("read-bad-offset", () => readTool.execute("t35", { path: "ten.txt", offset: 0 }, undefined, undefined, ctx), "bad offset");
await throwsToolError("read-bad-limit", () => readTool.execute("t36", { path: "ten.txt", limit: -1 }, undefined, undefined, ctx), "bad limit");

const order = [];
const ctx2 = { env: new ComputerExecutionEnv(createFakeStore(order), "ws2") };
await Promise.all([
  writeTool.execute("w1", { path: "race.txt", content: "first" }, undefined, undefined, ctx2),
  writeTool.execute("w2", { path: "race.txt", content: "second" }, undefined, undefined, ctx2),
  writeTool.execute("w3", { path: "race.txt", content: "third" }, undefined, undefined, ctx2),
]);
eq("race-order", order, ["race.txt", "race.txt", "race.txt"]);
eq("race-last-wins", textOf(await readTool.execute("w4", { path: "race.txt" }, undefined, undefined, ctx2)), "third");

// Overlapping write plus edit serialize on the same queue.
await Promise.all([
  writeTool.execute("w5", { path: "mix.txt", content: "aaa" }, undefined, undefined, ctx2),
  editTool.execute("w6", { path: "mix.txt", edits: [{ oldText: "aaa", newText: "bbb" }] }, undefined, undefined, ctx2),
]);
eq("mix-serialized", textOf(await readTool.execute("w7", { path: "mix.txt" }, undefined, undefined, ctx2)), "bbb");

console.log("PASS verify-tools");
