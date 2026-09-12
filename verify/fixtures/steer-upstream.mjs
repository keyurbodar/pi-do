// steer-upstream.mjs — fake openai-completions upstream for
// verify/steer-injection.sh. On the first call of a turn (no tool-role
// message in the conversation yet) it waits ~4s and answers with a bash
// tool call for `echo injected-ok`, so the turn stays mid-flight long
// enough for the verify script to send a steer; the tool result forces a
// second model call. On every later call it answers with
// "saw: <last user message text>", so the final result quotes exactly the
// user messages the model saw — a steer that landed in the same run's
// context is quoted verbatim. Every request appends a line to the log file
// in argv[2].
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const logPath = process.argv[2];
const port = Number(process.argv[3] || 8899);
let n = 0;

function messagesOf(body) {
  try { return JSON.parse(body).messages ?? []; } catch { return []; }
}

function lastUserText(msgs) {
  const users = msgs.filter((m) => m.role === "user");
  const c = users[users.length - 1]?.content;
  return typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b.text ?? "").join(" ") : "";
}

function sse(deltas, finish) {
  const enc = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
  const chunk = (delta) => ({ id: "c1", object: "chat.completion.chunk", created: 1, model: "steer-1", choices: [{ index: 0, delta, finish_reason: null }] });
  let out = "";
  for (const d of deltas) out += enc(chunk(d));
  out += enc({ id: "c1", object: "chat.completion.chunk", created: 1, model: "steer-1", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
  return out + "data: [DONE]\n\n";
}

createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", async () => {
    n += 1;
    const msgs = messagesOf(body);
    const hasToolTurn = msgs.some((m) => m.role === "tool");
    appendFileSync(logPath, `${n} toolTurn=${hasToolTurn} lastUser=${JSON.stringify(lastUserText(msgs).slice(0, 80))}\n`);
    const send = (payload) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(payload);
    };
    if (!hasToolTurn) {
      // Hold the first call open so the steer lands mid-turn.
      await new Promise((r) => setTimeout(r, 4000));
      send(sse([{ role: "assistant", tool_calls: [{ index: 0, id: "call1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo injected-ok" }) } }] }], "tool_calls"));
      return;
    }
    send(sse([{ role: "assistant", content: `saw: ${lastUserText(msgs)}` }], "stop"));
  });
}).listen(port, "127.0.0.1", () => console.log(`steer-upstream listening on ${port}`));
