// send-upstream.mjs — fake openai-completions upstream for
// verify/send-tool-proof.sh. On the sender's first call it answers with a
// `send` tool call (to the recipient session name, body carrying the proof
// marker), so the agent sends mid-turn through the real tool seam; on the
// next call (tool result present) it answers "sent-ok". The recipient's
// wake turn gets a plain text answer. Every request appends a line to the
// log file in argv[2]. argv: logPath port recipientName marker
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const logPath = process.argv[2];
const port = Number(process.argv[3] || 8899);
const recipient = process.argv[4] || "responder";
const marker = process.argv[5] || `team-msg-${Date.now()}`;
let n = 0;

const enc = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const chunk = (delta, finish) => ({ id: "c1", object: "chat.completion.chunk", created: 1, model: "send-1", choices: [{ index: 0, delta, finish_reason: finish ?? null }] });
const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };

function textSse(text) {
  let out = enc(chunk({ role: "assistant", content: text }));
  out += enc(chunk({}, "stop"));
  return out + "data: [DONE]\n\n";
}

function toolCallSse(name, args) {
  let out = enc(chunk({ role: "assistant", content: "" }));
  out += enc(chunk({ tool_calls: [{ index: 0, id: "call-send-1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }));
  out += enc(chunk({}, "tool_calls"));
  return out + "data: [DONE]\n\n";
}

createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    n += 1;
    let hasToolResult = false;
    try {
      const doc = JSON.parse(body);
      hasToolResult = (doc.messages ?? []).some((m) => m.role === "tool");
    } catch {}
    appendFileSync(logPath, `${n} toolResult=${hasToolResult}\n`);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(hasToolResult ? textSse("sent-ok") : toolCallSse("send", { to: recipient, body: marker, thread: `team-${marker}` }));
  });
}).listen(port, "127.0.0.1", () => console.log(`send-upstream listening on ${port}`));
