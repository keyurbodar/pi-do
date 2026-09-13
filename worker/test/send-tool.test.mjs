// send-tool.test.mjs — proves the agent-facing send tool over a fake
// InboxAccess: delivered calls return the recipient and spawn marker,
// errors surface as typed {error, hint}, self-awareness comes from
// context.selfId, and a session without messaging access degrades with a
// hint instead of throwing raw.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hook.mjs", import.meta.url);

const { sendTool } = await import("pi-cf/tools/send-tool");

function makeContext(inbox, selfId = "bot-a") {
  return { env: {}, inbox, selfId };
}

test("send delivers through the injected access and reports recipient + spawn", async () => {
  const calls = [];
  const ctx = makeContext({
    async send(from, to, body, thread, requestId) {
      calls.push({ from, to, body, thread, requestId });
      return { ok: true, id: "m1", toSid: "bot-b", created: true };
    },
  });
  const res = await sendTool.execute("id", { to: "bot-b", body: "do the thing", thread: "offsite", requestId: "r1" }, undefined, undefined, ctx);
  assert.equal(res.details.sent, true);
  assert.match(res.content[0].text, /delivered to bot-b/);
  assert.match(res.content[0].text, /new bot spawned/);
  assert.deepEqual(calls[0], { from: "bot-a", to: "bot-b", body: "do the thing", thread: "offsite", requestId: "r1" });
});

test("access errors become typed {error, hint} failures", async () => {
  const ctx = makeContext({
    async send() {
      return { ok: false, error: "self-send", hint: "a session cannot message itself" };
    },
  });
  await assert.rejects(
    () => sendTool.execute("id", { to: "bot-a", body: "x" }, undefined, undefined, ctx),
    (e) => e.error === "self-send" && typeof e.hint === "string",
  );
});

test("no messaging access degrades with a hint; bad args fail before the access", async () => {
  const ctx = makeContext(undefined);
  await assert.rejects(
    () => sendTool.execute("id", { to: "b", body: "x" }, undefined, undefined, ctx),
    (e) => e.error === "noInbox",
  );
  const withAccess = makeContext({
    async send() {
      throw new Error("must not be called");
    },
  });
  await assert.rejects(
    () => sendTool.execute("id", { to: "", body: "" }, undefined, undefined, withAccess),
    (e) => e.error === "missing send args",
  );
});
