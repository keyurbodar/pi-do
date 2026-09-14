// send-tool.ts — agent-facing durable messaging: a bot inside its turn can
// message another session by id or name. The tool only carries the request —
// resolution, dedupe, persistence, and the wake all belong to the InboxAccess
// the host injects, so this file stays store-free.
import type { AgentHarnessTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ToolContext } from "./tools.ts";
import { failKey } from "../runtime/validate.ts";

export const sendTool: AgentHarnessTool<ToolContext, any, { sent: boolean; to: string }> = {
  name: "send",
  label: "Send",
  description:
    "Send a durable message to another bot (session) by id or name, to a group by id, name, or thread (one copy per member), or to the literal \"user\" to reach the human on a thread. Recipients wake with your message in context; unknown names materialize a new bot whose persona is the message body, so this is also how you propose new teammates. Use thread to keep a group conversation together. Delivery is at-least-once across crashes.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient: session id or name, group id/name/thread, or \"user\" for the human" },
      body: { type: "string", description: "Message text" },
      thread: { type: "string", description: "Optional channel key to group the conversation" },
      requestId: { type: "string", description: "Optional idempotency key; a retry with the same key never double-sends" },
    },
    required: ["to", "body"],
  },
  async execute(
    id,
    params: { to?: string; body?: string; thread?: string; requestId?: string },
    _signal,
    _onUpdate,
    context,
  ): Promise<AgentToolResult<{ sent: boolean; to: string }>> {
    void id;
    if (context.inbox === undefined || context.selfId === undefined) {
      failKey("noInbox", { hint: "this session has no messaging access; messaging is host-provided" });
    }
    if (typeof params.to !== "string" || params.to.length === 0 || typeof params.body !== "string" || params.body.length === 0) {
      throw { error: "missing send args", hint: 'retry with {"to": "<session id or name>", "body": "text"}' };
    }
    const inbox = context.inbox;
    const selfId = context.selfId;
    const out = await inbox.send(selfId, params.to, params.body, params.thread, params.requestId);
    if (!out.ok) throw { error: out.error, hint: out.hint };
    return {
      content: [{ type: "text", text: `message ${out.id} delivered to ${out.toSid}${out.created ? " (new bot spawned)" : ""}` }],
      details: { sent: true, to: out.toSid },
    };
  },
};
