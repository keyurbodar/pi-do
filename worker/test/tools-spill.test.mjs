// tools-spill.test.mjs — spillCapped writes the full text into the workspace
// (tmp/) and appends the path note; a failed write degrades to the note.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hook.mjs", import.meta.url);

const { spillCapped } = await import("pi-cf/tools/tools");

function makeContext(failWrite = false) {
  const written = new Map();
  return {
    written,
    env: {
      writeFile(path, data) {
        if (failWrite) throw new Error("disk full");
        written.set(path, String(data));
        return { path, bytes: String(data).length };
      },
    },
  };
}

test("spillCapped stores the full text and appends the path note", () => {
  const ctx = makeContext();
  const note = spillCapped(ctx, "test", "x".repeat(40_000), "[32,000 chars shown]");
  assert.match(note, /\[output capped — full text saved to tmp\/spill-test-.*\.txt\]/);
  const path = note.match(/tmp\/spill-test-.*\.txt/)[0];
  assert.equal(ctx.written.get(path).length, 40_000);
});

test("spillCapped degrades to the note when the write throws", () => {
  const ctx = makeContext(true);
  const note = spillCapped(ctx, "grep", "full", "[capped]");
  assert.equal(note, "[capped]");
});
