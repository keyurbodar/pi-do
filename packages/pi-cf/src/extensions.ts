// extensions.ts — inline extensions on pi's ExtensionFactory contract.
//
// Read-only ref (never import): refs/pi packages/coding-agent
// src/core/extensions/{types,loader,runner,wrapper}.ts. Same three powers, no
// new concepts: registerTool (an LLM-callable tool merged into the session
// tools), registerCommand (a named handler on the command map), on()
// (turn hooks fired around each run). Inline factories only: no wire frames
// (PR20), no VFS loading (PR21).
import type { AgentHarnessTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "./tools.ts";

export interface InlineToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string> | string;
}

export interface InlineCommandDefinition {
  description?: string;
  handler: (args: string) => Promise<string> | string;
}

export type InlineHookEvent = "turn_start" | "turn_end";

export interface InlineTurnContext {
  prompt: string;
  result: string;
  calls: { tool: string; output: string }[];
}

export type InlineHook = (ctx: InlineTurnContext) => Promise<string | void> | string | void;

export interface InlineExtensionApi {
  registerTool: (tool: InlineToolDefinition) => void;
  registerCommand: (name: string, command: InlineCommandDefinition) => void;
  on: (event: InlineHookEvent, handler: InlineHook) => void;
}

export type InlineExtensionFactory = (api: InlineExtensionApi) => void | Promise<void>;

export interface LoadedInlineCommand extends InlineCommandDefinition {
  name: string;
}

export interface LoadedInlineExtensions {
  tools: Map<string, AgentHarnessTool<ToolContext, any, unknown>>;
  commands: Map<string, LoadedInlineCommand>;
  hooks: Map<InlineHookEvent, InlineHook[]>;
}

function fail(error: string, hint: string): never {
  throw { error, hint };
}

export async function loadInlineExtensions(
  factories: InlineExtensionFactory[],
): Promise<LoadedInlineExtensions> {
  const tools = new Map<string, AgentHarnessTool<ToolContext, any, unknown>>();
  const commands = new Map<string, LoadedInlineCommand>();
  const hooks = new Map<InlineHookEvent, InlineHook[]>([
    ["turn_start", []],
    ["turn_end", []],
  ]);
  const api: InlineExtensionApi = {
    registerTool(tool) {
      if (tool === null || typeof tool !== "object" || typeof tool.name !== "string" || tool.name.length === 0) {
        fail("bad extension tool", "registerTool needs { name, description, execute } with a non-empty name");
      }
      if (typeof tool.execute !== "function") {
        fail(`bad extension tool: ${tool.name}`, "registerTool needs an execute(args) function returning the text output");
      }
      if (tools.has(tool.name)) {
        fail(`duplicate extension tool: ${tool.name}`, "rename the tool so each extension tool name is unique");
      }
      const definition = tool;
      tools.set(tool.name, {
        name: tool.name,
        label: tool.name,
        description: tool.description ?? "",
        parameters: (tool.parameters ?? { type: "object", properties: {} }) as any,
        execute(_id, params, _signal, _onUpdate, _context): Promise<AgentToolResult<unknown>> {
          const run = async (): Promise<AgentToolResult<unknown>> => {
            const output = await definition.execute((params ?? {}) as Record<string, unknown>);
            return { content: [{ type: "text", text: output }], details: {} };
          };
          return run();
        },
      });
    },
    registerCommand(name, command) {
      if (typeof name !== "string" || name.length === 0) {
        fail("bad extension command", "registerCommand needs a non-empty name plus { handler }");
      }
      if (command === null || typeof command !== "object" || typeof command.handler !== "function") {
        fail(`bad extension command: ${name}`, "registerCommand needs a handler(args) function returning the text output");
      }
      if (commands.has(name)) {
        fail(`duplicate extension command: ${name}`, "rename the command so each extension command name is unique");
      }
      commands.set(name, { name, description: command.description, handler: command.handler });
    },
    on(event, handler) {
      const list = hooks.get(event);
      if (list === undefined || typeof handler !== "function") {
        fail(
          `bad extension hook: ${String(event)}`,
          'on() takes "turn_start" or "turn_end" plus a handler function',
        );
      }
      list.push(handler);
    },
  };
  for (const factory of factories) {
    await factory(api);
  }
  return { tools, commands, hooks };
}

export const SAMPLE_TOOL_NAME = "ext_note";
export const SAMPLE_COMMAND_NAME = "ext_hello";
export const SAMPLE_TOOL_OUTPUT = "sample extension tool ok";
export const SAMPLE_HOOK_MARKER = "hook-fired:turn_end";

export function createSampleInlineExtension(): InlineExtensionFactory {
  return (api) => {
    api.registerTool({
      name: SAMPLE_TOOL_NAME,
      description: "Sample inline-extension tool: returns a fixed marker proving the extension tool path runs.",
      parameters: { type: "object", properties: {} },
      execute: () => SAMPLE_TOOL_OUTPUT,
    });
    api.registerCommand(SAMPLE_COMMAND_NAME, {
      description: "Sample inline-extension command.",
      handler: () => "hello from sample extension",
    });
    api.on("turn_end", () => SAMPLE_HOOK_MARKER);
  };
}
