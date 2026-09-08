import type {
  AgentHarnessTool,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import { normalizeWorkspacePath, type ToolContext } from "./tools.ts";
import { CAPS, capText, failKey, joinOutput } from "./validate.ts";

export const TEST_MAX_OUTPUT_CHARS = CAPS.testChars;

export const testTool: AgentHarnessTool<ToolContext, any, { passed: boolean; exit: number }> = {
  name: "test",
  label: "Test",
  description:
    "Run one test file or one shell command through the shell seam and report structured pass or fail with captured output. Pass exactly one of file (a workspace-relative test script, executed by content) or command. Exit 0 is pass, anything else is fail. The isolate shell runs builtins plus sh with no node or npm, so test files must be shell-runnable. Read-only apart from whatever the command itself does.",
  parameters: {
    type: "object",
    properties: {
      file: { type: "string" },
      command: { type: "string" },
    },
    required: [],
  },
  async execute(
    id,
    params: { file?: string; command?: string },
    _signal,
    _onUpdate,
    context,
  ): Promise<AgentToolResult<{ passed: boolean; exit: number }>> {
    void id;
    const hasFile = params.file !== undefined && params.file !== "";
    const hasCommand = typeof params.command === "string" && params.command.length > 0;
    if (hasFile === hasCommand) {
      failKey("badArgs");
    }
    let label: string;
    let script: string;
    if (hasFile) {
      const path = normalizeWorkspacePath(params.file);
      label = path;
      script = new TextDecoder().decode(context.env.readFile(path));
    } else {
      label = (params.command as string).slice(0, 120);
      script = params.command as string;
    }
    const out = await context.env.exec(script);
    const capped = capText(joinOutput(out.stdout, out.stderr), TEST_MAX_OUTPUT_CHARS);
    const passed = out.exit === 0;
    const head = passed ? `PASS ${label}` : `FAIL ${label} (exit ${out.exit})`;
    return {
      content: [{ type: "text", text: capped.text ? `${head}\n${capped.text}` : head }],
      details: { passed, exit: out.exit },
    };
  },
};
function shellSafe(value: string, what: string): string {
  if (value.length === 0 || /[\n;|&`$()<>"'\\]/.test(value)) {
    failKey("badName", { what });
  }
  return value;
}

const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"];

export const pmTool: AgentHarnessTool<
  ToolContext,
  any,
  { action: string; exit: number; lockfile: string | null }
> = {
  name: "pm",
  label: "PM",
  description:
    "Run the project package manager through the shell seam: install dependencies, add one package, or run one package.json script. Actions: install, add (needs package), run (needs script). Reads package.json from the workspace root first and fails closed when it is missing; install uses npm ci when package-lock.json is present. Names the lockfile found, if any. Returns the structured exit plus captured output. Read-only apart from whatever the manager itself does.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string" },
      package: { type: "string" },
      script: { type: "string" },
    },
    required: ["action"],
  },
  async execute(
    id,
    params: { action: string; package?: string; script?: string },
    _signal,
    _onUpdate,
    context,
  ): Promise<AgentToolResult<{ action: string; exit: number; lockfile: string | null }>> {
    void id;
    if (params.action !== "install" && params.action !== "add" && params.action !== "run") {
      failKey("badAction");
    }
    let raw: string;
    try {
      raw = new TextDecoder().decode(context.env.readFile("package.json"));
    } catch {
      failKey("noPackageJson");
    }
    let scripts: string[] = [];
    try {
      const manifest = JSON.parse(raw) as { scripts?: Record<string, string> };
      scripts = Object.keys(manifest.scripts ?? {});
    } catch {
      failKey("badPackageJson");
    }
    let lockfile: string | null = null;
    for (const name of LOCKFILES) {
      try {
        context.env.readFile(name);
        lockfile = name;
        break;
      } catch {
        continue;
      }
    }
    let command: string;
    if (params.action === "install") {
      command = lockfile === "package-lock.json" ? "npm ci" : "npm install";
    } else if (params.action === "add") {
      if (typeof params.package !== "string" || params.package.length === 0) {
        failKey("missingPackage");
      }
      command = `npm install ${shellSafe(params.package as string, "package")}`;
    } else {
      if (typeof params.script !== "string" || params.script.length === 0) {
        failKey("missingScript");
      }
      const script = shellSafe(params.script as string, "script");
      if (!scripts.includes(script)) {
        failKey("unknownScript", { script, scripts: scripts.join(", ") || "(no scripts)" });
      }
      command = `npm run ${script}`;
    }
    const out = await context.env.exec(command);
    const capped = capText(joinOutput(out.stdout, out.stderr), TEST_MAX_OUTPUT_CHARS);
    const head = `${params.action} (exit ${out.exit}, lockfile: ${lockfile ?? "none"})`;
    return {
      content: [{ type: "text", text: capped.text ? `${head}\n${capped.text}` : head }],
      details: { action: params.action, exit: out.exit, lockfile },
    };
  },
};
