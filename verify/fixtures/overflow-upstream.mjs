// overflow-upstream.mjs — fake openai-completions upstream for
// verify/overflow-recovery.sh. A request whose last user message contains
// the marker "OVERFLOW-NOW" gets the context-overflow 400 ("prompt is too
// long", matching pi-ai's OVERFLOW_PATTERNS) exactly once — the first marker
// request; every later request (the retry, the compaction summarizer) is a
// minimal SSE chat completion whose text is "recovered-ok". Each request
// appends a line to the log file in argv[2] so the verify script can count
// and classify upstream hits.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const logPath = process.argv[2];
const port = Number(process.argv[3] || 8899);
const MARKER = "OVERFLOW-NOW";
let markerServed = false;
let n = 0;

function lastUserText(body) {
  try {
    const doc = JSON.parse(body);
    const msgs = (doc.messages ?? []).filter((m) => m.role === "user");
    const c = msgs[msgs.length - 1]?.content;
    return typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b.text ?? "").join(" ") : "";
  } catch {
    return "";
  }
}

function sse(text) {
  const chunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
  return (
    chunk({ id: "c1", object: "chat.completion.chunk", created: 1, model: "overflow-1", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }) +
    chunk({ id: "c1", object: "chat.completion.chunk", created: 1, model: "overflow-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) +
    "data: [DONE]\n\n"
  );
}

createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    n += 1;
    const marked = lastUserText(body).includes(MARKER);
    appendFileSync(logPath, `${n} marked=${marked} markerServed=${markerServed} ${req.method} ${req.url}\n`);
    if (marked && !markerServed) {
      markerServed = true;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "prompt is too long: 1234 tokens > 1000 maximum", type: "invalid_request_error", code: "context_length_exceeded" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse("recovered-ok"));
  });
}).listen(port, "127.0.0.1", () => console.log(`overflow-upstream listening on ${port}`));
